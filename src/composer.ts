import * as vscode from 'vscode';
import { BUILT_IN_CONFIG, CommitConfig } from './config';
import { ConfigService } from './configLoader';
import { branchScopeCandidates, BranchScopeOptions } from './branch';
import {
	DraftProblem,
	FormatOptions,
	isDraftComplete,
	renderCommitMessage,
	renderHeader,
	SemverImpact,
	semverImpact,
	validateDraft,
} from './format';
import { CommitDraft, DraftStore } from './model';
import { GitService } from './git';

/**
 * Compares two commit messages for the purpose of "did we write this?".
 *
 * Trailing whitespace differences do not count as a hand edit: the box can pick
 * up a stray newline, and nagging about that would make the warning noise rather
 * than signal.
 */
function isSameMessage(a: string, b: string | undefined): boolean {
	return b !== undefined && a.trimEnd() === b.trimEnd();
}

/**
 * Coordinates the draft, the repository and the resolved config, and owns the
 * one piece of shared state everything else reads: the rendered message and
 * whether it currently matches the Source Control input box.
 */
export class Composer implements vscode.Disposable {
	private config: CommitConfig = BUILT_IN_CONFIG;
	private tooling: string[] = [];
	private outOfSync = false;

	private readonly disposables: vscode.Disposable[] = [];
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(
		private readonly git: GitService,
		private readonly configService: ConfigService,
		private readonly drafts: DraftStore,
	) {
		this.disposables.push(
			this.git.onDidChangeActiveRepository(() => void this.refresh()),
			this.git.onDidChangeRepositoryState(() => void this.refresh()),
			this.configService.onDidChange(() => void this.refresh()),
			this.drafts.onDidChange((key) => {
				if (key === this.repositoryKey) {
					this.afterDraftChange();
				}
			}),
		);
	}

	get repositoryKey(): string | undefined {
		return this.git.activeRepositoryKey;
	}

	get currentConfig(): CommitConfig {
		return this.config;
	}

	get branchName(): string | undefined {
		return this.git.branchName;
	}

	get isOutOfSync(): boolean {
		return this.outOfSync;
	}

	get liveSyncEnabled(): boolean {
		return this.configService.setting<boolean>('liveSync', true);
	}

	get draft(): CommitDraft {
		const key = this.repositoryKey;
		return key ? this.drafts.get(key) : {};
	}

	get formatOptions(): FormatOptions {
		return this.configService.getFormatOptions(this.config, this.draft);
	}

	update(patch: Partial<CommitDraft>): void {
		const key = this.repositoryKey;
		if (key) {
			this.drafts.update(key, patch);
		}
	}

	/**
	 * Updates a specific repository's draft. Used by long-lived flows such as the
	 * body editor tab, where the active repository may have changed in the
	 * meantime and writing to "current" would land in the wrong draft.
	 */
	updateFor(key: string, patch: Partial<CommitDraft>): void {
		this.drafts.update(key, patch);
	}

	reset(): void {
		const key = this.repositoryKey;
		if (!key) {
			return;
		}

		this.drafts.reset(key);

		// Reset means a clean slate, so it takes the commit box with it.
		//
		// It used to leave the box alone whenever it held text the panel had not
		// written, which meant resetting while out of sync cleared the draft, left
		// the foreign text in place, and then immediately re-raised the very
		// out-of-sync warning the user was trying to get rid of.
		this.git.setCommitMessage('');
		this.drafts.setLastWritten(key, '');
		this.outOfSync = false;
		void this.refresh();
	}

	/**
	 * Re-evaluates whether the commit box still matches the draft.
	 *
	 * Extensions cannot observe edits to the Source Control input box — the Git
	 * API exposes `value` with no change event — so an out-of-sync warning can go
	 * stale after the user clears or fixes the box by hand. Re-running the check
	 * when the panel becomes visible means switching away and back settles it,
	 * instead of the warning lingering until the next unrelated event.
	 */
	recheckSync(): void {
		this.syncToInputBox();
		this.onDidChangeEmitter.fire();
	}

