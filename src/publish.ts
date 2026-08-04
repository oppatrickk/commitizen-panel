/**
 * Deciding where an unpublished branch should go.
 *
 * Kept free of `vscode` so the part with real branching — which remote, and was
 * this even the missing-upstream failure — is unit-testable without an extension
 * host. The notification that acts on the answer lives in `composer.ts`.
 */

/**
 * `GitErrorCodes.NoUpstreamBranch`, as a literal.
 *
 * Deliberately not imported: `GitErrorCodes` is an `export const enum` inside a
 * `.d.ts` with no runtime module behind it, so a value import survives type
 * erasure into a bundle that cannot resolve it. `git.ts` imports those types with
 * `import type` for the same reason.
 */
const NO_UPSTREAM_BRANCH = 'NoUpstreamBranch';

/** Structural stand-in for the Git API's `Remote`, so this file imports nothing. */
export interface RemoteLike {
	name: string;
	isReadOnly: boolean;
}

export type PublishChoice =
	| { kind: 'none' }
	| { kind: 'remote'; name: string }
	| { kind: 'ask'; names: string[] };

/**
 * True when a push failed only because the branch has no upstream.
 *
 * Duck-typed rather than instance-checked: the error crosses the Git extension's
 * API boundary, so it arrives as a plain object carrying `gitErrorCode`.
 */
export function isNoUpstreamBranch(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'gitErrorCode' in error &&
		(error as { gitErrorCode?: unknown }).gitErrorCode === NO_UPSTREAM_BRANCH
	);
}

/**
 * Picks the remote to publish to, or says that the user has to.
 *
 * `origin` wins when it is there because that is what it means; a repository with
 * one differently-named remote uses that one rather than guessing at a name that
 * does not exist.
 */
export function choosePublishRemote(remotes: readonly RemoteLike[]): PublishChoice {
	if (remotes.length === 0) {
		return { kind: 'none' };
	}

	// A read-only remote cannot be pushed to, but if that flag ever excluded every
	// remote, offering all of them beats telling the user they have none.
	const writable = remotes.filter((remote) => !remote.isReadOnly);
	const names = (writable.length > 0 ? writable : remotes).map((remote) => remote.name);

	if (names.length === 1) {
		return { kind: 'remote', name: names[0] };
	}

	return names.includes('origin') ? { kind: 'remote', name: 'origin' } : { kind: 'ask', names };
}
