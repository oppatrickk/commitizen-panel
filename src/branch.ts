/**
 * Derives scope suggestions from the current branch name.
 *
 * Free of any `vscode` runtime import so it can be unit-tested without an
 * extension host.
 */

export interface BranchScopeOptions {
	/** Regex source. The first capture group wins when present. */
	ticketPattern: string;
	/** Branch name prefixes stripped before the segment fallback. */
	branchPrefixes: string[];
	/** Branches that should never produce a suggestion. */
	ignoreBranches: string[];
}

export const DEFAULT_BRANCH_SCOPE_OPTIONS: BranchScopeOptions = {
	ticketPattern: '([A-Z][A-Z0-9]+-\\d+)',
	branchPrefixes: ['feature', 'feat', 'fix', 'bugfix', 'hotfix', 'chore', 'release'],
	ignoreBranches: ['main', 'master', 'develop', 'dev', 'trunk'],
};

export interface BranchScopeSuggestion {
	/** Ticket ID matched by `ticketPattern`, e.g. `PROJ-123`. */
	ticket?: string;
	/** The branch segment with any known prefix stripped, e.g. `add-login`. */
	segment?: string;
}

/**
 * ```
 * feature/PROJ-123-add-login  →  { ticket: 'PROJ-123', segment: 'PROJ-123-add-login' }
 * feat/user-auth              →  { segment: 'user-auth' }
 * release/2.1.0               →  { segment: '2.1.0' }
 * main                        →  {}
 * undefined (detached HEAD)   →  {}
 * ```
 */
export function suggestScopes(
	branchName: string | undefined,
	options: BranchScopeOptions = DEFAULT_BRANCH_SCOPE_OPTIONS,
): BranchScopeSuggestion {
	const branch = (branchName ?? '').trim();
	if (!branch) {
		return {};
	}

	if (options.ignoreBranches.some((ignored) => ignored.toLowerCase() === branch.toLowerCase())) {
		return {};
	}

	const suggestion: BranchScopeSuggestion = {};

	const ticket = matchTicket(branch, options.ticketPattern);
	if (ticket) {
		suggestion.ticket = ticket;
	}

	const segment = extractSegment(branch, options.branchPrefixes);
	if (segment) {
		suggestion.segment = segment;
	}

	return suggestion;
}

/** Returns the ordered, de-duplicated list of scope candidates from a branch. */
export function branchScopeCandidates(
	branchName: string | undefined,
	options: BranchScopeOptions = DEFAULT_BRANCH_SCOPE_OPTIONS,
): string[] {
	const { ticket, segment } = suggestScopes(branchName, options);
	const candidates = [ticket, segment].filter((value): value is string => Boolean(value));
	return [...new Set(candidates)];
}

/**
 * A user-supplied pattern can be invalid or catastrophically slow to author; a
 * bad regex must degrade to "no ticket found" rather than break the panel.
 */
function matchTicket(branch: string, pattern: string): string | undefined {
	if (!pattern) {
		return undefined;
	}

	let regex: RegExp;
	try {
		regex = new RegExp(pattern);
	} catch {
		return undefined;
	}

	const match = regex.exec(branch);
	if (!match) {
		return undefined;
	}

	// Prefer the first capture group, falling back to the whole match.
	return (match[1] ?? match[0]) || undefined;
}

/**
 * Takes the part of the branch after the last `/`, unless the whole branch is a
 * single segment that begins with a known prefix (`feat-user-auth`).
 */
function extractSegment(branch: string, prefixes: string[]): string | undefined {
	const parts = branch.split('/').filter(Boolean);
	if (parts.length === 0) {
		return undefined;
	}

	if (parts.length > 1) {
		const last = parts[parts.length - 1];
		return last || undefined;
	}

	const single = parts[0];
	for (const prefix of prefixes) {
		if (!prefix) {
			continue;
		}
		const lowered = single.toLowerCase();
		const loweredPrefix = prefix.toLowerCase();
		if (lowered.startsWith(`${loweredPrefix}-`) || lowered.startsWith(`${loweredPrefix}_`)) {
			const stripped = single.slice(prefix.length + 1);
			return stripped || undefined;
		}
	}

	return single || undefined;
}
