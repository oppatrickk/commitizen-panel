import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

/**
 * VS Code opens a Unix domain socket under its user-data directory, and those
 * paths are capped at ~104 characters on macOS. The default lands inside the
 * checkout, and GitHub's macOS runners duplicate the repository name in the
 * workspace path (`work/<repo>/<repo>/…`), which put us over the limit and failed
 * with `EINVAL` before a single test ran. Keeping the user-data directory short
 * and outside the checkout avoids depending on how long the repo name happens to
 * be. Windows has no such limit, but a temp directory is fine there too.
 */
const userDataDir = process.platform === 'win32' ? join(tmpdir(), 'vsct') : '/tmp/vsct';

export default defineConfig({
	files: 'out-test/test/integration/**/*.test.js',
	// The extension's own folder is a Git repository, so the Git extension has
	// something real to report while the integration tests run.
	workspaceFolder: '.',
	launchArgs: ['--user-data-dir', userDataDir],
	mocha: { ui: 'tdd', timeout: 60000 },
});
