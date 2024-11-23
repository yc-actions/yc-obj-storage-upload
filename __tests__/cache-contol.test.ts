import { getCacheControlValue, parseCacheControlFormats } from '../src/cache-control'

describe('Cache-Control', () => {
    describe('parseCacheControlFormats', () => {
        it('should parse cache control formats', () => {
            const formats = ['*.html:public, max-age=3600', '*.css:public, max-age=3600', '*:public, max-age=3600']
            const result = parseCacheControlFormats(formats)

            expect(result).toEqual({
                mapping: new Map([
                    ['*.html', 'public, max-age=3600'],
                    ['*.css', 'public, max-age=3600']
                ]),
                default: 'public, max-age=3600'
            })
        })

        it('should handle empty value', () => {
            const formats = ['*.html:public, max-age=3600', '*.css:public, max-age=3600', '*:']
            const result = parseCacheControlFormats(formats)

            expect(result).toEqual({
                mapping: new Map([
                    ['*.html', 'public, max-age=3600'],
                    ['*.css', 'public, max-age=3600']
                ]),
                default: undefined
            })
        })

        it('should handle empty string', () => {
            const formats = ['*.html:public, max-age=3600', '*.css:public, max-age=3600', '*: ']
            const result = parseCacheControlFormats(formats)

            expect(result).toEqual({
                mapping: new Map([
                    ['*.html', 'public, max-age=3600'],
                    ['*.css', 'public, max-age=3600']
                ]),
                default: undefined
            })
        })

        it('should handle empty input', () => {
            const formats: string[] = []
            const result = parseCacheControlFormats(formats)

            expect(result).toEqual({
                mapping: new Map(),
                default: undefined
            })
        })

        it('should handle multiple keys separated by comma', () => {
            const formats = [
                '*.html, *.htm:public, max-age=3600',
                '*.css:public, max-age=3600',
                '*:public, max-age=3600'
            ]
            const result = parseCacheControlFormats(formats)

            expect(result).toEqual({
                mapping: new Map([
                    ['*.html', 'public, max-age=3600'],
                    ['*.htm', 'public, max-age=3600'],
                    ['*.css', 'public, max-age=3600']
                ]),
                default: 'public, max-age=3600'
            })
        })
    })

    describe('getCacheControlValue', () => {
        it('should return value for key', () => {
            const cacheControl = {
                mapping: new Map([
                    ['*.html', 'html-value'],
                    ['*.css', 'css-value']
                ]),
                default: 'default-value'
            }
            const key = 'file.html'
            const result = getCacheControlValue(cacheControl, key)

            expect(result).toEqual('html-value')
        })

        it('should return default value', () => {
            const cacheControl = {
                mapping: new Map([
                    ['*.html', 'html-value'],
                    ['*.css', 'css-value']
                ]),
                default: 'default-value'
            }
            const key = 'file.js'
            const result = getCacheControlValue(cacheControl, key)

            expect(result).toEqual('default-value')
        })
    })
})
