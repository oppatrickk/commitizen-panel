import * as assert from 'assert';
import { choosePublishRemote, isNoUpstreamBranch, RemoteLike } from '../../publish';

function remote(name: string, isReadOnly = false): RemoteLike {
	return { name, isReadOnly };
}

describe('isNoUpstreamBranch', () => {
	it('recognises the error the Git API rejects with', () => {
		// The error crosses the extension API boundary, so it arrives as a plain
		// object carrying gitErrorCode rather than a class we can instanceof.
		const error = Object.assign(new Error('fatal: The current branch x has no upstream branch.'), {
			gitErrorCode: 'NoUpstreamBranch',
		});
		assert.strictEqual(isNoUpstreamBranch(error), true);
	});

	it('does not swallow other push failures', () => {
		assert.strictEqual(isNoUpstreamBranch({ gitErrorCode: 'PushRejected' }), false);
		assert.strictEqual(isNoUpstreamBranch(new Error('fatal: could not read Username')), false);
		assert.strictEqual(isNoUpstreamBranch(undefined), false);
		assert.strictEqual(isNoUpstreamBranch(null), false);
		assert.strictEqual(isNoUpstreamBranch('NoUpstreamBranch'), false);
	});
});

describe('choosePublishRemote', () => {
	it('reports that there is nowhere to publish to', () => {
		assert.deepStrictEqual(choosePublishRemote([]), { kind: 'none' });
	});

	it('uses the only remote whatever it is called', () => {
		// Not everyone names it origin, and guessing at a name that does not exist
		// would fail after the user had already agreed to publish.
		assert.deepStrictEqual(choosePublishRemote([remote('upstream')]), { kind: 'remote', name: 'upstream' });
	});

	it('prefers origin when there is more than one', () => {
		assert.deepStrictEqual(choosePublishRemote([remote('fork'), remote('origin')]), {
			kind: 'remote',
			name: 'origin',
		});
	});

	it('asks when several remotes compete and none is origin', () => {
		assert.deepStrictEqual(choosePublishRemote([remote('fork'), remote('upstream')]), {
			kind: 'ask',
			names: ['fork', 'upstream'],
		});
	});

	it('ignores remotes that cannot be pushed to', () => {
		assert.deepStrictEqual(choosePublishRemote([remote('mirror', true), remote('fork')]), {
			kind: 'remote',
			name: 'fork',
		});
	});

	it('offers everything rather than nothing when every remote is read-only', () => {
		// Better a push that fails with git's own message than telling someone with
		// remotes configured that they have none.
		assert.deepStrictEqual(choosePublishRemote([remote('mirror', true)]), {
			kind: 'remote',
			name: 'mirror',
		});
	});
});
