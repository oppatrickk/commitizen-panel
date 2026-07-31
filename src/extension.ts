import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { Composer } from './composer';
import { ConfigService } from './configLoader';
import { GitService } from './git';
import { DraftStore } from './model';
import { ComposerViewProvider } from './panel';

export const VIEW_ID = ComposerViewProvider.viewType;

/** Exposed to integration tests so they can drive the real objects. */
export interface CommitizenApi {
	composer: Composer;
	git: GitService;
	drafts: DraftStore;
}

export async function activate(context: vscode.ExtensionContext): Promise<CommitizenApi> {
	const git = await GitService.create();
	const configService = new ConfigService();
	const drafts = new DraftStore(context.workspaceState);
	const composer = new Composer(git, configService, drafts);
	const provider = new ComposerViewProvider(context.extensionUri, composer);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ComposerViewProvider.viewType, provider, {
			// The panel holds a half-written message; rebuilding it on every collapse
			// would throw away caret position and scroll.
			webviewOptions: { retainContextWhenHidden: true },
		}),
		provider,
		composer,
		drafts,
		configService,
		git,
		...registerCommands(context, composer),
	);

	// Populate the panel from whatever repository is already open.
	await composer.refresh();

	return { composer, git, drafts };
}

export function deactivate(): void {
	// Everything is registered through context.subscriptions.
}
