import * as core from '@actions/core'
import {
    type AbortMultipartUploadCommandOutput,
    type CompleteMultipartUploadCommandOutput,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { HttpRequest } from '@smithy/protocol-http'
import { type FinalizeRequestMiddleware } from '@aws-sdk/types/dist-types/middleware'

import { IamTokenService } from '@yandex-cloud/nodejs-sdk/dist/token-service/iam-token-service'
import * as fs from 'fs'
import { glob } from 'glob'
import mimeTypes from 'mime-types'
import { minimatch } from 'minimatch'
import path from 'node:path'
import { fromServiceAccountJsonFile } from './service-account-json'

type ActionInputs = {
    bucket: string
    prefix: string
    root: string
    include: string[]
    exclude: string[]
    clear: boolean
}

export async function run(): Promise<void> {
    try {
        const ycSaJsonCredentials = core.getInput('yc-sa-json-credentials', {
            required: true
        })
        core.setSecret(ycSaJsonCredentials)

        const serviceAccountJson = fromServiceAccountJsonFile(JSON.parse(ycSaJsonCredentials))

        const inputs: ActionInputs = {
            bucket: core.getInput('bucket', { required: true }),
            prefix: core.getInput('prefix', { required: false }),
            root: core.getInput('root', { required: true }),
            include: core.getMultilineInput('include', { required: false }),
            exclude: core.getMultilineInput('exclude', { required: false }),
            clear: core.getBooleanInput('clear', { required: false })
        }

        // Initialize Token service with your SA credentials
        const tokenService = new IamTokenService(serviceAccountJson)

        const s3Client = new S3Client({
            region: 'ru-central1',
            endpoint: 'https://storage.yandexcloud.net'
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

        s3Client.middlewareStack.removeByTag('AWSAUTH')
        s3Client.middlewareStack.addRelativeTo(middleware, {
            name: 'ycAuthMiddleware',
            tags: ['YCAUTH'],
            relation: 'after',
            toMiddleware: 'retryMiddleware',
            override: true
        })
        if (inputs.clear) {
            await clearBucket(s3Client, inputs.bucket)
        }
        await upload(s3Client, inputs)
    } catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message)
        }
    }
}

export interface UploadInputs {
    include: string[]
    exclude: string[]
    root: string
    prefix: string
    bucket: string
}

const uploadFile = async (
    client: S3Client,
    filePath: string,
    { root, bucket, prefix }: UploadInputs
): Promise<CompleteMultipartUploadCommandOutput | AbortMultipartUploadCommandOutput | undefined> => {
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
        return
    }
    const contentType = mimeTypes.lookup(filePath) || 'text/plain'

    let key = path.relative(root, filePath)
    if (prefix) {
        key = path.join(prefix, key)
    }
    try {
        core.info(`starting to upload ${key}`)
        const parallelUploads3 = new Upload({
            client,
            params: {
                Bucket: bucket,
                Key: key,
                Body: fs.createReadStream(filePath),
                ContentType: contentType
            },
            queueSize: 4,
            leavePartsOnError: false
        })

        return await parallelUploads3.done()
    } catch (e) {
        core.error(`${e}`)
    }
}

export async function upload(s3Client: S3Client, inputs: UploadInputs): Promise<void> {
    core.startGroup('Upload')

    try {
        core.info('Upload start')

        const workspace = process.env['GITHUB_WORKSPACE'] ?? ''
        const patterns = parseIgnoreGlobPatterns(inputs.exclude)
        const root = path.join(workspace, inputs.root)

        for (const include of inputs.include) {
            let pathFromSourceRoot = path.join(root, include)
            if (!pathFromSourceRoot.includes('*')) {
                try {
                    const stat = fs.statSync(pathFromSourceRoot)
                    if (stat.isDirectory()) {
                        pathFromSourceRoot = path.join(pathFromSourceRoot, '*')
                    }
                } catch (e) {
                    core.debug(`${e}`)
                }
            }
            const matches = glob.sync(pathFromSourceRoot, { absolute: false })
            for (const match of matches) {
                const res = !patterns.map(p => minimatch(match, p, { matchBase: true })).some(x => x)
                if (res) {
                    await uploadFile(s3Client, match, {
                        ...inputs,
                        root
                    })
                }
            }
        }
    } finally {
        core.endGroup()
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

    core.info(`Source ignore pattern: "${JSON.stringify(result)}"`)
    return result
}

export async function clearBucket(client: S3Client, bucket: string): Promise<void> {
    core.info('Clearing bucket')
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

    core.info(`Deleted ${totalDeleted} objects from bucket ${bucket}`)
}
