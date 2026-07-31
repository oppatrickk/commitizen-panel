const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Copies VS Code's icon font into `media/` so the panel can use the same glyphs
 * as the rest of the workbench.
 *
 * A webview cannot reach node_modules — `localResourceRoots` is limited to
 * `media/` — so the font and its stylesheet have to physically live there.
 */
function copyCodicons() {
	const from = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
	const to = path.join(__dirname, 'media', 'codicons');

	if (!fs.existsSync(from)) {
		console.warn('[build] @vscode/codicons is not installed; the panel will fall back to text glyphs');
		return;
	}

	fs.mkdirSync(to, { recursive: true });
	for (const file of ['codicon.css', 'codicon.ttf']) {
		fs.copyFileSync(path.join(from, file), path.join(to, file));
	}
}

/** Reports build problems in the format the VS Code problem matcher expects. */
const problemMatcherPlugin = {
	name: 'problem-matcher',
	setup(build) {
		build.onStart(() => console.log('[watch] build started'));
		build.onEnd((result) => {
			for (const { text, location } of result.errors) {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			}
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	copyCodicons();

	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		// platform:node defaults to ['main', 'module'], which pulls in jsonc-parser's
		// UMD build. That build resolves its internals through a dynamic require()
		// esbuild cannot follow, so the bundle throws "Cannot find module
		// './impl/format'" at load time. Preferring the ESM entry keeps every import
		// statically analysable.
		mainFields: ['module', 'main'],
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [problemMatcherPlugin],
	});

	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
