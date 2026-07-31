import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out-test/test/integration/**/*.test.js',
	// The extension's own folder is a Git repository, so the Git extension has
	// something real to report while the integration tests run.
	workspaceFolder: '.',
	mocha: { ui: 'tdd', timeout: 60000 },
});
