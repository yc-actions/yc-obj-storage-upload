import { jest } from '@jest/globals'
import type { AxiosStatic } from 'axios'

export const post = jest.fn<AxiosStatic['post']>()

const axios = { post } as unknown as AxiosStatic

export default axios
