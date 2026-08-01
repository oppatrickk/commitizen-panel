import { execFile } from 'child_process';
import * as vscode from 'vscode';
import * as jsonc from 'jsonc-parser';
import * as yaml from 'yaml';
import {
	BUILT_IN_CONFIG,
	CommitConfig,
	emojiForType,
	parseCommitlintConfig,
	parseCzCustomizable,
	parseCzrc,
	parseSettingsTypes,
	resolveConfig,
} from './config';
import type { FormatOptions } from './format';
import type { CommitDraft } from './model';

/** Filenames probed for a cz-customizable config, in order. */
const CZ_CONFIG_FILES = ['.cz-config.js', '.cz-config.cjs', 'cz-config.js', '.cz-config.json'];
const CZRC_FILES = ['.czrc', '.cz.json'];
const COMMITLINT_FILES = [
	'commitlint.config.js',
	'commitlint.config.cjs',
	'commitlint.config.mjs',
	'.commitlintrc',
	'.commitlintrc.json',
	'.commitlintrc.yml',
	'.commitlintrc.yaml',
];

const WATCH_GLOB = `{${[...CZ_CONFIG_FILES, ...CZRC_FILES, ...COMMITLINT_FILES, 'package.json'].join(',')}}`;

/** A repository config should never be able to hang the panel. */
const JS_CONFIG_TIMEOUT_MS = 5000;
const JS_CONFIG_MAX_BUFFER = 1024 * 1024;

/**
 * Loads commit-type configuration from the repository, the VS Code settings, or
 * the built-in list — whichever comes first.
 *
 * Executing a repository's JavaScript config means running code from the repo, so
 * it is off unless the user opts in *and* the workspace is trusted, and it happens
 * in a short-lived child process rather than inside the extension host.
 */
