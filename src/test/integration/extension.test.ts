import * as assert from 'assert';
import * as vscode from 'vscode';
import type { CommitPanelApi } from '../../extension';

const EXTENSION_NAME = 'conventional-commit-panel';

/**
 * Looks the extension up by name rather than by `publisher.name`.
 *
 * The publisher is a placeholder until release, so a hardcoded full ID would
 * break the entire suite the moment it is set for real — which is exactly what
 * happened once already.
 */
async function getApi(): Promise<CommitPanelApi> {
	const extension = vscode.extensions.all.find(
		(candidate) => candidate.packageJSON?.name === EXTENSION_NAME,
	) as vscode.Extension<CommitPanelApi> | undefined;
	assert.ok(extension, `no extension named "${EXTENSION_NAME}" is loaded in the test host`);

	const api = extension.isActive ? extension.exports : await extension.activate();
	// A failed activation surfaces here as undefined exports with isActive true;
	// the underlying error only reaches the extension host log, so say so plainly.
	assert.ok(
		api,
		'activation produced no API — check .vscode-test/user-data/logs/**/exthost/exthost.log for the activation error',
	);
	return api;
}

/** The Git extension discovers repositories asynchronously after activation. */
async function waitForRepository(api: CommitPanelApi, timeoutMs = 20000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (api.git.activeRepositoryKey) {
			await api.composer.refresh();
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

suite('Conventional Commit Panel', () => {
	test('activates and exposes the composer', async () => {
		const api = await getApi();
		assert.ok(api.composer, 'composer was not exported');
		assert.ok(api.git, 'git service was not exported');
	});

	test('registers its commands', async () => {
		await getApi();
		const commands = await vscode.commands.getCommands(true);

		for (const command of [
			'conventionalCommitPanel.wizard',
			'conventionalCommitPanel.edit',
			'conventionalCommitPanel.editBodyInEditor',
			'conventionalCommitPanel.apply',
			'conventionalCommitPanel.reset',
		]) {
			assert.ok(commands.includes(command), `${command} was not registered`);
		}
	});

	test('falls back to the built-in Conventional Commits types', async () => {
		const api = await getApi();
		await api.composer.refresh();

		const values = api.composer.currentConfig.types.map((type) => type.value);
		assert.ok(values.includes('feat'));
		assert.ok(values.includes('fix'));
		assert.ok(values.includes('chore'));
	});

	suite('with a repository', () => {
		let api: CommitPanelApi;
		let available = false;

		suiteSetup(async function () {
			api = await getApi();
			available = await waitForRepository(api);
			if (!available) {
				this.skip();
			}
		});

		setup(() => {
			api.composer.reset();
		});

		suiteTeardown(() => {
			if (available) {
				api.composer.reset();
			}
		});

		test('live sync writes the rendered message into the commit box', async () => {
			api.composer.update({ type: 'feat', scope: 'panel', scopeSource: 'custom' });
			api.composer.update({ subject: 'add composer rows' });

			assert.strictEqual(api.git.getCommitMessage(), 'feat(panel): add composer rows');
		});

		test('a body is separated from the header by a blank line', async () => {
			api.composer.update({ type: 'fix', scope: '', scopeSource: 'custom' });
			api.composer.update({ subject: 'handle detached HEAD', body: 'Fall back to no scope.' });

			assert.strictEqual(
				api.git.getCommitMessage(),
				'fix: handle detached HEAD\n\nFall back to no scope.',
			);
		});

		test('a breaking change adds the marker and the footer', async () => {
			api.composer.update({ type: 'feat', scope: '', scopeSource: 'custom' });
			api.composer.update({ subject: 'drop v1', isBreaking: true, breakingDescription: 'v1 is gone' });

			assert.strictEqual(api.git.getCommitMessage(), 'feat!: drop v1\n\nBREAKING CHANGE: v1 is gone');
		});

		test('refuses to overwrite a hand-typed commit box', async () => {
			api.composer.update({ type: 'feat', scope: '', scopeSource: 'custom', subject: 'first' });
			assert.strictEqual(api.composer.isOutOfSync, false);

			// Simulate the user typing directly into the Source Control box.
			const repository = api.git.activeRepository;
			assert.ok(repository);
			repository.inputBox.value = 'hand written message';

			api.composer.update({ subject: 'second' });

			assert.strictEqual(api.composer.isOutOfSync, true, 'the panel should have flagged itself out of sync');
			assert.strictEqual(repository.inputBox.value, 'hand written message', 'the manual text was clobbered');
		});

		test('reset clears the commit box and the out-of-sync warning', async () => {
			api.composer.update({ type: 'feat', scope: '', scopeSource: 'custom', subject: 'first' });

			const repository = api.git.activeRepository;
			assert.ok(repository);
			repository.inputBox.value = 'hand written message';
			api.composer.update({ subject: 'second' });
			assert.strictEqual(api.composer.isOutOfSync, true, 'precondition: the panel should be out of sync');

			api.composer.reset();

			// Reset used to skip the box while out of sync, then immediately re-raise
			// the warning it was meant to clear.
			assert.strictEqual(repository.inputBox.value, '', 'the commit box was not cleared');
			assert.strictEqual(api.composer.isOutOfSync, false, 'the warning survived a reset');
		});

		test('normal panel edits never raise the warning', async () => {
			// The everyday path: each edit rewrites the box, and the panel recognises
			// its own text next time round.
			api.composer.update({ type: 'feat', scope: '', scopeSource: 'custom' });
			api.composer.update({ subject: 'add export' });
			api.composer.update({ scope: 'api', scopeSource: 'custom' });
			api.composer.update({ body: 'Some context.' });
			api.composer.update({ isBreaking: true, breakingDescription: 'v1 gone' });

			assert.strictEqual(api.composer.isOutOfSync, false, 'editing the panel should never look like a hand edit');
			assert.strictEqual(
				api.git.getCommitMessage(),
				'feat(api)!: add export\n\nSome context.\n\nBREAKING CHANGE: v1 gone',
			);
		});

		test('trailing whitespace in the box is not treated as a hand edit', async () => {
			api.composer.update({ type: 'feat', scope: '', scopeSource: 'custom', subject: 'add export' });

			const repository = api.git.activeRepository;
			assert.ok(repository);
			repository.inputBox.value = 'feat: add export\n';

			api.composer.update({ subject: 'add export twice' });

			assert.strictEqual(api.composer.isOutOfSync, false, 'a stray newline should not trip the warning');
			assert.strictEqual(repository.inputBox.value, 'feat: add export twice');
		});

		test('remembers what it wrote across a reload', async () => {
			api.composer.update({ type: 'feat', scope: '', scopeSource: 'custom', subject: 'add export' });
			const key = api.git.activeRepositoryKey;
			assert.ok(key);

			// The value is persisted, not just held in memory, so a fresh session can
			// still recognise the commit box VS Code restores alongside it.
			assert.strictEqual(api.drafts.getLastWritten(key), 'feat: add export');
		});

		test('clearing the box by hand lets sync resume', async () => {
			api.composer.update({ type: 'feat', scope: '', scopeSource: 'custom', subject: 'first' });

			const repository = api.git.activeRepository;
			assert.ok(repository);
			repository.inputBox.value = 'hand written message';
			api.composer.update({ subject: 'second' });
			assert.strictEqual(api.composer.isOutOfSync, true);

			// The Git API exposes no change event for the input box, so the panel only
			// finds out on the next re-check — which is what becoming visible triggers.
			repository.inputBox.value = '';
			api.composer.recheckSync();

			assert.strictEqual(api.composer.isOutOfSync, false, 'sync did not resume after the box was cleared');
			assert.strictEqual(repository.inputBox.value, 'feat: second');
		});

		test('derives the scope from the current branch', async function () {
			const branch = api.git.branchName;
			if (!branch) {
				// A repository with an unborn HEAD reports no branch.
				this.skip();
			}

			const configuration = vscode.workspace.getConfiguration('conventionalCommitPanel');
			const previous = configuration.get<string[]>('scope.ignoreBranches');

			// Neutralise the ignore list so whatever branch the tests run on produces
			// a suggestion, rather than the assertion depending on the branch name.
			await configuration.update('scope.ignoreBranches', [], vscode.ConfigurationTarget.Global);
			try {
				api.composer.reset();
				await api.composer.refresh();

				assert.deepStrictEqual(api.composer.branchScopes().length > 0, true, 'no scope derived from the branch');
				assert.strictEqual(api.composer.draft.scope, api.composer.branchScopes()[0]);
				assert.strictEqual(api.composer.draft.scopeSource, 'branch');
			} finally {
				await configuration.update('scope.ignoreBranches', previous, vscode.ConfigurationTarget.Global);
			}
		});

		test('an ignored branch is still offered as a chip, just never auto-filled', async function () {
			const branch = api.git.branchName;
			if (!branch) {
				this.skip();
			}

			const configuration = vscode.workspace.getConfiguration('conventionalCommitPanel');
			const previous = configuration.get<string[]>('scope.ignoreBranches');

			await configuration.update('scope.ignoreBranches', [branch], vscode.ConfigurationTarget.Global);
			try {
				api.composer.reset();
				await api.composer.refresh();

				// Auto-fill and offering are separate concerns: an ignored branch must
				// not land in a commit on its own, but it should still be one click away.
				assert.deepStrictEqual(api.composer.branchScopes(), [], 'an ignored branch was auto-filled');
				assert.strictEqual(api.composer.draft.scope, undefined);
				assert.strictEqual(
					api.composer.branchScopeSuggestions().includes(branch as string),
					true,
					'an ignored branch should still be offered as a suggestion',
				);
			} finally {
				await configuration.update('scope.ignoreBranches', previous, vscode.ConfigurationTarget.Global);
			}
		});

		test('typing a scope does not add it to the suggestions', async () => {
			api.drafts.clearRecentScopes();

			// setScope fires on every debounced keystroke, so recording there banked
			// each half-typed prefix as a permanent suggestion chip that clearing the
			// field could not remove.
			for (const partial of ['a', 'ap', 'api']) {
				api.composer.update({ scope: partial, scopeSource: 'custom' });
			}

			assert.deepStrictEqual(api.composer.getRecentScopes(), []);
		});

		test('clearing the scope leaves no suggestion behind', async () => {
			api.drafts.clearRecentScopes();

			api.composer.update({ scope: 'throwaway', scopeSource: 'custom' });
			api.composer.update({ scope: '', scopeSource: 'custom' });

			assert.strictEqual(
				api.composer.getRecentScopes().includes('throwaway'),
				false,
				'an abandoned scope should not linger as a suggestion',
			);
		});

		test('clearRecentScopes empties the list', async () => {
			api.drafts.rememberScope('api');
			assert.ok(api.composer.getRecentScopes().length > 0);

			api.composer.clearRecentScopes();

			assert.deepStrictEqual(api.composer.getRecentScopes(), []);
		});

		test('a scope the user chose survives a config refresh', async () => {
			api.composer.update({ scope: 'handpicked', scopeSource: 'custom' });
			await api.composer.refresh();

			assert.strictEqual(api.composer.draft.scope, 'handpicked');
			assert.strictEqual(api.composer.draft.scopeSource, 'custom');
		});

		test('reports the semver impact the panel shows next to the toggle', async () => {
			api.composer.update({ type: 'feat', subject: 'add export' });
			assert.strictEqual(api.composer.semver, 'minor');

			api.composer.update({ isBreaking: true });
			assert.strictEqual(api.composer.semver, 'major');
		});

		test('surfaces the problems the panel renders under the subject', async () => {
			api.composer.update({ subject: 'no type chosen' });
			assert.strictEqual(
				api.composer.problems.some((problem) => problem.field === 'type'),
				true,
			);

			api.composer.update({ type: 'feat' });
			assert.deepStrictEqual(api.composer.problems, []);
		});

		test('refuses to commit until the draft is complete and something is staged', async () => {
			assert.strictEqual(api.composer.canCommit, false, 'an empty draft should not be committable');

			api.composer.update({ type: 'feat', subject: 'add export' });

			// The suite does not stage anything, so this asserts the staging guard
			// rather than the message being valid.
			assert.strictEqual(api.composer.canCommit, api.composer.stagedCount > 0);
		});

		test('counts staged and changed files for the footer', async () => {
			assert.strictEqual(typeof api.composer.stagedCount, 'number');
			assert.strictEqual(typeof api.composer.changedCount, 'number');
			assert.ok(api.composer.changedCount >= api.composer.stagedCount);
		});

		test('selecting the custom card stays selected with no value typed', async () => {
			api.composer.setType('feat');
			assert.strictEqual(api.composer.isCustomType, false);

			api.composer.activateCustomType();

			// The whole point of the customTypeActive flag: an empty custom type must
			// not read as "nothing chosen", or the card would un-highlight itself and
			// the input field would vanish on the next render.
			assert.strictEqual(api.composer.isCustomType, true);
			assert.strictEqual(api.composer.draft.type, undefined);
		});

		test('a custom type keeps the custom card selected', async () => {
			api.composer.activateCustomType();
			api.composer.setCustomType('deps');

			assert.strictEqual(api.composer.isCustomType, true);
			assert.strictEqual(api.composer.draft.type, 'deps');
			// Asserted on the rendered header rather than the commit box, which an
			// earlier test in this suite deliberately leaves out of sync.
			assert.strictEqual(api.composer.renderHeaderLine().startsWith('deps'), true);
		});

		test('picking a listed type leaves custom mode', async () => {
			api.composer.activateCustomType();
			api.composer.setCustomType('deps');
			assert.strictEqual(api.composer.isCustomType, true);

			api.composer.setType('fix');

			assert.strictEqual(api.composer.isCustomType, false);
			assert.strictEqual(api.composer.draft.type, 'fix');
		});

		test('a type not on the list implies custom mode after a reload', async () => {
			// Simulates a restored draft, where customTypeActive was never set.
			api.composer.update({ type: 'deps', customTypeActive: undefined });
			assert.strictEqual(api.composer.isCustomType, true);
		});

		test('re-selecting custom keeps a value already typed', async () => {
			api.composer.activateCustomType();
			api.composer.setCustomType('deps');

			api.composer.activateCustomType();

			assert.strictEqual(api.composer.draft.type, 'deps');
		});

		test('honours conventionalCommitPanel.scope.required', async () => {
			const configuration = vscode.workspace.getConfiguration('conventionalCommitPanel');
			const previous = configuration.get<boolean>('scope.required');

			await configuration.update('scope.required', true, vscode.ConfigurationTarget.Global);
			try {
				await api.composer.refresh();
				api.composer.update({ type: 'feat', subject: 'add export', scope: '', scopeSource: 'custom' });

				assert.strictEqual(
					api.composer.problems.some((problem) => problem.field === 'scope'),
					true,
					'an empty scope should be an error when scope.required is on',
				);

				api.composer.update({ scope: 'api', scopeSource: 'custom' });
				assert.deepStrictEqual(api.composer.problems, []);
			} finally {
				await configuration.update('scope.required', previous, vscode.ConfigurationTarget.Global);
			}
		});

		test('an explicit apply overwrites the box and clears the warning', async () => {
			api.composer.update({ type: 'chore', scope: '', scopeSource: 'custom', subject: 'tidy up' });

			const repository = api.git.activeRepository;
			assert.ok(repository);
			repository.inputBox.value = 'hand written message';
			api.composer.update({ subject: 'tidy up more' });
			assert.strictEqual(api.composer.isOutOfSync, true);

			api.composer.applyToInputBox();

			assert.strictEqual(api.composer.isOutOfSync, false);
			assert.strictEqual(repository.inputBox.value, 'chore: tidy up more');
		});
	});
});
