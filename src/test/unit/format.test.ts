import * as assert from 'assert';
import {
	DEFAULT_FORMAT_OPTIONS,
	isDraftComplete,
	renderCommitMessage,
	renderHeader,
	semverImpact,
	validateCustomType,
	validateDraft,
	validateSubject,
	ValidationRules,
	wrapBody,
} from '../../format';
import type { CommitDraft } from '../../model';

describe('renderHeader', () => {
	const cases: Array<[string, CommitDraft, string]> = [
		['type and subject', { type: 'feat', subject: 'add login retry' }, 'feat: add login retry'],
		[
			'type, scope and subject',
			{ type: 'feat', scope: 'auth', subject: 'add login retry' },
			'feat(auth): add login retry',
		],
		[
			'breaking marker sits before the colon',
			{ type: 'feat', scope: 'auth', subject: 'drop v1', isBreaking: true },
			'feat(auth)!: drop v1',
		],
		['breaking without a scope', { type: 'fix', subject: 'drop v1', isBreaking: true }, 'fix!: drop v1'],
		['an empty scope is omitted', { type: 'chore', scope: '', subject: 'tidy' }, 'chore: tidy'],
		['subject alone when no type is chosen yet', { subject: 'work in progress' }, 'work in progress'],
		['nothing at all', {}, ''],
	];

	for (const [name, draft, expected] of cases) {
		it(name, () => {
			assert.strictEqual(renderHeader(draft), expected);
		});
	}

	it('places the emoji before the subject', () => {
		const header = renderHeader(
			{ type: 'feat', scope: 'auth', subject: 'add login retry' },
			{ ...DEFAULT_FORMAT_OPTIONS, emoji: '✨' },
		);
		assert.strictEqual(header, 'feat(auth): ✨ add login retry');
	});

	it('trims surrounding whitespace from every part', () => {
		const header = renderHeader({ type: '  feat ', scope: ' auth  ', subject: '  add retry  ' });
		assert.strictEqual(header, 'feat(auth): add retry');
	});
});

describe('renderCommitMessage', () => {
	it('separates header, body and footers with blank lines', () => {
		const message = renderCommitMessage({
			type: 'feat',
			scope: 'auth',
			subject: 'add login retry',
			body: 'Retry twice before surfacing the error.',
			isBreaking: true,
			breakingDescription: 'the retry callback signature changed',
			footers: ['Refs: PROJ-123'],
		});

		assert.strictEqual(
			message,
			[
				'feat(auth)!: add login retry',
				'',
				'Retry twice before surfacing the error.',
				'',
				'BREAKING CHANGE: the retry callback signature changed',
				'Refs: PROJ-123',
			].join('\n'),
		);
	});

	it('omits the body block entirely when there is no body', () => {
		const message = renderCommitMessage({ type: 'fix', subject: 'handle null user' });
		assert.strictEqual(message, 'fix: handle null user');
	});

	it('marks a commit breaking without a footer when no description is given', () => {
		const message = renderCommitMessage({ type: 'feat', subject: 'drop v1', isBreaking: true });
		assert.strictEqual(message, 'feat!: drop v1');
	});

	it('drops empty footer entries', () => {
		const message = renderCommitMessage({
			type: 'fix',
			subject: 'handle null user',
			footers: ['', '   ', 'Closes #12'],
		});
		assert.strictEqual(message, 'fix: handle null user\n\nCloses #12');
	});
});

describe('wrapBody', () => {
	it('wraps at the requested column', () => {
		const wrapped = wrapBody('one two three four five six seven eight nine ten', 20);
		for (const line of wrapped.split('\n')) {
			assert.ok(line.length <= 20, `line too long: ${line}`);
		}
		assert.strictEqual(wrapped.split('\n').length > 1, true);
	});

	it('never splits a word longer than the width, which keeps URLs intact', () => {
		const url = 'https://example.com/a/very/long/path/that/exceeds/the/wrap/width';
		const wrapped = wrapBody(`See ${url} for details`, 20);
		assert.ok(wrapped.includes(url), 'the URL was broken across lines');
	});

	it('preserves existing newlines and blank lines', () => {
		const text = 'first paragraph\n\nsecond paragraph';
		assert.strictEqual(wrapBody(text, 72), text);
	});

	it('leaves fenced code blocks untouched', () => {
		const text = ['intro', '```', 'a very long line inside a fence that would otherwise wrap', '```'].join('\n');
		assert.strictEqual(wrapBody(text, 20), text);
	});

	it('is a no-op when the width is zero', () => {
		const text = 'a line that is definitely longer than twenty characters';
		assert.strictEqual(wrapBody(text, 0), text);
	});

	it('keeps list markers on the first line and indents continuations', () => {
		const wrapped = wrapBody('- alpha beta gamma delta epsilon zeta', 16);
		const lines = wrapped.split('\n');
		assert.strictEqual(lines[0].startsWith('- '), true);
		assert.strictEqual(lines[1].startsWith('  '), true);
	});
});

