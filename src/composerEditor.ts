import * as vscode from 'vscode';
import { Composer } from './composer';
import { ComposerHost } from './panel';

/**
 * The composer as a full editor tab.
 *
 * The panel's home is a view inside VS Code's *built-in* Source Control container,
 * which hands its sections a share of the sidebar and gives extensions no way to
 * ask for more: `contributes.views` `initialSize` is ignored outright for a view
 * whose container belongs to someone else, and `WebviewView` has no sizing API at
 * all. A dozen type cards, five fields and a preview want more room than that, so
 * the extra height comes from a different surface rather than a setting.
 *
 * Shares the {@link Composer} with the sidebar view, so the two stay in step
 * without either knowing the other exists.
 */
export class ComposerEditor implements vscode.Disposable {
	/** Must match the `activeWebviewPanelId` used by the `editor/title` menus. */
	static readonly viewType = 'conventionalCommitPanel.editor';

	private panel: vscode.WebviewPanel | undefined;
	private host: ComposerHost | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly composer: Composer,
	) {}

	/** Opens the tab, or brings the existing one forward. Never opens a second. */
	show(): void {
		if (this.panel) {
			this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			ComposerEditor.viewType,
			'Conventional Commit',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				// Holds a half-written message, same reason as the sidebar view.
				retainContextWhenHidden: true,
				// This is a form, not a document: Ctrl+F belongs to whichever field
				// has focus, not to a find bar over the whole panel.
				enableFindWidget: false,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
			},
		);

		this.panel = panel;
		this.host = new ComposerHost(this.extensionUri, this.composer, panel.webview, (state) => {
			// A WebviewPanel has no description slot, so the branch the sidebar puts
			// beside its title goes into the tab title instead.
			panel.title = state.branch ? `Conventional Commit — ${state.branch}` : 'Conventional Commit';
		});

		panel.onDidChangeViewState((event) => {
			if (event.webviewPanel.visible) {
				this.composer.recheckSync();
			}
		});

		panel.onDidDispose(() => {
			this.host?.dispose();
			this.host = undefined;
			this.panel = undefined;
		});

		void this.composer.refresh();
	}

	dispose(): void {
		// Disposing the panel fires onDidDispose, which clears the host and refs.
		this.panel?.dispose();
	}
}
