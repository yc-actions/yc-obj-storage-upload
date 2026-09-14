# TypeScript Action Template Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `yc-actions/yc-obj-storage-upload` onto the `actions/typescript-action` layout and harness — ESM source, Rollup bundle, `__fixtures__`/`__tests__` split, template CI — without changing a single request the action issues.

**Architecture:** A characterization snapshot is recorded against the current code first and must reproduce unchanged after every later task. The 350-line `src/main.ts` then splits into six modules while still CommonJS, so the refactor and the ESM switch are never in flight at the same time. ESM, then Rollup, then scaffolding, then CI, then cleanup.

**Tech Stack:** TypeScript 5.9 (NodeNext), Node 24, Jest 30 + ts-jest in ESM mode, Rollup 4, ESLint 9 flat config, Prettier 3, AWS SDK v3, `@yandex-cloud/nodejs-sdk` v3.

**Design spec:** [`docs/superpowers/specs/2026-09-14-typescript-action-template-rewrite-design.md`](../specs/2026-09-14-typescript-action-template-rewrite-design.md)

## Global Constraints

- Branch: `feat/typescript-action-template`. Everything lands here; no commits to `main`.
- `action.yml` inputs, outputs, `branding`, and `runs.using: 'node24'` must not change.
- Prettier settings stay at this repo's values: `printWidth: 120`, `tabWidth: 4`, `arrowParens: avoid`, `semi: false`, `singleQuote: true`, `trailingComma: none`, `bracketSameLine: true`, `endOfLine: lf`.
- Node floor stays `>=24`. `.node-version` contains `24.9.0`.
- After every task from Task 2 onward, `__tests__/__snapshots__/characterization.test.ts.snap` must be byte-identical to the version committed in Task 1. `git diff __tests__/__snapshots__/` returning empty is the gate.
- Never run `jest -u` / `--updateSnapshot` after Task 1. A snapshot diff is a finding, not a chore.
- The pre-commit hook (`.husky/pre-commit`) runs `npm run all`. Let it run on every code commit in this plan.
- Coverage floors (added in Task 8, measured on the current code): lines 90, statements 90, functions 90, branches 80.
- Final version: `5.0.0`.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `__tests__/characterization.test.ts` | Records every S3 command and token-exchange request `run()` issues, per scenario. The regression net. |
| `src/action-inputs.ts` | `ActionInputs` type and `readInputs()`. |
| `src/auth.ts` | `exchangeToken()` and `resolveTokenService()` — the three credential paths. |
| `src/s3-client.ts` | `createS3Client()` — client construction plus the YC auth middleware. |
| `src/upload.ts` | `upload()`, `runPool()`, `parseConcurrency()`, and the private file/glob helpers. |
| `src/clear-bucket.ts` | `clearBucket()`. |
| `__fixtures__/core.ts` | `jest.fn()` doubles for every `@actions/core` export the source uses. |
| `__fixtures__/axios.ts` | `jest.fn()` double for `axios.post`, with a default export. |
| `__fixtures__/workspace/**` | Test data moved out of `__tests__/`. |
| `__tests__/upload.test.ts` | The `upload` suite, split out of `main.test.ts`. |
| `__tests__/clear-bucket.test.ts` | The `clearBucket` suite, split out of `main.test.ts`. |
| `rollup.config.ts` | ESM bundle config plus the `require`/`__filename`/`__dirname` banner. |
| `jest.config.js` | ESM Jest config (replaces the `jest` key in `package.json`). |
| `.node-version`, `.prettierrc.yml`, `.env.example` | Template scaffolding. |
| `.markdown-lint.yml`, `.yaml-lint.yml`, `actionlint.yml` | Root linter configs. |
| `.vscode/extensions.json`, `.vscode/launch.json` | Template editor config. |
| `.github/workflows/ci.yml`, `.github/workflows/linter.yml` | Template CI. |

**Modified:** `src/main.ts` (shrinks to orchestration), `src/index.ts` (`.js` extension), `__tests__/main.test.ts` (only the `run` suite remains, ESM mocking), `package.json`, `tsconfig.json`, `eslint.config.mjs`, `.prettierignore`, `.vscode/settings.json`, `.github/workflows/check-dist.yml`, `README.md`, `action.yml` (untouched — listed only to be explicit that it is reviewed and left alone).

**Deleted:** `.nvmrc`, `.prettierrc.json`, `.github/linters/`, `.github/workflows/test.yml`, `__tests__/cache-contol.test.ts` (renamed), `__tests__/src/`, `__tests__/src_with_subfolders/` (moved).

---

## Task 1: Characterization snapshot on the current code

The regression net, recorded before anything moves. It spies on `S3Client.prototype.send` rather than on an instance or a module mock — a prototype spy behaves identically under CommonJS and ESM, so this recording mechanism survives Task 4.

**Files:**

- Create: `__tests__/characterization.test.ts`
- Create (generated): `__tests__/__snapshots__/characterization.test.ts.snap`

**Interfaces:**

- Consumes: `run` from `src/main.ts` (current signature `() => Promise<void>`).
- Produces: the snapshot file that every later task is gated on.

- [ ] **Step 1: Write the characterization test**

Create `__tests__/characterization.test.ts`:

