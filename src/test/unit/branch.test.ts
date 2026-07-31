import * as assert from 'assert';
import {
	branchScopeCandidates,
	DEFAULT_BRANCH_SCOPE_OPTIONS,
	suggestScopes,
	BranchScopeSuggestion,
} from '../../branch';

describe('suggestScopes', () => {
	const cases: Array<[string, string | undefined, BranchScopeSuggestion]> = [
		[
			'ticket ID and segment from a prefixed branch',
			'feature/PROJ-123-add-login',
			{ ticket: 'PROJ-123', segment: 'PROJ-123-add-login' },
		],
		['segment only when there is no ticket', 'feat/user-auth', { segment: 'user-auth' }],
		['a version branch yields just the segment', 'release/2.1.0', { segment: '2.1.0' }],
		['nested branch paths use the last segment', 'team/alpha/fix/PROJ-9-npe', { ticket: 'PROJ-9', segment: 'PROJ-9-npe' }],
		['a protected branch yields nothing', 'main', {}],
		['protected branch matching is case-insensitive', 'MAIN', {}],
		['a detached HEAD yields nothing', undefined, {}],
		['an empty branch name yields nothing', '', {}],
		['a bare branch name is its own segment', 'quickfix', { segment: 'quickfix' }],
		['a known prefix is stripped from a single segment', 'feature-user-auth', { segment: 'user-auth' }],
	];

	for (const [name, branch, expected] of cases) {
		it(name, () => {
			assert.deepStrictEqual(suggestScopes(branch), expected);
		});
	}

	it('falls back gracefully when the ticket pattern is invalid', () => {
		const suggestion = suggestScopes('feature/PROJ-123-add-login', {
			...DEFAULT_BRANCH_SCOPE_OPTIONS,
			ticketPattern: '([unclosed',
		});

		assert.strictEqual(suggestion.ticket, undefined);
		assert.strictEqual(suggestion.segment, 'PROJ-123-add-login');
	});

	it('uses the whole match when the pattern has no capture group', () => {
		const suggestion = suggestScopes('feature/ABC-7-thing', {
			...DEFAULT_BRANCH_SCOPE_OPTIONS,
			ticketPattern: '[A-Z]+-\\d+',
		});

		assert.strictEqual(suggestion.ticket, 'ABC-7');
	});

	it('honours a custom ignore list', () => {
		const suggestion = suggestScopes('sandbox', {
			...DEFAULT_BRANCH_SCOPE_OPTIONS,
			ignoreBranches: ['sandbox'],
		});

		assert.deepStrictEqual(suggestion, {});
	});
});

describe('branchScopeCandidates', () => {
	it('lists the ticket before the segment', () => {
		assert.deepStrictEqual(branchScopeCandidates('feature/PROJ-123-add-login'), [
			'PROJ-123',
			'PROJ-123-add-login',
		]);
	});

	it('de-duplicates when the ticket is the whole segment', () => {
		assert.deepStrictEqual(branchScopeCandidates('feature/PROJ-123'), ['PROJ-123']);
	});

	it('is empty for a protected branch', () => {
		assert.deepStrictEqual(branchScopeCandidates('develop'), []);
	});
});