describe('validateSubject', () => {
	it('requires a subject', () => {
		const problem = validateSubject('   ', {});
		assert.strictEqual(problem?.severity, 'error');
	});

	it('warns about a trailing period rather than blocking', () => {
		const problem = validateSubject('add login retry.', { type: 'feat' });
		assert.strictEqual(problem?.severity, 'warning');
	});

	it('counts the type and scope against the header limit', () => {
		const draft: CommitDraft = { type: 'feat', scope: 'authentication' };
		const subject = 'x'.repeat(60);

		const problem = validateSubject(subject, draft, { ...DEFAULT_FORMAT_OPTIONS, headerMaxLength: 72 });
		assert.strictEqual(problem?.severity, 'error');
		assert.ok(problem?.message.includes('72'));
	});

	it('accepts a subject that fits', () => {
		assert.strictEqual(validateSubject('add login retry', { type: 'feat' }), undefined);
	});
});

describe('isDraftComplete', () => {
	it('needs both a type and a subject', () => {
		assert.strictEqual(isDraftComplete({ type: 'feat' }), false);
		assert.strictEqual(isDraftComplete({ subject: 'x' }), false);
		assert.strictEqual(isDraftComplete({ type: 'feat', subject: 'x' }), true);
	});
});

describe('validateCustomType', () => {
	it('accepts plausible hand-typed types', () => {
		for (const value of ['deps', 'wip', 'hotfix', 'release-2', 'db_migration', 'a']) {
			assert.strictEqual(validateCustomType(value), undefined, `rejected ${value}`);
		}
	});

	it('accepts an empty value, which just means nothing chosen yet', () => {
		assert.strictEqual(validateCustomType(''), undefined);
		assert.strictEqual(validateCustomType('   '), undefined);
	});

	it('rejects the characters that carry structural meaning in the header', () => {
		// A type containing these would silently change how the header parses.
		for (const value of ['feat(scope)', 'feat:', 'feat!', 'a(b']) {
			assert.ok(validateCustomType(value), `accepted ${value}`);
		}
	});

	it('rejects whitespace inside the type', () => {
		assert.ok(validateCustomType('new feature'));
	});

	it('rejects a type that does not start with a letter', () => {
		assert.ok(validateCustomType('2fix'));
		assert.ok(validateCustomType('-fix'));
	});
});

describe('validateDraft with a custom type', () => {
	const open: ValidationRules = { headerMaxLength: 72, types: [], scopes: [], allowCustomScopes: true };

	it('accepts a custom type when the repo pins nothing', () => {
		assert.deepStrictEqual(validateDraft({ type: 'deps', subject: 'bump axios' }, DEFAULT_FORMAT_OPTIONS, open), []);
	});

	it('reports a malformed custom type before checking it against the list', () => {
		const problems = validateDraft({ type: 'a:b', subject: 'x' }, DEFAULT_FORMAT_OPTIONS, open);
		assert.strictEqual(problems[0].field, 'type');
		assert.ok(problems[0].message.includes('( ) ! or :'));
	});

	it('flags a custom type when the repo pins a type-enum, without blocking it', () => {
		const pinned: ValidationRules = { ...open, types: ['feat', 'fix'] };
		const problems = validateDraft({ type: 'deps', subject: 'x' }, DEFAULT_FORMAT_OPTIONS, pinned);

		assert.ok(problems[0].message.includes("this repository's configured types"));
		assert.strictEqual(problems[0].severity, 'warning');
	});
});

describe('semverImpact', () => {
	const cases: Array<[CommitDraft, string]> = [
		[{ type: 'feat' }, 'minor'],
		[{ type: 'fix' }, 'patch'],
		[{ type: 'perf' }, 'patch'],
		[{ type: 'chore' }, 'none'],
		[{ type: 'docs' }, 'none'],
		[{}, 'none'],
		// Breaking outranks the type, including for types that release nothing.
		[{ type: 'feat', isBreaking: true }, 'major'],
		[{ type: 'chore', isBreaking: true }, 'major'],
	];

	for (const [draft, expected] of cases) {
		it(`${draft.type ?? 'no type'}${draft.isBreaking ? ' breaking' : ''} → ${expected}`, () => {
			assert.strictEqual(semverImpact(draft), expected);
		});
	}
});