```ts
import * as core from '@actions/core'
import {
    DeleteObjectsCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client
} from '@aws-sdk/client-s3'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { run } from '../src/main'

type Recorded = { command: string; input: unknown }
type HeadBehavior = 'missing' | 'match' | 'differ'

const SA_JSON = JSON.stringify({
    id: 'id',
    created_at: '2021-01-01T00:00:00Z',
    key_algorithm: 'RSA_2048',
    service_account_id: 'service_account_id',
    private_key: 'private_key',
    public_key: 'public_key'
})

const baseInputs: Record<string, string> = {
    'yc-sa-json-credentials': SA_JSON,
    'yc-iam-token': '',
    'yc-sa-id': '',
    bucket: 'bucket',
    prefix: '',
    root: '.',
    include: 'src/*',
    exclude: '',
    clear: 'false',
    'cache-control': '',
    concurrency: '',
    'skip-unchanged': 'false',
    'fail-on-error': 'false'
}

// Streams and buffers are not reproducible across runs; the digest of a fixed
// fixture file is. Keys are sorted and undefined values dropped so that the
// recorded shape does not depend on property insertion order.
function normalize(value: unknown): unknown {
    if (value === null || value === undefined) {
        return null
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return `sha256:${createHash('sha256').update(value).digest('hex')}`
    }
    const maybeStream = value as { path?: unknown; pipe?: unknown }
    if (typeof maybeStream.pipe === 'function' && typeof maybeStream.path === 'string') {
        return `sha256:${createHash('sha256').update(readFileSync(maybeStream.path)).digest('hex')}`
    }
    if (Array.isArray(value)) {
        return value.map(normalize)
    }
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(value as object).sort()) {
            const inner = (value as Record<string, unknown>)[key]
            if (inner === undefined) {
                continue
            }
            out[key] = normalize(inner)
        }
        return out
    }
    return String(value)
}

// Failure messages embed absolute-ish workspace paths, which change when the
// fixture tree moves in Task 2, and list failed files in whatever order the
// concurrent uploads happened to reject in, which real async I/O scheduling
// decides and this test cannot pin down. The requests themselves never do
// either, so both get normalized before the message is trusted as a snapshot.
function scrub(message: unknown): unknown {
    const workspace = process.env.GITHUB_WORKSPACE ?? ''
    if (typeof message !== 'string') {
        return message
    }
    const withoutWorkspace = workspace === '' ? message : message.split(workspace).join('<workspace>')
    const marker = 'file(s): '
    const markerIndex = withoutWorkspace.indexOf(marker)
    if (markerIndex === -1) {
        return withoutWorkspace
    }
    const prefix = withoutWorkspace.slice(0, markerIndex + marker.length)
    const files = withoutWorkspace
        .slice(markerIndex + marker.length)
        .split(', ')
        .sort()
    return prefix + files.join(', ')
}

describe('characterization', () => {
    let recorded: Recorded[]
    let headBehavior: HeadBehavior
    let putFails: boolean

    let getInputMock: jest.SpyInstance
    let getMultilineInputMock: jest.SpyInstance
    let getBooleanInputMock: jest.SpyInstance
    let getIDTokenMock: jest.SpyInstance
    let setFailedMock: jest.SpyInstance
    let axiosPostMock: jest.SpyInstance

    function applyInputs(overrides: Record<string, string> = {}): void {
        const inputs: Record<string, string> = { ...baseInputs, ...overrides }
        getInputMock.mockImplementation((name: string, options?: { required?: boolean }): string => {
            const value = inputs[name] ?? ''
            if (options?.required && !value) {
                throw new Error(`Input required and not supplied: ${name}`)
            }
            return value
        })
        getMultilineInputMock.mockImplementation((name: string): string[] =>
            (inputs[name] ?? '').split('\n').filter(line => line !== '')
        )
        getBooleanInputMock.mockImplementation((name: string): boolean => (inputs[name] ?? 'false') === 'true')
    }

    function snapshotOf(): { calls: Recorded[]; failed: unknown[] } {
        const calls = [...recorded].sort((a, b) => {
            const byCommand = a.command.localeCompare(b.command)
            if (byCommand !== 0) {
                return byCommand
            }
            const aKey = String((a.input as Record<string, unknown>)?.Key ?? '')
            const bKey = String((b.input as Record<string, unknown>)?.Key ?? '')
            return aKey.localeCompare(bKey)
        })
        return { calls, failed: setFailedMock.mock.calls.map(args => scrub(args[0])) }
    }

    beforeEach(() => {
        recorded = []
        headBehavior = 'missing'
        putFails = false

        jest.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
            const cmd = command as { constructor: { name: string }; input: Record<string, unknown> }
            recorded.push({ command: cmd.constructor.name, input: normalize(cmd.input) })

            if (command instanceof ListObjectsV2Command) {
                return { Contents: [{ Key: 'stale/object.txt' }], IsTruncated: false }
            }
            if (command instanceof DeleteObjectsCommand) {
                return { Deleted: [{ Key: 'stale/object.txt' }] }
            }
            if (command instanceof HeadObjectCommand) {
                if (headBehavior === 'missing') {
                    const err = new Error('NotFound') as Error & { name: string }
                    err.name = 'NotFound'
                    throw err
                }
                if (headBehavior === 'differ') {
                    return { ETag: '"00000000000000000000000000000000"' }
                }
                const key = String(cmd.input.Key)
                const md5 = createHash('md5')
                    .update(readFileSync(join(process.env.GITHUB_WORKSPACE ?? '', key)))
                    .digest('hex')
                return { ETag: `"${md5}"` }
            }
            if (command instanceof PutObjectCommand && putFails) {
                throw new Error('upload boom')
            }
            return { ETag: '"stub-etag"' }
        })

        getInputMock = jest.spyOn(core, 'getInput')
        getMultilineInputMock = jest.spyOn(core, 'getMultilineInput')
        getBooleanInputMock = jest.spyOn(core, 'getBooleanInput')
        getIDTokenMock = jest.spyOn(core, 'getIDToken')
        setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
        axiosPostMock = jest.spyOn(require('axios'), 'post')

        jest.spyOn(core, 'info').mockImplementation()
        jest.spyOn(core, 'debug').mockImplementation()
        jest.spyOn(core, 'error').mockImplementation()
        jest.spyOn(core, 'startGroup').mockImplementation()
        jest.spyOn(core, 'endGroup').mockImplementation()

        applyInputs()
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    test('sa-json credentials with default inputs', async () => {
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('prefix is prepended to every key', async () => {
        applyInputs({ prefix: 'assets/' })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('exclude patterns drop matching files', async () => {
        applyInputs({ exclude: '**/*.txt' })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('include glob walks subdirectories', async () => {
        applyInputs({ include: 'src_with_subfolders/**' })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('root drops the folder prefix from keys', async () => {
        applyInputs({ root: './src', include: '*' })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('clear empties the bucket before uploading', async () => {
        applyInputs({ clear: 'true' })
        await run()

        // The `calls` snapshot below is sorted by command name, so it cannot see
        // temporal order and would stay byte-identical even if a future module
        // split ran upload before clearBucket finished. Assert the real order on
        // the raw, unsorted log so that regression is actually caught.
        const lastClearIndex = recorded.reduce(
            (last, entry, index) =>
                entry.command === 'ListObjectsV2Command' || entry.command === 'DeleteObjectsCommand' ? index : last,
            -1
        )
        const firstPutIndex = recorded.findIndex(entry => entry.command === 'PutObjectCommand')
        expect(lastClearIndex).toBeLessThan(firstPutIndex)

        expect(snapshotOf()).toMatchSnapshot()
    })

    test('cache-control mapping and default are applied', async () => {
        applyInputs({ 'cache-control': '*.js:public, max-age=3600\n*:no-cache' })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('custom concurrency uploads the same set', async () => {
        applyInputs({ concurrency: '2' })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('skip-unchanged skips files whose etag matches', async () => {
        applyInputs({ 'skip-unchanged': 'true' })
        headBehavior = 'match'
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('skip-unchanged uploads files whose etag differs', async () => {
        applyInputs({ 'skip-unchanged': 'true' })
        headBehavior = 'differ'
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('fail-on-error attempts every file then fails', async () => {
        applyInputs({ 'fail-on-error': 'true' })
        putFails = true
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('iam token credentials', async () => {
        applyInputs({ 'yc-sa-json-credentials': '', 'yc-iam-token': 'test-iam-token' })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('workload identity credentials', async () => {
        applyInputs({ 'yc-sa-json-credentials': '', 'yc-sa-id': 'test-sa-id' })
        getIDTokenMock.mockResolvedValue('github-token')
        axiosPostMock.mockImplementation(async (url: string, payload: unknown) => {
            recorded.push({ command: 'axios.post', input: normalize({ url, payload }) })
            return { status: 200, data: { access_token: 'exchanged-token' } }
        })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('no credentials fails before any request', async () => {
        applyInputs({ 'yc-sa-json-credentials': '' })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })

    test('missing required bucket fails before any request', async () => {
        applyInputs({ bucket: '' })
        await run()
        expect(snapshotOf()).toMatchSnapshot()
    })
})
```

- [ ] **Step 2: Run the test and confirm the spy actually intercepts**

Run: `npm test -- __tests__/characterization.test.ts`

Expected: 15 passing tests, and the run writes `__tests__/__snapshots__/characterization.test.ts.snap`.

If any test hangs or attempts a real network call, the `S3Client.prototype.send` spy is not intercepting. In that case the AWS SDK has moved `send` further up the prototype chain — find it with:

```bash
node -e "const {S3Client}=require('@aws-sdk/client-s3'); let p=S3Client.prototype; while(p){ if(Object.getOwnPropertyNames(p).includes('send')) console.log(p.constructor.name); p=Object.getPrototypeOf(p) }"
```

and spy on the class that prints. Record the finding in the commit message.

- [ ] **Step 3: Read the snapshot and sanity-check it**

Run: `cat __tests__/__snapshots__/characterization.test.ts.snap`

Check by eye, before trusting it as a net:

- the default scenario records three `PutObjectCommand` entries with keys `src/exclude.txt`, `src/exclude.yaml`, `src/func.js`
- the `prefix` scenario records the same three keys under `assets/`
- the `clear` scenario records one `ListObjectsV2Command` and one `DeleteObjectsCommand`
- the `clear` scenario's ordering assertion (on the raw, unsorted `recorded` array) actually fails if `clearBucket` and `upload` are called in the wrong order — verified by hand, not just read
- the `cache-control` scenario records `CacheControl: "public, max-age=3600"` on `src/func.js` and `"no-cache"` on the other two
- the `skip-unchanged` matching scenario records three `HeadObjectCommand` entries and zero `PutObjectCommand` entries
- the `workload identity` scenario records one `axios.post` entry with `audience: "test-sa-id"` and `subject_token: "github-token"`
- the `no credentials` and `missing required bucket` scenarios record zero calls and one `failed` message each
- no entry anywhere contains a `Body` that is not a `sha256:` string

If any of these is wrong, the net is recording the wrong thing — fix the test before continuing. A wrong snapshot is worse than no snapshot.

- [ ] **Step 4: Verify the whole existing suite still passes**

Run: `npm test`

Expected: all suites pass. The new file must not disturb `main.test.ts` or `cache-contol.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add __tests__/characterization.test.ts __tests__/__snapshots__/characterization.test.ts.snap
git commit -m "test: record characterization snapshot of S3 requests

Captures every S3 command and token-exchange request run() issues across
all 15 input scenarios, recorded through a S3Client.prototype.send spy so
the mechanism survives the CommonJS to ESM move. This snapshot is the
regression net for the typescript-action template rewrite and must
reproduce unchanged after every step of it."
```

---

## Task 2: Move test data to `__fixtures__/workspace/`

Test data is not tests. This move is deliberately its own task: it is the first proof that the Task 1 net actually detects nothing when nothing changed.

**Files:**

