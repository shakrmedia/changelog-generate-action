import * as core from '@actions/core';
import * as github from '@actions/github';
import * as parser from 'conventional-commits-parser';
import { LinearClient } from '@linear/sdk';

async function getTeamStateIdMap(client: LinearClient): Promise<Map<string, string>> {
    const { nodes: states } = await client.workflowStates();

    const done_states = states.filter(state => state.name === 'Done');

    if (done_states.length === 0) {
        throw new Error('Couldn\'t find "Done" state from Linear workspace');
    }

    const team_state_pairs = await Promise.all(
        done_states.map(async done_state => {
            const team = await done_state.team;

            if (!team) {
                return null;
            }

            return [team.id, done_state.id] as const;
        })
    );

    return new Map(team_state_pairs.filter((pair): pair is [string, string] => !!pair));
}

async function markLinearIssuesAsDone(
    token: string,
    linear_api_key: string,
    commit_shas: string[]
): Promise<void> {
    const octokit = github.getOctokit(token);
    const associated_pr_bodies = await Promise.all(
        commit_shas.map(async commit_sha => {
            const res = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
                ...github.context.repo,
                commit_sha
            });

            return res.data.length > 0 ? res.data[0].body : null;
        })
    );
    const linear_issues = [
        ...new Set(
            associated_pr_bodies
                .filter((body): body is string => !!body)
                .map(body => body.match(/Resolves\s([A-Z0-9]+-[0-9]+)/)?.[1])
                .filter((issue): issue is string => !!issue)
        )
    ];

    const client = new LinearClient({ apiKey: linear_api_key });
    const [issues, team_state_id_map] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/promise-function-async
        Promise.all(linear_issues.map(issue_id => client.issue(issue_id))),
        getTeamStateIdMap(client)
    ]);

    core.debug('Fetch issues and workflow states from Linear');

    await Promise.all(
        issues.map(async node => {
            const team = await node.team;

            await node.update({ stateId: team_state_id_map.get(team?.id ?? '') });
        })
    );

    core.debug('Mark linked Linear issues as done');
}

async function findPreviousRelease(
    token: string,
    tag_prefix: string
): Promise<{
    target_release_id: number;
    version: string;
    sha: [string, string];
}> {
    const octokit = github.getOctokit(token);
    let previous_release_tag: string | null = null;
    let page = 1;
    const current_tag_name = github.context.ref.replace('refs/tags/', '');

    while (!previous_release_tag) {
        const { data } = await octokit.rest.repos.listReleases({
            ...github.context.repo,
            per_page: 100,
            page
        });
        previous_release_tag =
            data
                .map(release => release.tag_name)
                .find(
                    tag_name => tag_name !== current_tag_name && tag_name.startsWith(tag_prefix)
                ) ?? null;

        page++;

        if (data.length < 100) {
            break;
        }
    }

    if (!previous_release_tag) {
        throw new Error('Could not found previous release');
    }

    core.debug(`Current Release Tag: ${current_tag_name}`);
    core.debug(`Found Pevious Release Tag: ${previous_release_tag}`);

    const [
        [from_commit, to_commit],
        {
            data: { id: target_release_id }
        }
    ] = await Promise.all([
        Promise.all(
            [previous_release_tag, current_tag_name].map(async tag_name =>
                octokit.rest.git.getRef({ ...github.context.repo, ref: `tags/${tag_name}` })
            )
        ),
        octokit.rest.repos.getReleaseByTag({
            ...github.context.repo,
            tag: current_tag_name
        })
    ]);

    return {
        target_release_id,
        version: current_tag_name.replace(tag_prefix, ''),
        sha: [from_commit.data.object.sha, to_commit.data.object.sha]
    };
}

async function getCommits(
    token: string,
    from: string,
    to: string
): Promise<{
    url: string;
    commit_shas: string[];
    messages: string[];
}> {
    const octokit = github.getOctokit(token);
    const commits: unknown[] = [];
    let url: string = '';
    let page: number = 1;

    while (true) {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
            ...github.context.repo,
            basehead: `${from}...${to}`,
            per_page: 100,
            page
        });

        commits.push(...data.commits);

        if (data.commits.length === 0) {
            url = data.html_url;

            break;
        }
    }

    return {
        url,
        commit_shas: commits.map(commit => commit.sha),
        messages: commits.map(commit => commit.commit.message)
    };
}

