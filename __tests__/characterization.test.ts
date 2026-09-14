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

    let getInputMock: jest.Mock
    let getMultilineInputMock: jest.Mock
    let getBooleanInputMock: jest.Mock
    let getIDTokenMock: jest.Mock
    let setFailedMock: jest.Mock
    let axiosPostMock: jest.Mock

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

        getInputMock = core.getInput
        getMultilineInputMock = core.getMultilineInput
        getBooleanInputMock = core.getBooleanInput
        getIDTokenMock = core.getIDToken
        setFailedMock = core.setFailed
        axiosPostMock = axios.post

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