- Move: `__tests__/src/` → `__fixtures__/workspace/src/`
- Move: `__tests__/src_with_subfolders/` → `__fixtures__/workspace/src_with_subfolders/`
- Modify: `package.json` (the `test` script's `GITHUB_WORKSPACE`)
- Modify: `__tests__/main.test.ts:424` (the `join('__tests__', key)` in the skip-unchanged test)

**Interfaces:**

- Consumes: nothing new.
- Produces: `GITHUB_WORKSPACE=__fixtures__/workspace` for every later task's test runs.

- [ ] **Step 1: Move the fixture trees**

```bash
mkdir -p __fixtures__/workspace
git mv __tests__/src __fixtures__/workspace/src
git mv __tests__/src_with_subfolders __fixtures__/workspace/src_with_subfolders
```

- [ ] **Step 2: Point the test script at the new workspace**

In `package.json`, change:

```json
"test": "GITHUB_WORKSPACE=__tests__ jest",
```

to:

```json
"test": "GITHUB_WORKSPACE=__fixtures__/workspace jest",
```

and change `ci-test` from `"jest"` to:

```json
"ci-test": "GITHUB_WORKSPACE=__fixtures__/workspace jest",
```

(`ci-test` previously ran without `GITHUB_WORKSPACE`, which made CI and local runs disagree. They agree from here on.)

- [ ] **Step 3: Update the one test that hardcoded the old workspace**

In `__tests__/main.test.ts`, inside the `skips a file whose remote ETag matches the local md5` test, change:

```ts
.update(readFileSync(join('__tests__', key)))
```

to:

```ts
.update(readFileSync(join(process.env.GITHUB_WORKSPACE ?? '', key)))
```

Add `import { env } from 'process'` usage is already present in the file as `env`; either `process.env` or the imported `env` is fine — use `env.GITHUB_WORKSPACE ?? ''` to match the file's existing style.

- [ ] **Step 4: Run the full suite and diff the snapshot**

Run: `npm test && git diff --stat __tests__/__snapshots__/`

Expected: all suites pass, and `git diff` on the snapshot directory prints nothing. The `scrub()` helper is what absorbs the workspace path change in the `fail-on-error` scenario's failure message.

If the snapshot diffs, do not update it — read the diff. Anything other than a workspace path means the move changed behavior.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: move fixture data to __fixtures__/workspace"
```

---

## Task 3: Split `src/main.ts` into modules (still CommonJS)

The refactor happens before the ESM switch so that only one of the two is ever unverified at a time. Under CommonJS the existing `jest.spyOn(core, ...)` still works, so the test edits in this task are import paths and nothing else.

**Files:**

- Create: `src/auth.ts`, `src/s3-client.ts`, `src/upload.ts`, `src/clear-bucket.ts`, `src/action-inputs.ts`
- Modify: `src/main.ts` (shrinks to orchestration), `package.json` (add `@smithy/types`)
- Modify: `__tests__/main.test.ts` (import paths only)

**Interfaces:**

- Consumes: `run` from `src/main.ts`, unchanged signature.
- Produces:
  - `src/auth.ts`: `exchangeToken(token: string, saId: string): Promise<string>`, `resolveTokenService(ycSaJsonCredentials: string, ycIamToken: string, ycSaId: string): Promise<TokenService>`
  - `src/s3-client.ts`: `createS3Client(tokenService: TokenService): S3Client`
  - `src/upload.ts`: `upload(s3Client: S3Client, inputs: UploadInputs): Promise<void>`, `runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void>`, `parseConcurrency(raw: string): number`, `interface UploadInputs`, `DEFAULT_CONCURRENCY = 16`, `MAX_CONCURRENCY = 256`
  - `src/clear-bucket.ts`: `clearBucket(client: S3Client, bucket: string): Promise<void>`
  - `src/action-inputs.ts`: `type ActionInputs`, `readInputs(): ActionInputs`

- [ ] **Step 1: Add `@smithy/types` as a direct dependency**

Run: `npm install --save @smithy/types`

This lets `FinalizeRequestMiddleware` come from its own package instead of through
`@aws-sdk/types/dist-types/middleware`, which reaches past that package's exports map.

- [ ] **Step 2: Create `src/upload.ts`**

Move `UploadInputs`, `DEFAULT_CONCURRENCY`, `MAX_CONCURRENCY`, `parseConcurrency`, `runPool`, `fileMd5`, `uploadFile`, `upload`, and `parseIgnoreGlobPatterns` out of `main.ts` verbatim:

```ts
import { debug, endGroup, error, info, setFailed, startGroup } from '@actions/core'
import {
    type AbortMultipartUploadCommandOutput,
    type CompleteMultipartUploadCommandOutput,
    HeadObjectCommand,
    S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { createHash } from 'crypto'
import { createReadStream, statSync } from 'fs'
import { glob } from 'glob'
import mimeTypes from 'mime-types'
import { minimatch } from 'minimatch'
import path from 'node:path'
import { CacheControlConfig, getCacheControlValue } from './cache-control'

export interface UploadInputs {
    include: string[]
    exclude: string[]
    root: string
    prefix: string
    bucket: string
    cacheControl: CacheControlConfig
    concurrency?: number
    skipUnchanged?: boolean
    failOnError?: boolean
}

export const DEFAULT_CONCURRENCY = 16
export const MAX_CONCURRENCY = 256

export function parseConcurrency(raw: string): number {
    const n = parseInt(raw, 10)
    if (isNaN(n)) {
        return DEFAULT_CONCURRENCY
    }
    return Math.min(MAX_CONCURRENCY, Math.max(1, n))
}

export async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    let index = 0
    const next = async (): Promise<void> => {
        while (index < items.length) {
            const current = items[index]
            index += 1
            await worker(current)
        }
    }
    const workerCount = Math.max(1, Math.min(concurrency, items.length))
    await Promise.all(Array.from({ length: workerCount }, () => next()))
}

async function fileMd5(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('md5')
        const stream = createReadStream(filePath)
        stream.on('error', reject)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('end', () => resolve(hash.digest('hex')))
    })
}

const uploadFile = async (
    client: S3Client,
    filePath: string,
    { root, bucket, prefix, cacheControl, skipUnchanged }: UploadInputs
): Promise<CompleteMultipartUploadCommandOutput | AbortMultipartUploadCommandOutput | undefined> => {
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
        return
    }
    const contentType = mimeTypes.lookup(filePath) || 'text/plain'

    let key = path.relative(root, filePath)
    if (prefix) {
        key = path.join(prefix, key)
    }

    if (skipUnchanged) {
        try {
            const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
            const remoteETag = (head.ETag ?? '').replace(/"/g, '').toLowerCase()
            const localMd5 = (await fileMd5(filePath)).toLowerCase()
            if (remoteETag && remoteETag === localMd5) {
                info(`skipping unchanged ${key}`)
                return
            }
        } catch (e) {
            // Object missing (404) or HeadObject failed -> fall through and upload.
            debug(`head check failed for ${key}: ${e}`)
        }
    }

    try {
        info(`starting to upload ${key}`)
        const parallelUploads3 = new Upload({
            client,
            params: {
                Bucket: bucket,
                Key: key,
                Body: createReadStream(filePath),
                ContentType: contentType,
                CacheControl: getCacheControlValue(cacheControl, key)
            },
            queueSize: 4,
            leavePartsOnError: false
        })

        return await parallelUploads3.done()
    } catch (e) {
        error(`failed to upload ${key}: ${e}`)
        throw e
    }
}

export async function upload(s3Client: S3Client, inputs: UploadInputs): Promise<void> {
    startGroup('Upload')

    try {
        info('Upload start')

        const workspace = process.env['GITHUB_WORKSPACE'] ?? ''
        const patterns = parseIgnoreGlobPatterns(inputs.exclude)
        const root = path.join(workspace, inputs.root)

        const filesToUpload: string[] = []
        for (const include of inputs.include) {
            let pathFromSourceRoot = path.join(root, include)
            if (!pathFromSourceRoot.includes('*')) {
                try {
                    const stat = statSync(pathFromSourceRoot)
                    if (stat.isDirectory()) {
                        pathFromSourceRoot = path.join(pathFromSourceRoot, '*')
                    }
                } catch (e) {
                    debug(`${e}`)
                }
            }
            const matches = glob.sync(pathFromSourceRoot, { absolute: false })
            for (const match of matches) {
                const excluded = patterns.map(p => minimatch(match, p, { matchBase: true })).some(x => x)
                if (!excluded) {
                    filesToUpload.push(match)
                }
            }
        }

        const concurrency = inputs.concurrency ?? DEFAULT_CONCURRENCY
        const failures: string[] = []
        await runPool(filesToUpload, concurrency, async match => {
            try {
                await uploadFile(s3Client, match, { ...inputs, root })
            } catch {
                // uploadFile already logged the error; record the file so we can fail the action.
                failures.push(match)
            }
        })

        if (failures.length > 0 && inputs.failOnError) {
            setFailed(`Failed to upload ${failures.length} file(s): ${failures.join(', ')}`)
        }
    } finally {
        endGroup()
    }
}

function parseIgnoreGlobPatterns(patterns: string[]): string[] {
    const result: string[] = []

    for (const pattern of patterns) {
        //only not empty patterns
        if (pattern?.length > 0) {
            result.push(pattern)
        }
    }

    info(`Source ignore pattern: "${JSON.stringify(result)}"`)
    return result
}
```

- [ ] **Step 3: Create `src/clear-bucket.ts`**

```ts
import { info } from '@actions/core'
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

