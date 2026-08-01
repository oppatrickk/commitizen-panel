# Changelog

All notable changes to the Conventional Commit Panel extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/oppatrickk/conventional-commit-panel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oppatrickk/conventional-commit-panel/releases/tag/v0.1.0
