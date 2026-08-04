# Contributing

## Getting set up

```bash
npm install
npm run watch        # esbuild in watch mode
# then press F5 to launch the Extension Development Host
```

## Checks

```bash
npm run verify       # everything CI runs, in the same order — use this before pushing
```

Run `npm run verify` rather than the individual steps. Running them piecemeal is how a lint error
reached CI once: the final edit landed after lint had already been run by hand.

The individual steps, if you need them:

```bash
npm run check-types  # tsc --noEmit
npm run lint
npm test             # unit tests (no VS Code host needed)
npm run test:integration
npm run package      # → conventional-commit-panel-<version>.vsix
```

## Layout

`format.ts`, `branch.ts`, `changes.ts`, `config.ts` and `gitCli.ts` are deliberately free of any
`vscode` runtime import, so they can be tested under plain mocha. Anything touching the editor lives
elsewhere.

`media/panel.js` and `media/panel.css` are the webview front-end. Nothing type-checks across the
seam between them and the HTML in `src/panel.ts`, so `src/test/unit/webviewContract.test.ts` compares
the two as text: every `getElementById` target, every codicon name against the shipped font, and the
CSP shape. It also parses `panel.js` with `vm.Script`, because nothing else validates that file —
esbuild never touches `media/`, `tsc` ignores `.js`, and eslint is scoped to `src/`.

`media/codicons/` is a build artifact copied from `node_modules` by `scripts/copy-codicons.js`. It is
gitignored and recreated by both the build and `pretest:unit`, so a clean clone can run the tests.

## Gotchas worth knowing

**Integration test failures are invisible.** When one reports "activation produced no API", the
underlying error is in `.vscode-test/user-data/logs/**/exthost/exthost.log` — it does not reach the
test output.

**Never call `Repository.revert()`.** It reads like an unstage but runs `git checkout HEAD --`,
discarding uncommitted work. The correct `restore(paths, { staged: true })` is not in the shipped Git
extension API (absent at 1.85 and 1.95). `src/gitCli.ts` shells out to `git reset HEAD --` instead,
with tests that assert the working tree survives.

**The panel cannot control its own height.** `WebviewView` has no size API, and the `initialSize`
field on a view contribution is only honoured when the extension owns the view container too — which
it does not, since this view lives in the built-in `scm` container. The workbench logs
`… tried to set the view size of … but it was ignored because the view container does not belong to
it` and moves on. This is why **Open Composer in Editor** exists: `src/composerEditor.ts` mounts the
same `ComposerHost` in a `WebviewPanel`, which is the only way to get the full window. Anything added
to the composer therefore has to survive both a ~300px sidebar section and a maximised tab — see the
`@media (min-width: 640px)` block and the reflowing `.type-grid` in `media/panel.css`.

**Do not import `GitErrorCodes` as a value.** It is an `export const enum` inside
`src/types/git.d.ts`, which has no runtime module behind it. A value import passes both
`check-types` and `lint`, then fails at `npm run compile` — esbuild never tries a `.d.ts` and cannot
inline ambient const enums. `src/publish.ts` holds the one code it needs as a string literal, and
`src/git.ts` takes everything else from that file with `import type`.

## Releasing

Published as **`patREKT.conventional-commit-panel`**.

One-time setup:

1. Create a Personal Access Token in Azure DevOps (<https://dev.azure.com>) for **All accessible
   organizations**, scoped to **Marketplace → Manage**.
2. Add it to the repository as an Actions secret named `VSCE_PAT` (`gh secret set VSCE_PAT`), or keep
   it local for `vsce login`.

The `publisher` field must match the registered ID exactly, including case. The release workflow
guards against it being left as a placeholder, but it cannot check that the ID is one you own — the
first publish is where a mismatch surfaces.

To release:

```bash
npm version minor          # or patch / major — creates the v<version> tag
git push --follow-tags
```

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which
re-runs the full test suite, verifies the tag matches `package.json`, attaches the `.vsix` to a
GitHub release, and publishes to the Marketplace. Nothing publishes from a plain push to `main`.

By hand instead:

```bash
npx vsce login patREKT
npm run package
npx vsce publish
```

## Screenshots

`images/panel.png` is what the README shows on the Marketplace. To refresh it: launch the Extension
Development Host (F5), open a repository with staged changes, and capture the panel region of the
Source Control view. Keep it reasonably narrow — the Marketplace scales images down to the README
column width.
