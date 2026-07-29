/**
 * File selection and upload to Yandex Object Storage.
 *
 * @module
 */

import {
    type AbortMultipartUploadCommandOutput,
    type CompleteMultipartUploadCommandOutput,
    HeadObjectCommand,
    S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { debug, endGroup, error, info, setFailed, startGroup } from '@actions/core'
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { glob } from 'glob'
import mimeTypes from 'mime-types'
import { minimatch } from 'minimatch'
import path from 'node:path'
import { CacheControlConfig, getCacheControlValue } from './cache-control.js'
import { DEFAULT_CONCURRENCY } from './action-inputs.js'

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

/**
 * Runs `worker` over `items` with at most `concurrency` in flight.
 *
 * @param items - Work items
 * @param concurrency - Maximum number of concurrent workers
 * @param worker - Async function applied to each item
 */
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

/**
 * Selects files matching the include patterns and uploads them.
 *
 * @param s3Client - Configured S3 client
 * @param inputs - Upload configuration
 */
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
