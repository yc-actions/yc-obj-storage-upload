import { jest } from '@jest/globals'
import type * as core from '@actions/core'

export const debug = jest.fn<typeof core.debug>()
export const endGroup = jest.fn<typeof core.endGroup>()
export const error = jest.fn<typeof core.error>()
export const getBooleanInput = jest.fn<typeof core.getBooleanInput>()
export const getIDToken = jest.fn<typeof core.getIDToken>()
export const getInput = jest.fn<typeof core.getInput>()
export const getMultilineInput = jest.fn<typeof core.getMultilineInput>()
export const info = jest.fn<typeof core.info>()
export const setFailed = jest.fn<typeof core.setFailed>()
export const startGroup = jest.fn<typeof core.startGroup>()
