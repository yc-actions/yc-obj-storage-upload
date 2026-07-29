/**
 * Main entry point for the Yandex Object Storage upload action.
 *
 * Resolves credentials, reads inputs, builds an S3 client, and runs the
 * optional bucket clear followed by the upload.
 *
 * @see {@link https://github.com/yc-actions/yc-obj-storage-upload} for usage examples
 * @module
 */

import { setFailed } from '@actions/core'

import { readInputs } from './action-inputs.js'
import { createTokenService, resolveSessionConfig } from './auth.js'
import { clearBucket } from './bucket.js'
import { createS3Client } from './s3-client.js'
import { upload } from './upload.js'

/**
 * Main entry point for GitHub Action execution.
 */
export async function run(): Promise<void> {
    try {
        const sessionConfig = await resolveSessionConfig()
        const inputs = readInputs()
        const tokenService = createTokenService(sessionConfig)
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
