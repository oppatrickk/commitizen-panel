import * as vscode from 'vscode';
import { Composer } from './composer';
import type { DraftProblem, SemverImpact } from './format';
import type { ScopeSource } from './model';

/** Shape pushed to the webview on every state change. */
export interface PanelState {
	branch?: string;
	/** `badge` is the emoji when the type has one, else its initial. */
	types: Array<{ value: string; label: string; short: string; badge: string; isEmoji: boolean }>;
	draft: {
		type?: string;
		scope?: string;
		subject?: string;
		body?: string;
		isBreaking: boolean;
		breakingDescription?: string;
	};
	scopeChips: Array<{ value: string; source: ScopeSource }>;
	headerLength: number;
	headerMax: number;
	preview: string;
	problems: DraftProblem[];
	validationLabel: string;
	validationOk: boolean;
	semver: SemverImpact;
	stagedCount: number;
	changedCount: number;
	canCommit: boolean;
	tooling: string[];
	specLabel: string;
	scopeRequired: boolean;
	showBreakingChange: boolean;
	showCustomType: boolean;
	/** True when the custom card is the selected one. */
	isCustomType: boolean;
	/** The hand-typed type, so the custom field can show it. */
	customType: string;
	/** True when this push echoes the webview's own edit, so it must not stomp inputs. */
	echo: boolean;
}

type InboundMessage =
	| { type: 'ready' }
	| { type: 'setType'; value: string }
	| { type: 'selectCustomType' }
	| { type: 'setCustomType'; value: string }
	| { type: 'setScope'; value: string }
	| { type: 'setSubject'; value: string }
	| { type: 'setBody'; value: string }
	| { type: 'setBreaking'; value: boolean }
	| { type: 'setBreakingDescription'; value: string }
	| { type: 'commit' }
	| { type: 'commitOptions' }
	| { type: 'copy' }
	| { type: 'reset' };

/**
 * The composer UI, driving one webview.
 *
 * A webview rather than a TreeView: the design needs a type grid, inline text
 * fields, a live preview and a Commit button, none of which a TreeItem can render.
 *
 * Deliberately does not reproduce the file lists — the built-in Source Control
 * `Changes` section sits directly below and already does that job.
 *
 * Knows nothing about what its webview is mounted in, so the Source Control view
 * and the editor tab share one message handler, one state builder and one HTML
 * template. Both subscribe to the same {@link Composer}, which is what makes an
 * edit in either surface show up in the other.
 */
