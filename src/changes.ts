/**
 * View model for the panel's Staged Changes / Changes lists.
 *
 * Pure — no `vscode` import — so the status mapping and path splitting can be
 * unit-tested directly. The actions that touch the repository live in
 * `changeActions.ts`.
 */

/**
 * Mirror of the `Status` const enum in the Git extension's `git.d.ts`.
 *
 * It cannot be imported as a value: `git.d.ts` is a declaration file with no
 * JavaScript behind it, so esbuild would emit a runtime import of a module that
 * does not exist. The values are ordinals from that declaration and are covered
 * by a test that asserts every one of them maps to something.
 */
export const GitStatus = {
	INDEX_MODIFIED: 0,
	INDEX_ADDED: 1,
	INDEX_DELETED: 2,
	INDEX_RENAMED: 3,
	INDEX_COPIED: 4,
	MODIFIED: 5,
	DELETED: 6,
	UNTRACKED: 7,
	IGNORED: 8,
	INTENT_TO_ADD: 9,
	INTENT_TO_RENAME: 10,
	TYPE_CHANGED: 11,
	ADDED_BY_US: 12,
	ADDED_BY_THEM: 13,
	DELETED_BY_US: 14,
	DELETED_BY_THEM: 15,
	BOTH_ADDED: 16,
	BOTH_DELETED: 17,
	BOTH_MODIFIED: 18,
} as const;

export type ChangeTone = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored' | 'conflict';

export interface StatusDescription {
	/** Single-letter badge, matching the vocabulary of VS Code's own list. */
	letter: string;
	tone: ChangeTone;
	/** Spelled-out status for the row tooltip. */
	label: string;
}

const STATUS_TABLE: Record<number, StatusDescription> = {
	[GitStatus.INDEX_MODIFIED]: { letter: 'M', tone: 'modified', label: 'Modified' },
	[GitStatus.INDEX_ADDED]: { letter: 'A', tone: 'added', label: 'Added' },
	[GitStatus.INDEX_DELETED]: { letter: 'D', tone: 'deleted', label: 'Deleted' },
	[GitStatus.INDEX_RENAMED]: { letter: 'R', tone: 'renamed', label: 'Renamed' },
	[GitStatus.INDEX_COPIED]: { letter: 'C', tone: 'added', label: 'Copied' },
	[GitStatus.MODIFIED]: { letter: 'M', tone: 'modified', label: 'Modified' },
	[GitStatus.DELETED]: { letter: 'D', tone: 'deleted', label: 'Deleted' },
	[GitStatus.UNTRACKED]: { letter: 'U', tone: 'untracked', label: 'Untracked' },
	[GitStatus.IGNORED]: { letter: 'I', tone: 'ignored', label: 'Ignored' },
	[GitStatus.INTENT_TO_ADD]: { letter: 'A', tone: 'added', label: 'Intent to add' },
	[GitStatus.INTENT_TO_RENAME]: { letter: 'R', tone: 'renamed', label: 'Intent to rename' },
	[GitStatus.TYPE_CHANGED]: { letter: 'T', tone: 'modified', label: 'Type changed' },
	[GitStatus.ADDED_BY_US]: { letter: 'A', tone: 'conflict', label: 'Added by us' },
	[GitStatus.ADDED_BY_THEM]: { letter: 'A', tone: 'conflict', label: 'Added by them' },
	[GitStatus.DELETED_BY_US]: { letter: 'D', tone: 'conflict', label: 'Deleted by us' },
	[GitStatus.DELETED_BY_THEM]: { letter: 'D', tone: 'conflict', label: 'Deleted by them' },
	[GitStatus.BOTH_ADDED]: { letter: 'A', tone: 'conflict', label: 'Both added' },
	[GitStatus.BOTH_DELETED]: { letter: 'D', tone: 'conflict', label: 'Both deleted' },
	[GitStatus.BOTH_MODIFIED]: { letter: 'M', tone: 'conflict', label: 'Both modified' },
};

const UNKNOWN_STATUS: StatusDescription = { letter: '?', tone: 'modified', label: 'Changed' };

export function describeStatus(status: number): StatusDescription {
	return STATUS_TABLE[status] ?? UNKNOWN_STATUS;
}

/** True for statuses that mean "git is not tracking this file yet". */
export function isUntracked(status: number): boolean {
	return status === GitStatus.UNTRACKED || status === GitStatus.IGNORED;
}

/** True for statuses that mean the file no longer exists in the working tree. */
export function isDeleted(status: number): boolean {
	return (
		status === GitStatus.DELETED ||
		status === GitStatus.INDEX_DELETED ||
		status === GitStatus.DELETED_BY_US ||
		status === GitStatus.DELETED_BY_THEM ||
		status === GitStatus.BOTH_DELETED
	);
}

export interface ChangeRow {
	/** Absolute path, the handle used for stage/unstage/diff round-trips. */
	path: string;
	name: string;
	/** Directory relative to the repository root; empty at the root. */
	directory: string;
	letter: string;
	tone: ChangeTone;
	label: string;
	staged: boolean;
	untracked: boolean;
	deleted: boolean;
}

export interface ChangeInput {
	fsPath: string;
	status: number;
	staged: boolean;
}

/**
 * Splits a path into the file name and its directory relative to the repository
 * root, the way VS Code's own change list presents them.
 *
 * Separators are normalised so the result is identical on Windows and POSIX,
 * which is what makes this testable on one platform.
 */
export function splitPath(fsPath: string, repoRoot: string): { name: string; directory: string } {
	const normalized = normalize(fsPath);
	const root = trimTrailingSlash(normalize(repoRoot));

	const relative =
		root && normalized.toLowerCase().startsWith(root.toLowerCase() + '/')
			? normalized.slice(root.length + 1)
			: normalized;

	const lastSlash = relative.lastIndexOf('/');
	if (lastSlash === -1) {
		return { name: relative, directory: '' };
	}

	return { name: relative.slice(lastSlash + 1), directory: relative.slice(0, lastSlash) };
}

function normalize(value: string): string {
	return value.replace(/\\/g, '/');
}

function trimTrailingSlash(value: string): string {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function buildRow(input: ChangeInput, repoRoot: string): ChangeRow {
	const { letter, tone, label } = describeStatus(input.status);
	const { name, directory } = splitPath(input.fsPath, repoRoot);

	return {
		path: input.fsPath,
		name,
		directory,
		letter,
		tone,
		label,
		staged: input.staged,
		untracked: isUntracked(input.status),
		deleted: isDeleted(input.status),
	};
}

export function buildRows(inputs: ChangeInput[], repoRoot: string): ChangeRow[] {
	return inputs.map((input) => buildRow(input, repoRoot));
}

export interface CappedRows {
	rows: ChangeRow[];
	/** How many rows were dropped, so the UI can say so instead of pretending. */
	hidden: number;
}

/**
 * Bounds how many rows reach the webview. A working tree with thousands of files
 * would otherwise build thousands of DOM nodes on every state push.
 */
export function capRows(rows: ChangeRow[], max: number): CappedRows {
	if (max <= 0 || rows.length <= max) {
		return { rows, hidden: 0 };
	}
	return { rows: rows.slice(0, max), hidden: rows.length - max };
}
