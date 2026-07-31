import * as vscode from 'vscode';
import { buildRows, capRows, CappedRows, ChangeInput } from './changes';
import { GitService } from './git';
import { unstage as gitUnstage, unstageAll as gitUnstageAll } from './gitCli';

/** Upper bound on rows sent to the webview; the rest are reported as hidden. */
const MAX_ROWS = 200;

/** Ref the Git extension uses for the index in a `git:` URI. */
const INDEX_REF = '~';

/**
 * Repository-touching operations behind the panel's change lists.
 *
 * Staging goes through the Git extension's `add`, which is stable and gives
 * VS Code's own UI its optimistic update. Unstaging deliberately does not use the
 * extension API: `revert()` is a working tree discard, and `restore()` is not in
 * the shipped API surface — see `gitCli.ts` for the full reasoning.
 */
export class ChangeActions {
	constructor(private readonly git: GitService) {}

	stagedRows(): CappedRows {
		return this.rows(this.git.indexChanges, true);
	}

	unstagedRows(): CappedRows {
		return this.rows(this.git.unstagedChanges, false);
	}

	private rows(changes: readonly { uri: vscode.Uri; status: number }[], staged: boolean): CappedRows {
		const root = this.git.rootUri?.fsPath ?? '';
		const inputs: ChangeInput[] = changes.map((change) => ({
			fsPath: change.uri.fsPath,
			status: change.status,
			staged,
		}));

		const capped = capRows(buildRows(inputs, root), MAX_ROWS);
		if (capped.hidden > 0) {
			console.info(`[commitizen] change list capped at ${MAX_ROWS}; ${capped.hidden} rows not shown`);
		}
		return capped;
	}

	async stage(paths: string[]): Promise<void> {
		try {
			await this.git.stage(paths);
		} catch (error) {
			this.report('Could not stage', error);
		}
	}

	async stageAll(): Promise<void> {
		await this.stage(this.git.unstagedChanges.map((change) => change.uri.fsPath));
	}

	async unstage(paths: string[]): Promise<void> {
		const options = this.cliOptions();
		if (!options) {
			return;
		}

		try {
			await gitUnstage(options, paths);
		} catch (error) {
			this.report('Could not unstage', error);
		}
	}

	async unstageAll(): Promise<void> {
		const options = this.cliOptions();
		if (!options) {
			return;
		}

		try {
			await gitUnstageAll(options);
		} catch (error) {
			this.report('Could not unstage', error);
		}
	}

	/**
	 * Discards working tree changes, after the same modal confirmation VS Code
	 * shows for its own Discard Changes action.
	 *
	 * This is the one irreversible thing the panel can do — the edits are not in
	 * git and are not recoverable — so it always asks, and the dialog names the
	 * files rather than saying "these changes".
	 */
	async discard(paths: string[]): Promise<void> {
		if (paths.length === 0) {
			return;
		}

		const names = paths.map((path) => path.split(/[\\/]/).pop() ?? path);
		const detail =
			paths.length === 1
				? `Are you sure you want to discard changes in ${names[0]}?`
				: `Are you sure you want to discard changes in ${paths.length} files?\n\n${names.join(', ')}`;

		const confirm = await vscode.window.showWarningMessage(
			detail,
			{ modal: true, detail: 'This is IRREVERSIBLE — the changes will be lost.' },
			'Discard Changes',
		);

		if (confirm !== 'Discard Changes') {
			return;
		}

		try {
			// `clean` is the API's discard: it removes untracked files and checks
			// tracked ones back out. Distinct from `revert`, which we never use.
			await this.git.discard(paths);
		} catch (error) {
			this.report('Could not discard', error);
		}
	}

	/**
	 * Discards every unstaged change.
	 *
	 * Reads the full list from the repository rather than from what the panel
	 * rendered, so a capped list cannot cause a partial discard that looks complete.
	 */
	async discardAll(): Promise<void> {
		await this.discard(this.git.unstagedChanges.map((change) => change.uri.fsPath));
	}

	/** Opens the file itself rather than a comparison. */
	async openFile(fsPath: string): Promise<void> {
		try {
			await vscode.window.showTextDocument(vscode.Uri.file(fsPath), { preview: false });
		} catch (error) {
			this.report('Could not open the file', error);
		}
	}

	private cliOptions(): { gitPath: string; cwd: string } | undefined {
		const gitPath = this.git.gitPath;
		const cwd = this.git.rootUri?.fsPath;
		if (!gitPath || !cwd) {
			void vscode.window.showErrorMessage('Commitizen: the Git extension has not reported a git binary yet.');
			return undefined;
		}
		return { gitPath, cwd };
	}

	/**
	 * Opens the appropriate comparison for a row.
	 *
	 * Built with `vscode.diff` and `toGitUri` rather than the `git.openChange`
	 * command, which mis-targets when handed a plain Uri.
	 */
	async openChange(fsPath: string, staged: boolean, untracked: boolean, preview = true): Promise<void> {
		const uri = vscode.Uri.file(fsPath);
		const name = fsPath.split(/[\\/]/).pop() ?? fsPath;

		try {
			if (untracked) {
				// Nothing to compare against; just show the file.
				await vscode.window.showTextDocument(uri, { preview });
				return;
			}

			const left = this.git.toGitUri(uri, staged ? 'HEAD' : INDEX_REF);
			const right = staged ? this.git.toGitUri(uri, INDEX_REF) : uri;

			if (!left || !right) {
				await vscode.window.showTextDocument(uri, { preview });
				return;
			}

			const title = staged ? `${name} (Index)` : `${name} (Working Tree)`;
			await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview });
		} catch (error) {
			this.report('Could not open the change', error);
		}
	}

	private report(prefix: string, error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Commitizen: ${prefix} — ${detail}`);
	}
}
