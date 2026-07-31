// @ts-check
/**
 * Commitizen panel front-end.
 *
 * The draft itself lives in the extension host; this script renders the state it
 * is handed and reports edits back. All DOM is built through createElement and
 * textContent rather than innerHTML, because branch names, scopes, subjects and
 * type names are user-controlled strings that must never be parsed as markup.
 */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const TEXT_DEBOUNCE_MS = 160;

	/** Sentinel for the custom type card; a space cannot appear in a real type. */
	const CUSTOM_CARD = ' custom';

	const el = {
		empty: /** @type {HTMLElement} */ (document.getElementById('empty')),
		composer: /** @type {HTMLElement} */ (document.getElementById('composer')),
		typeGrid: /** @type {HTMLElement} */ (document.getElementById('type-grid')),
		typeHint: /** @type {HTMLElement} */ (document.getElementById('type-hint')),
		scope: /** @type {HTMLInputElement} */ (document.getElementById('scope')),
		scopeHint: /** @type {HTMLElement} */ (document.getElementById('scope-hint')),
		scopeChips: /** @type {HTMLElement} */ (document.getElementById('scope-chips')),
		subject: /** @type {HTMLTextAreaElement} */ (document.getElementById('subject')),
		counter: /** @type {HTMLElement} */ (document.getElementById('counter')),
		meterFill: /** @type {HTMLElement} */ (document.getElementById('meter-fill')),
		validation: /** @type {HTMLElement} */ (document.getElementById('validation')),
		body: /** @type {HTMLTextAreaElement} */ (document.getElementById('body')),
		breakingRow: /** @type {HTMLElement} */ (document.getElementById('breaking-row')),
		breaking: /** @type {HTMLInputElement} */ (document.getElementById('breaking')),
		breakingDetail: /** @type {HTMLElement} */ (document.getElementById('breaking-detail')),
		breakingDescription: /** @type {HTMLInputElement} */ (document.getElementById('breaking-description')),
		semver: /** @type {HTMLElement} */ (document.getElementById('semver')),
		specLabel: /** @type {HTMLElement} */ (document.getElementById('spec-label')),
		preview: /** @type {HTMLElement} */ (document.getElementById('preview')),
		copy: /** @type {HTMLButtonElement} */ (document.getElementById('copy')),
		staged: /** @type {HTMLElement} */ (document.getElementById('staged')),
		tooling: /** @type {HTMLElement} */ (document.getElementById('tooling')),
		commit: /** @type {HTMLButtonElement} */ (document.getElementById('commit')),
		commitOptions: /** @type {HTMLButtonElement} */ (document.getElementById('commit-options')),
	};

	/** Field id → the message that reports its new value. */
	const CLEAR_TARGETS = {
		scope: 'setScope',
		subject: 'setSubject',
		body: 'setBody',
		'breaking-description': 'setBreakingDescription',
	};

	let renderedTypeSignature = '';
	/** The custom card's inline input, created with the grid rather than in the HTML. */
	let customInput = null;

	/** Every chip is a suggestion, so they all carry the same sparkle. */
	const CHIP_ICON = 'sparkle';

	function post(message) {
		vscode.postMessage(message);
	}

	/** Trailing-edge debounce, so typing does not post a message per keystroke. */
	function debounce(fn, wait) {
		let timer;
		return function (...args) {
			clearTimeout(timer);
			timer = setTimeout(() => fn.apply(null, args), wait);
		};
	}

	/** Builds a codicon span, keeping the class convention in one place. */
	function icon(name) {
		const node = document.createElement('span');
		node.className = 'codicon codicon-' + name;
		node.setAttribute('aria-hidden', 'true');
		return node;
	}

	// --- text inputs --------------------------------------------------------

	const sendScope = debounce((value) => post({ type: 'setScope', value }), TEXT_DEBOUNCE_MS);
	const sendSubject = debounce((value) => post({ type: 'setSubject', value }), TEXT_DEBOUNCE_MS);
	const sendBody = debounce((value) => post({ type: 'setBody', value }), TEXT_DEBOUNCE_MS);
	const sendCustomType = debounce((value) => post({ type: 'setCustomType', value }), TEXT_DEBOUNCE_MS);
	const sendBreakingDescription = debounce(
		(value) => post({ type: 'setBreakingDescription', value }),
		TEXT_DEBOUNCE_MS,
	);

	el.scope.addEventListener('input', () => sendScope(el.scope.value));
	el.subject.addEventListener('input', () => sendSubject(el.subject.value));
	el.body.addEventListener('input', () => sendBody(el.body.value));
	el.breakingDescription.addEventListener('input', () => sendBreakingDescription(el.breakingDescription.value));

	el.breaking.addEventListener('change', () => post({ type: 'setBreaking', value: el.breaking.checked }));
	el.commit.addEventListener('click', () => post({ type: 'commit' }));
	el.commitOptions.addEventListener('click', () => post({ type: 'commitOptions' }));
	el.copy.addEventListener('click', () => post({ type: 'copy' }));

	// A newline in the subject would silently break the header, and Enter reads as
	// "I am done" in a one-line field.
	el.subject.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			el.body.focus();
		}
	});

	document.addEventListener('keydown', (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !el.commit.disabled) {
			event.preventDefault();
			post({ type: 'commit' });
		}
	});

	// --- clear buttons ------------------------------------------------------

	for (const button of document.querySelectorAll('.clear-button')) {
		const id = button.getAttribute('data-clears');
		const field = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (document.getElementById(id));
		if (!field) {
			continue;
		}

		button.addEventListener('click', () => {
			field.value = '';
			post({ type: CLEAR_TARGETS[id], value: '' });
			updateClearButtons();
			field.focus();
		});

		field.addEventListener('input', updateClearButtons);
	}

	/** A clear button is pointless on an empty field, so it only shows with content. */
	function updateClearButtons() {
		for (const button of document.querySelectorAll('.clear-button')) {
			const field = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (
				document.getElementById(button.getAttribute('data-clears'))
			);
			button.hidden = !field || field.value.length === 0;
		}
	}

	// --- state --------------------------------------------------------------

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message && message.type === 'state') {
			render(message.state);
		}
	});

	function render(state) {
		const hasRepository = state.branch !== undefined || state.changedCount > 0 || state.types.length > 0;
		el.empty.hidden = hasRepository;
		el.composer.hidden = !hasRepository;
		if (!hasRepository) {
			return;
		}

		renderTypes(state);
		renderScope(state);
		renderSubject(state);
		renderBody(state);
		renderBreaking(state);
		renderPreview(state);
		renderFooter(state);
		updateClearButtons();
	}

	// --- type grid ----------------------------------------------------------

	function renderTypes(state) {
		// Rebuilding the grid steals focus, so only do it when the list itself changed.
		const signature = state.types.map((type) => type.value).join(' ') + '|' + state.showCustomType;
		if (signature !== renderedTypeSignature) {
			renderedTypeSignature = signature;
			const cards = state.types.map(createTypeCard);
			if (state.showCustomType) {
				cards.push(createCustomTypeCard());
			}
			el.typeGrid.replaceChildren(...cards);
		}

		for (const card of el.typeGrid.children) {
			const value = card.getAttribute('data-value');
			const selected = value === CUSTOM_CARD ? state.isCustomType : value === state.draft.type;
			card.setAttribute('aria-checked', selected ? 'true' : 'false');
		}

		// The field belongs to the card: it appears only while Custom is selected.
		if (customInput) {
			setValue(customInput, state.customType);
		}

		const active = state.types.find((type) => type.value === state.draft.type);
		el.typeHint.textContent = state.isCustomType ? 'custom type' : active ? active.short : '';
	}

	function createTypeCard(type) {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'type-card';
		card.setAttribute('role', 'radio');
		card.setAttribute('data-value', type.value);

		// The badge carries the icon. An emoji reads on its own, so it gets no
		// filled background; a letter fallback keeps the chip treatment.
		const badge = document.createElement('span');
		badge.className = type.isEmoji ? 'type-badge emoji' : 'type-badge';
		badge.textContent = type.badge;

		card.append(badge, typeText(type.label, type.short));
		card.addEventListener('click', () => post({ type: 'setType', value: type.value }));
		return card;
	}

	/**
	 * The custom card types in place.
	 *
	 * The name slot is the input itself rather than a separate field below the
	 * grid, so the card reads and behaves like the others. It is a div, not a
	 * button, because an input cannot legally live inside one.
	 */
	function createCustomTypeCard() {
		const card = document.createElement('div');
		card.className = 'type-card custom-card';
		card.setAttribute('role', 'radio');
		card.setAttribute('data-value', CUSTOM_CARD);

		const badge = document.createElement('span');
		badge.className = 'type-badge';
		badge.append(icon('edit'));

		const text = document.createElement('span');
		text.className = 'type-text';

		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'type-input';
		input.placeholder = 'custom';
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.setAttribute('aria-label', 'Custom commit type');

		const short = document.createElement('span');
		short.className = 'type-short';
		short.textContent = 'Type your own';

		text.append(input, short);
		card.append(badge, text);

		// Focusing the field is what selects the card, so clicking anywhere on it
		// starts typing rather than needing a second click.
		card.addEventListener('mousedown', (event) => {
			if (event.target !== input) {
				event.preventDefault();
				input.focus();
			}
		});
		input.addEventListener('focus', () => post({ type: 'selectCustomType' }));
		input.addEventListener('input', () => sendCustomType(input.value.trim()));

		customInput = input;
		return card;
	}

	function typeText(label, short) {
		const text = document.createElement('span');
		text.className = 'type-text';

		const name = document.createElement('span');
		name.className = 'type-name';
		name.textContent = label;

		const detail = document.createElement('span');
		detail.className = 'type-short';
		detail.textContent = short;

		text.append(name, detail);
		return text;
	}

	// --- scope, subject, body, breaking -------------------------------------

	function renderScope(state) {
		setValue(el.scope, state.draft.scope || '');
		el.scopeHint.textContent = state.scopeRequired ? 'required' : 'optional';
		el.scopeChips.replaceChildren(...state.scopeChips.map((chip) => createChip(chip, state.draft.scope)));
	}

	const CHIP_TITLES = {
		branch: 'Suggested from the current branch',
		config: 'From the repository commit config',
		recent: 'Recently used',
		custom: 'Custom scope',
	};

	function createChip(chip, current) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = chip.source === 'branch' ? 'chip branch' : 'chip';
		button.title = CHIP_TITLES[chip.source] || 'Suggested scope';
		if (chip.value === current) {
			button.classList.add('selected');
		}

		// Marks the chip as a suggestion; the tooltip says where it came from.
		button.append(icon(CHIP_ICON));

		const label = document.createElement('span');
		label.textContent = chip.value;
		button.append(label);

		button.addEventListener('click', () => {
			el.scope.value = chip.value;
			post({ type: 'setScope', value: chip.value });
		});
		return button;
	}

	function renderSubject(state) {
		setValue(el.subject, state.draft.subject || '');

		el.counter.textContent = state.headerLength + '/' + state.headerMax;
		const ratio = state.headerMax > 0 ? state.headerLength / state.headerMax : 0;
		const level = ratio > 1 ? 'over' : ratio > 0.85 ? 'warn' : '';

		el.counter.className = 'counter' + (level ? ' ' + level : '');
		el.meterFill.className = 'meter-fill' + (level ? ' ' + level : '');
		el.meterFill.style.width = Math.min(100, Math.round(ratio * 100)) + '%';

		const worst = state.problems[0];
		el.validation.replaceChildren(
			icon(state.validationOk ? 'check' : worst && worst.severity === 'error' ? 'error' : 'warning'),
			document.createTextNode(' ' + state.validationLabel),
		);
		el.validation.className =
			'validation ' + (state.validationOk ? 'ok' : worst && worst.severity === 'error' ? 'error' : 'warn');
	}

	function renderBody(state) {
		setValue(el.body, state.draft.body || '');
	}

	function renderBreaking(state) {
		el.breakingRow.hidden = !state.showBreakingChange;
		if (!state.showBreakingChange) {
			el.breakingDetail.hidden = true;
			return;
		}

		if (document.activeElement !== el.breaking) {
			el.breaking.checked = state.draft.isBreaking;
		}
		el.breakingDetail.hidden = !state.draft.isBreaking;
		setValue(el.breakingDescription, state.draft.breakingDescription || '');

		el.semver.textContent = state.semver === 'none' ? 'no release' : state.semver;
		el.semver.className = 'semver' + (state.semver === 'major' ? ' major' : '');
	}

	// --- preview ------------------------------------------------------------

	function renderPreview(state) {
		el.specLabel.textContent = state.specLabel;
		el.preview.replaceChildren(...previewNodes(state.preview));
	}

	/** Builds the coloured preview as real nodes — never innerHTML. */
	function previewNodes(message) {
		if (!message.trim()) {
			const placeholder = document.createElement('span');
			placeholder.className = 'placeholder';
			placeholder.textContent = 'Pick a type and write a subject to see the message.';
			return [placeholder];
		}

		const nodes = [];
		const lines = message.split('\n');

		lines.forEach((line, index) => {
			if (index > 0) {
				nodes.push(document.createTextNode('\n'));
			}
			if (index === 0) {
				nodes.push(...headerNodes(line));
			} else if (/^[A-Z][A-Za-z -]*: /.test(line) || line.startsWith('BREAKING CHANGE:')) {
				nodes.push(span('tok-footer', line));
			} else {
				nodes.push(document.createTextNode(line));
			}
		});

		return nodes;
	}

	function headerNodes(header) {
		const match = /^([a-zA-Z][a-zA-Z0-9_-]*)(\([^)]*\))?(!)?(: )(.*)$/.exec(header);
		if (!match) {
			return [document.createTextNode(header)];
		}

		const nodes = [span('tok-type', match[1])];
		if (match[2]) {
			nodes.push(span('tok-scope', match[2]));
		}
		if (match[3]) {
			nodes.push(span('tok-bang', match[3]));
		}
		nodes.push(document.createTextNode(match[4] + match[5]));
		return nodes;
	}

	function span(className, text) {
		const node = document.createElement('span');
		node.className = className;
		node.textContent = text;
		return node;
	}

	// --- footer -------------------------------------------------------------

	function renderFooter(state) {
		renderStagedStatus(state);

		el.tooling.textContent = state.tooling.join(' · ');

		el.commit.disabled = !state.canCommit;
		el.commitOptions.disabled = state.changedCount === 0 && state.stagedCount === 0;
		el.commit.title = state.canCommit
			? 'Create the commit'
			: state.stagedCount === 0
				? 'Stage something to commit'
				: 'Complete the message first';
	}

	/**
	 * The staged-files check.
	 *
	 * With no file list in the panel any more, this line is the only indication of
	 * what a commit would actually contain, so it states the count plainly and
	 * mentions unstaged work rather than staying silent about it.
	 */
	function renderStagedStatus(state) {
		const staged = state.stagedCount;
		const unstaged = state.changedCount - staged;

		let iconName;
		let text;
		let tone;

		if (staged > 0) {
			iconName = 'check';
			text = staged + (staged === 1 ? ' file staged' : ' files staged');
			tone = 'ok';
		} else if (state.changedCount > 0) {
			iconName = 'circle-outline';
			text = 'No files staged';
			tone = 'warn';
		} else {
			iconName = 'circle-slash';
			text = 'No changes';
			tone = 'muted';
		}

		const nodes = [icon(iconName), document.createTextNode(' ' + text)];

		if (staged > 0 && unstaged > 0) {
			nodes.push(span('staged-extra', ' · ' + unstaged + ' unstaged'));
		}

		el.staged.replaceChildren(...nodes);
		el.staged.className = 'staged-status ' + tone;
	}

	/**
	 * Writes a value into a field without disturbing the caret.
	 *
	 * The extension echoes state back after every keystroke; assigning to a focused
	 * input would jump the cursor to the end mid-word.
	 */
	function setValue(input, value) {
		if (document.activeElement === input || input.value === value) {
			return;
		}
		input.value = value;
	}

	post({ type: 'ready' });
})();
