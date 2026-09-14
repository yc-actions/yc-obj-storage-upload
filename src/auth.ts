import { getIDToken, info } from '@actions/core'
import { IamTokenService } from '@yandex-cloud/nodejs-sdk/dist/token-service/iam-token-service'
import { TokenService } from '@yandex-cloud/nodejs-sdk/dist/types'
import axios from 'axios'
import { fromServiceAccountJsonFile } from './service-account-json'

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

export async function resolveTokenService(
    ycSaJsonCredentials: string,
    ycIamToken: string,
    ycSaId: string
): Promise<TokenService> {
    if (ycSaJsonCredentials !== '') {
        const serviceAccountJson = fromServiceAccountJsonFile(JSON.parse(ycSaJsonCredentials))
        info('Parsed Service account JSON')
        return new IamTokenService(serviceAccountJson)
    }

    let iamToken: string
    if (ycIamToken !== '') {
        iamToken = ycIamToken
        info('Using IAM token')
    } else if (ycSaId !== '') {
        const ghToken = await getIDToken()
        if (!ghToken) {
            throw new Error('No credentials provided')
        }
        iamToken = await exchangeToken(ghToken, ycSaId)
    } else {
        throw new Error('No credentials')
    }

    return { getToken: async () => iamToken }
}
