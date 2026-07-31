import * as vscode from 'vscode';
import type { API as GitAPI, Change, GitExtension, Repository } from './types/git';

const STATE_CHANGE_DEBOUNCE_MS = 200;

/**
 * Thin wrapper over the built-in Git extension's API.
 *
 * Owns three things the rest of the extension should not have to think about:
 * which repository is "active" in a multi-root workspace, debouncing the very
 * chatty `state.onDidChange` event, and keeping the `commitizen.hasRepository`
 * context key in sync so the panel can hide itself outside Git workspaces.
 */
export class GitService implements vscode.Disposable {
	private api: GitAPI | undefined;
	private active: Repository | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	/** Subscriptions tied to the currently active repository only. */
	private repoDisposables: vscode.Disposable[] = [];
	private stateChangeTimer: NodeJS.Timeout | undefined;

	private readonly onDidChangeActiveRepositoryEmitter = new vscode.EventEmitter<Repository | undefined>();
	readonly onDidChangeActiveRepository = this.onDidChangeActiveRepositoryEmitter.event;

	private readonly onDidChangeRepositoryStateEmitter = new vscode.EventEmitter<void>();
	/** Debounced; fires for branch switches, staging, and every other state change. */
	readonly onDidChangeRepositoryState = this.onDidChangeRepositoryStateEmitter.event;

	private constructor() {}

	/**
	 * Resolves once the Git extension is activated. Returns a service with no API
	 * attached when Git is missing or disabled, rather than throwing — the panel
	 * degrades to hidden instead of the extension failing to activate.
	 */
	static async create(): Promise<GitService> {
		const service = new GitService();
		await service.initialize();
		return service;
	}

	private async initialize(): Promise<void> {
		const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!extension) {
			await this.updateContextKey();
			return;
		}

		const gitExtension = extension.isActive ? extension.exports : await extension.activate();

		const attach = () => {
			if (!gitExtension.enabled) {
				this.api = undefined;
				this.setActiveRepository(undefined);
				void this.updateContextKey();
				return;
			}

			try {
				this.api = gitExtension.getAPI(1);
			} catch {
				// getAPI throws while the extension is disabled; the enablement
				// listener below will call back in when that changes.
				this.api = undefined;
				void this.updateContextKey();
				return;
			}

			this.disposables.push(
				this.api.onDidOpenRepository(() => this.refreshActiveRepository()),
				this.api.onDidCloseRepository(() => this.refreshActiveRepository()),
			);
			this.refreshActiveRepository();
		};

