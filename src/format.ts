import type { CommitDraft } from './model';

/**
 * Rendering of a {@link CommitDraft} into a Conventional Commits message.
 *
 * This module is deliberately free of any `vscode` runtime import so it can be
 * exercised by plain mocha without an extension host. The `import type` above is
 * erased at compile time.
 */

export interface FormatOptions {
	/** Maximum length of the header line. */
	headerMaxLength: number;
	/** Column to wrap the body at. `0` disables wrapping. */
	bodyLineLength: number;
	/** Emoji to place before the subject. Ignored when undefined. */
	emoji?: string;
}

/**
 * Two different numbers that happen to look like one convention.
 *
 * The body wraps at 72 for the classic reason: `git log` indents the message by
 * four spaces, so 72 still fits an 80-column terminal, and git was built around
 * patches mailed around, where quoting adds two characters per reply level.
 *
 * The header is 100 because exceeding it is an *error* here, and an error blocks
 * the Commit button. `@commitlint/config-conventional` and the Angular guidelines
 * both put `header-max-length` at 100, so a stricter default meant the panel
 * refusing to commit headers the repository's own linter would have passed. The
 * type and scope spend that budget too — `feat(composer): ` is already 16
 * characters — which the 72 of the subject-only convention never accounted for.
 */
export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
	headerMaxLength: 100,
	bodyLineLength: 72,
};

export const BREAKING_CHANGE_TOKEN = 'BREAKING CHANGE';

/**
 * Builds the header line: `type(scope)!: subject`.
 *
 * A draft that has no type yet still renders — the subject alone — so the panel
 * can show a useful preview while the message is half-composed.
 */
export function renderHeader(draft: CommitDraft, options: FormatOptions = DEFAULT_FORMAT_OPTIONS): string {
	const subject = (draft.subject ?? '').trim();
	const prefixedSubject = options.emoji ? `${options.emoji} ${subject}`.trim() : subject;

	const type = (draft.type ?? '').trim();
	if (!type) {
		return prefixedSubject;
	}

	const scope = (draft.scope ?? '').trim();
	const scopePart = scope ? `(${scope})` : '';
	const breakingMark = draft.isBreaking ? '!' : '';

	return `${type}${scopePart}${breakingMark}: ${prefixedSubject}`;
}

/**
 * Builds the full commit message: header, body, then the footer block.
 *
 * ```
 * feat(auth)!: add login retry
 *
 * Retry twice before surfacing the error.
 *
 * BREAKING CHANGE: the retry callback signature changed
 * Refs: PROJ-123
 * ```
 */
export function renderCommitMessage(draft: CommitDraft, options: FormatOptions = DEFAULT_FORMAT_OPTIONS): string {
	const blocks: string[] = [];

	const header = renderHeader(draft, options);
	if (header) {
		blocks.push(header);
	}

	const body = (draft.body ?? '').trim();
	if (body) {
		blocks.push(wrapBody(body, options.bodyLineLength));
	}

	const footerLines: string[] = [];
	if (draft.isBreaking) {
		const description = (draft.breakingDescription ?? '').trim();
		if (description) {
			footerLines.push(`${BREAKING_CHANGE_TOKEN}: ${description}`);
		}
	}
	for (const footer of draft.footers ?? []) {
		const trimmed = footer.trim();
		if (trimmed) {
			footerLines.push(trimmed);
		}
	}
	if (footerLines.length > 0) {
		blocks.push(footerLines.join('\n'));
	}

	return blocks.join('\n\n');
}

/**
 * Hard-wraps `text` at `width` columns.
 *
 * Existing newlines are preserved, fenced code blocks are passed through
 * untouched, and a single word longer than `width` is never split — which is what
 * keeps long URLs intact.
 */
