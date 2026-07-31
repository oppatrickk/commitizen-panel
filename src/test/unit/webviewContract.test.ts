import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/**
 * Guards the seam between the webview's HTML and its script.
 *
 * The HTML lives in `src/panel.ts` and the script in `media/panel.js`, so nothing
 * type-checks across the two. A renamed id makes `getElementById` return null and
 * the panel dies at runtime with no compile error and no failing test — this
 * closes that gap by reading both files as text and comparing them.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PANEL_TS = path.join(ROOT, 'src', 'panel.ts');
const PANEL_JS = path.join(ROOT, 'media', 'panel.js');
const PANEL_CSS = path.join(ROOT, 'media', 'panel.css');

function read(file: string): string {
	return fs.readFileSync(file, 'utf8');
}

function matchAll(source: string, pattern: RegExp): string[] {
	return [...source.matchAll(pattern)].map((match) => match[1]);
}

describe('webview contract', () => {
	const html = read(PANEL_TS);
	const script = read(PANEL_JS);
	const css = read(PANEL_CSS);

	const htmlIds = new Set(matchAll(html, /\bid="([^"]+)"/g));

	it('panel.js parses', () => {
		// Nothing else checks this file: esbuild never touches media/, tsc ignores
		// .js, and eslint is scoped to src/. A syntax error here would ship happily
		// and leave the panel blank at runtime. `vm.Script` compiles without running.
		assert.doesNotThrow(() => new vm.Script(script, { filename: PANEL_JS }));
	});

	it('references the codicon stylesheet that ships in media/', () => {
		assert.ok(html.includes("'codicons', 'codicon.css'"), 'the HTML does not link codicon.css');

		const font = path.join(ROOT, 'media', 'codicons', 'codicon.ttf');
		assert.ok(fs.existsSync(font), 'codicon.ttf is missing — run the build to copy it into media/');
	});

	it('allows the icon font in the content security policy', () => {
		assert.ok(/font-src \$\{webview\.cspSource\}/.test(html), 'CSP does not permit the icon font');
	});

	it('every codicon class used is defined by the shipped stylesheet', () => {
		const codiconCss = fs.readFileSync(path.join(ROOT, 'media', 'codicons', 'codicon.css'), 'utf8');
		const used = new Set([
			...matchAll(html, /codicon codicon-([a-z-]+)/g),
			...matchAll(script, /icon\('([a-z-]+)'\)/g),
			// Names held in constants rather than passed inline, which the call-site
			// pattern above cannot see.
			...matchAll(script, /_ICONS?\s*=\s*'([a-z-]+)'/g),
			...matchAll(script, /icon\(([a-z-]+)\s*\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g),
		]);

		assert.ok(used.size > 0, 'expected the panel to use codicons');
		const missing = [...used].filter((name) => !codiconCss.includes(`.codicon-${name}:before`));
		assert.deepStrictEqual(missing, [], `codicons that do not exist in the font: ${missing.join(', ')}`);
	});

	it('every getElementById target exists in the HTML', () => {
		const referenced = matchAll(script, /getElementById\('([^']+)'\)/g);
		assert.ok(referenced.length > 10, 'expected the script to look up several elements');

		const missing = referenced.filter((id) => !htmlIds.has(id));
		assert.deepStrictEqual(missing, [], `ids used in panel.js but absent from the HTML: ${missing.join(', ')}`);
	});

	it('every clear button targets a field that exists', () => {
		const targets = matchAll(html, /data-clears="([^"]+)"/g);
		assert.ok(targets.length >= 3, 'expected clear buttons on the text fields');

		const missing = targets.filter((id) => !htmlIds.has(id));
		assert.deepStrictEqual(missing, [], `clear buttons point at unknown fields: ${missing.join(', ')}`);
	});

	it('every clear button has a handler entry keyed by its field id', () => {
		const targets = matchAll(html, /data-clears="([^"]+)"/g);
		const handlerBlock = /const CLEAR_TARGETS = \{([\s\S]*?)\};/.exec(script);
		assert.ok(handlerBlock, 'CLEAR_TARGETS map not found in panel.js');

		for (const id of targets) {
			assert.ok(
				handlerBlock[1].includes(`${id}:`) || handlerBlock[1].includes(`'${id}':`),
				`no CLEAR_TARGETS entry for "${id}", so its clear button would post undefined`,
			);
		}
	});

	it('has no collapsible sections and no file lists', () => {
		// The built-in Source Control Changes section sits right below the panel, so
		// duplicating it here was removed; a stray leftover would be dead markup.
		for (const id of ['section-message', 'section-staged', 'section-changes', 'staged-list', 'changes-list']) {
			assert.strictEqual(htmlIds.has(id), false, `leftover element: ${id}`);
		}
		assert.strictEqual(html.includes('<details'), false, 'a <details> section is still in the HTML');
	});

	it('fills the height it is given, with the fields scrolling under a pinned footer', () => {
		assert.ok(/body\s*\{[^}]*height:\s*100vh/.test(css), 'body does not fill the view height');
		assert.ok(/\.composer\s*\{[^}]*overflow-y:\s*auto/.test(css), 'the fields do not scroll');
		// The footer must be a sibling of the scrolling area, not inside it, or
		// Commit scrolls away with everything else.
		assert.ok(/<\/div>\s*<footer/.test(html), 'the footer is nested inside the scrolling composer');
	});

	it('uses the workbench UI font for chrome and the commit-box font for the message', () => {
		// Mixing the monospace editor face into labels and chips is what made the
		// panel look unlike the rest of the Source Control view.
		assert.strictEqual(
			/font-family:\s*var\(--vscode-editor-font-family\)/.test(css.replace(/--cz-message-font:[^;]+;/, '')),
			false,
			'the editor font is still applied directly outside the message font token',
		);
		assert.ok(css.includes('--cz-ui-font: var(--vscode-font-family)'), 'no UI font token');
		assert.ok(/\.text-input\s*\{[^}]*font-family:\s*var\(--cz-message-font\)/.test(css));
		assert.ok(/\.preview-body\s*\{[^}]*font-family:\s*var\(--cz-message-font\)/.test(css));
	});

	it('has no commit-box sync warning left behind', () => {
		for (const leftover of ['sync-warning', 'sync-apply']) {
			assert.strictEqual(htmlIds.has(leftover), false, `leftover element: ${leftover}`);
			assert.strictEqual(css.includes(`.${leftover}`), false, `leftover style: .${leftover}`);
			assert.strictEqual(script.includes(leftover), false, `leftover script reference: ${leftover}`);
		}
	});

	it('types a custom type in the card itself, not a separate field', () => {
		assert.strictEqual(htmlIds.has('custom-type-wrap'), false, 'the separate custom field is still in the HTML');
		assert.ok(script.includes("input.className = 'type-input'"), 'the custom card has no inline input');
		assert.ok(css.includes('.type-input'), 'the inline custom input has no styling');
	});

	it('every class the script applies has a rule in the stylesheet', () => {
		// Catches a class renamed in one file but not the other.
		const applied = new Set([
			...matchAll(script, /className = '([a-z-]+)'/g),
			...matchAll(script, /classList\.add\('([a-z-]+)'\)/g),
		]);

		const missing = [...applied].filter((name) => !css.includes(`.${name}`));
		assert.deepStrictEqual(missing, [], `classes set by panel.js with no CSS rule: ${missing.join(', ')}`);
	});

	it('the script never builds markup from strings', () => {
		// User-controlled text (branch names, scopes, subjects) flows into these
		// nodes, so it must always go through textContent.
		assert.strictEqual(/\.innerHTML\s*=/.test(script), false, 'panel.js assigns innerHTML');
		assert.strictEqual(/insertAdjacentHTML/.test(script), false, 'panel.js uses insertAdjacentHTML');
	});

	it('the content security policy denies everything by default and allows no inline script', () => {
		assert.ok(html.includes("\"default-src 'none'\""), 'CSP does not start from default-src none');
		assert.ok(html.includes("script-src 'nonce-"), 'scripts are not nonce-restricted');
		assert.strictEqual(html.includes("'unsafe-inline'"), false, 'CSP allows unsafe-inline');
		assert.strictEqual(html.includes("'unsafe-eval'"), false, 'CSP allows unsafe-eval');
	});
});