export class ComposerHost implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	/** Set while applying a webview edit, so the echoed state leaves inputs alone. */
	private applyingWebviewEdit = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly composer: Composer,
		private readonly webview: vscode.Webview,
		/** Lets each container do what it can with the state, e.g. show the branch. */
		private readonly onState: (state: PanelState) => void = () => {},
	) {
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		webview.html = this.render(webview);

		this.disposables.push(
			webview.onDidReceiveMessage((message: InboundMessage) => void this.handle(message)),
			this.composer.onDidChange(() => this.postState()),
		);
	}

	private async handle(message: InboundMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.postState();
				return;

			case 'setType':
				return this.edit(() => this.composer.setType(message.value));

			case 'selectCustomType':
				return this.edit(() => this.composer.activateCustomType());

			case 'setCustomType':
				return this.edit(() => this.composer.setCustomType(message.value.trim()));

			case 'setScope': {
				const scope = message.value.trim();
				// Deliberately does not record the scope as "recent": this fires on
				// every debounced keystroke, so it used to bank every half-typed
				// prefix ("a", "ap", "api") as a permanent suggestion. A scope only
				// counts as used once it has actually been committed with.
				return this.edit(() => {
					// Typing a scope by hand takes it out of the branch's control, so a
					// later branch switch will not overwrite the choice.
					this.composer.update({ scope, scopeSource: 'custom' });
				});
			}

			case 'setSubject':
				return this.edit(() => this.composer.update({ subject: message.value }));

			case 'setBody':
				return this.edit(() => this.composer.update({ body: message.value }));

			case 'setBreaking':
				return this.edit(() =>
					this.composer.update({
						isBreaking: message.value ? true : undefined,
						...(message.value ? {} : { breakingDescription: undefined }),
					}),
				);

			case 'setBreakingDescription':
				return this.edit(() =>
					this.composer.update({ breakingDescription: message.value.trim() || undefined }),
				);

			case 'commit':
				await this.composer.commit();
				return;

			case 'commitOptions':
				await this.showCommitOptions();
				return;

			case 'copy':
				await vscode.env.clipboard.writeText(this.composer.renderMessage());
				void vscode.window.setStatusBarMessage('Commit message copied', 2000);
				return;

			case 'reset':
				this.composer.reset();
				return;
		}
	}

	/** Runs a webview-originated edit, flagging the resulting state as an echo. */
	private async edit(mutate: () => void): Promise<void> {
		this.applyingWebviewEdit = true;
		try {
			mutate();
		} finally {
			this.applyingWebviewEdit = false;
		}
	}

	private async showCommitOptions(): Promise<void> {
		const options = [
			{ label: '$(check) Commit', detail: 'Commit the staged changes', action: 'commit' as const },
			{
				label: '$(arrow-up) Commit & Push',
				detail: 'Commit, then push to the upstream branch',
				action: 'push' as const,
			},
			{
				label: '$(add) Stage all & Commit',
				detail: 'Stage every tracked change, then commit',
				action: 'all' as const,
			},
			{
				label: '$(pencil) Commit (amend)',
				detail: 'Replace the previous commit with this message',
				action: 'amend' as const,
			},
		];

		const picked = await vscode.window.showQuickPick(options, {
			title: 'Commit options',
			placeHolder: 'How should this commit be created?',
		});

		if (!picked) {
			return;
		}

		switch (picked.action) {
			case 'commit':
				await this.composer.commit();
				return;
			case 'all':
				await this.composer.commit({ all: true });
				return;
			case 'amend':
				await this.composer.commit({ amend: true });
				return;
			case 'push':
				if (await this.composer.commit()) {
					await this.composer.push();
				}
				return;
		}
	}

	private postState(): void {
		const state = this.buildState();
		this.onState(state);
		void this.webview.postMessage({ type: 'state', state });
	}

	private buildState(): PanelState {
		const draft = this.composer.draft;
		const config = this.composer.currentConfig;
		const problems = this.composer.problems;
		const errors = problems.filter((problem) => problem.severity === 'error');
		const usesCommitlint = this.composer.detectedTooling.includes('commitlint');
		const isCustom = this.composer.isCustomType;
		// A custom type outside the repo's list is no longer reported as a problem,
		// so the panel must not turn around and claim commitlint would pass either.
		const typeIsListed = !draft.type || config.types.some((type) => type.value === draft.type);

		return {
			...(this.composer.branchName ? { branch: this.composer.branchName } : {}),
			types: config.types.map((type) => ({
				value: type.value,
				label: type.name ?? type.value,
				short: type.short ?? type.description ?? '',
				// The emoji is the icon; the initial is only a fallback for custom
				// types from a repo config that carry no emoji of their own.
				badge: type.emoji ?? type.value.charAt(0).toUpperCase(),
				isEmoji: Boolean(type.emoji),
			})),
			draft: {
				...(draft.type ? { type: draft.type } : {}),
				...(draft.scope !== undefined ? { scope: draft.scope } : {}),
				...(draft.subject ? { subject: draft.subject } : {}),
				...(draft.body ? { body: draft.body } : {}),
				isBreaking: Boolean(draft.isBreaking),
				...(draft.breakingDescription ? { breakingDescription: draft.breakingDescription } : {}),
			},
			scopeChips: this.buildScopeChips(),
			headerLength: this.composer.renderHeaderLine().length,
			headerMax: this.composer.formatOptions.headerMaxLength,
			preview: this.composer.renderMessage(),
			problems,
			// Only claim commitlint when the repo actually has it; otherwise the
			// check is against the Conventional Commits shape and says so.
			validationLabel: errors.length
				? errors[0].message
				: problems.length
					? problems[0].message
					: usesCommitlint && typeIsListed
						? 'Passes commitlint rules.'
						: 'Valid Conventional Commit.',
			validationOk: problems.length === 0,
			semver: this.composer.semver,
			stagedCount: this.composer.stagedCount,
			changedCount: this.composer.changedCount,
			canCommit: this.composer.canCommit,
			tooling: this.composer.detectedTooling,
			specLabel: this.specLabel(config.source),
			scopeRequired: this.composer.scopeRequired,
			showBreakingChange: this.composer.showBreakingChange,
			showCustomType: this.composer.showCustomType,
			isCustomType: isCustom,
			customType: isCustom ? (draft.type ?? '') : '',
			echo: this.applyingWebviewEdit,
		};
	}

	private specLabel(source: string): string {
		switch (source) {
			case 'cz-config':
				return 'cz-customizable';
			case 'czrc':
				return '.czrc';
			case 'commitlint':
				return 'commitlint';
			case 'settings':
				return 'user settings';
			default:
				return 'conventional-commits v1.0';
		}
	}

	private buildScopeChips(): Array<{ value: string; source: ScopeSource }> {
		const chips: Array<{ value: string; source: ScopeSource }> = [];
		const seen = new Set<string>();

		const add = (value: string, source: ScopeSource) => {
			if (!value || seen.has(value)) {
				return;
			}
			seen.add(value);
			chips.push({ value, source });
		};

		for (const scope of this.composer.branchScopeSuggestions()) {
			add(scope, 'branch');
		}
		for (const scope of this.composer.currentConfig.scopes) {
			add(scope, 'config');
		}
		for (const scope of this.composer.getRecentScopes()) {
			add(scope, 'recent');
		}

		return chips.slice(0, 12);
	}

	private render(webview: vscode.Webview): string {
		const nonce = createNonce();
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
		const codiconUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css'),
		);
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
			`font-src ${webview.cspSource}`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codiconUri}" rel="stylesheet">
	<link href="${styleUri}" rel="stylesheet">
	<title>Conventional Commit Panel</title>