export function wrapBody(text: string, width: number): string {
	if (width <= 0) {
		return text;
	}

	const output: string[] = [];
	let insideFence = false;

	for (const line of text.split('\n')) {
		if (/^\s*```/.test(line)) {
			insideFence = !insideFence;
			output.push(line);
			continue;
		}

		if (insideFence || line.trim() === '' || line.length <= width) {
			output.push(line);
			continue;
		}

		output.push(...wrapLine(line, width));
	}

	return output.join('\n');
}

/** Wraps a single line, preserving its leading indentation on continuations. */
function wrapLine(line: string, width: number): string[] {
	const indentMatch = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)/.exec(line);
	const firstIndent = indentMatch ? indentMatch[1] : '';
	// Continuation lines align under the text, not under the bullet itself.
	const hangingIndent = ' '.repeat(firstIndent.length);

	const words = line.slice(firstIndent.length).split(/\s+/).filter(Boolean);
	const wrapped: string[] = [];
	let current = firstIndent;
	let currentIsEmpty = true;

	for (const word of words) {
		const indent = wrapped.length === 0 ? firstIndent : hangingIndent;
		if (currentIsEmpty) {
			current = indent + word;
			currentIsEmpty = false;
			continue;
		}

		if (current.length + 1 + word.length <= width) {
			current += ` ${word}`;
		} else {
			wrapped.push(current);
			current = hangingIndent + word;
		}
	}

	if (!currentIsEmpty) {
		wrapped.push(current);
	}

	return wrapped.length > 0 ? wrapped : [line];
}

export interface SubjectProblem {
	message: string;
	severity: 'error' | 'warning';
}

/**
 * Validates a candidate subject in the context of the rest of the draft, so the
 * header length check accounts for the type and scope already chosen.
 */
export function validateSubject(
	subject: string,
	draft: CommitDraft,
	options: FormatOptions = DEFAULT_FORMAT_OPTIONS,
): SubjectProblem | undefined {
	const trimmed = subject.trim();
	if (!trimmed) {
		return { message: 'A subject is required.', severity: 'error' };
	}

	if (trimmed.endsWith('.')) {
		return { message: 'Subject should not end with a period.', severity: 'warning' };
	}

	const header = renderHeader({ ...draft, subject: trimmed }, options);
	if (header.length > options.headerMaxLength) {
		return {
			message: `Header is ${header.length} characters; the limit is ${options.headerMaxLength}.`,
			severity: 'error',
		};
	}

	return undefined;
}

/** True when the draft has the minimum needed for a valid Conventional Commit. */
export function isDraftComplete(draft: CommitDraft): boolean {
	return Boolean((draft.type ?? '').trim()) && Boolean((draft.subject ?? '').trim());
}

export type DraftField = 'type' | 'scope' | 'subject' | 'body' | 'breaking';

export interface DraftProblem {
	field: DraftField;
	message: string;
	severity: 'error' | 'warning';
}

export interface ValidationRules {
	headerMaxLength: number;
	/** Allowed types. An empty list means "anything goes". */
	types: string[];
	/** Allowed scopes, from a commitlint `scope-enum` or a cz config. */
	scopes: string[];
	/** Whether a free-text scope is acceptable when `scopes` is non-empty. */
	allowCustomScopes: boolean;
	/** True when the user is deliberately composing a type outside the list. */
	customTypeActive?: boolean;
	/**
	 * Whether an empty scope is an error.
	 *
	 * Conventional Commits treats scope as optional, so this is opt-in via
	 * `conventionalCommitPanel.scope.required` rather than a default.
	 */
	scopeRequired?: boolean;
}

/**
 * Checks the draft against the rules we were able to read from the repository.
 *
 * This is not a call into commitlint — running the repo's own commitlint per
 * keystroke would be far too slow. It evaluates the rules parsed out of the
 * commitlint/cz config (`type-enum`, `scope-enum`, `header-max-length`) plus the
 * baseline Conventional Commits shape, which is why the panel labels the result
 * "commitlint rules" rather than claiming commitlint itself passed.
 */
export function validateDraft(
	draft: CommitDraft,
	options: FormatOptions,
	rules: ValidationRules,
): DraftProblem[] {
	const problems: DraftProblem[] = [];

	const type = (draft.type ?? '').trim();
	if (!type) {
		problems.push({
			field: 'type',
			message: rules.customTypeActive ? 'Type a custom type.' : 'Pick a commit type.',
			severity: 'error',
		});
	} else {
		const shapeProblem = validateCustomType(type);
		if (shapeProblem) {
			problems.push({ field: 'type', message: shapeProblem, severity: 'error' });
		} else if (!rules.customTypeActive && rules.types.length > 0 && !rules.types.includes(type)) {
			// Only reported when the type did *not* come from the Custom card.
			//
			// Telling someone who deliberately chose "custom" that their type is not
			// on the list is just restating what they asked for, and it fired on
			// every keystroke as they typed. It stays useful for the other case: a
			// restored draft whose type the repository has since stopped offering.
			//
			// A warning rather than an error either way — the type is legal
			// Conventional Commits, and if commitlint really does enforce the list,
			// the hook says so at commit time and that message is surfaced verbatim.
			problems.push({
				field: 'type',
				message: `"${type}" is not one of this repository's configured types.`,
				severity: 'warning',
			});
		}
	}

	const scope = (draft.scope ?? '').trim();
	if (!scope && rules.scopeRequired) {
		problems.push({ field: 'scope', message: 'A scope is required.', severity: 'error' });
	} else if (scope && rules.scopes.length > 0 && !rules.scopes.includes(scope) && !rules.allowCustomScopes) {
		problems.push({
			field: 'scope',
			message: `"${scope}" is not one of the configured scopes.`,
			severity: 'error',
		});
	}

	const subjectProblem = validateSubject(draft.subject ?? '', draft, options);
	if (subjectProblem) {
		problems.push({ field: 'subject', message: subjectProblem.message, severity: subjectProblem.severity });
	}

	if (draft.isBreaking && !(draft.breakingDescription ?? '').trim()) {
		problems.push({
			field: 'breaking',
			message: 'Breaking changes are easier to act on with a short description.',
			severity: 'warning',
		});
	}

	return problems;
}

/**
 * Rejects a hand-typed type that would produce a malformed header.
 *
 * Conventional Commits gives `(`, `)`, `!` and `:` structural meaning in the
 * header, so a type containing them would silently change how the message parses.
 * Returns undefined when the value is acceptable.
 */
export function validateCustomType(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	if (/\s/.test(trimmed)) {
		return 'A type cannot contain spaces.';
	}
	if (/[()!:]/.test(trimmed)) {
		return 'A type cannot contain ( ) ! or :';
	}
	if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmed)) {
		return 'A type must start with a letter and use only letters, digits, - or _';
	}

	return undefined;
}

export type SemverImpact = 'major' | 'minor' | 'patch' | 'none';

/**
 * The release the commit would drive under Conventional Commits, shown next to
 * the breaking-change toggle so the consequence of the choice is visible.
 */
export function semverImpact(draft: CommitDraft): SemverImpact {
	if (draft.isBreaking) {
		return 'major';
	}

	switch ((draft.type ?? '').trim()) {
		case 'feat':
			return 'minor';
		case 'fix':
		case 'perf':
			return 'patch';
		default:
			return 'none';
	}
}
