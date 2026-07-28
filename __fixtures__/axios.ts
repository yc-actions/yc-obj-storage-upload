import { jest } from '@jest/globals'

export const post = jest.fn(async () => ({
    status: 200,
    statusText: 'OK',
    data: { access_token: 'exchanged-token' }
}))

export const get = jest.fn()
export const put = jest.fn()

// src/main.ts does `import axios from 'axios'` and calls axios.post, so the
// default export has to carry the same functions as the named ones.
export default { post, get, put }