</head>
<body>
	<div id="empty" class="empty" hidden>Open a Git repository to compose a commit message.</div>

	<div id="composer" class="composer">
		<section class="field">
			<div class="field-head">
				<span class="field-label">Type</span>
				<span class="field-hint" id="type-hint"></span>
			</div>
			<div class="type-grid" id="type-grid" role="radiogroup" aria-label="Commit type"></div>
		</section>

		<section class="field">
			<div class="field-head">
				<span class="field-label">Scope</span>
				<span class="field-hint" id="scope-hint">optional</span>
			</div>
			<div class="input-wrap">
				<input id="scope" class="text-input" type="text" autocomplete="off" spellcheck="false"
					placeholder="area of the codebase" aria-label="Commit scope">
				<button type="button" class="clear-button" data-clears="scope"
					aria-label="Clear scope" title="Clear" hidden>&times;</button>
			</div>
			<div class="chips" id="scope-chips"></div>
		</section>

		<section class="field">
			<div class="field-head">
				<span class="field-label">Subject</span>
				<span class="counter" id="counter"></span>
			</div>
			<div class="input-wrap">
				<textarea id="subject" class="text-input area" rows="2" spellcheck="false"
					placeholder="short, imperative description" aria-label="Commit subject"></textarea>
				<button type="button" class="clear-button top" data-clears="subject"
					aria-label="Clear subject" title="Clear" hidden>&times;</button>
			</div>
			<div class="meter"><div class="meter-fill" id="meter-fill"></div></div>
			<div class="validation" id="validation"></div>
		</section>

		<section class="field">
			<div class="field-head">
				<span class="field-label">Body</span>
				<span class="field-hint">optional &middot; why, not what</span>
			</div>
			<div class="input-wrap">
				<textarea id="body" class="text-input area body" rows="3"
					placeholder="Context, trade-offs, links to issues&hellip;" aria-label="Commit body"></textarea>
				<button type="button" class="clear-button top" data-clears="body"
					aria-label="Clear body" title="Clear" hidden>&times;</button>
			</div>
		</section>

		<section class="toggle-row" id="breaking-row"
			title="Marks the commit as breaking API compatibility: adds a ! after the scope and a BREAKING CHANGE: footer, which release tooling reads as a major version bump.">
			<label class="switch">
				<input type="checkbox" id="breaking" aria-label="Breaking change">
				<span class="switch-track"><span class="switch-thumb"></span></span>
				<span class="switch-label">Breaking change</span>
			</label>
			<span class="semver" id="semver"></span>
		</section>

		<section class="field breaking-detail" id="breaking-detail" hidden>
			<div class="input-wrap">
				<input id="breaking-description" class="text-input" type="text" autocomplete="off"
					placeholder="What breaks, and what to do about it" aria-label="Breaking change description">
				<button type="button" class="clear-button" data-clears="breaking-description"
					aria-label="Clear breaking change description" title="Clear" hidden>&times;</button>
			</div>
		</section>

		<section class="preview">
			<div class="preview-head">
				<span class="field-label">Preview</span>
				<span class="preview-meta">
					<span id="spec-label"></span>
					<button type="button" class="link-button" id="copy">copy</button>
				</span>
			</div>
			<pre class="preview-body" id="preview"></pre>
		</section>
	</div>

	<footer class="footer" id="footer">
		<div class="footer-meta">
			<span class="staged-status" id="staged"></span>
			<span class="tooling" id="tooling"></span>
		</div>
		<div class="commit-row">
			<button type="button" class="commit-button" id="commit">Commit</button>
			<button type="button" class="commit-caret" id="commit-options" aria-label="Commit options">
				<span class="codicon codicon-chevron-down" aria-hidden="true"></span>
			</button>
		</div>
	</footer>

	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}

/**
 * The `CONVENTIONAL COMMIT` section in the Source Control view.
 *
 * Owns only the container concerns — when to re-check sync, where the branch name
 * goes — and hands the webview itself to a {@link ComposerHost}.
 */
export class ComposerViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'conventionalCommitPanel.composer';

	private host: ComposerHost | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly composer: Composer,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		// A re-resolve replaces the webview, so the old host's subscriptions would
		// otherwise stack up and post to a webview that no longer exists.
		this.host?.dispose();
		this.host = new ComposerHost(this.extensionUri, this.composer, view.webview, (state) => {
			view.description = state.branch;
		});

		this.disposables.push(
			view.onDidChangeVisibility(() => {
				if (view.visible) {
					// Re-checks the commit box as well as re-posting, so a stale
					// out-of-sync warning clears itself on the way back in.
					this.composer.recheckSync();
				}
			}),
			view.onDidDispose(() => {
				this.host?.dispose();
				this.host = undefined;
			}),
		);

		void this.composer.refresh();
	}

	dispose(): void {
		this.host?.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}

function createNonce(): string {
	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let index = 0; index < 32; index += 1) {
		nonce += characters.charAt(Math.floor(Math.random() * characters.length));
	}
	return nonce;
}
