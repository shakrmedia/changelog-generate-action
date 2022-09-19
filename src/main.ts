import * as core from '@actions/core';
import * as github from '@actions/github';
import * as parser from 'conventional-commits-parser';

async function createRelease(token: string, tag_name: string, body: string): Promise<void> {
    const octokit = github.getOctokit(token);

    await octokit.rest.repos.createRelease({
        ...github.context.repo,
        tag_name,
        body
    });
}

async function getLatestTaggedCommit(
    token: string,
    prefix: string
): Promise<{ version: string; sha: [string, string] }> {
    const octokit = github.getOctokit(token);
    let matched_tags: { name: string; commit: { sha: string } }[] = [];
    let page = 1;

    while (matched_tags.length < 2) {
        const { data } = await octokit.rest.repos.listTags({
            ...github.context.repo,
            per_page: 100,
            page
        });
        const matched = data.filter(tag => tag.name.startsWith(prefix)).slice(0, 2);

        matched_tags = matched_tags.concat(matched);
        page++;

        if (data.length < 100) {
            break;
        }
    }

    if (matched_tags.length < 2) {
        throw new Error('Could not found matched tags');
    }

    const tag_commits = matched_tags.map(tag => tag.commit.sha);
    const version = matched_tags[0].name.replace(prefix, '');

    return {
        version,
        sha: [tag_commits[1], tag_commits[0]]
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
        head: to
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
            version,
            sha: [commit_from, commit_to]
        } = await getLatestTaggedCommit(token, tag_prefix);
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

        await createRelease(token, `${tag_prefix}${version}`, full_content);
    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message);
    }
}

run();