export class ConfigService implements vscode.Disposable {
	private readonly cache = new Map<string, CommitConfig>();
	private readonly toolingCache = new Map<string, string[]>();
	private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
	private readonly promptedRoots = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];

	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('conventionalCommitPanel')) {
					this.cache.clear();
					this.toolingCache.clear();
					this.onDidChangeEmitter.fire();
				}
			}),
			vscode.workspace.onDidGrantWorkspaceTrust(() => {
				this.cache.clear();
				this.toolingCache.clear();
				this.onDidChangeEmitter.fire();
			}),
		);
	}

	/** Cached per repository root; the file watcher invalidates on config edits. */
	async getConfig(repoRoot: vscode.Uri | undefined): Promise<CommitConfig> {
		if (!repoRoot) {
			return this.settingsOrBuiltIn();
		}

		const key = repoRoot.toString();
		const cached = this.cache.get(key);
		if (cached) {
			return cached;
		}

		this.ensureWatcher(repoRoot);

		const config = resolveConfig([
			await this.loadCzCustomizable(repoRoot),
			await this.loadCommitlint(repoRoot),
			parseSettingsTypes(this.setting<unknown[]>('types', [])),
		]);

		this.cache.set(key, config);
		return config;
	}

	/**
	 * Detects commit tooling the repository already uses, shown as badges in the
	 * panel footer so it is obvious which hooks will run on commit.
	 */
	async detectTooling(repoRoot: vscode.Uri | undefined): Promise<string[]> {
		if (!repoRoot) {
			return [];
		}

		const key = repoRoot.toString();
		const cached = this.toolingCache.get(key);
		if (cached) {
			return cached;
		}

		const tooling: string[] = [];
		if (await this.exists(vscode.Uri.joinPath(repoRoot, '.husky'))) {
			tooling.push('husky');
		}

		const config = await this.getConfig(repoRoot);
		if (config.source === 'commitlint') {
			tooling.push('commitlint');
		} else {
			for (const file of COMMITLINT_FILES) {
				if (await this.exists(vscode.Uri.joinPath(repoRoot, file))) {
					tooling.push('commitlint');
					break;
				}
			}
		}

		this.toolingCache.set(key, tooling);
		return tooling;
	}

	/** Combines the resolved config with user settings into rendering options. */
	getFormatOptions(config: CommitConfig, draft: CommitDraft): FormatOptions {
		const options: FormatOptions = {
			// A commitlint/cz config in the repo is more authoritative than the
			// user's global preference, so it wins when present.
			headerMaxLength: config.headerMaxLength ?? this.setting<number>('headerMaxLength', 72),
			bodyLineLength: this.setting<number>('bodyLineLength', 72),
		};

		if (this.setting<boolean>('useEmoji', false)) {
			const emoji = emojiForType(config, draft.type);
			if (emoji) {
				options.emoji = emoji;
			}
		}

		return options;
	}

	setting<T>(key: string, fallback: T): T {
		return vscode.workspace.getConfiguration('conventionalCommitPanel').get<T>(key, fallback);
	}

	private settingsOrBuiltIn(): CommitConfig {
		return resolveConfig([parseSettingsTypes(this.setting<unknown[]>('types', []))]) ?? BUILT_IN_CONFIG;
	}

	// --- cz-customizable ----------------------------------------------------

	private async loadCzCustomizable(repoRoot: vscode.Uri): Promise<CommitConfig | undefined> {
		for (const candidate of await this.czConfigCandidates(repoRoot)) {
			const raw = await this.loadModule(repoRoot, candidate);
			const parsed = parseCzCustomizable(raw);
			if (parsed) {
				return parsed;
			}
		}
		return undefined;
	}

	/**
	 * `.czrc` may point at a non-default config path, so it is consulted first to
	 * build the candidate list rather than being a separate precedence rung.
	 */
	private async czConfigCandidates(repoRoot: vscode.Uri): Promise<vscode.Uri[]> {
		const candidates: vscode.Uri[] = [];

		for (const file of CZRC_FILES) {
			const uri = vscode.Uri.joinPath(repoRoot, file);
			const raw = await this.readJson(uri);
			const { czCustomizablePath } = parseCzrc(raw);
			if (czCustomizablePath) {
				candidates.push(vscode.Uri.joinPath(repoRoot, czCustomizablePath));
			}
		}

		const packageJson = await this.readJson(vscode.Uri.joinPath(repoRoot, 'package.json'));
		if (packageJson && typeof packageJson === 'object') {
			const config = (packageJson as Record<string, unknown>).config;
			if (config && typeof config === 'object') {
				const { czCustomizablePath } = parseCzrc((config as Record<string, unknown>).commitizen);
				if (czCustomizablePath) {
					candidates.push(vscode.Uri.joinPath(repoRoot, czCustomizablePath));
				}
			}
		}

		for (const file of CZ_CONFIG_FILES) {
			candidates.push(vscode.Uri.joinPath(repoRoot, file));
		}

		return candidates;
	}

	// --- commitlint ---------------------------------------------------------

	private async loadCommitlint(repoRoot: vscode.Uri): Promise<CommitConfig | undefined> {
		for (const file of COMMITLINT_FILES) {
			const uri = vscode.Uri.joinPath(repoRoot, file);
			const raw = await this.loadModule(repoRoot, uri);
			const parsed = parseCommitlintConfig(raw);
			if (parsed) {
				return parsed;
			}
		}
		return undefined;
	}

	// --- loading primitives -------------------------------------------------

	/** Dispatches on extension: data files are parsed, code files are executed. */
	private async loadModule(repoRoot: vscode.Uri, uri: vscode.Uri): Promise<unknown> {
		const path = uri.path.toLowerCase();

		if (path.endsWith('.js') || path.endsWith('.cjs') || path.endsWith('.mjs')) {
			return this.loadJsConfig(repoRoot, uri);
		}
		if (path.endsWith('.yml') || path.endsWith('.yaml')) {
			return this.readYaml(uri);
		}
		return this.readJson(uri);
	}

	private async readJson(uri: vscode.Uri): Promise<unknown> {
		const text = await this.readText(uri);
		if (text === undefined) {
			return undefined;
		}

		const errors: jsonc.ParseError[] = [];
		const parsed = jsonc.parse(text, errors, { allowTrailingComma: true });
		return errors.length > 0 && parsed === undefined ? undefined : parsed;
	}

	private async readYaml(uri: vscode.Uri): Promise<unknown> {
		const text = await this.readText(uri);
		if (text === undefined) {
			return undefined;
		}

		try {
			return yaml.parse(text);
		} catch {
			return undefined;
		}
	}

	private async readText(uri: vscode.Uri): Promise<string | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return Buffer.from(bytes).toString('utf8');
		} catch {
			return undefined;
		}
	}

	private async exists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Evaluates a JS config in a child process and reads back JSON.
	 *
	 * Gated on workspace trust and an explicit opt-in. The child is spawned from
	 * `process.execPath` with `ELECTRON_RUN_AS_NODE` set, because in the desktop
	 * extension host that path is the Electron binary rather than a plain node.
	 */
	private async loadJsConfig(repoRoot: vscode.Uri, uri: vscode.Uri): Promise<unknown> {
		if (uri.scheme !== 'file' || !(await this.exists(uri))) {
			return undefined;
		}

		if (!vscode.workspace.isTrusted) {
			return undefined;
		}

		if (!this.setting<boolean>('config.allowJsConfig', false)) {
			void this.promptForJsConfig(repoRoot, uri);
			return undefined;
		}

		const script = `
			const path = process.env.COMMITIZEN_CONFIG_PATH;
			function emit(value) {
				const resolved = value && value.__esModule && value.default ? value.default : value;
				process.stdout.write(JSON.stringify(resolved === undefined ? null : resolved));
			}
			(async () => {
				try {
					emit(require(path));
				} catch (error) {
					if (error && (error.code === 'ERR_REQUIRE_ESM' || error.code === 'ERR_REQUIRE_ASYNC_MODULE')) {
						const module = await import(require('url').pathToFileURL(path).href);
						emit(module.default === undefined ? module : module.default);
					} else {
						throw error;
					}
				}
			})().catch((error) => {
				process.stderr.write(String(error && error.message ? error.message : error));
				process.exit(1);
			});
		`;

		try {
			const stdout = await new Promise<string>((resolve, reject) => {
				execFile(
					process.execPath,
					['-e', script],
					{
						cwd: repoRoot.fsPath,
						timeout: JS_CONFIG_TIMEOUT_MS,
						maxBuffer: JS_CONFIG_MAX_BUFFER,
						env: {
							...process.env,
							ELECTRON_RUN_AS_NODE: '1',
							COMMITIZEN_CONFIG_PATH: uri.fsPath,
						},
					},
					(error, out) => (error ? reject(error) : resolve(out)),
				);
			});

			return stdout.trim() ? JSON.parse(stdout) : undefined;
		} catch {
			// A broken repository config is the repository's problem — fall through
			// to the next precedence rung rather than surfacing an error dialog.
			return undefined;
		}
	}

	private async promptForJsConfig(repoRoot: vscode.Uri, uri: vscode.Uri): Promise<void> {
		const key = repoRoot.toString();
		if (this.promptedRoots.has(key)) {
			return;
		}
		this.promptedRoots.add(key);

		const enable = 'Enable';
		const choice = await vscode.window.showInformationMessage(
			`Conventional Commit Panel found ${basename(uri)} in this repository. Loading it runs JavaScript from the workspace.`,
			enable,
			'Not Now',
		);

		if (choice === enable) {
			await vscode.workspace
				.getConfiguration('conventionalCommitPanel')
				.update('config.allowJsConfig', true, vscode.ConfigurationTarget.Workspace);
		}
	}

	private ensureWatcher(repoRoot: vscode.Uri): void {
		const key = repoRoot.toString();
		if (this.watchers.has(key)) {
			return;
		}

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoRoot, WATCH_GLOB));
		const invalidate = () => {
			this.cache.delete(key);
			this.toolingCache.delete(key);
			this.onDidChangeEmitter.fire();
		};

		watcher.onDidCreate(invalidate);
		watcher.onDidChange(invalidate);
		watcher.onDidDelete(invalidate);

		this.watchers.set(key, watcher);
	}

	dispose(): void {
		for (const watcher of this.watchers.values()) {
			watcher.dispose();
		}
		this.watchers.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.onDidChangeEmitter.dispose();
	}
}

function basename(uri: vscode.Uri): string {
	const parts = uri.path.split('/');
	return parts[parts.length - 1] || uri.path;
}
