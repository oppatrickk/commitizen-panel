import * as vscode from 'vscode';
import { BUILT_IN_CONFIG, CommitConfig, resolveDefaultType } from './config';
import { ConfigService } from './configLoader';
import { branchScopeCandidates, BranchScopeOptions, DEFAULT_BRANCH_SCOPE_OPTIONS } from './branch';
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
import { choosePublishRemote, isNoUpstreamBranch } from './publish';

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

		// After the box is cleared, not before: seeding first runs a sync against
		// the message still sitting in the box and reports the draft out of sync
		// with text the user just asked to throw away.
		this.applyDefaultType();
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

	/**
	 * The message the panel is willing to put anywhere outside itself.
	 *
	 * A header with no subject is not a commit message, it is a prefix. With a type
	 * pre-selected and {@link applyBranchScope} filling the scope in, letting it
	 * through would mean that merely opening the Source Control view stamped
	 * `feat(PROJ-123): ` into a commit box the user had deliberately left empty.
	 *
	 * The rule is deliberately about the subject rather than about which type was
	 * seeded, so it reads as one sentence — the box holds a whole message or
	 * nothing — and so deleting the subject empties the box again instead of
	 * stranding a bare prefix there.
	 */
	private composedMessage(): string {
		return (this.draft.subject ?? '').trim() ? this.renderMessage() : '';
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
		// Deliberately the guarded message, not the rendered one: with a type
		// pre-selected the raw render is never empty, so committing straight from
		// the command palette would otherwise record a subject-less `feat: `.
		const message = this.composedMessage();
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
			await this.withPushProgress('Pushing…', () => this.git.push());
		} catch (error) {
			if (isNoUpstreamBranch(error)) {
				await this.offerToPublish();
				return;
			}

			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Push failed: ${detail}`);
		}
	}

	/**
	 * Offers to set an upstream, and pushes again only if the button is pressed.
	 *
	 * Reached by catching the failure rather than by checking `HEAD.upstream` up
	 * front: that state comes from the Git extension's last `git status` and goes
	 * stale when someone sets a remote in a terminal, and anyone running with
	 * `push.autoSetupRemote` has pushes that succeed with no upstream — a pre-check
	 * would interrupt them for nothing. Nothing has reached the network at this
	 * point either way; git refuses a push with no refspec locally.
	 */
	private async offerToPublish(): Promise<void> {
		const branch = this.git.branchName;
		if (!branch) {
			// Detached or unborn HEAD: there is no branch to publish.
			void vscode.window.showErrorMessage('Push failed: no branch is checked out.');
			return;
		}

		const choice = choosePublishRemote(this.git.remotes);

		if (choice.kind === 'none') {
			const addRemote = 'Add Remote';
			const picked = await vscode.window.showWarningMessage(
				`"${branch}" cannot be published: this repository has no remote.`,
				addRemote,
			);
			if (picked === addRemote) {
				await vscode.commands.executeCommand('git.addRemote');
			}
			return;
		}

		const publish = 'Publish Branch';
		const confirmed = await vscode.window.showInformationMessage(
			`"${branch}" has no upstream branch.`,
			publish,
		);
		if (confirmed !== publish) {
			return;
		}

		let remote: string;
		if (choice.kind === 'remote') {
			remote = choice.name;
		} else {
			const picked = await vscode.window.showQuickPick(choice.names, {
				title: 'Publish branch',
				placeHolder: `Which remote should "${branch}" be published to?`,
			});
			if (!picked) {
				return;
			}
			remote = picked;
		}

		try {
			await this.withPushProgress(`Publishing ${branch} to ${remote}…`, () =>
				this.git.push({ remote, branch, setUpstream: true }),
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Publishing "${branch}" failed: ${detail}`);
		}
	}

	/**
	 * Shows push progress in the status bar rather than on the Source Control view,
	 * because the composer can also be open as an editor tab, where a spinner in
	 * the sidebar is not necessarily visible.
	 */
	private withPushProgress<T>(title: string, task: () => Thenable<T>): Thenable<T> {
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task);
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

	/**
	 * Scope candidates used to pre-fill the field, honouring `ignoreBranches`.
	 *
	 * The ignore list exists because a long-lived branch name is not a scope:
	 * `feat(main): …` says nothing about which area changed, and once committed it
	 * is in the history for good.
	 */
	branchScopes(): string[] {
		return branchScopeCandidates(this.git.branchName, this.branchScopeOptions());
	}

	/**
	 * Scope candidates offered as chips, which is every branch including the
	 * ignored ones.
	 *
	 * Auto-filling and offering are different things, and conflating them meant
	 * that on `main` the branch was not merely un-filled, it was unreachable. Now
	 * it is always one click away — it just never lands in a commit by itself.
	 */
	branchScopeSuggestions(): string[] {
		return branchScopeCandidates(this.git.branchName, {
			...this.branchScopeOptions(),
			ignoreBranches: [],
		});
	}

	/**
	 * Falls back to the real defaults, not to empty lists.
	 *
	 * `[]` fails open: an empty ignore list means "suggest a scope on every
	 * branch", so if a setting ever failed to resolve — a stale install whose
	 * manifest declares different keys than the code asks for, say — the panel
	 * would start suggesting `main`. An empty list is a meaningful user choice and
	 * should not double as "value missing".
	 */
	private branchScopeOptions(): BranchScopeOptions {
		return {
			ticketPattern: this.configService.setting<string>(
				'scope.ticketPattern',
				DEFAULT_BRANCH_SCOPE_OPTIONS.ticketPattern,
			),
			branchPrefixes: this.configService.setting<string[]>(
				'scope.branchPrefixes',
				DEFAULT_BRANCH_SCOPE_OPTIONS.branchPrefixes,
			),
			ignoreBranches: this.configService.setting<string[]>(
				'scope.ignoreBranches',
				DEFAULT_BRANCH_SCOPE_OPTIONS.ignoreBranches,
			),
		};
	}

	/** Reloads config, re-derives the branch scope, and re-syncs the input box. */
	async refresh(): Promise<void> {
		const root = this.git.activeRepository?.rootUri;
		this.config = await this.configService.getConfig(root);
		this.tooling = await this.configService.detectTooling(root);
		this.applyDefaultType();
		this.applyBranchScope();
		this.syncToInputBox();
		this.onDidChangeEmitter.fire();
	}

	/**
	 * Pre-selects a type on a draft that has none.
	 *
	 * Only ever fills a gap. A type already chosen — and Custom mode with nothing
	 * typed into it yet — are both left alone, because this runs on every refresh
	 * and re-asserting the default would overwrite the user's choice a couple of
	 * hundred milliseconds after every file save.
	 */
	private applyDefaultType(): void {
		const key = this.repositoryKey;
		if (!key) {
			return;
		}

		const draft = this.drafts.get(key);
		if (draft.type !== undefined || draft.customTypeActive) {
			return;
		}

		const value = resolveDefaultType(
			this.configService.setting<string>('defaultType', 'feat'),
			this.config.types,
		);
		if (value) {
			this.drafts.update(key, { type: value });
		}
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

		const rendered = this.composedMessage();
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

		const rendered = this.composedMessage();
		if (!rendered) {
			// Apply on a draft with no subject would otherwise wipe the box, which
			// is the one thing an explicit Apply should never do.
			return;
		}

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