	renderMessage(): string {
		return renderCommitMessage(this.draft, this.formatOptions);
	}

	renderHeaderLine(): string {
		return renderHeader(this.draft, this.formatOptions);
	}

	/** Commit tooling detected in the repository, e.g. `['husky', 'commitlint']`. */
	get detectedTooling(): string[] {
		return this.tooling;
	}

	get stagedCount(): number {
		return this.git.stagedCount;
	}

	get changedCount(): number {
		return this.git.changedCount;
	}

	get semver(): SemverImpact {
		return semverImpact(this.draft);
	}

	get scopeRequired(): boolean {
		return this.configService.setting<boolean>('scope.required', false);
	}

	get showBreakingChange(): boolean {
		return this.configService.setting<boolean>('showBreakingChange', true);
	}

	get showCustomType(): boolean {
		return this.configService.setting<boolean>('showCustomType', true);
	}

	/**
	 * True when the Custom card is the selected one: either explicitly chosen, or
	 * implied by a type that is not on the offered list (a restored draft, or a
	 * type the repo config stopped offering).
	 */
	get isCustomType(): boolean {
		const draft = this.draft;
		if (draft.customTypeActive) {
			return true;
		}
		return Boolean(draft.type) && !this.config.types.some((type) => type.value === draft.type);
	}

	/** Switches to the custom card, keeping a custom value that is already there. */
	activateCustomType(): void {
		const keepValue = this.isCustomType;
		this.update({ customTypeActive: true, ...(keepValue ? {} : { type: undefined }) });
	}

	/**
	 * Chooses one of the offered types, which also leaves custom mode.
	 *
	 * Separate from {@link setCustomType} so the custom text field can update the
	 * type without the card de-selecting itself on every keystroke.
	 */
	setType(value: string): void {
		this.update({ type: value, customTypeActive: undefined });
	}

	/** Updates the hand-typed type, staying in custom mode. */
	setCustomType(value: string): void {
		this.update({ type: value || undefined, customTypeActive: true });
	}

	/** Rule violations in the current draft, worst first. */
	get problems(): DraftProblem[] {
		return validateDraft(this.draft, this.formatOptions, {
			headerMaxLength: this.formatOptions.headerMaxLength,
			types: this.config.types.map((type) => type.value),
			scopes: this.config.scopes,
			allowCustomScopes: this.config.allowCustomScopes,
			scopeRequired: this.scopeRequired,
			customTypeActive: this.isCustomType,
		});
	}

	/** True when the draft is complete and has something staged to record. */
	get canCommit(): boolean {
		return (
			isDraftComplete(this.draft) &&
			this.stagedCount > 0 &&
			!this.problems.some((problem) => problem.severity === 'error')
		);
	}