export async function clearBucket(client: S3Client, bucket: string): Promise<void> {
    info('Clearing bucket')
    const listCommand = new ListObjectsV2Command({
        Bucket: bucket,
        // The default and maximum number of keys returned is 1000.
        MaxKeys: 1000
    })

    let isTruncated = true
    let totalDeleted = 0

    while (isTruncated) {
        const { Contents, IsTruncated, NextContinuationToken } = await client.send(listCommand)

        if (!Contents || Contents.length === 0) {
            break
        }

        isTruncated = Boolean(IsTruncated)
        listCommand.input.ContinuationToken = NextContinuationToken

        const deleteCommand = new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
                Objects: Contents.map(c => ({ Key: c.Key }))
            }
        })

        const { Deleted } = await client.send(deleteCommand)

        totalDeleted += Deleted?.length ?? 0
    }

    info(`Deleted ${totalDeleted} objects from bucket ${bucket}`)
}
```

- [ ] **Step 4: Create `src/auth.ts`**

The three credential branches and the `TokenService` derivation fold into one function. Two intentional consequences, both recorded in the spec: the unreachable `No IAM token provided` message goes away, and `new IamTokenService(...)` now runs before `readInputs()`. The constructor is pure field assignment, so nothing observable moves.

```ts
import { getIDToken, info } from '@actions/core'
import { IamTokenService } from '@yandex-cloud/nodejs-sdk/dist/token-service/iam-token-service'
import { TokenService } from '@yandex-cloud/nodejs-sdk/dist/types'
import axios from 'axios'
import { fromServiceAccountJsonFile } from './service-account-json'

export async function exchangeToken(token: string, saId: string): Promise<string> {
    info(`Exchanging token for service account ${saId}`)
    const res = await axios.post(
        'https://auth.yandex.cloud/oauth/token',
        {
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            audience: saId,
            subject_token: token,
            subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
        },
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    )
    if (res.status !== 200) {
        throw new Error(`Failed to exchange token: ${res.status} ${res.statusText}`)
    }
    if (!res.data.access_token) {
        throw new Error(`Failed to exchange token: ${res.data.error} ${res.data.error_description}`)
    }
    info(`Token exchanged successfully`)
    return res.data.access_token
}

export async function resolveTokenService(
    ycSaJsonCredentials: string,
    ycIamToken: string,
    ycSaId: string
): Promise<TokenService> {
    if (ycSaJsonCredentials !== '') {
        const serviceAccountJson = fromServiceAccountJsonFile(JSON.parse(ycSaJsonCredentials))
        info('Parsed Service account JSON')
        return new IamTokenService(serviceAccountJson)
    }

    let iamToken: string
    if (ycIamToken !== '') {
        iamToken = ycIamToken
        info('Using IAM token')
    } else if (ycSaId !== '') {
        const ghToken = await getIDToken()
        if (!ghToken) {
            throw new Error('No credentials provided')
        }
        iamToken = await exchangeToken(ghToken, ycSaId)
    } else {
        throw new Error('No credentials')
    }

    return { getToken: async () => iamToken }
}
```

- [ ] **Step 5: Create `src/s3-client.ts`**

```ts
import { S3Client } from '@aws-sdk/client-s3'
import { RequestChecksumCalculation, ResponseChecksumValidation } from '@aws-sdk/middleware-flexible-checksums'
import { HttpRequest } from '@smithy/protocol-http'
import { type FinalizeRequestMiddleware } from '@smithy/types'
import { TokenService } from '@yandex-cloud/nodejs-sdk/dist/types'

export function createS3Client(tokenService: TokenService): S3Client {
    const s3Client = new S3Client({
        region: 'ru-central1',
        endpoint: 'https://storage.yandexcloud.net',
        requestChecksumCalculation: RequestChecksumCalculation.WHEN_REQUIRED,
        responseChecksumValidation: ResponseChecksumValidation.WHEN_REQUIRED
    })

    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    const middleware: FinalizeRequestMiddleware<any, any> = next => {
        return async args => {
            if (!HttpRequest.isInstance(args.request)) {
                return next(args)
            }
            args.request.headers['X-YaCloud-SubjectToken'] = await tokenService.getToken()
            return next(args)
        }
    }

    s3Client.middlewareStack.removeByTag('HTTP_AUTH_SCHEME')
    s3Client.middlewareStack.removeByTag('HTTP_SIGNING')
    s3Client.middlewareStack.addRelativeTo(middleware, {
        name: 'ycAuthMiddleware',
        tags: ['YCAUTH'],
        relation: 'after',
        toMiddleware: 'retryMiddleware',
        override: true
    })

    return s3Client
}
```

If `@smithy/types` does not type-check here, revert this one import to
`import { type FinalizeRequestMiddleware } from '@aws-sdk/types/dist-types/middleware'`, drop
the `@smithy/types` dependency added in Step 1, and note the reason in the commit message.

- [ ] **Step 6: Create `src/action-inputs.ts`**

```ts
import { getBooleanInput, getInput, getMultilineInput } from '@actions/core'
import { CacheControlConfig, parseCacheControlFormats } from './cache-control'
import { parseConcurrency } from './upload'

export type ActionInputs = {
    bucket: string
    prefix: string
    root: string
    include: string[]
    exclude: string[]
    clear: boolean
    cacheControl: CacheControlConfig
    concurrency: number
    skipUnchanged: boolean
    failOnError: boolean
}

export function readInputs(): ActionInputs {
    return {
        bucket: getInput('bucket', { required: true }),
        prefix: getInput('prefix', { required: false }),
        root: getInput('root', { required: true }),
        include: getMultilineInput('include', { required: false }),
        exclude: getMultilineInput('exclude', { required: false }),
        clear: getBooleanInput('clear', { required: false }),
        cacheControl: parseCacheControlFormats(getMultilineInput('cache-control', { required: false })),
        concurrency: parseConcurrency(getInput('concurrency', { required: false })),
        skipUnchanged: getBooleanInput('skip-unchanged', { required: false }),
        failOnError: getBooleanInput('fail-on-error', { required: false })
    }
}
```

- [ ] **Step 7: Replace `src/main.ts` with the orchestration only**

```ts
import { getInput, setFailed } from '@actions/core'
import { readInputs } from './action-inputs'
import { resolveTokenService } from './auth'
import { clearBucket } from './clear-bucket'
import { createS3Client } from './s3-client'
import { upload } from './upload'

export async function run(): Promise<void> {
    try {
        const tokenService = await resolveTokenService(
            getInput('yc-sa-json-credentials'),
            getInput('yc-iam-token'),
            getInput('yc-sa-id')
        )

        const inputs = readInputs()
        const s3Client = createS3Client(tokenService)

        if (inputs.clear) {
            await clearBucket(s3Client, inputs.bucket)
        }
        await upload(s3Client, inputs)
    } catch (err) {
        if (err instanceof Error) {
            setFailed(err.message)
        }
    }
}
```

- [ ] **Step 8: Update test imports**

In `__tests__/main.test.ts`, replace:

```ts
import { clearBucket, parseConcurrency, run, runPool, upload, UploadInputs } from '../src/main'
```

with:

```ts
import { clearBucket } from '../src/clear-bucket'
import { run } from '../src/main'
import { parseConcurrency, runPool, upload, UploadInputs } from '../src/upload'
```

No other change to that file in this task.

- [ ] **Step 9: Run everything and diff the snapshot**

Run: `npm test && npx tsc --noEmit && git diff --stat __tests__/__snapshots__/`

Expected: all suites pass, `tsc` is clean, the snapshot diff is empty.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: split main.ts into focused modules

Moves upload, clearBucket, credential resolution, S3 client construction
and input reading out of main.ts, leaving orchestration only. Behavior is
unchanged: the characterization snapshot reproduces byte-identically."
```

---

## Task 4: Switch source and tests to ESM

**Files:**

- Modify: `package.json` (`type`, `jest` key removed, scripts), `tsconfig.json`
- Create: `jest.config.js`, `__fixtures__/core.ts`, `__fixtures__/axios.ts`
- Modify: every file in `src/` (relative imports gain `.js`)
- Create: `__tests__/upload.test.ts`, `__tests__/clear-bucket.test.ts`
- Modify: `__tests__/main.test.ts`, `__tests__/characterization.test.ts`
- Rename: `__tests__/cache-contol.test.ts` → `__tests__/cache-control.test.ts`

**Interfaces:**

- Consumes: every export listed in Task 3's Produces block, now under `.js` specifiers (`../src/upload.js`).
- Produces:
  - `__fixtures__/core.ts`: named `jest.fn()` exports `debug`, `endGroup`, `error`, `getBooleanInput`, `getIDToken`, `getInput`, `getMultilineInput`, `info`, `setFailed`, `startGroup`
  - `__fixtures__/axios.ts`: named export `post` plus a `default` export object carrying it

- [ ] **Step 1: Install the ESM harness dependencies**

```bash
npm install --save-dev ts-jest-resolver @jest/globals
```

- [ ] **Step 2: Mark the package as ESM**

In `package.json`: add `"type": "module"` next to `"version"`, and delete the entire `"jest"` key (it moves to `jest.config.js` in Step 3). Update the two test scripts:

```json
"ci-test": "NODE_OPTIONS=--experimental-vm-modules NODE_NO_WARNINGS=1 GITHUB_WORKSPACE=__fixtures__/workspace npx jest",
"test": "NODE_OPTIONS=--experimental-vm-modules NODE_NO_WARNINGS=1 GITHUB_WORKSPACE=__fixtures__/workspace npx jest",
```

- [ ] **Step 3: Create `jest.config.js`**

```js
// See: https://jestjs.io/docs/configuration

/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
    clearMocks: true,
    collectCoverage: true,
    collectCoverageFrom: ['./src/**', '!./src/index.ts'],
    coverageDirectory: './coverage',
    coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
    coverageReporters: ['json-summary', 'text', 'lcov'],
    extensionsToTreatAsEsm: ['.ts'],
    moduleFileExtensions: ['ts', 'js'],
    preset: 'ts-jest',
    reporters: ['default'],
    resolver: 'ts-jest-resolver',
    testEnvironment: 'node',
    testMatch: ['**/*.test.ts'],
    testPathIgnorePatterns: ['/dist/', '/node_modules/'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                tsconfig: 'tsconfig.json',
                useESM: true
            }
        ]
    },
    verbose: true
}
```

The `coverageThreshold` key is deliberately absent here; it is added in Task 8 once the post-rewrite numbers are known.

- [ ] **Step 4: Replace `tsconfig.json`**

```json
{
    "$schema": "https://json.schemastore.org/tsconfig",
    "compilerOptions": {
        "allowSyntheticDefaultImports": true,
        "declaration": false,
        "declarationMap": false,
        "esModuleInterop": true,
        "forceConsistentCasingInFileNames": true,
        "isolatedModules": true,
        "lib": ["ES2022"],
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "newLine": "lf",
        "noImplicitAny": true,
        "noUnusedLocals": true,
        "noUnusedParameters": false,
        "outDir": "./dist",
        "pretty": true,
        "resolveJsonModule": true,
        "sourceMap": true,
        "strict": true,
        "strictNullChecks": true,
        "target": "ES2022"
    },
    "exclude": ["__fixtures__", "__tests__", "coverage", "dist", "node_modules"],
    "include": ["src"]
}
```

- [ ] **Step 5: Add `.js` to every relative import in `src/`**

Only relative specifiers change. Bare specifiers (`@actions/core`, `glob`) and the Yandex SDK deep specifiers (`@yandex-cloud/nodejs-sdk/dist/types`) stay exactly as they are — the SDK's exports map declares `"./dist/*": "./dist/*.js"`, so NodeNext resolves them unchanged.

| File | Change |
| --- | --- |
| `src/index.ts` | `'./main'` → `'./main.js'` |
| `src/main.ts` | `'./action-inputs'`, `'./auth'`, `'./clear-bucket'`, `'./s3-client'`, `'./upload'` each gain `.js` |
| `src/action-inputs.ts` | `'./cache-control'` → `'./cache-control.js'`, `'./upload'` → `'./upload.js'` |
| `src/auth.ts` | `'./service-account-json'` → `'./service-account-json.js'` |
| `src/upload.ts` | `'./cache-control'` → `'./cache-control.js'` |

`src/cache-control.ts`, `src/clear-bucket.ts`, `src/s3-client.ts`, and `src/service-account-json.ts` have no relative imports.

- [ ] **Step 6: Verify the source compiles before touching tests**

Run: `npx tsc --noEmit`

Expected: clean. If `noUnusedLocals` flags anything, delete the unused binding — do not disable the flag.

- [ ] **Step 7: Create `__fixtures__/core.ts`**

```ts
import { jest } from '@jest/globals'
import type * as core from '@actions/core'

export const debug = jest.fn<typeof core.debug>()
export const endGroup = jest.fn<typeof core.endGroup>()
export const error = jest.fn<typeof core.error>()
export const getBooleanInput = jest.fn<typeof core.getBooleanInput>()
export const getIDToken = jest.fn<typeof core.getIDToken>()
export const getInput = jest.fn<typeof core.getInput>()
export const getMultilineInput = jest.fn<typeof core.getMultilineInput>()
export const info = jest.fn<typeof core.info>()
export const setFailed = jest.fn<typeof core.setFailed>()
export const startGroup = jest.fn<typeof core.startGroup>()
```

- [ ] **Step 8: Create `__fixtures__/axios.ts`**

`src/auth.ts` does `import axios from 'axios'` and calls `axios.post(...)`, so the double needs a default export carrying `post`.

```ts
import { jest } from '@jest/globals'
import type { AxiosStatic } from 'axios'

export const post = jest.fn<AxiosStatic['post']>()

const axios = { post } as unknown as AxiosStatic

export default axios
```

- [ ] **Step 9: Rewrite `__tests__/characterization.test.ts` for ESM**

The snapshot must not change; only the mocking mechanism does. Replace the imports and the `core`/`axios` spy setup:

```ts
import { jest } from '@jest/globals'
import {
    DeleteObjectsCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client
} from '@aws-sdk/client-s3'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as core from '../__fixtures__/core.js'
import * as axios from '../__fixtures__/axios.js'

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('axios', () => axios)

const { run } = await import('../src/main.js')
```

Then, inside `beforeEach`, the `jest.spyOn(core, ...)` lines become direct references to the
fixture mocks — the fixture functions *are* the mocks:

```ts
        getInputMock = core.getInput
        getMultilineInputMock = core.getMultilineInput
        getBooleanInputMock = core.getBooleanInput
        getIDTokenMock = core.getIDToken
        setFailedMock = core.setFailed
        axiosPostMock = axios.post
```

Delete the five `jest.spyOn(core, 'info' | 'debug' | 'error' | 'startGroup' | 'endGroup').mockImplementation()` lines — the fixtures are already no-op mocks. Change the declared types of those six `let` bindings from `jest.SpyInstance` to `jest.Mock`, or simply drop the separate declarations and use `core.getInput` etc. inline. Keep `afterEach(() => { jest.restoreAllMocks() })` for the `S3Client.prototype.send` spy, which stays a real `jest.spyOn`.

- [ ] **Step 10: Split `__tests__/main.test.ts` into three files**

`__tests__/upload.test.ts` takes the `parseConcurrency`, `runPool`, and `upload` describe blocks:

```ts
import { jest } from '@jest/globals'
import {
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand
} from '@aws-sdk/client-s3'
import { createHash } from 'crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { env } from 'process'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { newCacheControlConfig } = await import('../src/cache-control.js')
const { parseConcurrency, runPool, upload } = await import('../src/upload.js')
type UploadInputs = import('../src/upload.js').UploadInputs
```

Everything else in those three describe blocks is copied verbatim, with two mechanical
substitutions:

- `jest.spyOn(core, 'setFailed').mockImplementation()` becomes `core.setFailed`, and the
  matching `setFailedMock.mockRestore()` lines are deleted (`clearMocks: true` handles it)
- `join('__tests__', key)` becomes `join(env.GITHUB_WORKSPACE ?? '', key)` (already done in
  Task 2 — carry it across unchanged)

`__tests__/clear-bucket.test.ts` takes the three `clearBucket` tests (`it should clear bucket`,
`it should clear bucket with a lot objects`, and the two empty/undefined-contents tests
currently sitting inside the `run` describe block):

```ts
import { jest } from '@jest/globals'
import { DeleteObjectsCommand, ListObjectsV2Command, ListObjectsV2Output, S3Client } from '@aws-sdk/client-s3'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { clearBucket } = await import('../src/clear-bucket.js')
```

`__tests__/main.test.ts` keeps only the `run` describe block:

```ts
import { jest } from '@jest/globals'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import * as core from '../__fixtures__/core.js'
import * as axios from '../__fixtures__/axios.js'

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('axios', () => axios)

const { run } = await import('../src/main.js')
```

with `jest.spyOn(core, 'getInput')` and friends replaced by the fixture mocks, and
`jest.spyOn(require('axios'), 'post')` replaced by `axios.post`. The assertions themselves —
which `setFailed` message, which `axios.post` payload — do not change.

- [ ] **Step 11: Rename the cache-control test**

```bash
git mv __tests__/cache-contol.test.ts __tests__/cache-control.test.ts
```

and change its import to `'../src/cache-control.js'`.

- [ ] **Step 12: Run the suite and diff the snapshot**

Run: `npm test && git diff --stat __tests__/__snapshots__/`

Expected: all five suites pass and the snapshot diff is empty.

Two failure modes to expect here, both with known fixes:

- `unstable_mockModule` matches the *exact* specifier string the module under test imports. If a
  `core` mock does not take effect, check that the source imports `'@actions/core'` and not a
  subpath.
- `jest.fn()` doubles from `__fixtures__` are shared across a test file. `clearMocks: true`
  resets them between tests, so any implementation must be set in `beforeEach` or in the test
  itself, never in `beforeAll`.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "refactor: convert source and tests to ESM

