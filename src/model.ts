import * as vscode from 'vscode';

/** Where the current scope value came from, used to annotate the panel's chips. */
export type ScopeSource = 'branch' | 'custom' | 'config' | 'recent';

/** The editable parts of a commit message, in the order the wizard walks them. */
export type FieldKey = 'type' | 'scope' | 'subject' | 'body' | 'breaking';

export interface CommitDraft {
	type?: string;
	scope?: string;
	subject?: string;
	body?: string;
	isBreaking?: boolean;
	breakingDescription?: string;
	footers?: string[];
	scopeSource?: ScopeSource;
	/**
	 * True once the user picks the Custom card.
	 *
	 * Needed as its own flag because an empty custom type is indistinguishable
	 * from "nothing chosen" by looking at `type` alone — without it, selecting
	 * Custom and typing nothing would un-highlight the card on the next render.
	 */
	customTypeActive?: boolean;
}

export const EMPTY_DRAFT: CommitDraft = {};

const DRAFTS_KEY = 'conventionalCommitPanel.drafts';
const RECENT_SCOPES_KEY = 'conventionalCommitPanel.recentScopes';
const LAST_WRITTEN_KEY = 'conventionalCommitPanel.lastWritten';
const MAX_RECENT_SCOPES = 20;

/**
 * Holds one in-progress commit message per repository.
 *
 * Drafts survive a window reload via `workspaceState` — losing a half-written
 * body to an accidental reload is the kind of thing that makes people stop using
 * a tool like this.
 */
export class DraftStore implements vscode.Disposable {
	private readonly drafts = new Map<string, CommitDraft>();
	private readonly lastWritten = new Map<string, string>();
	private recentScopes: string[] = [];

	private readonly onDidChangeEmitter = new vscode.EventEmitter<string>();
	/** Fires with the repository key whose draft changed. */
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly memento: vscode.Memento) {
		const stored = this.memento.get<Record<string, CommitDraft>>(DRAFTS_KEY, {});
		for (const [key, draft] of Object.entries(stored)) {
			this.drafts.set(key, draft);
		}
		this.recentScopes = this.memento.get<string[]>(RECENT_SCOPES_KEY, []);

		const written = this.memento.get<Record<string, string>>(LAST_WRITTEN_KEY, {});
		for (const [key, value] of Object.entries(written)) {
			this.lastWritten.set(key, value);
		}
	}

	/**
	 * The last message this extension wrote into a repository's commit box.
	 *
	 * Persisted, not just held in memory: VS Code restores the commit box across a
	 * window reload, and without this the panel would come back not recognising its
	 * own text and wrongly report that the box had been edited by hand.
	 */
	getLastWritten(key: string): string | undefined {
		return this.lastWritten.get(key);
	}

	setLastWritten(key: string, value: string): void {
		this.lastWritten.set(key, value);
		void this.memento.update(LAST_WRITTEN_KEY, Object.fromEntries(this.lastWritten));
	}

	get(key: string): CommitDraft {
		return this.drafts.get(key) ?? EMPTY_DRAFT;
	}

	/** Merges `patch` into the draft. `undefined` values clear their field. */
	update(key: string, patch: Partial<CommitDraft>): void {
		const next: CommitDraft = { ...this.get(key), ...patch };

		for (const field of Object.keys(patch) as Array<keyof CommitDraft>) {
			if (patch[field] === undefined) {
				delete next[field];
			}
		}

		this.drafts.set(key, next);
		void this.persistDrafts();
		this.onDidChangeEmitter.fire(key);
	}

	reset(key: string): void {
		this.drafts.delete(key);
		void this.persistDrafts();
		this.onDidChangeEmitter.fire(key);
	}

	getRecentScopes(): string[] {
		return [...this.recentScopes];
	}

	/** Empties the recently-used scope list. */
	clearRecentScopes(): void {
		this.recentScopes = [];
		void this.memento.update(RECENT_SCOPES_KEY, this.recentScopes);
	}

	/** Records a scope as most-recently-used, capped at {@link MAX_RECENT_SCOPES}. */
	rememberScope(scope: string): void {
		const trimmed = scope.trim();
		if (!trimmed) {
			return;
		}

		this.recentScopes = [trimmed, ...this.recentScopes.filter((s) => s !== trimmed)].slice(0, MAX_RECENT_SCOPES);
		void this.memento.update(RECENT_SCOPES_KEY, this.recentScopes);
	}

	private persistDrafts(): Thenable<void> {
		return this.memento.update(DRAFTS_KEY, Object.fromEntries(this.drafts));
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}
}
