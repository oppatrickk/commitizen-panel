import * as assert from 'assert';
import {
	BUILT_IN_CONFIG,
	BUILT_IN_TYPES,
	CommitConfig,
	emojiForType,
	normalizeScopes,
	normalizeTypes,
	parseCommitlintConfig,
	parseCzCustomizable,
	parseCzrc,
	parseSettingsTypes,
	resolveConfig,
	resolveDefaultType,
} from '../../config';

describe('normalizeTypes', () => {
	it('accepts a plain string list and enriches known types', () => {
		const types = normalizeTypes(['feat', 'fix']);
		assert.deepStrictEqual(
			types.map((t) => t.value),
			['feat', 'fix'],
		);
		assert.strictEqual(types[0].description, 'A new feature');
		assert.strictEqual(types[0].emoji, '✨');
	});

	it('keeps unknown types without inventing metadata', () => {
		const [type] = normalizeTypes(['wip']);
		assert.strictEqual(type.value, 'wip');
		assert.strictEqual(type.name, 'wip');
		assert.strictEqual(type.description, undefined);
	});

	it('carries the built-in short label onto a repo-configured type', () => {
		const [type] = normalizeTypes([{ value: 'feat', name: 'feat: Ship it' }]);
		assert.strictEqual(type.short, 'New capability');
	});

	it("splits cz-customizable's combined name into label and detail", () => {
		const [type] = normalizeTypes([{ value: 'feat', name: 'feat:     A new feature' }]);
		assert.strictEqual(type.name, 'feat');
		assert.strictEqual(type.description, 'A new feature');
	});

	it('lets an explicit description win over the built-in one', () => {
		const [type] = normalizeTypes([{ value: 'feat', description: 'Ship something new' }]);
		assert.strictEqual(type.description, 'Ship something new');
	});

	it('skips malformed entries', () => {
		assert.deepStrictEqual(normalizeTypes([null, 42, {}, { value: '   ' }, '']), []);
	});

	it('returns nothing for a non-array', () => {
		assert.deepStrictEqual(normalizeTypes({ feat: true }), []);
	});
});

describe('normalizeScopes', () => {
	it('accepts strings and { name } objects, de-duplicated', () => {
		assert.deepStrictEqual(normalizeScopes(['api', { name: 'ui' }, 'api', { nope: 1 }]), ['api', 'ui']);
	});
});

describe('parseCzCustomizable', () => {
	it('reads types, scopes and skipQuestions', () => {
		const config = parseCzCustomizable({
			types: [{ value: 'feat', name: 'feat: A new feature' }],
			scopes: [{ name: 'api' }, { name: 'ui' }],
			allowCustomScopes: false,
			skipQuestions: ['body', 'footer'],
			subjectLimit: 100,
		});

		assert.ok(config);
		assert.strictEqual(config.source, 'cz-config');
		assert.deepStrictEqual(config.scopes, ['api', 'ui']);
		assert.strictEqual(config.allowCustomScopes, false);
		assert.deepStrictEqual(config.skipQuestions, ['body', 'footer']);
		assert.strictEqual(config.headerMaxLength, 100);
	});

	it('defaults allowCustomScopes to true', () => {
		const config = parseCzCustomizable({ types: ['feat'] });
		assert.strictEqual(config?.allowCustomScopes, true);
	});

	it('rejects a config with no usable types', () => {
		assert.strictEqual(parseCzCustomizable({ scopes: ['api'] }), undefined);
		assert.strictEqual(parseCzCustomizable(undefined), undefined);
		assert.strictEqual(parseCzCustomizable('not an object'), undefined);
	});
});

describe('parseCommitlintConfig', () => {
	it('reads type-enum, scope-enum and header-max-length', () => {
		const config = parseCommitlintConfig({
			rules: {
				'type-enum': [2, 'always', ['feat', 'fix', 'chore']],
				'scope-enum': [2, 'always', ['api', 'ui']],
				'header-max-length': [2, 'always', 100],
			},
		});

		assert.ok(config);
		assert.strictEqual(config.source, 'commitlint');
		assert.deepStrictEqual(
			config.types.map((t) => t.value),
			['feat', 'fix', 'chore'],
		);
		assert.deepStrictEqual(config.scopes, ['api', 'ui']);
		assert.strictEqual(config.headerMaxLength, 100);
	});

	it('ignores rules that are switched off', () => {
		const config = parseCommitlintConfig({
			rules: {
				'type-enum': [2, 'always', ['feat']],
				'header-max-length': [0, 'always', 100],
			},
		});

		assert.strictEqual(config?.headerMaxLength, undefined);
	});

	it('rejects a config without rules or types', () => {
		assert.strictEqual(parseCommitlintConfig({ extends: ['@commitlint/config-conventional'] }), undefined);
		assert.strictEqual(parseCommitlintConfig({ rules: {} }), undefined);
	});
});