Adds type: module, moves jest config out of package.json into an ESM
config with ts-jest-resolver, and replaces @actions/core and axios spies
with __fixtures__ doubles registered through unstable_mockModule. The
characterization snapshot reproduces byte-identically across the change."
```

---

## Task 5: Bundle with Rollup

The one unproven step. It is gated by running the bundle for real at the end of this task, not by CI later.

**Files:**

- Create: `rollup.config.ts`
- Modify: `package.json` (scripts, devDependencies)
- Delete: `dist/` contents produced by ncc (regenerated)

**Interfaces:**

- Consumes: `src/index.ts` as the bundle entrypoint.
- Produces: `dist/index.js` (ESM) and `dist/index.js.map`, referenced by `action.yml`'s `runs.main`.

- [ ] **Step 1: Install Rollup and its plugins**

```bash
npm install --save-dev rollup @rollup/plugin-commonjs @rollup/plugin-json @rollup/plugin-node-resolve @rollup/plugin-typescript rimraf
```

- [ ] **Step 2: Create `rollup.config.ts`**

```ts
// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

// @yandex-cloud/nodejs-sdk, @grpc/grpc-js, nice-grpc and jsonwebtoken are
// CommonJS and reference require, __filename and __dirname. None of the three
// exist in an ES module, so the bundle defines them from import.meta.url.
const banner = [
    "import { createRequire as __createRequire } from 'node:module'",
    "import { fileURLToPath as __fileURLToPath } from 'node:url'",
    "import { dirname as __pathDirname } from 'node:path'",
    'const require = __createRequire(import.meta.url)',
    'const __filename = __fileURLToPath(import.meta.url)',
    'const __dirname = __pathDirname(__filename)'
].join('\n')

const config = {
    input: 'src/index.ts',
    output: {
        banner,
        esModule: true,
        file: 'dist/index.js',
        format: 'es',
        sourcemap: true
    },
    plugins: [
        typescript(),
        // exportConditions: ['node'] is an addition to the template. The AWS SDK
        // and @smithy/* packages publish browser variants; without it, resolve
        // can pick a browser build whose crypto and stream shims do not work on
        // the Actions runner.
        nodeResolve({ preferBuiltins: true, exportConditions: ['node'] }),
        commonjs(),
        json()
    ]
}

export default config
```

- [ ] **Step 3: Swap the `package` script from ncc to Rollup**

In `package.json`:

```json
"package": "npx rimraf ./dist && npx rollup --config rollup.config.ts --configPlugin @rollup/plugin-typescript",
"package:watch": "npm run package -- --watch",
```

- [ ] **Step 4: Build the bundle**

Run: `npm run package`

Expected: `dist/index.js` and `dist/index.js.map` only. No `proto/`, `xds/`,
`protoc-gen-validate/`, `licenses.txt`, or `sourcemap-register.js`.

Rollup will emit circular-dependency and `this`-rewrite warnings from the CommonJS graph. Those
are expected. What is not acceptable is an *error*, or an unresolved import.

If `banner` collides with a bundled declaration (Rollup errors on a duplicate `require`,
`__filename`, or `__dirname` binding), rename the bundle's version rather than dropping the
shim — the shim is what turns a `ReferenceError` into a clear `ENOENT` if grpc-js ever reaches
its proto loader.

- [ ] **Step 5: Smoke-test the bundle by hand**

```bash
env -u INPUT_YC-SA-JSON-CREDENTIALS node dist/index.js; echo "exit=$?"
```

Expected: prints `::error::No credentials` and `exit=1`.

This is the gate on the whole Rollup decision. If the bundle throws `ERR_REQUIRE_ESM`, a
`ReferenceError`, or a missing-module error instead, take the documented fallback:

- revert `package` to `"ncc build src/index.ts --license licenses.txt"`
- add `dist/package.json` containing `{"type":"commonjs"}`
- keep `@vercel/ncc` in `devDependencies` permanently
- record the exact failure in the commit message, and stop to report it

The ESM source layout and the test harness stand either way; only this script changes.

- [ ] **Step 6: Confirm the bundle still passes tests, then drop ncc**

Run: `npm test`

Expected: all suites pass (tests run against `src/`, not `dist/`, but this catches an
accidental source edit).

If Step 5 succeeded, remove ncc:

```bash
npm uninstall @vercel/ncc
```

and delete `.prettierignore`'s `lib/` line if present (there is no `lib/` in this repo).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build: bundle with Rollup instead of ncc

Emits a single ESM dist/index.js with a banner that defines require,
__filename and __dirname from import.meta.url, which the CommonJS
dependencies in this graph need. Drops the grpc-js proto/, xds/ and
protoc-gen-validate/ trees: their loader resolves above the action
checkout, so shipping them cannot restore parity, and both call sites are
unreachable for a client-only action."
```

---

## Task 6: Template scaffolding and configs

**Files:**

- Create: `.node-version`, `.prettierrc.yml`, `.env.example`, `.markdown-lint.yml`, `.yaml-lint.yml`, `actionlint.yml`, `.vscode/extensions.json`, `.vscode/launch.json`
- Modify: `eslint.config.mjs`, `.prettierignore`, `.vscode/settings.json`, `package.json` (scripts, ESLint deps)
- Delete: `.nvmrc`, `.prettierrc.json`, `.github/linters/`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `.node-version` (read by both workflows in Task 7), root linter configs (read by `linter.yml`).

- [ ] **Step 1: Swap the Node version file**

```bash
git rm .nvmrc
printf '24.9.0\n' > .node-version
```

- [ ] **Step 2: Swap the Prettier config to the template's file format, keeping this repo's values**

```bash
git rm .prettierrc.json
```

Create `.prettierrc.yml`:

```yaml
# See: https://prettier.io/docs/en/configuration

printWidth: 120
tabWidth: 4
useTabs: false
semi: false
singleQuote: true
quoteProps: as-needed
jsxSingleQuote: false
trailingComma: none
bracketSpacing: true
bracketSameLine: true
arrowParens: avoid
proseWrap: always
htmlWhitespaceSensitivity: css
endOfLine: lf
```

Replace `.prettierignore` with:

```text
.DS_Store
dist/
node_modules/
coverage/
```

- [ ] **Step 3: Replace `eslint.config.mjs` with the template's**

The current config pulls in `eslint-plugin-github`'s React rules, which are meaningless for a
Node action.

```js
// See: https://eslint.org/docs/latest/use/configure/configuration-files

import { FlatCompat } from '@eslint/eslintrc'
import js from '@eslint/js'
import typescriptEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import jest from 'eslint-plugin-jest'
import prettier from 'eslint-plugin-prettier'
import globals from 'globals'

const compat = new FlatCompat({
    baseDirectory: import.meta.dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
})

export default [
    {
        ignores: ['**/coverage', '**/dist', '**/node_modules']
    },
    ...compat.extends(
        'eslint:recommended',
        'plugin:@typescript-eslint/eslint-recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:jest/recommended',
        'plugin:prettier/recommended'
    ),
    {
        plugins: {
            jest,
            prettier,
            '@typescript-eslint': typescriptEslint
        },

        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.jest,
                Atomics: 'readonly',
                SharedArrayBuffer: 'readonly'
            },

            parser: tsParser,
            ecmaVersion: 2023,
            sourceType: 'module',

            parserOptions: {
                projectService: {
                    allowDefaultProject: [
                        '__fixtures__/*.ts',
                        '__tests__/*.ts',
                        'eslint.config.mjs',
                        'jest.config.js',
                        'rollup.config.ts'
                    ]
                },
                tsconfigRootDir: import.meta.dirname
            }
        },

        rules: {
            camelcase: 'off',
            'no-console': 'off',
            'no-shadow': 'off',
            'no-unused-vars': 'off',
            'prettier/prettier': 'error'
        }
    }
]
```

Then swap the dependencies:

```bash
npm uninstall eslint-plugin-github eslint-plugin-import eslint-import-resolver-typescript eslint-plugin-jsonc
npm install --save-dev eslint-config-prettier
```

- [ ] **Step 4: Add the root linter configs**

`.markdown-lint.yml`:

```yaml
# See: https://github.com/DavidAnson/markdownlint

# Unordered list style
MD004:
  style: dash

# Disable line length for tables
MD013:
  tables: false

# Ordered list item prefix
MD029:
  style: one

# Spaces after list markers
MD030:
  ul_single: 1
  ol_single: 1
  ul_multi: 1
  ol_multi: 1

# Code block style
MD046:
  style: fenced
```

`.yaml-lint.yml`:

```yaml
# See: https://yamllint.readthedocs.io/en/stable/

rules:
  document-end: disable
  document-start:
    level: warning
    present: false
  line-length:
    level: warning
    max: 80
    allow-non-breakable-words: true
    allow-non-breakable-inline-mappings: true
```

`actionlint.yml`:

```yaml
# See: https://github.com/rhysd/actionlint/blob/v1.7.7/docs/config.md

paths:
  .github/workflows/**/*.{yml,yaml}:
    ignore:
      - invalid runner name "node24"
```

