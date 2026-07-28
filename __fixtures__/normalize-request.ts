/**
 * Stable serializer for recorded S3 client state.
 *
 * Deliberately free of jest and AWS SDK imports so it survives the migration
 * from `jest.mock` to `jest.unstable_mockModule` unchanged.
 */

import { basename } from 'node:path'

/**
 * Normalizes a value into a form that is stable across runs and machines.
 *
 * - `fs.ReadStream` bodies become `stream:<basename>`. The stream object is not
 *   serializable and its internal state is not reproducible; the file it reads
 *   is the part that matters.
 * - Buffers and byte arrays become `bytes:<length>`.
 * - Functions become `fn:<name>`, so a middleware reference does not serialize
 *   as an empty object.
 * - Dates become `date:<iso>`.
 * - Object keys are sorted so insertion order cannot cause a false diff.
 *
 * Auth token values are deliberately NOT redacted. Under the fixtures they are
 * fixed literals, and recording them is what proves the correct credential path
 * fed the middleware.
 */
export function normalize(value: unknown): unknown {
    if (value === null || value === undefined) {
        return value
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return `bytes:${value.length}`
    }
    if (typeof value === 'bigint') {
        return value.toString()
    }
    if (typeof value === 'function') {
        return `fn:${value.name || 'anonymous'}`
    }
    if (value instanceof Date) {
        return `date:${value.toISOString()}`
    }
    if (Array.isArray(value)) {
        return value.map(normalize)
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>
        // fs.ReadStream, identified structurally so this module needs no node:fs
        // import: a string `path` plus a `pipe` method.
        if (typeof obj.path === 'string' && typeof obj.pipe === 'function') {
            return `stream:${basename(obj.path)}`
        }
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(obj).sort()) {
            out[key] = normalize(obj[key])
        }
        return out
    }
    return value
}