describe('validateDraft', () => {
	const rules: ValidationRules = {
		headerMaxLength: 72,
		types: ['feat', 'fix', 'chore'],
		scopes: [],
		allowCustomScopes: true,
	};

	const valid: CommitDraft = { type: 'feat', subject: 'add login retry' };

	it('accepts a well-formed draft', () => {
		assert.deepStrictEqual(validateDraft(valid, DEFAULT_FORMAT_OPTIONS, rules), []);
	});

	it('requires a type', () => {
		const problems = validateDraft({ subject: 'x' }, DEFAULT_FORMAT_OPTIONS, rules);
		assert.strictEqual(problems.some((p) => p.field === 'type' && p.severity === 'error'), true);
	});

	it('warns rather than errors for a type outside the configured list', () => {
		const problems = validateDraft({ ...valid, type: 'wip' }, DEFAULT_FORMAT_OPTIONS, rules);
		assert.strictEqual(problems[0].field, 'type');
		assert.ok(problems[0].message.includes('wip'));
		// An error here would disable Commit for a type that is valid Conventional
		// Commits; only the repository's own list objects to it.
		assert.strictEqual(problems[0].severity, 'warning');
	});

	it('says nothing about the list while the custom card is active', () => {
		// Telling someone who chose "custom" that their type is not on the list
		// restates their own choice, and it fired on every keystroke.
		for (const partial of ['d', 'de', 'dep', 'deps']) {
			const problems = validateDraft({ ...valid, type: partial }, DEFAULT_FORMAT_OPTIONS, {
				...rules,
				customTypeActive: true,
			});
			assert.deepStrictEqual(problems, [], `typing "${partial}" still produced ${JSON.stringify(problems)}`);
		}
	});

	it('never renders the list message with an empty type', () => {
		// Guards the shape of the message itself: an empty or blank type must take
		// the "nothing chosen" path, never interpolate into "" is not one of…
		for (const empty of [undefined, '', '   ']) {
			for (const custom of [false, true]) {
				const problems = validateDraft({ ...valid, type: empty }, DEFAULT_FORMAT_OPTIONS, {
					...rules,
					customTypeActive: custom,
				});
				assert.strictEqual(
					problems.some((problem) => problem.message.includes('is not one of')),
					false,
					`empty type produced: ${problems.map((p) => p.message).join(' | ')}`,
				);
			}
		}
	});

	it('asks for a custom type rather than "pick one" while the custom card is active', () => {
		const problems = validateDraft({ subject: 'x' }, DEFAULT_FORMAT_OPTIONS, {
			...rules,
			customTypeActive: true,
		});
		assert.strictEqual(problems[0].message, 'Type a custom type.');

		const listed = validateDraft({ subject: 'x' }, DEFAULT_FORMAT_OPTIONS, rules);
		assert.strictEqual(listed[0].message, 'Pick a commit type.');
	});

	it('allows any type when no list is configured', () => {
		const problems = validateDraft({ ...valid, type: 'wip' }, DEFAULT_FORMAT_OPTIONS, { ...rules, types: [] });
		assert.deepStrictEqual(problems, []);
	});

	it('rejects an unconfigured scope only when custom scopes are disallowed', () => {
		const strict = { ...rules, scopes: ['api', 'ui'], allowCustomScopes: false };
		const draft = { ...valid, scope: 'billing' };

		assert.strictEqual(validateDraft(draft, DEFAULT_FORMAT_OPTIONS, strict)[0].field, 'scope');
		assert.deepStrictEqual(
			validateDraft(draft, DEFAULT_FORMAT_OPTIONS, { ...strict, allowCustomScopes: true }),
			[],
		);
	});

	it('leaves an empty scope alone by default, per the spec', () => {
		assert.deepStrictEqual(validateDraft(valid, DEFAULT_FORMAT_OPTIONS, rules), []);
	});

	it('errors on an empty scope when scopeRequired is on', () => {
		const required = { ...rules, scopeRequired: true };

		const problems = validateDraft(valid, DEFAULT_FORMAT_OPTIONS, required);
		assert.deepStrictEqual(
			problems.map((p) => [p.field, p.severity]),
			[['scope', 'error']],
		);

		assert.deepStrictEqual(
			validateDraft({ ...valid, scope: 'api' }, DEFAULT_FORMAT_OPTIONS, required),
			[],
		);
	});

	it('treats whitespace as empty when a scope is required', () => {
		const problems = validateDraft({ ...valid, scope: '   ' }, DEFAULT_FORMAT_OPTIONS, {
			...rules,
			scopeRequired: true,
		});
		assert.strictEqual(problems[0].field, 'scope');
	});

	it('reports an over-long header', () => {
		// The limit is read from FormatOptions, not from the headerMaxLength on
		// ValidationRules, so the threshold is set here rather than left to whatever
		// the default happens to be.
		const options = { ...DEFAULT_FORMAT_OPTIONS, headerMaxLength: 72 };
		const draft = { ...valid, subject: 'x'.repeat(80) };
		const problems = validateDraft(draft, options, rules);
		assert.strictEqual(problems[0].severity, 'error');
	});

	it('allows by default the header length commitlint allows', () => {
		// Going over is an error, and an error blocks the Commit button, so a default
		// stricter than commitlint's 100 would refuse commits the repository's own
		// linter accepts.
		const draft = { ...valid, subject: 'x'.repeat(90) };
		assert.strictEqual(renderHeader(draft, DEFAULT_FORMAT_OPTIONS).length, 96);
		assert.deepStrictEqual(validateDraft(draft, DEFAULT_FORMAT_OPTIONS, rules), []);
	});

	it('warns about a breaking change with no description', () => {
		const problems = validateDraft({ ...valid, isBreaking: true }, DEFAULT_FORMAT_OPTIONS, rules);
		assert.deepStrictEqual(
			problems.map((p) => [p.field, p.severity]),
			[['breaking', 'warning']],
		);
	});
});
