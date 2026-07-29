/**
 * Action input reading and parsing.
 *
 * @module
 */

import { getBooleanInput, getInput, getMultilineInput } from '@actions/core'
import { CacheControlConfig, parseCacheControlFormats } from './cache-control.js'

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

export const DEFAULT_CONCURRENCY = 16
export const MAX_CONCURRENCY = 256

/**
 * Parses the concurrency input, clamping it to a usable range.
 *
 * @param raw - Raw input value
 * @returns Concurrency between 1 and 256; DEFAULT_CONCURRENCY when unparseable
 */
export function parseConcurrency(raw: string): number {
    const n = parseInt(raw, 10)
    if (isNaN(n)) {
        return DEFAULT_CONCURRENCY
    }
    return Math.min(MAX_CONCURRENCY, Math.max(1, n))
}

/**
 * Reads every action input and parses it into the upload configuration.
 *
 * @returns Parsed configuration
 * @throws {Error} If a required input is missing
 */
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
