import { execFile } from 'child_process';

/**
 * Direct invocations of the git binary, for the operations the Git extension's
 * API cannot do safely.
 *
 * Free of any `vscode` import so it can be exercised against a real temporary
 * repository under plain mocha — which matters more here than anywhere else in
 * the codebase, because getting this wrong destroys uncommitted work.
 *
 * Why this file exists at all: the obvious-looking `Repository.revert(paths)` is
 * not an unstage, it runs `git checkout HEAD --` and throws away working tree
 * edits. The correct `Repository.restore(paths, { staged: true })` does not exist
 * in the shipped API (absent at 1.85 and 1.95; `main` only), and the `git.unstage`
 * command mis-targets when handed a Uri. `git reset HEAD --` is the canonical
 * unstage, works on every git version, and cannot touch the working tree.
 */

const DEFAULT_TIMEOUT_MS = 15000;

export interface GitCliOptions {
	/** Path to the git binary, from the Git extension's `api.git.path`. */
	gitPath: string;
	/** Repository root, used as the working directory. */
	cwd: string;
	timeoutMs?: number;
}

export interface GitCliResult {
	stdout: string;
	stderr: string;
}

export class GitCliError extends Error {
	constructor(
		message: string,
		readonly args: string[],
		readonly stderr: string,
	) {
		super(message);
		this.name = 'GitCliError';
	}
}

/** Runs a git subcommand, rejecting with the stderr text on a non-zero exit. */
export function runGit(options: GitCliOptions, args: string[]): Promise<GitCliResult> {
	return new Promise((resolve, reject) => {
		execFile(
			options.gitPath,
			args,
			{
				cwd: options.cwd,
				timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: 8 * 1024 * 1024,
				// Keep git's output parseable regardless of the user's locale, and stop
				// it prompting for credentials in a process nobody can answer.
				env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(new GitCliError(stderr.trim() || error.message, args, stderr));
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}

/** True when the repository has no commits yet, so `HEAD` resolves to nothing. */
export async function hasCommits(options: GitCliOptions): Promise<boolean> {
	try {
		await runGit(options, ['rev-parse', '--verify', 'HEAD']);
		return true;
	} catch {
		return false;
	}
}

/**
 * Removes paths from the index, leaving the working tree untouched.
 *
 * On a repository with commits this is `git reset -q HEAD -- <paths>`. Before the
 * first commit there is no HEAD to reset against, so it falls back to
 * `git rm --cached`, which also only rewrites the index.
 *
 * @param paths Absolute or repository-relative file paths.
 */
export async function unstage(options: GitCliOptions, paths: string[]): Promise<void> {
	const targets = paths.filter((path) => path.trim().length > 0);
	if (targets.length === 0) {
		return;
	}

	if (await hasCommits(options)) {
		await runGit(options, ['reset', '-q', 'HEAD', '--', ...targets]);
		return;
	}

	// `--ignore-unmatch` keeps a partially-staged selection from failing wholesale.
	await runGit(options, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...targets]);
}

/** Removes everything from the index. Working tree is untouched. */
export async function unstageAll(options: GitCliOptions): Promise<void> {
	if (await hasCommits(options)) {
		await runGit(options, ['reset', '-q', 'HEAD']);
		return;
	}

	await runGit(options, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', '.']);
}
