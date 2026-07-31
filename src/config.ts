/**
 * Parsing and merging of commit-type configuration.
 *
 * Only pure functions live here — no `vscode` and no file system — so the whole
 * precedence chain can be unit-tested without an extension host. The I/O side
 * (locating files, executing JS configs, caching) is in `configLoader.ts`.
 */

export interface CommitType {
	value: string;
	name?: string;
	/** Terse label for the panel's type grid, e.g. "New capability". */
	short?: string;
	description?: string;
	emoji?: string;
}

export type ConfigSource = 'cz-config' | 'czrc' | 'commitlint' | 'settings' | 'built-in';

export interface CommitConfig {
	types: CommitType[];
	scopes: string[];
	allowCustomScopes: boolean;
	/** Field keys the repo config asks to skip, e.g. `['scope', 'body']`. */
	skipQuestions: string[];
	headerMaxLength?: number;
	source: ConfigSource;
}

/**
 * The Conventional Commits type list, used when nothing else is configured.
 *
 * `short` is the two-or-three-word label the panel's type grid shows; `description`
 * is the fuller sentence used where there is room for it, such as the wizard's
 * QuickPick detail line.
 */
export const BUILT_IN_TYPES: CommitType[] = [
	{ value: 'feat', name: 'feat', short: 'New capability', description: 'A new feature', emoji: '✨' },
	{ value: 'fix', name: 'fix', short: 'Bug fix', description: 'A bug fix', emoji: '🐛' },
	{ value: 'docs', name: 'docs', short: 'Documentation', description: 'Documentation only changes', emoji: '📝' },
	{
		value: 'refactor',
		name: 'refactor',
		short: 'No behavior change',
		description: 'A code change that neither fixes a bug nor adds a feature',
		emoji: '♻️',
	},
	{
		value: 'perf',
		name: 'perf',
		short: 'Faster or lighter',
		description: 'A code change that improves performance',
		emoji: '⚡️',
	},
	{
		value: 'test',
		name: 'test',
		short: 'Tests only',
		description: 'Adding missing tests or correcting existing ones',
		emoji: '✅',
	},
	{
		value: 'style',
		name: 'style',
		short: 'Formatting',
		description: 'Changes that do not affect meaning (formatting, white-space, semicolons)',
		emoji: '💄',
	},
	{
		value: 'build',
		name: 'build',
		short: 'Build / deps',
		description: 'Changes to the build system or external dependencies',
		emoji: '📦',
	},
	{
		value: 'ci',
		name: 'ci',
		short: 'Pipeline config',
		description: 'Changes to CI configuration files and scripts',
		emoji: '👷',
	},
	{
		value: 'chore',
		name: 'chore',
		short: 'Maintenance',
		description: "Other changes that don't modify src or test files",
		emoji: '🔧',
	},
	{ value: 'revert', name: 'revert', short: 'Undo a commit', description: 'Reverts a previous commit', emoji: '⏪' },
];

export const BUILT_IN_CONFIG: CommitConfig = {
	types: BUILT_IN_TYPES,
	scopes: [],
	allowCustomScopes: true,
	skipQuestions: [],
	source: 'built-in',
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accepts the several shapes a type list appears in across ecosystems:
 * plain strings (commitlint `type-enum`) and `{ value, name, description }`
 * objects (cz-customizable, where `name` is the whole `"feat:  A new feature"`
 * display string).
 */
export function normalizeTypes(raw: unknown): CommitType[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const types: CommitType[] = [];
	for (const entry of raw) {
		if (typeof entry === 'string') {
			const value = entry.trim();
			if (value) {
				types.push(withBuiltInMetadata({ value }));
			}
			continue;
		}

		if (!isRecord(entry)) {
			continue;
		}

		const value = typeof entry.value === 'string' ? entry.value.trim() : '';
		if (!value) {
			continue;
		}

		const type: CommitType = { value };
		if (typeof entry.name === 'string' && entry.name.trim()) {
			// cz-customizable packs "feat:  A new feature" into `name`; split it so the
			// picker gets a clean label and a separate detail line.
			const { label, detail } = splitCzName(entry.name.trim(), value);
			type.name = label;
			if (detail) {
				type.description = detail;
			}
		}
		if (typeof entry.description === 'string' && entry.description.trim()) {
			type.description = entry.description.trim();
		}
		if (typeof entry.short === 'string' && entry.short.trim()) {
			type.short = entry.short.trim();
		}
		if (typeof entry.emoji === 'string' && entry.emoji.trim()) {
			type.emoji = entry.emoji.trim();
		}

		types.push(withBuiltInMetadata(type));
	}

	return types;
}

/** Fills in description/emoji from the built-in table when the config omits them. */
function withBuiltInMetadata(type: CommitType): CommitType {
	const builtIn = BUILT_IN_TYPES.find((candidate) => candidate.value === type.value);
	if (!builtIn) {
		return { ...type, name: type.name ?? type.value };
	}

	return {
		value: type.value,
		name: type.name ?? builtIn.name ?? type.value,
		short: type.short ?? builtIn.short,
		description: type.description ?? builtIn.description,
		emoji: type.emoji ?? builtIn.emoji,
	};
}

function splitCzName(name: string, value: string): { label: string; detail?: string } {
	if (name.startsWith(`${value}:`)) {
		const detail = name.slice(value.length + 1).trim();
		return detail ? { label: value, detail } : { label: value };
	}
	return { label: name };
}

/** Accepts `['api', 'ui']` or cz-customizable's `[{ name: 'api' }]`. */
export function normalizeScopes(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const scopes: string[] = [];
	for (const entry of raw) {
		if (typeof entry === 'string' && entry.trim()) {
			scopes.push(entry.trim());
		} else if (isRecord(entry) && typeof entry.name === 'string' && entry.name.trim()) {
			scopes.push(entry.name.trim());
		}
	}

	return [...new Set(scopes)];
}

/**
 * Parses a `cz-customizable` config object
 * (`{ types, scopes, allowCustomScopes, skipQuestions, subjectLimit }`).
 */
export function parseCzCustomizable(raw: unknown): CommitConfig | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}

	const types = normalizeTypes(raw.types);
	if (types.length === 0) {
		return undefined;
	}

	const config: CommitConfig = {
		types,
		scopes: normalizeScopes(raw.scopes),
		allowCustomScopes: raw.allowCustomScopes !== false,
		skipQuestions: Array.isArray(raw.skipQuestions)
			? raw.skipQuestions.filter((q): q is string => typeof q === 'string')
			: [],
		source: 'cz-config',
	};

	if (typeof raw.subjectLimit === 'number' && raw.subjectLimit > 0) {
		config.headerMaxLength = raw.subjectLimit;
	}

	return config;
}

