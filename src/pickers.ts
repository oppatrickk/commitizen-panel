import * as vscode from 'vscode';
import { Composer } from './composer';
import { validateSubject } from './format';
import type { CommitDraft, ScopeSource } from './model';

/**
 * Item construction shared by the panel's field editors and the wizard.
 *
 * Keeping the list-building here means the two entry points always offer exactly
 * the same choices, even though the wizard drives them through `MultiStepInput`
 * for its back button and the panel uses plain `showQuickPick`.
 */

export interface TypeItem extends vscode.QuickPickItem {
	value: string;
}

export function buildTypeItems(composer: Composer): TypeItem[] {
	const current = composer.draft.type;
	const useEmoji = Boolean(composer.formatOptions.emoji) || composer.currentConfig.types.some((t) => t.emoji);

	return composer.currentConfig.types.map((type) => {
		const item: TypeItem = {
			value: type.value,
			label: useEmoji && type.emoji ? `${type.emoji}  ${type.name ?? type.value}` : (type.name ?? type.value),
		};

		if (type.description) {
			item.description = type.description;
		}
		if (type.value === current) {
			item.detail = '$(check) Currently selected';
		}

		return item;
	});
}

export const CUSTOM_SCOPE = Symbol('custom-scope');
export const NO_SCOPE = Symbol('no-scope');

export interface ScopeItem extends vscode.QuickPickItem {
	value?: string;
	source?: ScopeSource;
	action?: typeof CUSTOM_SCOPE | typeof NO_SCOPE;
}

/**
 * Offers the branch-derived scope first and pre-selected, then configured scopes,
 * then recently used ones, and always a custom/none escape hatch. The branch value
 * is a default, never a lock-in.
 */
export function buildScopeItems(composer: Composer): ScopeItem[] {
	const items: ScopeItem[] = [];
	const seen = new Set<string>();
	const branch = composer.branchName;

	const push = (value: string, source: ScopeSource, description?: string) => {
		if (!value || seen.has(value)) {
			return;
		}
		seen.add(value);
		const item: ScopeItem = { label: value, value, source };
		if (description) {
			item.description = description;
		}
		items.push(item);
	};

	const branchScopes = composer.branchScopeSuggestions();
	if (branchScopes.length > 0) {
		items.push({ label: 'From branch', kind: vscode.QuickPickItemKind.Separator });
		for (const scope of branchScopes) {
			push(scope, 'branch', branch ? `from ${branch}` : undefined);
		}
	}

	const configured = composer.currentConfig.scopes.filter((scope) => !seen.has(scope));
	if (configured.length > 0) {
		items.push({ label: 'Configured', kind: vscode.QuickPickItemKind.Separator });
		for (const scope of configured) {
			push(scope, 'config');
		}
	}

	const recent = composer.getRecentScopes().filter((scope) => !seen.has(scope));
	if (recent.length > 0) {
		items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
		for (const scope of recent) {
			push(scope, 'recent');
		}
	}

	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	items.push({ label: '$(edit) Custom scope…', action: CUSTOM_SCOPE, alwaysShow: true });
	items.push({ label: '$(circle-slash) No scope', action: NO_SCOPE, alwaysShow: true });

	return items;
}

/**
 * Resolves a scope choice into a draft update, prompting for a value when
 * "Custom scope…" is picked.
 *
 * Lives here rather than in `commands.ts` because the wizard needs it too, and a
 * `commands ↔ wizard` import cycle would be the alternative.
 */
export async function applyScopeChoice(composer: Composer, picked: ScopeItem): Promise<void> {
	if (picked.action === NO_SCOPE) {
		// Recorded as a custom empty value so a branch switch does not re-fill it.
		composer.update({ scope: '', scopeSource: 'custom' });
		return;
	}

	if (picked.action === CUSTOM_SCOPE) {
		const custom = await vscode.window.showInputBox({
			title: 'Custom scope',
			prompt: 'The part of the codebase this change affects.',
			value: composer.draft.scope ?? '',
			validateInput: (value) =>
				value.includes(')') ? 'A scope cannot contain a closing parenthesis.' : undefined,
		});

		if (custom === undefined) {
			return;
		}

		composer.update({ scope: custom.trim(), scopeSource: 'custom' });
		return;
	}

	if (picked.value !== undefined) {
		composer.update({ scope: picked.value, scopeSource: picked.source ?? 'custom' });
	}
}

/** The item a scope picker should open on: the current value, else the branch one. */
export function activeScopeItem(items: ScopeItem[], draft: CommitDraft): ScopeItem | undefined {
	if (draft.scope) {
		const current = items.find((item) => item.value === draft.scope);
		if (current) {
			return current;
		}
	}
	return items.find((item) => item.source === 'branch');
}

/**
 * Validates a subject against the header length limit, accounting for the type and
 * scope already chosen. A trailing period is a warning rather than a block —
 * commitlint's default disallows it, but it is not worth refusing the input over.
 */
export function subjectValidator(
	composer: Composer,
): (value: string) => vscode.InputBoxValidationMessage | undefined {
	return (value: string) => {
		const problem = validateSubject(value, composer.draft, composer.formatOptions);
		if (!problem) {
			return undefined;
		}

		return {
			message: problem.message,
			severity:
				problem.severity === 'error'
					? vscode.InputBoxValidationSeverity.Error
					: vscode.InputBoxValidationSeverity.Warning,
		};
	};
}

/** Prompt text showing how many characters are left in the header. */
export function subjectPrompt(composer: Composer): string {
	const { headerMaxLength } = composer.formatOptions;
	const overhead = composer.renderHeaderLine().length - (composer.draft.subject ?? '').length;
	const available = Math.max(0, headerMaxLength - overhead);
	return `A short, imperative description — up to ${available} characters at the current header length.`;
}
