/**
 * TRAE 凭据解析与静默续期。
 *
 * 凭据结构（已从 ~/.dsh/.credentials.yaml 的 TRAE_ACCOUNT_* 实读）：
 *   access_token   JWT（Cloud-IDE-JWT）
 *   refresh_token  续期用
 *   expires_at     ms 字符串（>1e12 即 ms；<1e12 当秒）
 *   uid            账号 uid
 *   nickname / phone / email
 *   machine_id / device_id / enterprise_id
 *
 * 这里的解析逻辑与 dsh-our-free-model vendor/channel-pack 的
 * `parseCredential` / `traeCredentialExpiresAtMs` / `traeSOLOHeaders` 完全对应。
 * @module src/credential
 */

import { TRAE, OAUTH_PATHS } from './constants.js'

/** 若值 < 1e12 视为秒，否则视为毫秒（与 our-free-model 同判据）。 */
export function expiresAtMs(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  const asNumber = typeof raw === 'number' ? raw : Number(raw)
  if (Number.isFinite(asNumber)) return asNumber > 1e12 ? asNumber : asNumber * 1e3
  const parsed = Date.parse(String(raw))
  return Number.isNaN(parsed) ? undefined : parsed
}

export function parseCredential(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (parsed && typeof parsed === 'object' && typeof parsed.access_token === 'string') {
      return parsed
    }
  } catch {
    /* fallthrough */
  }
  return undefined
}

export function isExpired(credential, now = Date.now()) {
  const exp = expiresAtMs(credential?.expires_at)
  if (exp === undefined) return false
  return now >= exp
}

export function isRefreshable(credential) {
  return typeof credential?.refresh_token === 'string' && credential.refresh_token.length > 0
}

/**
 * 构造 SOLO 请求头（与 our-free-model `traeSOLOHeaders` 逐字段一致）。
 * @param {object} credential 已解析凭据
 * @param {{stream?: boolean}} opts
 */
export function soloHeaders(credential, opts = {}) {
  const stream = opts.stream ?? false
  const headers = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': TRAE.userAgent,
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-Cloudide-Token': credential.access_token,
    'X-Ide-Token': credential.access_token,
    'X-Uid': credential.uid ?? '',
    'X-App-Id': TRAE.appId,
    'X-App-Version': 'default',
    'X-Ide-Version': TRAE.ideVersion,
    'X-Ide-Version-Code': TRAE.ideVersionCode,
    'X-App-Version-Code': TRAE.ideVersionCode,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'macos',
    'X-OS-Version': TRAE.osVersion,
    'X-Device-Brand': TRAE.deviceBrand,
    'Request-Traffic-Type': 'prod',
  }
  if (credential.machine_id) headers['X-Machine-Id'] = credential.machine_id
  if (credential.device_id) headers['X-Device-Id'] = credential.device_id
  return headers
}

/**
 * 静默续期：POST ExchangeToken 换新 access_token。
 * 与 our-free-model `TraeAuth.refresh()` 同路径。
 */
export async function refreshCredential(credential, { fetcher = fetch, oauthHost = TRAE.agentHost } = {}) {
  if (!isRefreshable(credential)) {
    throw new Error('trae-video: 无 refresh_token，无法续期，请重新登录')
  }
  const res = await fetcher(`${oauthHost}${OAUTH_PATHS.exchangeToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': TRAE.userAgent,
    },
    body: JSON.stringify({
      refresh_token: credential.refresh_token,
      client_id: TRAE.clientId,
    }),
  })
  if (!res.ok) {
    throw new Error(`trae-video: ExchangeToken 续期失败 HTTP ${res.status}`)
  }
  const data = await res.json().catch(() => ({}))
  const result = data.Result ?? data.result ?? {}
  const accessToken = result.Token ?? result.token ?? result.accessToken
  const refreshToken = result.RefreshToken ?? result.refreshToken
  if (!accessToken) {
    throw new Error('trae-video: ExchangeToken 未返回 access_token，refresh_token 可能已失效')
  }
  return {
    ...credential,
    access_token: accessToken,
    refresh_token: refreshToken ?? credential.refresh_token,
    expires_at: String(
      result.TokenExpireAt
        ? (result.TokenExpireAt > 1e12 ? result.TokenExpireAt : result.TokenExpireAt * 1e3)
        : (result.TokenExpireDuration
          ? Date.now() + result.TokenExpireDuration * 1e3
          : ''),
    ),
  }
}

/**
 * 取可用凭据：先解析，过期且有 refresh_token 则静默续期。
 * @param {(ref: string) => Promise<{value: string} | undefined>} resolveRef 凭据解析函数
 * @param {string} ref 凭据引用名
 */
export async function ensureUsableCredential(resolveRef, ref = TRAE.defaultCredentialRef) {
  const resolved = await resolveRef(ref)
  if (!resolved) throw new Error(`trae-video: 未配置凭据 ${ref}，请先在 our-free-model 里登录 TRAE`)
  let credential = parseCredential(resolved.value)
  if (!credential) throw new Error('trae-video: 凭据解析失败（缺少 access_token）')
  if (isExpired(credential)) {
    credential = await refreshCredential(credential)
  }
  return credential
}