/**
 * Parses a commitlint config, reading `type-enum`, `scope-enum` and
 * `header-max-length` out of `rules`. Rule values are `[level, applicable, value]`.
 */
export function parseCommitlintConfig(raw: unknown): CommitConfig | undefined {
	if (!isRecord(raw) || !isRecord(raw.rules)) {
		return undefined;
	}

	const rules = raw.rules;
	const types = normalizeTypes(ruleValue(rules['type-enum']));
	if (types.length === 0) {
		return undefined;
	}

	const config: CommitConfig = {
		types,
		scopes: normalizeScopes(ruleValue(rules['scope-enum'])),
		allowCustomScopes: true,
		skipQuestions: [],
		source: 'commitlint',
	};

	const headerMax = ruleValue(rules['header-max-length']);
	if (typeof headerMax === 'number' && headerMax > 0) {
		config.headerMaxLength = headerMax;
	}

	return config;
}

function ruleValue(rule: unknown): unknown {
	if (!Array.isArray(rule)) {
		return undefined;
	}
	// [level, applicable, value] — a disabled rule (level 0) carries no useful value.
	if (typeof rule[0] === 'number' && rule[0] === 0) {
		return undefined;
	}
	return rule[2];
}

/**
 * Reads a `.czrc` / `package.json#config.commitizen` block. These name an adapter
 * rather than carrying types directly; the only case worth following is
 * `cz-customizable`, which points at a separate config file.
 */
export function parseCzrc(raw: unknown): { adapter?: string; czCustomizablePath?: string } {
	if (!isRecord(raw)) {
		return {};
	}

	const result: { adapter?: string; czCustomizablePath?: string } = {};
	if (typeof raw.path === 'string' && raw.path.trim()) {
		result.adapter = raw.path.trim();
	}

	const nested = raw.config;
	if (isRecord(nested)) {
		const czCustomizable = nested['cz-customizable'];
		if (isRecord(czCustomizable) && typeof czCustomizable.config === 'string') {
			result.czCustomizablePath = czCustomizable.config;
		}
	}

	return result;
}

/** Builds a config from the `commitizen.types` VS Code setting. */
export function parseSettingsTypes(raw: unknown): CommitConfig | undefined {
	const types = normalizeTypes(raw);
	if (types.length === 0) {
		return undefined;
	}

	return {
		types,
		scopes: [],
		allowCustomScopes: true,
		skipQuestions: [],
		source: 'settings',
	};
}

/**
 * Applies the documented precedence: the first candidate that yields types wins,
 * falling back to the built-in Conventional Commits list.
 */
export function resolveConfig(candidates: Array<CommitConfig | undefined>): CommitConfig {
	for (const candidate of candidates) {
		if (candidate && candidate.types.length > 0) {
			return candidate;
		}
	}
	return BUILT_IN_CONFIG;
}

/** Looks up the emoji for a type, used when `commitizen.useEmoji` is on. */
export function emojiForType(config: CommitConfig, type: string | undefined): string | undefined {
	if (!type) {
		return undefined;
	}
	return config.types.find((candidate) => candidate.value === type)?.emoji;
}
