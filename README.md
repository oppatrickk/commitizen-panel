# Commitizen Panel

Compose Conventional Commit messages from a persistent panel inside the Source Control view.

Existing Conventional Commit extensions give you a one-shot modal wizard: pick the wrong type on
step 1 and you start over, and nothing shows you the message you are assembling. This one adds a
**`COMMITIZEN` section that sits under `CHANGES`**, where every field holds its value and can be
re-edited in any order.

```
∨ COMMITIZEN                    accounting-invoices
    TYPE                              New capability
    ┌──────────────┐ ┌──────────────┐
    │ ✨  feat      │ │ 🐛  fix       │
    │    New capa… │ │    Bug fix   │
    └──────────────┘ └──────────────┘
    ┌──────────────┐
    │ ✎  |custom   │  ← type straight into the card
    └──────────────┘
    SCOPE
    ✦ accounting-invoices   ✦ api   ✦ deps
    SUBJECT                                  61/72
    BODY / BREAKING / PREVIEW
    ─────────────────────────────────────────────
    ✓ 3 files staged            husky · commitlint
    [              Commit              ] [∨]

∨ CHANGES                                       27
```

**Committing is always a deliberate press of the Commit button.** Nothing in the extension
creates a commit on its own.

The panel deliberately does **not** duplicate the file lists — VS Code's own `Changes` section sits
directly below it and already does that job well.

## What it does

- **Custom type, typed in place.** The last card in the type grid *is* a text field — click it and
  type. Characters that would change how the header parses (`(`, `)`, `!`, `:`, whitespace) are
  rejected, but the panel does not nag you for picking a type outside the repo list — that is the
  point of the card. If a commitlint hook really does enforce the list, it says so at commit time and
  that message is surfaced verbatim.
- **A staged-files check.** The footer states plainly what a commit would contain — `3 files staged`,
  `No files staged`, or `No changes` — with unstaged work called out rather than left implicit.
- **Branch-aware scope.** `feature/PROJ-123-add-login` suggests `PROJ-123`, pre-selected and
  always overridable. Switch branches and the scope follows — unless you picked one yourself.
  Suggestion chips are marked with a sparkle, and their tooltip says where each came from — the
  current branch, the repository config, or one you used recently.
- **Live validation.** Character counter against the header limit, a fill meter, and the specific
  rule you're breaking. When the repo has commitlint, the rules checked are the ones parsed from
  its config.
- **Guided wizard.** The ▶ button in the Source Control toolbar runs the same fields as a
  step-by-step flow with a back button. Panel and wizard share one draft.
- **Repository config.** Reads types from `.cz-config.js`, `.czrc`, `package.json#config.commitizen`
  or a commitlint config, falling back to the standard Conventional Commits list.
- **Never clobbers your typing.** If you edit the Source Control commit box by hand, the panel stops
  mirroring into it rather than overwriting what you wrote. Committing from the panel is unaffected —
  it always uses the panel's own draft.

### About the breaking-change toggle

It marks the commit as breaking API compatibility: a `!` after the scope
(`feat(accounting-invoices)!: …`) plus a `BREAKING CHANGE:` footer. Release tooling such as
semantic-release reads that and bumps the **major** version — which is what the label beside the
toggle reports (`minor` for a `feat`, `patch` for a `fix`, `major` once breaking is on). Repos that
don't publish versioned packages can hide it with `commitizen.showBreakingChange`.

### On the panel's height

VS Code gives a contributed webview view whatever height the container decides. `WebviewView` has no
size API, and the `initialSize` field on a view contribution is only honoured when the extension owns
the view container too — which it does not, since this view lives in the built-in `scm` container.

So the panel fills the height it is given: the fields scroll and the Commit button stays pinned at the
bottom, so it is reachable however tall you drag the section.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `commitizen.liveSync` | `true` | Mirror the draft into the commit box as you edit. |
| `commitizen.headerMaxLength` | `72` | Header limit. A commitlint `header-max-length` rule wins over this. |
| `commitizen.bodyLineLength` | `72` | Wrap column for the body. `0` disables wrapping. |
| `commitizen.useEmoji` | `false` | Prefix the subject with the type's emoji. |
| `commitizen.types` | `[]` | Custom type list. Empty means repo config, then the built-in list. |
| `commitizen.scope.ticketPattern` | `([A-Z][A-Z0-9]+-\d+)` | Pulls a ticket ID out of the branch name. |
| `commitizen.scope.branchPrefixes` | `feature, feat, fix, …` | Prefixes stripped before the segment fallback. |
| `commitizen.scope.ignoreBranches` | `main, master, develop, dev, trunk` | Branches that suggest no scope. |
| `commitizen.scope.required` | `false` | Treat an empty scope as an error. Off by default — Conventional Commits makes scope optional. |
| `commitizen.showBreakingChange` | `true` | Show the breaking-change toggle. |
| `commitizen.showCustomType` | `true` | Show the Custom card at the end of the type grid. |
| `commitizen.config.allowJsConfig` | `false` | Allow executing JS configs from the repository. |
| `commitizen.body.useEditor` | `false` | Always edit the body in an editor tab. |

### A note on JavaScript configs

`.cz-config.js` and `commitlint.config.js` are code, and loading them means running code from the
repository you just opened. That is off by default. When enabled, it happens in a short-lived child
process rather than in the extension host, and it is skipped entirely in untrusted workspaces.
JSON and YAML configs are parsed, never executed, and always read.

## Development

```bash
npm install
npm run watch        # esbuild in watch mode
# then press F5 to launch the Extension Development Host

npm run check-types  # tsc --noEmit
npm run lint
npm test             # unit tests (no VS Code host needed)
npm run test:integration
npm run package      # → commitizen-panel-0.1.0.vsix
```

`format.ts`, `branch.ts` and `config.ts` are deliberately free of any `vscode` runtime import so
they can be tested under plain mocha. Anything touching the editor lives elsewhere.

When an integration test reports "activation produced no API", the underlying error is in
`.vscode-test/user-data/logs/**/exthost/exthost.log` — it does not reach the test output.

## Publishing

> **`package.json` currently has `"publisher": "your-publisher-id"`, a placeholder.** Publishing
> fails until it is replaced with a Marketplace publisher you actually own. The release workflow
> checks for this and refuses to run rather than failing halfway.

One-time setup:

1. Create a publisher at <https://marketplace.visualstudio.com/manage> and set `publisher` in
   `package.json` to its ID.
2. Create a Personal Access Token in Azure DevOps (<https://dev.azure.com>) for **All accessible
   organizations**, scoped to **Marketplace → Manage**.
3. Add it to the repository as an Actions secret named `VSCE_PAT`
   (`gh secret set VSCE_PAT`), or keep it local for `vsce login`.

To release:

```bash
# 1. bump the version and write the changelog entry
npm version minor          # or patch / major — this creates the v<version> tag
# 2. push the commit and the tag
git push --follow-tags
```

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which
re-runs the full test suite, verifies the tag matches `package.json`, attaches the `.vsix` to a
GitHub release, and publishes to the Marketplace. Nothing publishes from a plain push to `main`.

To do it by hand instead:

```bash
npx vsce login <publisher>
npm run package        # produces commitizen-panel-<version>.vsix
npx vsce publish
```

To try a build locally without publishing:

```bash
npm run package
code --install-extension commitizen-panel-0.1.0.vsix
```
