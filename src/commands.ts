import * as vscode from 'vscode';
import { Composer } from './composer';
import {
	activeScopeItem,
	applyScopeChoice,
	buildScopeItems,
	buildTypeItems,
	subjectPrompt,
	subjectValidator,
} from './pickers';
import type { FieldKey } from './model';
import { runWizard } from './wizard';

/** The scratch file name; VS Code maps it to the `git-commit` language. */
const BODY_FILE_NAME = 'COMMIT_EDITMSG';

/**
 * Registers every user-facing command. Each field editor writes straight into the
 * draft, which the composer picks up and mirrors into the Source Control box.
 */
export function registerCommands(
	context: vscode.ExtensionContext,
	composer: Composer,
): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('conventionalCommitPanel.edit', (key: FieldKey) => editField(context, composer, key)),
		vscode.commands.registerCommand('conventionalCommitPanel.editBodyInEditor', () => editBodyInEditor(context, composer)),
		vscode.commands.registerCommand('conventionalCommitPanel.wizard', () => runWizard(composer)),
		vscode.commands.registerCommand('conventionalCommitPanel.apply', () => composer.applyToInputBox()),
		vscode.commands.registerCommand('conventionalCommitPanel.reset', () => composer.reset()),
		vscode.commands.registerCommand('conventionalCommitPanel.commit', () => composer.commit()),
		vscode.commands.registerCommand('conventionalCommitPanel.clearRecentScopes', () => {
			composer.clearRecentScopes();
			void vscode.window.setStatusBarMessage('Recent scope suggestions cleared', 2000);
		}),
		vscode.commands.registerCommand('conventionalCommitPanel.openSettings', () =>
			// Derived rather than hardcoded: the publisher is a placeholder until
			// release, and a stale literal here would silently open an empty
			// settings filter.
			vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
		),
	];
}

async function editField(
	context: vscode.ExtensionContext,
	composer: Composer,
	key: FieldKey,
): Promise<void> {
	switch (key) {
		case 'type':
			return editType(composer);
		case 'scope':
			return editScope(composer);
		case 'subject':
			return editSubject(composer);
		case 'body':
			return editBody(context, composer);
		case 'breaking':
			return editBreaking(composer);
	}
}

async function editType(composer: Composer): Promise<void> {
	const picked = await vscode.window.showQuickPick(buildTypeItems(composer), {
		title: 'Commit type',
		placeHolder: 'Select the kind of change you are committing',
		matchOnDescription: true,
	});

	if (picked) {
		composer.setType(picked.value);
	}
}

async function editScope(composer: Composer): Promise<void> {
	const items = buildScopeItems(composer);
	const picked = await showQuickPickWithActive(items, activeScopeItem(items, composer.draft), {
		title: 'Commit scope',
		placeHolder: 'Select a scope, or choose a custom one',
	});

	if (!picked) {
		return;
	}

	await applyScopeChoice(composer, picked);
}

async function editSubject(composer: Composer): Promise<void> {
	const subject = await vscode.window.showInputBox({
		title: 'Commit subject',
		prompt: subjectPrompt(composer),
		value: composer.draft.subject ?? '',
		validateInput: subjectValidator(composer),
	});

	if (subject !== undefined) {
		composer.update({ subject: subject.trim() });
	}
}

async function editBody(context: vscode.ExtensionContext, composer: Composer): Promise<void> {
	if (vscode.workspace.getConfiguration('conventionalCommitPanel').get<boolean>('body.useEditor', false)) {
		return editBodyInEditor(context, composer);
	}

	const body = await vscode.window.showInputBox({
		title: 'Commit body',
		prompt: 'Longer explanation. Use \\n for line breaks, or the pencil icon to edit in a full editor.',
		value: (composer.draft.body ?? '').replace(/\n/g, '\\n'),
	});

	if (body !== undefined) {
		composer.update({ body: body.replace(/\\n/g, '\n').trim() });
	}
}

/**
 * Opens the body in a real editor tab for multi-line editing.
 *
 * A file named `COMMIT_EDITMSG` in extension storage gets git-commit highlighting
 * for free, and being a real file means closing it does not raise a save prompt.
 * The draft updates on every save and once more on close.
 */
async function editBodyInEditor(context: vscode.ExtensionContext, composer: Composer): Promise<void> {
	const repositoryKey = composer.repositoryKey;
	if (!repositoryKey) {
		return;
	}

	const storage = context.storageUri ?? context.globalStorageUri;
	await vscode.workspace.fs.createDirectory(storage);
	const uri = vscode.Uri.joinPath(storage, BODY_FILE_NAME);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(composer.draft.body ?? '', 'utf8'));

	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document, { preview: false });

	const subscriptions: vscode.Disposable[] = [];
	const matches = (candidate: vscode.TextDocument) => candidate.uri.toString() === uri.toString();

	subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((saved) => {
			if (matches(saved)) {
				composer.updateFor(repositoryKey, { body: saved.getText().trim() });
			}
		}),
		vscode.workspace.onDidCloseTextDocument((closed) => {
			if (!matches(closed)) {
				return;
			}
			composer.updateFor(repositoryKey, { body: closed.getText().trim() });
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
		}),
	);

	context.subscriptions.push(...subscriptions);
}

async function editBreaking(composer: Composer): Promise<void> {
	const draft = composer.draft;

	if (draft.isBreaking) {
		const keep = 'Edit description';
		const clear = 'Mark as not breaking';
		const choice = await vscode.window.showQuickPick([keep, clear], {
			title: 'Breaking change',
			placeHolder: 'This commit is currently marked as a breaking change',
		});

		if (choice === clear) {
			composer.update({ isBreaking: undefined, breakingDescription: undefined });
			return;
		}
		if (choice !== keep) {
			return;
		}
	}

	const description = await vscode.window.showInputBox({
		title: 'Breaking change',
		prompt: 'What breaks, and what should people do about it? Leave empty to mark it breaking without a note.',
		value: draft.breakingDescription ?? '',
	});

	if (description === undefined) {
		return;
	}

	composer.update({ isBreaking: true, breakingDescription: description.trim() || undefined });
}

/**
 * `showQuickPick` cannot preselect an item, so the branch-derived scope is put
 * under the cursor by driving a QuickPick directly.
 */
function showQuickPickWithActive<T extends vscode.QuickPickItem>(
	items: T[],
	active: T | undefined,
	options: { title: string; placeHolder: string },
): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		const quickPick = vscode.window.createQuickPick<T>();
		quickPick.title = options.title;
		quickPick.placeholder = options.placeHolder;
		quickPick.items = items;
		quickPick.matchOnDescription = true;
		if (active) {
			quickPick.activeItems = [active];
		}

		let accepted: T | undefined;
		quickPick.onDidAccept(() => {
			accepted = quickPick.selectedItems[0];
			quickPick.hide();
		});
		quickPick.onDidHide(() => {
			resolve(accepted);
			quickPick.dispose();
		});

		quickPick.show();
	});
}
