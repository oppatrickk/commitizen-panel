const esbuild = require('esbuild');
const { copyCodicons } = require('./scripts/copy-codicons');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
