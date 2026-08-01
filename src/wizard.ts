import * as vscode from 'vscode';
import { Composer } from './composer';
import { MultiStepInput } from './multiStepInput';
import {
	activeScopeItem,
	applyScopeChoice,
	buildScopeItems,
	buildTypeItems,
	ScopeItem,
	subjectPrompt,
	subjectValidator,
	TypeItem,
} from './pickers';
import type { FieldKey } from './model';

const WIZARD_STEPS: FieldKey[] = ['type', 'scope', 'subject', 'body', 'breaking'];

/**
 * The guided flow behind the Source Control toolbar button.
 *
 * It reads and writes the same draft as the panel, so it starts from whatever is
 * already composed and the panel updates row by row as the wizard advances.
 * Like the panel, it stops at filling the commit box — committing stays a
 * deliberate press of VS Code's own Commit button.
 */
export async function runWizard(composer: Composer): Promise<void> {
	if (!composer.repositoryKey) {
		void vscode.window.showWarningMessage('Conventional Commit Panel: open a Git repository to compose a commit message.');
		return;
	}

	await composer.refresh();

	const skipped = new Set(composer.currentConfig.skipQuestions);
	const steps = WIZARD_STEPS.filter((step) => !skipped.has(step));
	if (steps.length === 0) {
		return;
	}

	const stepAt = (index: number) => {
		if (index >= steps.length) {
			return undefined;
		}

		return async (input: MultiStepInput) => {
			await runStep(composer, input, steps[index], index + 1, steps.length);
			return stepAt(index + 1);
		};
	};

	const first = stepAt(0);
	if (!first) {
		return;
	}

	await MultiStepInput.run(first);

	// Reveal the Source Control view so the composed message is visible and one
	// keystroke away from being committed.
	await vscode.commands.executeCommand('workbench.view.scm');
}

async function runStep(
	composer: Composer,
	input: MultiStepInput,
	field: FieldKey,
	step: number,
	totalSteps: number,
): Promise<void> {
	switch (field) {
		case 'type':
			return stepType(composer, input, step, totalSteps);
		case 'scope':
			return stepScope(composer, input, step, totalSteps);
		case 'subject':
			return stepSubject(composer, input, step, totalSteps);
		case 'body':
			return stepBody(composer, input, step, totalSteps);
		case 'breaking':
			return stepBreaking(composer, input, step, totalSteps);
	}
}

async function stepType(
	composer: Composer,
	input: MultiStepInput,
	step: number,
	totalSteps: number,
): Promise<void> {
	const items = buildTypeItems(composer);
	const current = items.find((item) => item.value === composer.draft.type);

	const picked = await input.showQuickPick<TypeItem>({
		title: 'Compose commit message',
		step,
		totalSteps,
		items,
		placeholder: 'Select the kind of change you are committing',
		...(current ? { activeItem: current } : {}),
	});

	composer.setType(picked.value);
}

async function stepScope(
	composer: Composer,
	input: MultiStepInput,
	step: number,
	totalSteps: number,
): Promise<void> {
	const items = buildScopeItems(composer);
	const active = activeScopeItem(items, composer.draft);

	const picked = await input.showQuickPick<ScopeItem>({
		title: 'Compose commit message',
		step,
		totalSteps,
		items,
		placeholder: 'Select a scope — the branch suggestion is pre-selected',
		...(active ? { activeItem: active } : {}),
	});

	await applyScopeChoice(composer, picked);
}

async function stepSubject(
	composer: Composer,
	input: MultiStepInput,
	step: number,
	totalSteps: number,
): Promise<void> {
	const subject = await input.showInputBox({
		title: 'Compose commit message',
		step,
		totalSteps,
		value: composer.draft.subject ?? '',
		prompt: subjectPrompt(composer),
		validate: subjectValidator(composer),
	});

	composer.update({ subject: subject.trim() });
}

async function stepBody(
	composer: Composer,
	input: MultiStepInput,
	step: number,
	totalSteps: number,
): Promise<void> {
	const body = await input.showInputBox({
		title: 'Compose commit message',
		step,
		totalSteps,
		value: (composer.draft.body ?? '').replace(/\n/g, '\\n'),
		prompt: 'Optional longer explanation. Use \\n for line breaks. Leave empty to skip.',
	});

	composer.update({ body: body.replace(/\\n/g, '\n').trim() || undefined });
}

const BREAKING_NO = 'No';
const BREAKING_YES = 'Yes';

async function stepBreaking(
	composer: Composer,
	input: MultiStepInput,
	step: number,
	totalSteps: number,
): Promise<void> {
	const items: vscode.QuickPickItem[] = [
		{ label: BREAKING_NO, description: 'A normal, backwards-compatible change' },
		{ label: BREAKING_YES, description: 'Adds a ! marker and a BREAKING CHANGE footer' },
	];

	const picked = await input.showQuickPick({
		title: 'Compose commit message',
		step,
		totalSteps,
		items,
		placeholder: 'Does this commit introduce a breaking change?',
		activeItem: composer.draft.isBreaking ? items[1] : items[0],
	});

	if (picked.label === BREAKING_NO) {
		composer.update({ isBreaking: undefined, breakingDescription: undefined });
		return;
	}

	const description = await input.showInputBox({
		title: 'Breaking change',
		step,
		totalSteps,
		value: composer.draft.breakingDescription ?? '',
		prompt: 'What breaks, and what should people do about it? Leave empty to skip the footer.',
	});

	composer.update({ isBreaking: true, breakingDescription: description.trim() || undefined });
}
