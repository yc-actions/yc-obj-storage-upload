import { minimatch } from 'minimatch'

export interface CacheControlConfig {
    mapping: Map<string, string>
    default?: string
}

export function newCacheControlConfig(): CacheControlConfig {
    return {
        mapping: new Map<string, string>(),
        default: undefined
    }
}

export function parseCacheControlFormats(formats: string[]): CacheControlConfig {
    const result = new Map<string, string>()

    for (const format of formats) {
        const [keysPart, valuePart] = format.split(':')
        const keys = keysPart.split(',').map(key => key.trim())
        const value = valuePart.trim()

        for (const key of keys) {
            result.set(key, value)
        }
    }

    let defaultCacheControl = result.get('*')?.trim()
    if (defaultCacheControl === '') {
        defaultCacheControl = undefined
    }
    if (result.has('*')) {
        result.delete('*')
    }

    return {
        mapping: result,
        default: defaultCacheControl
    }
}

export function getCacheControlValue(cacheControl: CacheControlConfig, key: string): string | undefined {
    for (const [pattern, value] of cacheControl.mapping) {
        if (minimatch.match([key], pattern).length > 0) {
            return value
        }
    }
    if (cacheControl.default) {
        return cacheControl.default
    }
}