Then delete the stale copies:

```bash
git rm -r .github/linters
```

- [ ] **Step 5: Add `.env.example`**

Every input in `action.yml`, in declaration order, with `action.yml`'s defaults.

```text
# Inputs for `npm run local-action`. See action.yml for what each one means.
# Provide exactly one of the three credential inputs.

INPUT_YC-SA-JSON-CREDENTIALS=
INPUT_YC-IAM-TOKEN=
INPUT_YC-SA-ID=

INPUT_BUCKET=
INPUT_PREFIX=
INPUT_ROOT=.
INPUT_INCLUDE=*
INPUT_EXCLUDE=
INPUT_CLEAR=false
INPUT_CACHE-CONTROL=
INPUT_CONCURRENCY=16
INPUT_SKIP-UNCHANGED=false
INPUT_FAIL-ON-ERROR=false

# The action resolves `root` and `include` relative to this directory.
GITHUB_WORKSPACE=.
```

Confirm `.gitignore` already ignores `.env` (it does — the repo's `.gitignore` is the standard
Node template). `.env.example` itself is committed.

- [ ] **Step 6: Add the VS Code config**

`.vscode/extensions.json`:

```json
{
  "recommendations": [
    "bierner.markdown-preview-github-styles",
    "davidanson.vscode-markdownlint",
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "github.copilot",
    "github.copilot-chat",
    "github.vscode-github-actions",
    "github.vscode-pull-request-github",
    "redhat.vscode-yaml",
    "rvest.vs-code-prettier-eslint",
    "yzhang.markdown-all-in-one"
  ]
}
```

`.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Action",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "cwd": "${workspaceRoot}",
      "args": ["@github/local-action", ".", "src/main.ts", ".env"],
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**", "node_modules/**"]
    }
  ]
}
```

`.vscode/settings.json` is *merged*, not replaced — the existing colour block stays:

```json
{
    "workbench.colorCustomizations": {
        "activityBar.background": "#4D4D0F",
        "titleBar.activeBackground": "#6C6C15",
        "titleBar.activeForeground": "#FBFBEA",
        "titleBar.inactiveBackground": "#4D4D0F",
        "titleBar.inactiveForeground": "#FBFBEA",
        "statusBar.background": "#4D4D0F",
        "statusBar.foreground": "#FBFBEA",
        "statusBar.debuggingBackground": "#4D4D0F",
        "statusBar.debuggingForeground": "#FBFBEA",
        "statusBar.noFolderBackground": "#4D4D0F",
        "statusBar.noFolderForeground": "#FBFBEA"
    },
    "github.copilot.chat.reviewSelection.instructions": [
        { "text": "Review the code changes carefully before accepting them." }
    ],
    "github.copilot.chat.commitMessageGeneration.instructions": [
        { "text": "Use conventional commit message format." }
    ],
    "github.copilot.chat.pullRequestDescriptionGeneration.instructions": [
        { "text": "Always include a list of key changes." }
    ]
}
```

- [ ] **Step 7: Adopt the template's script set**

```bash
npm install --save-dev @github/local-action
```

In `package.json`, the `scripts` block becomes (note `git-tag` and `prepare` are kept —
`git-tag` is this repo's release convention and the template's `script/release` is not adopted):

```json
"scripts": {
    "bundle": "npm run format:write && npm run package",
    "ci-test": "NODE_OPTIONS=--experimental-vm-modules NODE_NO_WARNINGS=1 GITHUB_WORKSPACE=__fixtures__/workspace npx jest",
    "coverage": "npx make-coverage-badge --output-path ./badges/coverage.svg",
    "format:write": "npx prettier --write .",
    "format:check": "npx prettier --check .",
    "lint": "npx eslint .",
    "local-action": "npx @github/local-action . src/main.ts .env",
    "package": "npx rimraf ./dist && npx rollup --config rollup.config.ts --configPlugin @rollup/plugin-typescript",
    "package:watch": "npm run package -- --watch",
    "test": "NODE_OPTIONS=--experimental-vm-modules NODE_NO_WARNINGS=1 GITHUB_WORKSPACE=__fixtures__/workspace npx jest",
    "all": "npm run format:write && npm run lint && npm run test && npm run coverage && npm run package",
    "git-tag": "git tag v`cat package.json | jq -r '.version' | awk -F. '{print $1}'` -f &&  git tag v`cat package.json | jq -r '.version'` -f",
    "prepare": "husky"
}
```

`format:write` now formats the whole repo rather than `**/*.ts`, so this step produces a large
reformatting diff across YAML and Markdown. That is expected and happens exactly once.

- [ ] **Step 8: Run the full gate and diff the snapshot**

Run: `npm run format:write && npm run lint && npm test && git diff --stat __tests__/__snapshots__/`

Expected: Prettier rewrites files, ESLint is clean, all suites pass, snapshot diff empty.

If ESLint reports `parserOptions.projectService` errors for files under `__fixtures__/` or
`__tests__/`, add the offending path to `allowDefaultProject`. The list above covers one
directory level only, which is all this repo needs — `__fixtures__/workspace/` holds `.js` data
files, not `.ts`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: adopt typescript-action template scaffolding

Swaps .nvmrc for .node-version, .prettierrc.json for .prettierrc.yml with
this repo's 120/4/arrowParens-avoid values, replaces the eslint-plugin-github
config with the template's flat config, moves the linter configs to the repo
root, and adds .env.example, local-action and the VS Code config. The
existing .vscode/settings.json colour block is merged, not replaced."
```

---

## Task 7: CI workflows

**Files:**

- Create: `.github/workflows/ci.yml`, `.github/workflows/linter.yml`
- Modify: `.github/workflows/check-dist.yml`
- Delete: `.github/workflows/test.yml`

**Interfaces:**

- Consumes: `.node-version` from Task 6, `dist/index.js` from Task 5, the `format:check` / `lint` / `ci-test` / `coverage` scripts from Task 6.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

The template's `test-action` job runs the action against itself, which for this action needs
Yandex Cloud credentials and a real bucket. It is replaced by a bundle smoke test that proves
the ESM bundle loads and both the grpc-js and AWS SDK module graphs initialize.

```yaml
name: Continuous Integration

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  test-typescript:
    name: TypeScript Tests
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        id: checkout
        uses: actions/checkout@v7

      - name: Setup Node.js
        id: setup-node
        uses: actions/setup-node@v7
        with:
          node-version-file: .node-version
          cache: npm

      - name: Install Dependencies
        id: npm-ci
        run: npm ci

      - name: Check Format
        id: npm-format-check
        run: npm run format:check

      - name: Lint
        id: npm-lint
        run: npm run lint

      - name: Test
        id: npm-ci-test
        run: npm run ci-test

  smoke-test:
    name: Bundle Smoke Test
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        id: checkout
        uses: actions/checkout@v7

      - name: Setup Node.js
        id: setup-node
        uses: actions/setup-node@v7
        with:
          node-version-file: .node-version

      - name: Run the bundle without credentials
        id: smoke
        run: |
          set +e
          output=$(node dist/index.js 2>&1)
          status=$?
          set -e
          echo "$output"
          if [ "$status" -eq 0 ]; then
            echo "Expected a non-zero exit status, got 0"
            exit 1
          fi
          echo "$output" | grep -q "No credentials"
```

- [ ] **Step 2: Create `.github/workflows/linter.yml`**

The template's, minus `CHECKOV_FILE_NAME` (no `.checkov.yml`, out of scope per the spec).

```yaml
# This workflow will lint the entire codebase using the
# `super-linter/super-linter` action.
#
# For more information, see the super-linter repository:
#     https://github.com/super-linter/super-linter
name: Lint Codebase

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read
  packages: read
  statuses: write

jobs:
  lint:
    name: Lint Codebase
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        id: checkout
        uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Setup Node.js
        id: setup-node
        uses: actions/setup-node@v7
        with:
          node-version-file: .node-version
          cache: npm

      - name: Install Dependencies
        id: install
        run: npm ci

      - name: Lint Codebase
        id: super-linter
        uses: super-linter/super-linter/slim@v8
        env:
          DEFAULT_BRANCH: main
          FILTER_REGEX_EXCLUDE: dist/**/*
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          LINTER_RULES_PATH: .
          VALIDATE_ALL_CODEBASE: true
          VALIDATE_BIOME_FORMAT: false
          VALIDATE_BIOME_LINT: false
          VALIDATE_GITHUB_ACTIONS_ZIZMOR: false
          VALIDATE_JAVASCRIPT_ES: false
          VALIDATE_JSCPD: false
          VALIDATE_JSON: false
          VALIDATE_TYPESCRIPT_ES: false
```

- [ ] **Step 3: Point `check-dist.yml` at the new Node version file**

In `.github/workflows/check-dist.yml`, change both occurrences of:

```yaml
          node-version-file: .nvmrc
```

to:

```yaml
          node-version-file: .node-version