		this.disposables.push(gitExtension.onDidChangeEnablement(() => attach()));
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.refreshActiveRepository()));

		attach();
	}

	get activeRepository(): Repository | undefined {
		return this.active;
	}

	get hasRepository(): boolean {
		return (this.api?.repositories.length ?? 0) > 0;
	}

	/** Stable key for the active repository, used to index drafts. */
	get activeRepositoryKey(): string | undefined {
		return this.active?.rootUri.toString();
	}

	/** Current branch name, or undefined on a detached HEAD or unborn branch. */
	get branchName(): string | undefined {
		return this.active?.state.HEAD?.name;
	}

	getCommitMessage(): string {
		return this.active?.inputBox.value ?? '';
	}

	setCommitMessage(value: string): void {
		if (this.active) {
			this.active.inputBox.value = value;
		}
	}

	/** Path to the git binary the Git extension resolved, for direct invocations. */
	get gitPath(): string | undefined {
		return this.api?.git.path;
	}

	get rootUri(): vscode.Uri | undefined {
		return this.active?.rootUri;
	}

	/** Changes in the index. */
	get indexChanges(): readonly Change[] {
		return this.active?.state.indexChanges ?? [];
	}

	/**
	 * Everything not staged: tracked modifications, unresolved merges and
	 * untracked files, in the order VS Code's own list presents them.
	 */
	get unstagedChanges(): readonly Change[] {
		const state = this.active?.state;
		if (!state) {
			return [];
		}
		return [...state.mergeChanges, ...state.workingTreeChanges, ...state.untrackedChanges];
	}

	/** Turns a working file into the git URI for a given ref, used for diffs. */
	toGitUri(uri: vscode.Uri, ref: string): vscode.Uri | undefined {
		return this.api?.toGitUri(uri, ref);
	}

	/** Adds paths to the index. Stable API, safe on every version. */
	async stage(paths: string[]): Promise<void> {
		if (!this.active || paths.length === 0) {
			return;
		}
		await this.active.add(paths);
	}

	/**
	 * Throws away working tree changes. Irreversible.
	 *
	 * `clean` is the Git extension's discard — it removes untracked files and
	 * checks tracked ones back out. Not to be confused with `revert`, which this
	 * extension never calls: it does the same destruction under a name that reads
	 * like "unstage".
	 */
	async discard(paths: string[]): Promise<void> {
		if (!this.active || paths.length === 0) {
			return;
		}
		await this.active.clean(paths);
	}

	/** Files in the index — what a plain commit would include. */
	get stagedCount(): number {
		return this.active?.state.indexChanges.length ?? 0;
	}

	/** Everything dirty: staged, unstaged, merge conflicts and untracked files. */
	get changedCount(): number {
		const state = this.active?.state;
		if (!state) {
			return 0;
		}
		return (
			state.indexChanges.length +
			state.workingTreeChanges.length +
			state.mergeChanges.length +
			state.untrackedChanges.length
		);
	}

	/** True when a commit would have nothing to record without `--amend`. */
	get isCleanIndex(): boolean {
		return this.stagedCount === 0;
	}

	/**
	 * Creates the commit. Deliberately only ever reached from an explicit press of
	 * the panel's Commit button — nothing in the extension commits on its own.
	 */
	async commit(message: string, options?: { all?: boolean; amend?: boolean }): Promise<void> {
		if (!this.active) {
			throw new Error('No Git repository is active.');
		}

		await this.active.commit(message, {
			...(options?.all ? { all: true as const } : {}),
			...(options?.amend ? { amend: true } : {}),
		});
	}

	async push(): Promise<void> {
		if (!this.active) {
			throw new Error('No Git repository is active.');
		}
		await this.active.push();
	}

	/** Re-resolves which repository the panel should be composing for. */
	private refreshActiveRepository(): void {
		const next = this.resolveActiveRepository();
		if (next !== this.active) {
			this.setActiveRepository(next);
		}
		void this.updateContextKey();
	}

	private resolveActiveRepository(): Repository | undefined {
		const repositories = this.api?.repositories ?? [];
		if (repositories.length === 0) {
			return undefined;
		}
		if (repositories.length === 1) {
			return repositories[0];
		}

		const editor = vscode.window.activeTextEditor;
		if (editor && this.api) {
			const owning = this.api.getRepository(editor.document.uri);
			if (owning) {
				return owning;
			}
		}

		// Keep the previous choice when the active editor belongs to no repository
		// (an output channel, a settings tab) so the panel does not jump around.
		if (this.active && repositories.includes(this.active)) {
			return this.active;
		}

		return repositories[0];
	}

	private setActiveRepository(repository: Repository | undefined): void {
		this.disposeRepoSubscriptions();
		this.active = repository;

		if (repository) {
			this.repoDisposables.push(
				repository.state.onDidChange(() => this.scheduleStateChange()),
			);
		}

		this.onDidChangeActiveRepositoryEmitter.fire(repository);
	}

	private scheduleStateChange(): void {
		if (this.stateChangeTimer) {
			clearTimeout(this.stateChangeTimer);
		}
		this.stateChangeTimer = setTimeout(() => {
			this.stateChangeTimer = undefined;
			this.onDidChangeRepositoryStateEmitter.fire();
		}, STATE_CHANGE_DEBOUNCE_MS);
	}

	private updateContextKey(): Thenable<unknown> {
		return vscode.commands.executeCommand('setContext', 'commitizen.hasRepository', this.hasRepository);
	}

	private disposeRepoSubscriptions(): void {
		for (const disposable of this.repoDisposables) {
			disposable.dispose();
		}
		this.repoDisposables = [];
	}

	dispose(): void {
		if (this.stateChangeTimer) {
			clearTimeout(this.stateChangeTimer);
		}
		this.disposeRepoSubscriptions();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.onDidChangeActiveRepositoryEmitter.dispose();
		this.onDidChangeRepositoryStateEmitter.dispose();
	}
}
