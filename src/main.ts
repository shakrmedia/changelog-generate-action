import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as parser from 'conventional-commits-parser';

const DELIMITER = '------------------------ >8 ------------------------';

async function getCommitHash(ref: string): Promise<string> {
    const output = await exec.getExecOutput('git', ['rev-parse', ref]);

    if (output.exitCode === 0) {
        return output.stdout.trim();
    } else {
        throw new Error(output.stderr);
    }
}

async function getLatestTaggedCommit(
    prefix: string
): Promise<[string, string]> {
    const output = await exec.getExecOutput('git', [
        'for-each-ref',
        '--count=2',
        '--sort=-creatordate',
        "--format='%(refname)'",
        `'refs/tags/${prefix}*'`
    ]);

    if (output.exitCode === 0) {
        core.debug(`Diff between: ${output.stdout}`);

        const [current, latest] = await Promise.all(
            output.stdout
                .trim()
                .split('\n')
                .map(async tag => getCommitHash(tag))
        );

        return [current, latest];
    } else {
        throw new Error(output.stderr);
    }
}

async function getCommits(from: string, to: string): Promise<string[]> {
    const output = await exec.getExecOutput('git', [
        'log',
        from,
        to,
        `--format=%B%n${DELIMITER}`
    ]);

    if (output.exitCode === 0) {
        return output.stdout.trim().split(`${DELIMITER}\n`);
    } else {
        throw new Error(output.stderr);
    }
}

const support_types = ['feat', 'fix'];
const type_titles: {[key: string]: string} = {
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

function getContent(messages_with_type: {[key: string]: string[]}): string {
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
    {type, scope, subject}: parser.Commit<string>
): {type: string; text: string} | null {
    if (
        type &&
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

function getMessages(
    project: string,
    commits: parser.Commit[],
    internal?: boolean
): {[key: string]: string[]} {
    return commits
        .filter(
            ({footer}) =>
                !internal || !footer || !footer.startsWith('Internal-commit:')
        )
        .map(commit_data => getMessage(project, commit_data))
        .filter(
            (message): message is NonNullable<typeof message> =>
                !!message && support_types.includes(message.type)
        )
        .reduce<{[key: string]: string[]}>((messages, {type, text}) => {
            messages[type] = messages[type] || [];

            messages[type].push(text);

            return messages;
        }, {});
}

async function run(): Promise<void> {
    try {
        const repository_name = core.getInput('repository_name');
        const deploy_url = core.getInput('deploy_url');
        const tag_prefix = core.getInput('tag_prefix');
        const scope = core.getInput('scope');
        const dependent_scopes = core.getInput('dependent_scopes').split(',');

        const [commit_from, commit_to] = await getLatestTaggedCommit(
            tag_prefix
        );
        const commits = await getCommits(commit_from, commit_to);
        const parsed_commits = commits.map(commit =>
            parser.sync(commit, {noteKeywords: ['Internal-Commit']})
        );

        const content = getContent(getMessages(scope, parsed_commits));
        const associated_project_content = dependent_scopes.reduce(
            (result, associated_project) => {
                const sub_content = getContent(
                    getMessages(associated_project, parsed_commits, true)
                );

                if (sub_content) {
                    return result + sub_content;
                }

                return result;
            },
            ''
        );

        const full_content = `
Project: ${scope}
From: ${commit_from}
To: ${commit_to}
Compare URL: https://github.com/shakrmedia/${repository_name}/compare/${commit_from.slice(
            0,
            7
        )}...${commit_to.slice(0, 7)}

Changelog:

*${getDateString()}* ${`${deploy_url} (version ${commit_to.slice(0, 7)})`}

${content}${associated_project_content}
`.trim();

        core.debug(full_content);
    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message);
    }
}

run();
