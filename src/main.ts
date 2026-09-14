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
