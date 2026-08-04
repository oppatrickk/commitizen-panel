# Changelog

All notable changes to the Conventional Commit Panel extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-04

### Added

- A commit type is pre-selected on a fresh draft, `feat` by default. Set
  `conventionalCommitPanel.defaultType` to pick a different one, or to an empty string to keep the
  old behaviour of starting with nothing selected. A default the repository does not offer falls back
  to the first type it does, so the panel never opens in Custom mode holding a type you did not pick.
- **Open Composer in Editor**, from the panel toolbar or the command palette. The panel lives in the
  Source Control view, which gives its sections a fixed share of the sidebar and offers extensions no
  way to ask for more; the editor tab is the same composer with the whole window to work in. Both
  stay in sync — edit in either and the other follows.
- Pushing a branch that has no upstream now offers a **Publish Branch** action instead of failing
  with `fatal: The current branch has no upstream branch`. It picks `origin` when there is one, asks
  which remote when there are several and no `origin`, and never contacts a remote until you press
  the button.
- A progress indicator while pushing.

### Changed

- The composed message no longer reaches the Source Control input box until it has a subject. A type
  and a branch-derived scope alone are a prefix, not a commit message, and with a type now
  pre-selected, writing them out would have meant that merely opening the Source Control view stamped
  `feat(PROJ-123): ` into a box you had deliberately left empty.
- The **Commit type** quick pick opens on the current type rather than at the top of the list.

## [0.1.1] - 2026-08-01

### Fixed

- Scopes typed into the field are no longer banked as suggestions. The scope was recorded on every
  debounced keystroke, so pausing while typing `api` stored `a`, `ap` and `api` permanently — and
  clearing the field could not undo it. A scope now becomes a suggestion only once it has actually
  been committed with.
- The Marketplace icon no longer has white corners.

### Added

- **Clear Recent Scope Suggestions** command, to remove entries banked by the old behaviour.
- A screenshot of the panel in the README.

### Changed

- The current branch is always offered as a scope suggestion chip, whatever it is.
  `conventionalCommitPanel.scope.ignoreBranches` now only controls whether it is *filled in*
  automatically, so a long-lived branch name never lands in a commit by itself but stays one click
  away. Set the list to `[]` to have it filled in on every branch.

## [0.1.0] - 2026-07-31

First release.

### Added

- **Commit panel in the Source Control view.** A webview section under `CHANGES` for composing
  Conventional Commit messages, with every field editable in any order rather than a one-shot wizard.
- **Type grid** with emoji badges and short descriptions, plus a **custom card you type directly
  into** for types outside the configured list.
- **Branch-aware scope.** `feature/PROJ-123-add-login` suggests `PROJ-123` via a configurable ticket
  pattern, with a segment fallback. Suggestion chips are drawn from the branch, the repository
  config and recently used scopes. A scope you pick yourself survives a branch switch.
- **Live validation.** Header character counter and fill meter against the configured limit, with
  the specific rule being broken named underneath. When the repository has commitlint, the rules
  checked are the ones parsed from its config.
- **Live preview** of the rendered message with syntax colouring, and a copy action.
- **Breaking-change toggle** that adds the `!` marker and `BREAKING CHANGE:` footer, showing the
  resulting semver impact (`patch` / `minor` / `major`).
- **Commit button** with options for Commit & Push, stage-all, and amend. Nothing commits on its own.
- **Guided wizard** on the Source Control toolbar, sharing one draft with the panel.
- **Repository config support.** Types and scopes read from `.cz-config.js`, `.czrc`,
  `package.json#config.commitizen` or a commitlint config, falling back to the standard
  Conventional Commits list.
- **Drafts survive a reload**, stored per repository in workspace state.

### Security

- JavaScript commit configs (`.cz-config.js`, `commitlint.config.js`) are **not** executed unless
  `conventionalCommitPanel.config.allowJsConfig` is enabled, are skipped entirely in untrusted workspaces, and
  run in a short-lived child process rather than the extension host. JSON and YAML configs are
  parsed, never executed.
- The webview runs under a strict CSP with a per-load nonce, no inline script and no remote
  resources. All DOM is built through `textContent`, never `innerHTML`.

### Notes

- The panel mirrors the composed message into the Source Control input box, but never overwrites
  text you typed there by hand.
- The panel does not duplicate the file lists; VS Code's own `Changes` section already does that.

[Unreleased]: https://github.com/oppatrickk/conventional-commit-panel/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/oppatrickk/conventional-commit-panel/releases/tag/v0.2.0
[0.1.1]: https://github.com/oppatrickk/conventional-commit-panel/releases/tag/v0.1.1
[0.1.0]: https://github.com/oppatrickk/conventional-commit-panel/releases/tag/v0.1.0
