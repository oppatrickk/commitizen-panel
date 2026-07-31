const fs = require('fs');
const path = require('path');

/**
 * Copies VS Code's icon font into `media/` so the panel can use the same glyphs
 * as the rest of the workbench.
 *
 * A webview cannot reach node_modules — `localResourceRoots` is limited to
 * `media/` — so the font and its stylesheet have to physically live there. The
 * copy is a build artifact and is gitignored, which is why this runs ahead of the
 * tests as well as the build: a clean checkout has no `media/codicons/`, and the
 * webview contract test asserts against the real font file.
 */
function copyCodicons() {
	const from = path.join(__dirname, '..', 'node_modules', '@vscode', 'codicons', 'dist');
	const to = path.join(__dirname, '..', 'media', 'codicons');

	if (!fs.existsSync(from)) {
		console.warn('[assets] @vscode/codicons is not installed; run npm install');
		return false;
	}

	fs.mkdirSync(to, { recursive: true });
	for (const file of ['codicon.css', 'codicon.ttf']) {
		fs.copyFileSync(path.join(from, file), path.join(to, file));
	}
	return true;
}

module.exports = { copyCodicons };

if (require.main === module) {
	copyCodicons();
}
