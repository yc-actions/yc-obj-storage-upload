/**
 * Credential resolution and IAM token acquisition.
 *
 * @module
 */

import { getIDToken, getInput, info } from '@actions/core'
import { IamTokenService } from '@yandex-cloud/nodejs-sdk/dist/token-service/iam-token-service.js'
import { SessionConfig, TokenService } from '@yandex-cloud/nodejs-sdk/dist/types.js'
import axios from 'axios'
import { fromServiceAccountJsonFile } from './service-account-json.js'

/**
 * Exchanges a GitHub OIDC token for a Yandex Cloud IAM token.
 *
 * @param token - GitHub OIDC token
 * @param saId - Service account ID to impersonate
 * @returns Yandex Cloud IAM token
 * @throws {Error} If the exchange endpoint rejects the request
 */
export async function exchangeToken(token: string, saId: string): Promise<string> {
    info(`Exchanging token for service account ${saId}`)
    const res = await axios.post(
        'https://auth.yandex.cloud/oauth/token',
        {
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            audience: saId,
            subject_token: token,
            subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
        },
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    )
    if (res.status !== 200) {
        throw new Error(`Failed to exchange token: ${res.status} ${res.statusText}`)
    }
    if (!res.data.access_token) {
        throw new Error(`Failed to exchange token: ${res.data.error} ${res.data.error_description}`)
    }
    info(`Token exchanged successfully`)
    return res.data.access_token
}

/**
 * Resolves credentials from the action inputs.
 *
 * Priority: Service Account JSON, then IAM token, then Workload Identity
 * Federation via the GitHub OIDC token.
 *
 * @returns Session configuration for the Yandex Cloud SDK
 * @throws {Error} If no credentials are provided
 */
export async function resolveSessionConfig(): Promise<SessionConfig> {
    const ycSaJsonCredentials = getInput('yc-sa-json-credentials')
    const ycIamToken = getInput('yc-iam-token')
    const ycSaId = getInput('yc-sa-id')

    if (ycSaJsonCredentials !== '') {
        const serviceAccountJson = fromServiceAccountJsonFile(JSON.parse(ycSaJsonCredentials))
        info('Parsed Service account JSON')
        return { serviceAccountJson }
    }
    if (ycIamToken !== '') {
        info('Using IAM token')
        return { iamToken: ycIamToken }
    }
    if (ycSaId !== '') {
        const ghToken = await getIDToken()
        if (!ghToken) {
            throw new Error('No credentials provided')
        }
        const saToken = await exchangeToken(ghToken, ycSaId)
        return { iamToken: saToken }
    }
    throw new Error('No credentials')
}

/**
 * Builds the token service the S3 auth middleware calls on every request.
 *
 * @param sessionConfig - Resolved credentials
 * @returns A token service backed by either the SA key or a static IAM token
 */
export function createTokenService(sessionConfig: SessionConfig): TokenService {
    if ('serviceAccountJson' in sessionConfig) {
        return new IamTokenService(sessionConfig.serviceAccountJson)
    }
    return {
        getToken: async () => {
            if (!('iamToken' in sessionConfig) || !sessionConfig.iamToken) {
                throw new Error('No IAM token provided')
            }
            return sessionConfig.iamToken
        }
    }
}