describe('parseCzrc', () => {
	it('reads the adapter path', () => {
		assert.deepStrictEqual(parseCzrc({ path: 'cz-conventional-changelog' }), {
			adapter: 'cz-conventional-changelog',
		});
	});

	it('follows a cz-customizable config path', () => {
		const result = parseCzrc({
			path: 'cz-customizable',
			config: { 'cz-customizable': { config: 'config/commit.js' } },
		});

		assert.strictEqual(result.czCustomizablePath, 'config/commit.js');
	});

	it('tolerates junk', () => {
		assert.deepStrictEqual(parseCzrc(null), {});
		assert.deepStrictEqual(parseCzrc({ config: { 'cz-customizable': 'nope' } }), {});
	});
});

describe('resolveConfig', () => {
	const czConfig: CommitConfig = {
		types: [{ value: 'feat' }],
		scopes: [],
		allowCustomScopes: true,
		skipQuestions: [],
		source: 'cz-config',
	};

	it('takes the first candidate that has types', () => {
		assert.strictEqual(resolveConfig([undefined, czConfig]).source, 'cz-config');
	});

	it('skips a candidate with an empty type list', () => {
		const empty: CommitConfig = { ...czConfig, types: [], source: 'commitlint' };
		assert.strictEqual(resolveConfig([empty, czConfig]).source, 'cz-config');
	});

	it('falls back to the built-in Conventional Commits list', () => {
		const config = resolveConfig([undefined, undefined]);
		assert.strictEqual(config.source, 'built-in');
		assert.strictEqual(config.types.length, BUILT_IN_TYPES.length);
		// Ordered for the panel's two-column grid, most-used types first.
		assert.deepStrictEqual(
			config.types.map((t) => t.value),
			['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'style', 'build', 'ci', 'chore', 'revert'],
		);
	});

	it('gives every built-in type a short label for the type grid', () => {
		for (const type of BUILT_IN_TYPES) {
			assert.ok(type.short, `${type.value} has no short label`);
			assert.ok(type.short.length <= 20, `${type.value} short label is too long for a card`);
		}
	});
});

describe('parseSettingsTypes', () => {
	it('builds a config from the settings array', () => {
		const config = parseSettingsTypes([{ value: 'spike', description: 'Exploratory work' }]);
		assert.strictEqual(config?.source, 'settings');
		assert.strictEqual(config?.types[0].description, 'Exploratory work');
	});

	it('returns nothing for the default empty array', () => {
		assert.strictEqual(parseSettingsTypes([]), undefined);
	});
});

describe('resolveDefaultType', () => {
	it('uses the configured type when the repository offers it', () => {
		assert.strictEqual(resolveDefaultType('fix', BUILT_IN_TYPES), 'fix');
	});

	it('never yields a type the repository does not offer', () => {
		// An off-list type would make Composer.isCustomType true, opening the panel
		// in Custom mode holding a type the user never picked.
		assert.strictEqual(resolveDefaultType('feat', [{ value: 'chore' }]), 'chore');
		assert.strictEqual(resolveDefaultType('nope', BUILT_IN_TYPES), 'feat');
	});

	it('treats an empty setting as "select nothing", not as "use the first type"', () => {
		assert.strictEqual(resolveDefaultType('', BUILT_IN_TYPES), undefined);
		assert.strictEqual(resolveDefaultType('   ', BUILT_IN_TYPES), undefined);
		assert.strictEqual(resolveDefaultType(undefined, BUILT_IN_TYPES), undefined);
	});

	it('yields nothing when there are no types to choose from', () => {
		assert.strictEqual(resolveDefaultType('feat', []), undefined);
	});
});

describe('emojiForType', () => {
	it('finds the emoji for a known type', () => {
		assert.strictEqual(emojiForType(BUILT_IN_CONFIG, 'fix'), '🐛');
	});

	it('returns nothing for an unknown or missing type', () => {
		assert.strictEqual(emojiForType(BUILT_IN_CONFIG, 'nope'), undefined);
		assert.strictEqual(emojiForType(BUILT_IN_CONFIG, undefined), undefined);
	});
});