const support_types = ['feat', 'fix'];
const type_titles: { [key: string]: string } = {
    feat: '*Enhancements*',
    fix: '*Bug Fixes*'
};

function getDateString(): string {
    const date = new Date();

    return [
        date.getFullYear(),
        `0${date.getMonth() + 1}`.slice(-2),
        `0${date.getDate()}`.slice(-2)
    ].join('-');
}

function paragraph(header: string, list: string[]): string {
    return list.length > 0 ? `${header}\n${list.join('\n')}` : '';
}

function getTypeContent(type: string, messages: string[]): string {
    const header = type_titles[type];

    return paragraph(header, messages);
}

function getContent(messages_with_type: { [key: string]: string[] }): string {
    return support_types.reduce((result, type) => {
        if (!messages_with_type[type]) {
            return result;
        }

        const content = getTypeContent(type, messages_with_type[type]);

        return (result += `${content}\n\n`);
    }, '');
}

function getMessage(
    target_scope: string,
    { type, scope, subject }: parser.Commit<string>
): { type: string; text: string } | null {
    if (
        type &&
        support_types.includes(type) &&
        subject &&
        (scope === target_scope || (!scope && !target_scope))
    ) {
        return {
            type,
            text: `${subject.charAt(0).toUpperCase()}${subject.substring(1)}`
        };
    }

    return null;
}

function getMessages(project: string, commits: parser.Commit[]): { [key: string]: string[] } {
    return commits
        .filter(({ footer }) => !footer || !footer.startsWith('Internal-commit:'))
        .map(commit_data => getMessage(project, commit_data))
        .filter((message): message is NonNullable<typeof message> => !!message)
        .reduce<{ [key: string]: string[] }>((messages, { type, text }) => {
            messages[type] = messages[type] || [];

            messages[type].push(text);

            return messages;
        }, {});
}

async function run(): Promise<void> {
    try {
        const token = core.getInput('token');
        const linear_api_key = core.getInput('linear_api_key');
        const application_name = core.getInput('application_name');
        const tag_prefix = core.getInput('tag_prefix');
        const scope = core.getInput('scope');
        const dependent_scopes_str = core.getInput('dependent_scopes');
        const dependent_scopes = dependent_scopes_str
            .trim()
            .split(',')
            .filter(dependent_scope => !!dependent_scope.trim());

        if (!github.context.ref.startsWith(`refs/tags/${tag_prefix}`)) {
            core.debug(
                `Git tag name (${github.context.ref.replace(
                    'refs/tags',
                    ''
                )}) isn't matched with tag_prefix config (${tag_prefix})`
            );
            core.debug('Skipping action...');

            return;
        }

        const {
            target_release_id,
            version,
            sha: [commit_from, commit_to]
        } = await findPreviousRelease(token, tag_prefix);

        core.debug(`Found Previous Release: ${target_release_id}`);
        core.debug(`Generate changelog from commit range: ${commit_from}...${commit_to}`);

        const { url, commit_shas, messages } = await getCommits(token, commit_from, commit_to);

        core.debug('Fetched commit messages');

        const parsed_commits = messages.map(commit =>
            parser.sync(commit, {
                noteKeywords: ['Internal-Commit', 'BREAKING CHANGE']
            })
        );

        const type_message_map = dependent_scopes.reduce((result_messages, associated_project) => {
            const sub_messages = getMessages(associated_project, parsed_commits);

            for (const type of support_types) {
                result_messages[type] = (result_messages[type] || []).concat(
                    sub_messages[type] || []
                );
            }

            return result_messages;
        }, getMessages(scope, parsed_commits));

        const full_content = `
## ${application_name} ${version} (${getDateString()})
Compare URL: ${url}

${getContent(type_message_map)}
`.trim();

        core.debug(full_content);

        await github.getOctokit(token).rest.repos.updateRelease({
            ...github.context.repo,
            release_id: target_release_id,
            body: full_content
        });

        core.debug('Changelog posted to release body');

        if (linear_api_key) {
            await markLinearIssuesAsDone(token, linear_api_key, commit_shas);
        }
    } catch (error) {
        if (error instanceof Error) core.setFailed(error);
    }
}

run();
