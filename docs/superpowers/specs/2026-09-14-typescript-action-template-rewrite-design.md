# Rewrite yc-obj-storage-upload onto the actions/typescript-action template

Date: 2026-09-14

## Goal

Adopt the code organization and development harness of
[`actions/typescript-action`](https://github.com/actions/typescript-action) while preserving this action's business
logic — uploading files to Yandex Cloud Object Storage — unchanged in observable behavior.

"Behavior" here means the S3 commands the action issues (`ListObjectsV2`, `DeleteObjects`, `HeadObject`, `PutObject`,
and the multipart sequence), the token exchange request it makes on the workload-identity path, and the set of keys it
writes. Any change to those is a regression, not a refactor.

This repeats the migration designed for
[`yc-sls-function`](https://github.com/yc-actions/yc-sls-function/blob/main/docs/superpowers/specs/2026-07-27-typescript-action-template-rewrite-design.md).
Sections below note where this repo's situation forced a different decision.

## Decisions

| Question                | Decision                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module system / bundler | Full ESM + Rollup, matching the template. ncc is the documented fallback.                                                                                |
| `src/` layout           | Split the 350-line `main.ts` into six focused modules.                                                                                                   |
| Test doubles and data   | Full template convention: `__fixtures__/` for doubles and data, `__tests__/` for `*.test.ts` only.                                                       |
| Scaffolding             | Core scripts + `.node-version` + `ci.yml` + `check-dist.yml` + `linter.yml`; coverage badge and threshold; `local-action` + `.env.example` + `.vscode/`. |
| Prettier                | Keep this repo's values (120 columns, 4-space indent, `arrowParens: avoid`) in the template's `.prettierrc.yml` file format.                             |
| Node version            | Already `using: node24` in `action.yml`; `.nvmrc` becomes `.node-version`, `engines.node >=24` stays.                                                    |
| Behavior verification   | Characterization snapshot captured on the old code first, plus a bundle smoke test in CI and a real upload to a scratch bucket before merge.             |
| Version                 | Major bump to 5.0.0.                                                                                                                                     |

The Prettier decision is deliberate divergence from the template: 120 columns suits the long AWS SDK and Yandex SDK type
names, and keeping the current width limits the diff to lines that actually changed.

The version decision is a choice, not a necessity. `action.yml` already declares `node24` and its inputs and outputs do
not change, so nothing here is mechanically breaking for consumers. The bump to 5.0.0 is taken anyway: `dist/` changes
module system, drops three asset trees, and the source tree is reorganized wholesale. A major tag makes that a
deliberate opt-in rather than something that arrives under a floating `v4`.

## Findings that shape the work

Three facts were verified against the installed dependency tree before designing.

**`@grpc/grpc-js` is in the bundle, despite `src/` never importing it.** `src/main.ts` imports `IamTokenService` from
`@yandex-cloud/nodejs-sdk/dist/token-service/iam-token-service`, and that module's first lines are
`require("@grpc/grpc-js")` and `require("nice-grpc")`. The current ncc `dist/` therefore contains `proto/`, `xds/`, and
`protoc-gen-validate/` — the `.proto` trees that `@grpc/grpc-js`'s `channelz.js` and `orca.js` load at runtime via
``loaderLoadSync('channelz.proto', { includeDirs: [`${__dirname}/../../proto`] })``.

Both call sites are lazy. `channelz.setup()` runs at import time but only _registers_ `getChannelzServiceDefinition` as
a callback; the proto load fires when an admin service is actually served. `orca.js` loads only under xds. A client-only
action reaches neither. But `__dirname` is undefined in a Rollup ESM bundle, so if either path were reached it would
raise `ReferenceError` rather than working.

**Copying the protos to `dist/proto/` cannot restore parity.** With `__dirname` shimmed to the real `dist/`,
`${__dirname}/../../proto` resolves _above_ the action checkout — for an action installed at
`_actions/yc-actions/yc-obj-storage-upload/v5/`, it points at `_actions/yc-actions/yc-obj-storage-upload/proto`, a
sibling of the version directory that is not part of any checkout. Making it land inside `dist/` would mean pointing
`__dirname` at a fabricated path such as `dist/node_modules/@grpc/grpc-js/build/src`, which breaks `__dirname` for every
other consumer in the bundle.

So the design shims `__dirname` honestly and does **not** ship the `.proto` files. With the shim in place, the failure
mode if either path were ever reached is a clear `ENOENT` on a real path rather than a `ReferenceError`. The bundle
smoke test and the real upload are the checks on this reasoning.

**`S3Client.prototype.send` is a stable interception point.** Spying on the prototype rather than on an instance or
through a module mock works identically under CommonJS and ESM. This matters for the characterization snapshot below,
and it is why several existing tests port across unchanged.

**Six direct dependencies are unused by `src/` and `__tests__/`.** `@actions/github`, `@types/mustache`, `@swc/cli`,
`@swc/core`, `@swc/jest`, and `js-yaml` have no importer. `minimist` and `path-scurry` sit in `dependencies` with range
specifiers (`>=1.2.8`, `^2.0.1`) that exist only to float transitive versions — that is what `overrides` is for.

## Architecture

### Target layout

```text
.node-version                 24.9
action.yml                    unchanged (inputs, outputs, and using: node24 all stay)
rollup.config.ts              ESM bundle + require/__filename/__dirname banner
tsconfig.json                 NodeNext, include: [src], noUnusedLocals
jest.config.js                ESM preset, ts-jest-resolver, coverage threshold
eslint.config.mjs             FlatCompat + @typescript-eslint + jest + prettier
.prettierrc.yml               120 / 4 / arrowParens: avoid
.env.example                  every action input, for npm run local-action
.markdown-lint.yml  .yaml-lint.yml  actionlint.yml
badges/coverage.svg
.vscode/                      extensions.json, launch.json, merged settings.json
src/
  index.ts                    entrypoint: run()
  main.ts                     thin: credentials -> inputs -> clear -> upload
  action-inputs.ts            ActionInputs type + readInputs()
  auth.ts                     exchangeToken(), resolveTokenService()
  s3-client.ts                createS3Client() + the YC auth middleware
  upload.ts                   upload, uploadFile, runPool, parseConcurrency, fileMd5
  clear-bucket.ts             clearBucket
  cache-control.ts            logic unchanged
  service-account-json.ts     logic unchanged
__fixtures__/
  core.ts  axios.ts
  workspace/src/{exclude.txt,exclude.yaml,func.js}
  workspace/src_with_subfolders/...
__tests__/
  characterization.test.ts  main.test.ts  upload.test.ts
  clear-bucket.test.ts  cache-control.test.ts  __snapshots__/
```

Deleted: `.github/workflows/test.yml`, `.github/linters/` (stale copies from an older template revision), `.nvmrc`,
`.prettierrc.json`, and from `dist/` the ncc-specific `licenses.txt` and `sourcemap-register.js` plus the `proto/`,
`xds/`, and `protoc-gen-validate/` trees.

Untouched: `.mergify.yml`, `.github/dependabot.yml`, `.husky/pre-commit`, `.gitattributes`, `LICENSE`, and every input
and output in `action.yml`. `README.md` prose is untouched apart from the five `yc-actions/yc-obj-storage-upload@v4`
references in its usage examples, which become `@v5` with the major bump.

`__tests__/cache-contol.test.ts` is renamed to `__tests__/cache-control.test.ts`, fixing the typo while the file is
being touched anyway.

`.vscode/settings.json` is tracked and holds `workbench.colorCustomizations`. The template's `extensions.json` and
`launch.json` are added as-is; `settings.json` is _merged_ so the existing color block survives. `mcp.json` is skipped —
it configures MCP servers unrelated to this action.

### Module split

`main.ts` currently mixes `run()` orchestration with credential selection, S3 client construction, the upload pipeline,
bucket clearing, and the OAuth token exchange. Each concern moves out with its logic intact:

| Current code                                                                                | Moves to               | Exports                                                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `exchangeToken`, the SA-JSON / IAM-token / WIF branch, the `TokenService` shim              | `src/auth.ts`          | `exchangeToken`, `resolveTokenService`                                                            |
| `new S3Client({...})` and the `ycAuthMiddleware` wiring                                     | `src/s3-client.ts`     | `createS3Client`                                                                                  |
| `upload`, `uploadFile`, `runPool`, `parseConcurrency`, `fileMd5`, `parseIgnoreGlobPatterns` | `src/upload.ts`        | `upload`, `runPool`, `parseConcurrency`, `UploadInputs`, `DEFAULT_CONCURRENCY`, `MAX_CONCURRENCY` |
| `clearBucket`                                                                               | `src/clear-bucket.ts`  | `clearBucket`                                                                                     |
| the inline `ActionInputs` object literal                                                    | `src/action-inputs.ts` | `ActionInputs`, `readInputs`                                                                      |

`resolveTokenService` takes the three raw input strings and returns a `TokenService`, folding together what are now two
separate branches in `run()` (building `sessionConfig`, then deriving `tokenService` from it). The intermediate
`SessionConfig` value exists only to be re-inspected three lines later, so it does not survive the move; the resulting
error messages and their order are preserved exactly.

Folding those branches drops one unreachable line. The current `getToken` closure throws `No IAM token provided` when
`sessionConfig.iamToken` is falsy, but every path that reaches it has already assigned a non-empty token: the
`yc-iam-token` branch is guarded by `!== ''`, and `exchangeToken` throws unless `res.data.access_token` is truthy. The
message is therefore unreachable today and is not carried forward.

The fold also moves `new IamTokenService(...)` ahead of `readInputs()`, so it now runs even when a required input is
missing. Its constructor is pure field assignment — no channel, no network, no I/O — so nothing observable changes.

The final review found one more unreachable branch, fixed in this same branch rather than deferred: `exchangeToken`'s
`res.status !== 200` check could never run in production, because real axios rejects on 4xx/5xx before that line is
reached, surfacing a 400 as axios's generic `Request failed with status code 400` instead of the intended
`Failed to exchange token: 400 Bad Request`. The fix adds `validateStatus: () => true` to the request config so axios
resolves for every status and the existing check does its job. The characterization snapshot's workload-identity
scenario stubs a 200 response, so this does not move it.

A third deliberate change, decided after the migration was reviewed and taken because v5 is a major release: **`exclude`
patterns are now matched against the path relative to `root`** rather than the path relative to the repository root.
`include` was always joined with `root`, so the two inputs were written in different coordinate systems, and any
`exclude` pattern that merely contained a slash silently matched nothing — `exclude: src/*.txt` dropped no files even
though `include: src/*` was valid.

The fix matches against `path.relative(root, match)`, which is also the object key the file would receive before
`prefix` is applied, so `exclude` now filters on exactly what `include` selected. The change is strictly additive for
patterns that already worked: slashless patterns still match the basename at any depth through minimatch's `matchBase`,
and `**/`-anchored patterns still match anywhere. Verified pattern by pattern in `__tests__/upload.test.ts`, and the
characterization snapshot — whose exclude scenario uses `**/*.txt` — does not move.

Joining the pattern with `root` instead, the obvious first idea, was rejected: it gives every pattern a slash, which
disables `matchBase`, so `*.txt` would stop matching nested files and start meaning "only directly in `root`" — a
regression on the most common form.

After the split, `main.ts` holds only: `resolveTokenService`, `readInputs`, `createS3Client`, the optional
`clearBucket`, `upload`, and the `try/catch` that calls `setFailed`.

Each new module has one reason to exist and can be tested without constructing the whole action.

### ESM migration

`package.json` gains `"type": "module"`, keeps `"exports": { ".": "./dist/index.js" }`, and keeps `engines.node >= 24`.
`name`, `repository`, and the `git-tag` script are preserved — release tagging reads `version` from this file and
force-moves both `v5` and `v5.0.0`.

`tsconfig.json` keeps `module: NodeNext` / `moduleResolution: NodeNext`, adds `noUnusedLocals`, and switches to
`include: ["src"]` with `__fixtures__`, `__tests__`, `coverage`, `dist`, and `node_modules` excluded.

Every relative import gains a `.js` extension (`./main` becomes `./main.js`). Bare specifiers and the Yandex SDK deep
specifiers are left alone — `@yandex-cloud/nodejs-sdk` declares `"./dist/*": "./dist/*.js"` in its exports map, so
`dist/types` and `dist/token-service/iam-token-service` resolve under NodeNext without rewriting.

One deep import is rewritten on its merits, not for ESM: `@aws-sdk/types/dist-types/middleware` reaches past the
package's exports map for `FinalizeRequestMiddleware`, which `@smithy/types` exports publicly. If the public specifier
type-checks, it replaces the deep one; if not, the deep import stays and the reason is recorded in the implementation
plan.

### Bundling

Rollup as in the template, plus one addition the template does not need: an `output.banner` that defines `require`,
`__filename`, and `__dirname` from `import.meta.url`. The CommonJS dependencies in this graph
(`@yandex-cloud/nodejs-sdk`, `@grpc/grpc-js`, `nice-grpc`, `jsonwebtoken`) reference all three, and none exist in an ES
module.

Plugins: `@rollup/plugin-typescript`, `@rollup/plugin-node-resolve`, `@rollup/plugin-commonjs`, `@rollup/plugin-json`.
Output is a single `dist/index.js` plus `dist/index.js.map`. No `dist/package.json` is needed — the root `package.json`
already marks the tree `type: module`.

`node-resolve` is configured with `preferBuiltins: true` as in the template, plus `exportConditions: ['node']`, which
the template omits. The AWS SDK v3 and `@smithy/*` packages publish browser variants through their exports maps and
`browser` fields; without the `node` condition, `node-resolve` can pick a browser build whose crypto and stream shims do
not work under the Actions runner. `@rollup/plugin-json` is likewise an addition — `@grpc/grpc-js` and `protobufjs`
import `package.json` for version reporting.

`output.inlineDynamicImports: true` is a fourth addition, forced by a real build error rather than chosen up front:
`@aws-sdk/credential-provider-node`'s SSO/ini/process/web-identity branches and `@smithy/core`'s event-streams submodule
reach their targets with dynamic `import()`, which pushes Rollup toward multi-chunk output — incompatible with the
single `output.file` this bundle needs. Inlining is safe because every module reached that way is free of top-level side
effects (no native bindings, no eager I/O), so evaluating them eagerly instead of lazily costs nothing.

## Test harness

`jest.config.js` is the template's: `preset: ts-jest`, `extensionsToTreatAsEsm: ['.ts']`, `resolver: ts-jest-resolver`,
`useESM: true`, `tsconfig: 'tsconfig.json'`, reporters `json-summary`, `text`, `lcov`. The `test` script sets
`NODE_OPTIONS=--experimental-vm-modules NODE_NO_WARNINGS=1` and `GITHUB_WORKSPACE=__fixtures__/workspace`.

`collectCoverageFrom` keeps this repo's current value, `['./src/**', '!./src/index.ts']`, rather than the template's
`['./src/**']`. `src/index.ts` is a two-line entrypoint that only calls `run()`; including it would move the percentages
without measuring anything, and the coverage floors below are calibrated against the existing exclusion.

Under ESM, `jest.spyOn` against a module namespace object does not work — the namespace is frozen. The tests split into
two groups by how much that costs them:

- **Ported unchanged in substance:** the `upload` and `clearBucket` suites spy on a real `S3Client` instance they
  construct themselves (`jest.spyOn(s3client, 'send')`), which defines an own property on the instance and is unaffected
  by ESM. They move to `upload.test.ts` and `clear-bucket.test.ts` with their assertions intact.
- **Rewritten mechanically:** the `run` suite spies on `@actions/core` and on `require('axios')`. Each becomes
  `jest.unstable_mockModule('@actions/core', () => core)` against `__fixtures__/core.ts` and `__fixtures__/axios.ts`,
  followed by `const { run } = await import('../src/main.js')`. The assertions themselves — which `setFailed` message,
  which `axios.post` payload — do not change.

`__tests__/src/` and `__tests__/src_with_subfolders/` are fixture data, not tests. They move to
`__fixtures__/workspace/`, and `GITHUB_WORKSPACE` points there. The `skip-unchanged` test that reads
`join('__tests__', key)` to compute an expected MD5 is updated to the new root.

The big-file multipart test keeps writing its 10 MB file into `GITHUB_WORKSPACE` at runtime and removing it afterwards;
the file is generated, not committed.

### Coverage threshold

Measured on the current code: lines 96.27%, statements 96.39%, functions 96.15%, branches 86.76%. The threshold is a
ratchet just below those — lines 90, statements 90, functions 90, branches 80 — not the template's commented-out 100%.
CI then blocks regressions without failing on day one.

The ratchet is _committed last_, after the rewrite, and validated against the post-rewrite measurement. Splitting
`main.ts` changes the denominator: the same tests spread over more files can move each percentage in either direction.
If a metric lands below its floor, the fix is to add the missing test, not to lower the floor — the pre-rewrite numbers
above are the contract.

## Verification

The tests that protect the business logic are themselves being rewritten, so they cannot serve as their own regression
net. The net is built first, on the old code.

**Stage 0 — characterization snapshot, committed before any rewrite.**

One test file, `__tests__/characterization.test.ts`, against the _current_ code. It installs a spy on
`S3Client.prototype.send` that records every command object the action issues, and a recording stub for `axios.post`,
then drives `run()` across every scenario the current `main.test.ts` covers:

- defaults (SA JSON credentials, `include: ['*']`, no prefix)
- a `prefix` value
- `include` and `exclude` patterns, including a subdirectory glob
- `clear: true`
- `cache-control` mappings, including the `*` default
- a non-default `concurrency`
- `skip-unchanged: true`, against both a matching and a differing remote ETag
- `fail-on-error: true` with a failing upload
- each of the three credential paths: SA JSON, IAM token, and workload identity

The recording is serialized through a stable normalizer and compared against a committed snapshot:

- the command's constructor name is recorded alongside its `input`
- `Body` (a `ReadStream`) becomes `sha256:<hex>` of the file's contents — the stream is not serializable, but the digest
  of a fixed fixture file is stable
- `undefined`-valued keys are dropped and object keys are sorted
- the `axios.post` URL and payload are recorded in the same list, in call order
- a `setFailed` message's embedded file list is sorted before comparison; concurrent uploads reject in whatever order
  real async I/O scheduling picks, which is not reproducible across machines or Node versions, while the workspace-path
  substitution handles the other non-reproducible part of the same message

Concurrency makes the _order_ of per-file commands non-deterministic, so the recorded list is sorted by `(command, Key)`
before comparison. That sort also discards ordering between phases, so it cannot by itself tell a correct
`clearBucket`-then-`upload` sequence from an accidentally inverted one — a future module split that ran them the wrong
way round would still produce the same sorted, byte-identical snapshot. The `clear` scenario therefore carries a second,
explicit assertion against the raw, unsorted recording: the last `ListObjectsV2Command`/ `DeleteObjectsCommand` entry's
index must be less than the first `PutObjectCommand` entry's index. This is asserted, not assumed by construction.

Because the spy is on `S3Client.prototype`, the recording mechanism itself survives the CJS to ESM move. The gate after
the rewrite is that the snapshot reproduces with no diff. Any diff is a behavior change to explain or fix.

**Bundle smoke test**, a `ci.yml` job: `node dist/index.js` with no credentials must exit non-zero and print
`No credentials`. This proves the ESM bundle loads and that both the grpc-js and AWS SDK module graphs initialize —
something unit tests against mocks cannot show.

**Real upload**, before merge: upload the same fixture tree to a scratch bucket from `main` and from the branch, then
compare the resulting object listing — keys, `Content-Type`, and `Cache-Control`. This requires a bucket name and
credentials, to be supplied at that point.

## CI

- `ci.yml` — `format:check`, `lint`, `ci-test`, `coverage`, plus the bundle smoke-test job. The template's `test-action`
  job (which runs the action against itself) is replaced by the smoke test, because running this action for real needs
  Yandex Cloud credentials and a bucket.
- `check-dist.yml` — kept as is; it already runs `npm run bundle` and diffs `dist/`. Only the `node-version-file` input
  changes from `.nvmrc` to `.node-version`.
- `linter.yml` — super-linter, with root `.markdown-lint.yml`, `.yaml-lint.yml`, and `actionlint.yml` replacing the
  stale `.github/linters/` copies.
- `test.yml` — deleted, superseded by `ci.yml`.
- `dependabot.yml` and `.mergify.yml` — unchanged.

### npm scripts

Template set: `bundle`, `package`, `package:watch`, `format:write`, `format:check`, `lint`, `test`, `ci-test`,
`coverage`, `local-action`, `all`. `.husky/pre-commit` keeps running `npm run all`.

`git-tag` is kept and the template's `script/release` is _not_ adopted. They are not equivalent: `git-tag` force-moves
both the floating major tag (`vN`) and the exact version tag (`vN.M.P`), which is the release convention for a published
action, while `script/release` prompts for a version and pushes a single tag. Adding both would give the repo two
contradictory release paths.

### Dependencies

Removed from `dependencies`: `@actions/github` (no importer), and `minimist` / `path-scurry`, which move to `overrides`
where a version-floating constraint belongs.

Removed from `devDependencies`: `@types/mustache`, `@swc/cli`, `@swc/core`, `@swc/jest`, `js-yaml` (no importers), and
`eslint-plugin-github` with `eslint-plugin-import`, `eslint-import-resolver-typescript`, and `eslint-plugin-jsonc`,
replaced by the template's ESLint stack. `@vercel/ncc` stays until the Rollup bundle passes the smoke test, then is
removed; if the fallback is taken it stays permanently.

`@grpc/grpc-js` stays in `dependencies`: `src/` never imports it, but it is the one transitive package whose version the
bundle is sensitive to, and a direct entry keeps Dependabot pointed at it.

Added to `dependencies`: `@smithy/types`, so `FinalizeRequestMiddleware` can be imported from its own package instead of
through `@aws-sdk/types/dist-types/middleware`. It is a type-only import that disappears at build time, and it pairs
with the already-direct `@smithy/protocol-http`.

Added to `devDependencies`: `rollup`, `@rollup/plugin-commonjs`, `@rollup/plugin-json`, `@rollup/plugin-node-resolve`,
`@rollup/plugin-typescript`, `rimraf` (the template's `package` script cleans `dist/` with it), `ts-jest-resolver`,
`@jest/globals`, `eslint-config-prettier`, and `@github/local-action`.

## Out of scope

Not brought over from the template: `licensed.yml` and `.licenses/` (needs the Ruby `licensed` gem, and the grpc
dependency tree makes it heavy), `codeql-analysis.yml`, `.checkov.yml`, `.devcontainer/`, `CODEOWNERS`,
`.github/copilot-instructions.md`, `.github/prompts/`, `.vscode/mcp.json`, and `script/release` (see npm scripts above
for why).

Not changed: `action.yml` inputs and outputs, README prose, and the business logic itself.

## Risks

**Rollup bundling `@grpc/grpc-js` is the one unproven step.** It is exercised early and gated by the smoke test. If
Rollup cannot produce a loadable bundle, the fallback is to revert `package` to ncc and ship the CJS output behind a
`dist/package.json` containing `{"type":"commonjs"}`. The ESM source layout and the test harness stand either way — only
the `package` script changes.

**The AWS SDK v3 graph is large and mixes module formats.** `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` ship both
CJS and ESM builds; `@rollup/plugin-node-resolve` should pick the ESM one, but conditional `require` inside `@smithy/*`
runtime packages may still need `@rollup/plugin-commonjs` to hoist. Same fallback as above.

**The characterization snapshot can only capture what the current tests reach.** Scenarios the existing suite never
exercises are not protected by it. The real upload before merge is the backstop for that gap.
