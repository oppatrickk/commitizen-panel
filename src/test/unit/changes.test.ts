import * as assert from 'assert';
import {
	buildRow,
	buildRows,
	capRows,
	ChangeRow,
	describeStatus,
	GitStatus,
	isDeleted,
	isUntracked,
	splitPath,
} from '../../changes';

describe('describeStatus', () => {
	it('covers every status the Git extension can report', () => {
		// Guards against the upstream `Status` enum gaining a member that would
		// otherwise silently render as "?".
		for (const [name, value] of Object.entries(GitStatus)) {
			const description = describeStatus(value);
			assert.notStrictEqual(description.letter, '?', `${name} has no mapping`);
			assert.ok(description.label.length > 0, `${name} has no label`);
		}
	});

	it('uses the same letters as the built-in list', () => {
		assert.strictEqual(describeStatus(GitStatus.MODIFIED).letter, 'M');
		assert.strictEqual(describeStatus(GitStatus.INDEX_ADDED).letter, 'A');
		assert.strictEqual(describeStatus(GitStatus.DELETED).letter, 'D');
		assert.strictEqual(describeStatus(GitStatus.INDEX_RENAMED).letter, 'R');
		assert.strictEqual(describeStatus(GitStatus.UNTRACKED).letter, 'U');
	});

	it('marks every merge state as a conflict', () => {
		for (const status of [
			GitStatus.ADDED_BY_US,
			GitStatus.ADDED_BY_THEM,
			GitStatus.DELETED_BY_US,
			GitStatus.DELETED_BY_THEM,
			GitStatus.BOTH_ADDED,
			GitStatus.BOTH_DELETED,
			GitStatus.BOTH_MODIFIED,
		]) {
			assert.strictEqual(describeStatus(status).tone, 'conflict');
		}
	});

	it('falls back for an unknown status rather than throwing', () => {
		assert.strictEqual(describeStatus(999).letter, '?');
	});
});

describe('isUntracked / isDeleted', () => {
	it('recognises untracked and ignored files', () => {
		assert.strictEqual(isUntracked(GitStatus.UNTRACKED), true);
		assert.strictEqual(isUntracked(GitStatus.IGNORED), true);
		assert.strictEqual(isUntracked(GitStatus.MODIFIED), false);
	});

	it('recognises every flavour of deletion', () => {
		assert.strictEqual(isDeleted(GitStatus.DELETED), true);
		assert.strictEqual(isDeleted(GitStatus.INDEX_DELETED), true);
		assert.strictEqual(isDeleted(GitStatus.BOTH_DELETED), true);
		assert.strictEqual(isDeleted(GitStatus.MODIFIED), false);
	});
});

describe('splitPath', () => {
	const root = '/Users/dev/project';

	const cases: Array<[string, string, { name: string; directory: string }]> = [
		['nested file', `${root}/src/accounting/invoices.ts`, { name: 'invoices.ts', directory: 'src/accounting' }],
		['file at the root', `${root}/package.json`, { name: 'package.json', directory: '' }],
		['one level deep', `${root}/src/index.ts`, { name: 'index.ts', directory: 'src' }],
		['dotfile at the root', `${root}/.czrc`, { name: '.czrc', directory: '' }],
	];

	for (const [name, fsPath, expected] of cases) {
		it(name, () => {
			assert.deepStrictEqual(splitPath(fsPath, root), expected);
		});
	}

	it('normalises Windows separators', () => {
		assert.deepStrictEqual(splitPath('C:\\work\\project\\src\\a.ts', 'C:\\work\\project'), {
			name: 'a.ts',
			directory: 'src',
		});
	});

	it('tolerates a trailing slash on the root', () => {
		assert.deepStrictEqual(splitPath(`${root}/src/a.ts`, `${root}/`), { name: 'a.ts', directory: 'src' });
	});

	it('leaves a path outside the repository intact', () => {
		const result = splitPath('/elsewhere/other/a.ts', root);
		assert.strictEqual(result.name, 'a.ts');
		assert.strictEqual(result.directory, '/elsewhere/other');
	});
});

describe('buildRow', () => {
	const root = '/Users/dev/project';

	it('assembles the row the panel renders', () => {
		const row = buildRow(
			{ fsPath: `${root}/src/accounting/csv.ts`, status: GitStatus.INDEX_MODIFIED, staged: true },
			root,
		);

		assert.deepStrictEqual(row, {
			path: `${root}/src/accounting/csv.ts`,
			name: 'csv.ts',
			directory: 'src/accounting',
			letter: 'M',
			tone: 'modified',
			label: 'Modified',
			staged: true,
			untracked: false,
			deleted: false,
		} satisfies ChangeRow);
	});

	it('flags untracked and deleted rows', () => {
		const untracked = buildRow({ fsPath: `${root}/new.ts`, status: GitStatus.UNTRACKED, staged: false }, root);
		assert.strictEqual(untracked.untracked, true);

		const deleted = buildRow({ fsPath: `${root}/gone.ts`, status: GitStatus.DELETED, staged: false }, root);
		assert.strictEqual(deleted.deleted, true);
	});

	it('maps a list preserving order', () => {
		const rows = buildRows(
			[
				{ fsPath: `${root}/b.ts`, status: GitStatus.MODIFIED, staged: false },
				{ fsPath: `${root}/a.ts`, status: GitStatus.MODIFIED, staged: false },
			],
			root,
		);

		assert.deepStrictEqual(
			rows.map((row) => row.name),
			['b.ts', 'a.ts'],
		);
	});
});

describe('capRows', () => {
	const root = '/r';
	const many = buildRows(
		Array.from({ length: 250 }, (_, index) => ({
			fsPath: `${root}/file-${index}.ts`,
			status: GitStatus.MODIFIED,
			staged: false,
		})),
		root,
	);

	it('reports how many rows it dropped', () => {
		const capped = capRows(many, 200);
		assert.strictEqual(capped.rows.length, 200);
		assert.strictEqual(capped.hidden, 50);
	});

	it('passes a short list through untouched', () => {
		const capped = capRows(many.slice(0, 10), 200);
		assert.strictEqual(capped.rows.length, 10);
		assert.strictEqual(capped.hidden, 0);
	});

	it('treats a non-positive cap as unlimited', () => {
		assert.strictEqual(capRows(many, 0).hidden, 0);
	});
});
