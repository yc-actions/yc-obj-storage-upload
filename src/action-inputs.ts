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