	/**
	 * Creates the commit from the current draft and clears it on success.
	 *
	 * Only ever called from an explicit press of the panel's Commit button. Errors
	 * from git — a failing husky hook, a rejected commitlint check, missing user
	 * config — are surfaced verbatim, because that text is the actionable part.
	 */
	async commit(options?: { all?: boolean; amend?: boolean }): Promise<boolean> {
		const message = this.renderMessage();
		if (!message.trim()) {
			void vscode.window.showWarningMessage('Conventional Commit Panel: nothing to commit — the message is empty.');
			return false;
		}

		// Captured before the draft is cleared below.
		const scope = (this.draft.scope ?? '').trim();

		try {
			await this.git.commit(message, options);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Commit failed: ${detail}`);
			return false;
		}

		// The only place a scope becomes "recent". Recording it while typing meant
		// every abandoned keystroke became a permanent suggestion chip.
		if (scope) {
			this.drafts.rememberScope(scope);
		}

		const key = this.repositoryKey;
		if (key) {
			this.drafts.reset(key);
			this.drafts.setLastWritten(key, '');
		}
		this.outOfSync = false;
		await this.refresh();
		return true;
	}

	async push(): Promise<void> {
		try {
			await this.git.push();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Push failed: ${detail}`);
		}
	}

	rememberScope(scope: string): void {
		this.drafts.rememberScope(scope);
	}

	getRecentScopes(): string[] {
		return this.drafts.getRecentScopes();
	}

	/** Empties the recent scope suggestions and refreshes the panel. */
	clearRecentScopes(): void {
		this.drafts.clearRecentScopes();
		this.onDidChangeEmitter.fire();
	}

	/** Scope candidates derived from the current branch name. */
	branchScopes(): string[] {
		return branchScopeCandidates(this.git.branchName, this.branchScopeOptions());
	}

	private branchScopeOptions(): BranchScopeOptions {
		return {
			ticketPattern: this.configService.setting<string>('scope.ticketPattern', '([A-Z][A-Z0-9]+-\\d+)'),
			branchPrefixes: this.configService.setting<string[]>('scope.branchPrefixes', []),
			ignoreBranches: this.configService.setting<string[]>('scope.ignoreBranches', []),
		};
	}

	/** Reloads config, re-derives the branch scope, and re-syncs the input box. */
	async refresh(): Promise<void> {
		const root = this.git.activeRepository?.rootUri;
		this.config = await this.configService.getConfig(root);
		this.tooling = await this.configService.detectTooling(root);
		this.applyBranchScope();
		this.syncToInputBox();
		this.onDidChangeEmitter.fire();
	}

	/**
	 * Keeps the scope in step with the branch, but only while the user has not
	 * taken it over — a scope they typed themselves must survive a branch switch.
	 */
	private applyBranchScope(): void {
		const key = this.repositoryKey;
		if (!key) {
			return;
		}

		const draft = this.drafts.get(key);
		if (draft.scopeSource && draft.scopeSource !== 'branch') {
			return;
		}

		const suggested = this.branchScopes()[0];
		if (suggested === draft.scope) {
			return;
		}

		if (suggested) {
			this.drafts.update(key, { scope: suggested, scopeSource: 'branch' });
		} else if (draft.scopeSource === 'branch') {
			// The new branch offers nothing; drop the stale suggestion.
			this.drafts.update(key, { scope: undefined, scopeSource: undefined });
		}
	}

	private afterDraftChange(): void {
		this.syncToInputBox();
		this.onDidChangeEmitter.fire();
	}

	/**
	 * Writes the rendered message into the Source Control box.
	 *
	 * Refuses to overwrite anything the user typed by hand: we only write when the
	 * box is empty or still holds exactly what we last put there. Otherwise the
	 * panel flags itself out of sync and waits for an explicit Apply.
	 */
	private syncToInputBox(): void {
		const key = this.repositoryKey;
		if (!key || !this.git.activeRepository) {
			return;
		}

		const rendered = this.renderMessage();
		const current = this.git.getCommitMessage();

		if (isSameMessage(current, rendered)) {
			this.drafts.setLastWritten(key, rendered);
			this.outOfSync = false;
			return;
		}

		if (!this.liveSyncEnabled) {
			this.outOfSync = current.trim().length > 0;
			return;
		}

		const previous = this.drafts.getLastWritten(key);
		if (current.trim() === '' || isSameMessage(current, previous)) {
			this.git.setCommitMessage(rendered);
			this.drafts.setLastWritten(key, rendered);
			this.outOfSync = false;
			return;
		}

		this.outOfSync = true;
	}

	/** Explicit user action: overwrite the box regardless of what is in it. */
	applyToInputBox(): void {
		const key = this.repositoryKey;
		if (!key || !this.git.activeRepository) {
			return;
		}

		const rendered = this.renderMessage();
		this.git.setCommitMessage(rendered);
		this.drafts.setLastWritten(key, rendered);
		this.outOfSync = false;
		this.onDidChangeEmitter.fire();
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.onDidChangeEmitter.dispose();
	}
}