```

Everything else in that workflow stays — it already runs `npm run bundle` and diffs `dist/`.

- [ ] **Step 4: Delete the superseded workflow**

```bash
git rm .github/workflows/test.yml
```

- [ ] **Step 5: Verify the smoke test locally before pushing it**

```bash
npm run package
set +e; output=$(node dist/index.js 2>&1); status=$?; set -e
echo "$output"; echo "exit=$status"
```

Expected: `exit=1` and `No credentials` in the output — the same assertion the workflow makes.

- [ ] **Step 6: Lint the workflows**

Run: `npx actionlint` (or skip if `actionlint` is not installed locally — `linter.yml` covers it
in CI, and `actionlint.yml` already silences the `node24` false positive).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "ci: replace test.yml with the template's ci.yml and linter.yml

ci.yml runs format:check, lint and ci-test, plus a bundle smoke test that
runs dist/index.js with no credentials and requires a non-zero exit with
'No credentials'. That replaces the template's test-action job, which for
this action would need real Yandex Cloud credentials and a bucket."
```

---

## Task 8: Cleanup, coverage ratchet, and the 5.0.0 bump

Committed last so the coverage floors are validated against the finished tree.

**Files:**

- Modify: `package.json` (version, dependency cleanup, `overrides`), `jest.config.js` (threshold), `README.md` (five `@v4` references), `badges/coverage.svg` (regenerated)

**Interfaces:**

- Consumes: everything from Tasks 1–7.
- Produces: the final `5.0.0` tree.

- [ ] **Step 1: Remove the unused direct dependencies**

Verify each has no importer before removing it:

```bash
grep -rn "@actions/github\|mustache\|@swc/\|js-yaml" src __tests__ __fixtures__ *.mjs *.js *.ts
```

Expected: no output. Then:

```bash
npm uninstall @actions/github @types/mustache @swc/cli @swc/core @swc/jest js-yaml
```

- [ ] **Step 2: Move the version-floating entries from `dependencies` to `overrides`**

`minimist` and `path-scurry` are not imported by `src/`; they sit in `dependencies` only to
float transitive versions, which is what `overrides` is for.

```bash
npm uninstall minimist path-scurry
```

Then in `package.json`, extend the existing `overrides` block:

```json
"overrides": {
    "minimist": ">=1.2.8",
    "path-scurry": "^2.0.1",
    "prettier-eslint": {
        "@typescript-eslint/parser": {
            "@typescript-eslint/typescript-estree": {
                "minimatch": "^9.0.7"
            }
        }
    }
}
```

Run `npm install` and confirm `npm ls minimist path-scurry` still resolves to the intended
versions. `@grpc/grpc-js` stays in `dependencies` — `src/` never imports it, but it is the one
transitive package the bundle is sensitive to, and a direct entry keeps Dependabot pointed at it.

- [ ] **Step 3: Measure coverage on the finished tree**

Run: `npm test`

Read the coverage table it prints. Record the four totals.

- [ ] **Step 4: Add the coverage ratchet**

In `jest.config.js`, add after `coverageReporters`:

```js
    coverageThreshold: {
        global: {
            branches: 80,
            functions: 90,
            lines: 90,
            statements: 90
        }
    },
```

These floors sit just below the pre-rewrite measurement (lines 96.27, statements 96.39,
functions 96.15, branches 86.76). If Step 3 shows a metric below its floor, **add the missing
test** — do not lower the floor. The pre-rewrite numbers are the contract.

- [ ] **Step 5: Regenerate the coverage badge**

Run: `npm run coverage`

Expected: `badges/coverage.svg` updates to the new percentage.

- [ ] **Step 6: Bump to 5.0.0 and update the README**

In `package.json`, set `"version": "5.0.0"`.

In `README.md`, change all five occurrences of
`uses: yc-actions/yc-obj-storage-upload@v4` to `@v5` (lines 30, 78, 93, 115, 152 at the time of
writing — verify with `grep -n "@v4" README.md`).

- [ ] **Step 7: Run the full gate one last time**

Run: `npm run all && git diff --stat __tests__/__snapshots__/`

Expected: format, lint, test, coverage and package all pass; the snapshot diff is empty; `dist/`
is regenerated and matches what `check-dist.yml` will produce.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore!: drop unused dependencies and release 5.0.0

Removes six direct dependencies with no importer, moves minimist and
path-scurry from dependencies to overrides where a version-floating
constraint belongs, adds the coverage ratchet at lines 90 / statements 90 /
functions 90 / branches 80, and bumps to 5.0.0.

BREAKING CHANGE: dist/ is now an ES module bundle produced by Rollup and no
longer ships the grpc-js proto, xds and protoc-gen-validate trees. The
action's inputs, outputs and node24 runtime are unchanged."
```

---

## Task 9: Real upload verification

The last gate before merge. Not automatable in CI — it needs a bucket and credentials.

**Files:** none modified.

**Interfaces:** none.

- [ ] **Step 1: Ask for a scratch bucket and credentials**

Ask the human partner for a bucket name and one of: a service-account JSON, an IAM token, or a
service-account ID with workload identity configured. Do not proceed without them, and do not
substitute a production bucket.

- [ ] **Step 2: Upload from `main` into a baseline prefix**

```bash
git stash list  # confirm nothing is stashed that you will need
git checkout main
npm ci && npm run package
```

Then run the bundle against the fixture tree, with the credentials supplied in Step 1 exported
as `INPUT_*` variables and `INPUT_PREFIX=verify-main/`:

```bash
env GITHUB_WORKSPACE=__fixtures__/workspace \
    INPUT_BUCKET="$BUCKET" \
    INPUT_ROOT=. \
    INPUT_INCLUDE='src/*' \
    INPUT_PREFIX=verify-main/ \
    INPUT_CACHE-CONTROL='*.js:public, max-age=3600' \
    INPUT_YC-IAM-TOKEN="$YC_IAM_TOKEN" \
    node dist/index.js
```

Note: on `main` the fixture tree is still at `__tests__/`, so use
`GITHUB_WORKSPACE=__tests__` for this run.

- [ ] **Step 3: Upload from the branch into a second prefix**

```bash
git checkout feat/typescript-action-template
npm ci && npm run package
```

Same command, with `GITHUB_WORKSPACE=__fixtures__/workspace` and
`INPUT_PREFIX=verify-branch/`.

- [ ] **Step 4: Compare the two prefixes**

List both prefixes and compare key names (minus the prefix), `Content-Type`, `Cache-Control`,
and `ETag`:

```bash
yc storage s3api list-objects --bucket "$BUCKET" --prefix verify-main/
yc storage s3api list-objects --bucket "$BUCKET" --prefix verify-branch/
```

Expected: identical relative keys, identical ETags, identical `Content-Type` and
`Cache-Control` on each corresponding object.

Any difference is a behavior change the snapshot did not catch. Report it rather than
explaining it away.

- [ ] **Step 5: Clean up and report**

Delete both verification prefixes from the bucket. Report the comparison result to the human
partner, then open the PR.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Target layout — new files | Tasks 3, 4, 5, 6, 7 |
| Target layout — deletions | Task 6 (`.nvmrc`, `.prettierrc.json`, `.github/linters/`), Task 7 (`test.yml`), Task 5 (ncc `dist/` artifacts) |
| Module split table | Task 3, Steps 2–7 |
| `resolveTokenService` fold, unreachable branch, constructor ordering | Task 3, Step 4 |
| ESM migration (`type: module`, tsconfig, `.js` specifiers) | Task 4, Steps 2, 4, 5 |
| `@smithy/types` rewrite of the deep import | Task 3, Steps 1 and 5 |
| Bundling, banner, `exportConditions`, plugin set | Task 5, Step 2 |
| Test harness, `unstable_mockModule`, fixtures | Task 4, Steps 7–11 |
| Fixture data move | Task 2 |
| Coverage ratchet, committed last | Task 8, Steps 3–4 |
| Stage 0 characterization snapshot | Task 1 |
| Bundle smoke test | Task 5 Step 5 (local), Task 7 Step 1 (CI) |
| Real upload | Task 9 |
| CI: `ci.yml`, `check-dist.yml`, `linter.yml`, `test.yml` deletion | Task 7 |
| npm scripts, `git-tag` kept | Task 6, Step 7 |
| Dependency removals and additions | Task 3 Step 1, Task 4 Step 1, Task 5 Steps 1 and 6, Task 6 Steps 3 and 7, Task 8 Steps 1–2 |
| Version 5.0.0 and README `@v5` | Task 8, Step 6 |
| Rollup fallback to ncc | Task 5, Step 5 |

No spec requirement is unassigned.

**Type consistency:** `UploadInputs`, `ActionInputs`, `TokenService`, `createS3Client`,
`resolveTokenService`, `readInputs`, `clearBucket`, `upload`, `runPool`, and `parseConcurrency`
are named identically in Task 3's Interfaces block, Task 3's code, and Task 4's import
rewrites. `DEFAULT_CONCURRENCY` and `MAX_CONCURRENCY` keep their current names and values.
