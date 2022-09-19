import * as core from '@actions/core';
import * as github from '@actions/github';
import * as parser from 'conventional-commits-parser';

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

    const [
        [from_commit, to_commit],
        {
            data: { id: target_release_id }
        }
    ] = await Promise.all([
        Promise.all(
            [previous_release_tag, current_tag_name].map(async tag_name =>
                octokit.rest.git.getRef({ ...github.context.repo, ref: `ref/tags/${tag_name}` })
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
    messages: string[];
}> {
    const octokit = github.getOctokit(token);
    const { data } = await octokit.rest.repos.compareCommits({
        ...github.context.repo,
        base: from,
        head: to,
        per_page: 100
    });

    return {
        url: data.html_url,
        messages: data.commits.map(commit => commit.commit.message)
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
    if (type && subject && (scope === target_scope || (!scope && !target_scope))) {
        return {
            type,
            text: `${subject.charAt(0).toUpperCase()}${subject.substring(1)}`
        };
    }

    return null;
}

function getMessages(
    project: string,
    commits: parser.Commit[],
    internal?: boolean
): { [key: string]: string[] } {
    return commits
        .filter(({ footer }) => !internal || !footer || !footer.startsWith('Internal-commit:'))
        .map(commit_data => getMessage(project, commit_data))
        .filter(
            (message): message is NonNullable<typeof message> =>
                !!message && support_types.includes(message.type)
        )
        .reduce<{ [key: string]: string[] }>((messages, { type, text }) => {
            messages[type] = messages[type] || [];

            messages[type].push(text);

            return messages;
        }, {});
}

async function run(): Promise<void> {
    try {
        const token = core.getInput('token');
        const application_name = core.getInput('application_name');
        const tag_prefix = core.getInput('tag_prefix');
        const scope = core.getInput('scope');
        const dependent_scopes = core.getInput('dependent_scopes').split(',');

        const {
            target_release_id,
            version,
            sha: [commit_from, commit_to]
        } = await findPreviousRelease(token, tag_prefix);
        const { url, messages } = await getCommits(token, commit_from, commit_to);
        const parsed_commits = messages.map(commit =>
            parser.sync(commit, {
                noteKeywords: ['Internal-Commit', 'BREAKING CHANGE']
            })
        );

        const type_message_map = dependent_scopes.reduce((result_messages, associated_project) => {
            const sub_messages = getMessages(associated_project, parsed_commits, true);

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
    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message);
    }
}

run();
