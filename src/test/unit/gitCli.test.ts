import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCliOptions, hasCommits, runGit, unstage, unstageAll } from '../../gitCli';

/**
 * These run against a real temporary repository rather than a mock.
 *
 * Unstaging is the one operation in this extension that sits next to destructive
 * git commands — the API method that looks like it does this (`revert`) actually
 * runs `git checkout HEAD --` and throws away uncommitted edits. A mock would
 * happily agree that our implementation is correct. Only real git can show that
 * the working tree survived.
 */

const GIT = 'git';

function git(cwd: string, ...args: string[]): string {
	return execFileSync(GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
}

function makeRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-gitcli-'));
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.email', 'test@example.com');
	git(root, 'config', 'user.name', 'Test');
	git(root, 'config', 'commit.gpgsign', 'false');
	return root;
}

function write(root: string, relative: string, contents: string): void {
	const target = path.join(root, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, contents, 'utf8');
}

/** Paths git currently has in the index, relative and sorted. */
function stagedPaths(root: string): string[] {
	return git(root, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
}

/** Tracked paths with unstaged working tree modifications. */
function dirtyPaths(root: string): string[] {
	return git(root, 'diff', '--name-only').split('\n').filter(Boolean).sort();
}

describe('gitCli', () => {
	let root: string;
	let options: GitCliOptions;

	beforeEach(() => {
		root = makeRepo();
		options = { gitPath: GIT, cwd: root };
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe('hasCommits', () => {
		it('is false before the first commit', async () => {
			assert.strictEqual(await hasCommits(options), false);
		});

		it('is true once something is committed', async () => {
			write(root, 'a.txt', 'one\n');
			git(root, 'add', '-A');
			git(root, 'commit', '-qm', 'initial');

			assert.strictEqual(await hasCommits(options), true);
		});
	});

	describe('unstage', () => {
		beforeEach(() => {
			write(root, 'a.txt', 'one\n');
			write(root, 'src/b.txt', 'two\n');
			git(root, 'add', '-A');
			git(root, 'commit', '-qm', 'initial');
		});

		it('removes a file from the index while preserving its edits', async () => {
			write(root, 'a.txt', 'one modified\n');
			git(root, 'add', 'a.txt');
			assert.deepStrictEqual(stagedPaths(root), ['a.txt']);

			await unstage(options, [path.join(root, 'a.txt')]);

			// The whole point: out of the index, still modified on disk.
			assert.deepStrictEqual(stagedPaths(root), []);
			assert.deepStrictEqual(dirtyPaths(root), ['a.txt']);
			assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one modified\n');
		});

		it('leaves other staged files alone', async () => {
			write(root, 'a.txt', 'one modified\n');
			write(root, 'src/b.txt', 'two modified\n');
			git(root, 'add', '-A');

			await unstage(options, [path.join(root, 'a.txt')]);

			assert.deepStrictEqual(stagedPaths(root), ['src/b.txt']);
			assert.deepStrictEqual(dirtyPaths(root), ['a.txt']);
		});

		it('unstages a nested path', async () => {
			write(root, 'src/b.txt', 'two modified\n');
			git(root, 'add', '-A');

			await unstage(options, [path.join(root, 'src', 'b.txt')]);

			assert.deepStrictEqual(stagedPaths(root), []);
			assert.strictEqual(fs.readFileSync(path.join(root, 'src/b.txt'), 'utf8'), 'two modified\n');
		});

		it('unstages several paths at once', async () => {
			write(root, 'a.txt', 'one modified\n');
			write(root, 'src/b.txt', 'two modified\n');
			git(root, 'add', '-A');

			await unstage(options, [path.join(root, 'a.txt'), path.join(root, 'src', 'b.txt')]);

			assert.deepStrictEqual(stagedPaths(root), []);
			assert.deepStrictEqual(dirtyPaths(root), ['a.txt', 'src/b.txt']);
		});

		it('keeps a newly added file on disk after unstaging it', async () => {
			write(root, 'new.txt', 'fresh\n');
			git(root, 'add', 'new.txt');

			await unstage(options, [path.join(root, 'new.txt')]);

			assert.deepStrictEqual(stagedPaths(root), []);
			assert.strictEqual(fs.existsSync(path.join(root, 'new.txt')), true);
			assert.strictEqual(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'fresh\n');
		});

		it('does nothing when handed an empty list', async () => {
			write(root, 'a.txt', 'one modified\n');
			git(root, 'add', '-A');

			await unstage(options, []);
			await unstage(options, ['   ']);

			assert.deepStrictEqual(stagedPaths(root), ['a.txt']);
		});
	});

	describe('unstage before the first commit', () => {
		it('falls back to rm --cached and keeps the file', async () => {
			write(root, 'a.txt', 'one\n');
			git(root, 'add', '-A');
			assert.strictEqual(await hasCommits(options), false);

			await unstage(options, [path.join(root, 'a.txt')]);

			// With no HEAD, "staged" means present in the index at all.
			assert.strictEqual(git(root, 'ls-files').trim(), '');
			assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');
		});
	});

	describe('unstageAll', () => {
		it('clears the index and preserves every edit', async () => {
			write(root, 'a.txt', 'one\n');
			write(root, 'src/b.txt', 'two\n');
			git(root, 'add', '-A');
			git(root, 'commit', '-qm', 'initial');

			write(root, 'a.txt', 'one modified\n');
			write(root, 'src/b.txt', 'two modified\n');
			git(root, 'add', '-A');
			assert.strictEqual(stagedPaths(root).length, 2);

			await unstageAll(options);

			assert.deepStrictEqual(stagedPaths(root), []);
			assert.deepStrictEqual(dirtyPaths(root), ['a.txt', 'src/b.txt']);
		});

		it('works before the first commit', async () => {
			write(root, 'a.txt', 'one\n');
			git(root, 'add', '-A');

			await unstageAll(options);

			assert.strictEqual(git(root, 'ls-files').trim(), '');
			assert.strictEqual(fs.existsSync(path.join(root, 'a.txt')), true);
		});
	});

	describe('runGit', () => {
		it('rejects with git stderr on failure', async () => {
			await assert.rejects(
				() => runGit(options, ['rev-parse', '--verify', 'definitely-not-a-ref']),
				(error: Error) => {
					assert.strictEqual(error.name, 'GitCliError');
					return true;
				},
			);
		});
	});
});
