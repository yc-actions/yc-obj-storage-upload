/**
 * Recording double for the S3 client, used by the characterization snapshot.
 *
 * Subclasses the real S3Client so run() constructs and wires it exactly as it
 * would in production, then captures:
 *
 *   1. the constructor config          - region, endpoint, checksum settings
 *   2. middlewareStack.identify()      - the effect of both removeByTag calls
 *                                        and the addRelativeTo placement
 *   3. every command issued            - name plus input
 *   4. the auth middleware's headers   - the X-YaCloud-SubjectToken injection
 *
 * `send` answers from a canned table, so nothing reaches the network and no
 * response has to satisfy an SDK deserializer.
 *
 * Deliberately free of jest imports so it survives the migration from
 * `jest.mock` to `jest.unstable_mockModule` unchanged.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpRequest } from '@smithy/protocol-http'

export interface RecordedCommand {
    command: string
    input: unknown
}

export interface Recorded {
    configs: unknown[]
    stack: string[]
    commands: RecordedCommand[]
    middlewareOptions: unknown[]
    authHeaders: Record<string, string> | null
}

export const recorded: Recorded = {
    configs: [],
    stack: [],
    commands: [],
    middlewareOptions: [],
    authHeaders: null
}

type HeadMode = 'match' | 'differ' | 'missing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMiddleware = (next: any) => (args: any) => Promise<any>

let listObjectPages: unknown[] = []
let headMode: HeadMode = 'missing'
let uploadFails = false
let capturedAuthMiddleware: AnyMiddleware | null = null

export function resetRecorder(): void {
    recorded.configs = []
    recorded.stack = []
    recorded.commands = []
    recorded.middlewareOptions = []
    recorded.authHeaders = null
    listObjectPages = []
    headMode = 'missing'
    uploadFails = false
    capturedAuthMiddleware = null
}

/** Pages returned by successive ListObjectsV2 calls. */
export function __setListObjectPages(pages: unknown[]): void {
    listObjectPages = [...pages]
}

/**
 * How HeadObject answers: with the real md5 of the local fixture file
 * (`match`), with a fixed different ETag (`differ`), or by throwing NotFound
 * (`missing`, the default).
 */
export function __setHeadObjectMode(mode: HeadMode): void {
    headMode = mode
}

/** When true, every upload command rejects. */
export function __setUploadFails(value: boolean): void {
    uploadFails = value
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function respond(command: any): Promise<any> {
    const name = command.constructor.name

    if (name === 'ListObjectsV2Command') {
        const page = listObjectPages.shift()
        return Promise.resolve(page ?? { Contents: [], IsTruncated: false })
    }
    if (name === 'DeleteObjectsCommand') {
        return Promise.resolve({ Deleted: command.input?.Delete?.Objects ?? [] })
    }
    if (name === 'HeadObjectCommand') {
        if (headMode === 'missing') {
            const err = new Error('NotFound') as Error & { name: string }
            err.name = 'NotFound'
            return Promise.reject(err)
        }
        if (headMode === 'differ') {
            return Promise.resolve({ ETag: '"00000000000000000000000000000000"' })
        }
        const workspace = process.env.GITHUB_WORKSPACE ?? ''
        const md5 = createHash('md5')
            .update(readFileSync(join(workspace, String(command.input.Key))))
            .digest('hex')
        return Promise.resolve({ ETag: `"${md5}"` })
    }
    if (uploadFails) {
        return Promise.reject(new Error('upload boom'))
    }
    return Promise.resolve({ ETag: '"d41d8cd98f00b204e9800998ecf8427e"' })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function makeRecordingS3Client(Base: any): any {
    return class RecordingS3Client extends Base {
        constructor(config: any) {
            super(config)
            recorded.configs.push({ ...config })

            const stack = (this as any).middlewareStack
            const originalAddRelativeTo = stack.addRelativeTo.bind(stack)

            stack.addRelativeTo = (middleware: AnyMiddleware, options: any) => {
                const result = originalAddRelativeTo(middleware, options)
                capturedAuthMiddleware = middleware
                recorded.middlewareOptions.push({ ...options })
                // main.ts adds its middleware last, after both removeByTag
                // calls, so this is the fully-wired stack.
                recorded.stack = stack.identify()
                return result
            }
        }

        async send(command: any): Promise<any> {
            recorded.commands.push({ command: command.constructor.name, input: command.input })
            return respond(command)
        }
    }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Runs the captured auth middleware against a synthetic request and records the
 * headers it produced. No-op when run() failed before wiring a client.
 */
export async function captureAuthHeaders(): Promise<void> {
    if (!capturedAuthMiddleware) {
        return
    }
    const request = new HttpRequest({
        method: 'PUT',
        protocol: 'https:',
        hostname: 'storage.yandexcloud.net',
        path: '/bucket/key',
        query: {},
        headers: {}
    })

    let seen: HttpRequest | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const terminal = async (args: any): Promise<any> => {
        seen = args.request
        return { output: {}, response: {} }
    }

    await capturedAuthMiddleware(terminal)({ request, input: {} })
    recorded.authHeaders = seen ? { ...seen.headers } : null
}
