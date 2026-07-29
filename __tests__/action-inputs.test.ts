import { expect, test } from '@jest/globals'
import { parseConcurrency } from '../src/action-inputs.js'

describe('parseConcurrency', () => {
    test('defaults to 16 for empty or non-numeric input', () => {
        expect(parseConcurrency('')).toBe(16)
        expect(parseConcurrency('abc')).toBe(16)
    })
    test('honors a valid value', () => {
        expect(parseConcurrency('8')).toBe(8)
    })
    test('clamps values below 1 up to 1', () => {
        expect(parseConcurrency('0')).toBe(1)
        expect(parseConcurrency('-5')).toBe(1)
    })
    test('clamps values above 256 down to 256', () => {
        expect(parseConcurrency('257')).toBe(256)
        expect(parseConcurrency('100000')).toBe(256)
    })
})
