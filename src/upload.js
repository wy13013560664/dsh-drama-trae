/**
 * TRAE 素材上传（图生视频 / 视频续写的本地素材上传）—— **全链路实测跑通（2026-11-03）**。
 *
 * 实测协议（非推断，逐字段验证）：
 *
 * 1. POST {host}/api/ide/v1/get_resource_upload_url
 *    body { targets: ["文件名.扩展名"] }
 *    → { session_key: base64(JSON), store_infos: [{ auth, store_uri }], upload_hosts: [host] }
 *
 * 2. PUT https://{upload_hosts[0]}/{store_uri}
 *    headers { "X-Auth": store_infos[0].auth, "Content-Type": <mime> }
 *    body 文件字节
 *    → 204 No Content = 上传成功
 *
 * 3. base64 解码 session_key 得最终 TOS key（json.uri），即 t2v 的 image_paths / video_paths。
 *
 * 关键逆回：`targets` 字段名来自二进制 handler/multimodal.rs 的 `targets_len` 连排；
 * X-Auth 的 auth JWT 内含 signatureInfo.accessKey/bucket/oidKey，走字节私有 TOS 鉴权。
 *
 * @module src/upload
 */

import { TRAE, PATHS } from './constants.js'
import { soloHeaders } from './credential.js'

/**
 * 拿上传凭证（store_uri + auth + upload_hosts）。
 *
 * 【抓包实测，2026-11-04】关键三条：
 *  1. `targets` 只传**裸文件名**（如 `1793800395798_dd1132fc80_jpg_1024x576`），
 *     服务端自动补 `cn/{uid}/image/` 前缀。传完整路径会重复成 `.../image/cn/{uid}/image/...`。
 *  2. `biz_type` 决定落到哪个 bucket（直接影响 i2v 能否签名）：
 *     `image` → tos-cn-i-zaeny81f73（图像业务桶，t2v 的 image_paths 只认它）
 *     `video` → tos-cn-i-av28lk49dz（视频业务桶，v2v 的 video_paths 用）
 *     不传    → tos-cn-i-3hx2o39pc4（通用桶）→ 后端报 invalid userid
 *  3. `store_infos[0].auth` 形如 `{accessKey}:version:v2:{jwt}`，PUT 时整串放进 Authorization。
 *
 * @param {object} credential 已解析凭据
 * @param {string|string[]} filenames 裸文件名（不含目录），如 "photo_jpg_1024x576"
 * @param {object} [opts]
 * @param {string} [opts.biz_type] 'image' | 'video'（必传其一才落对桶）
 * @returns {Promise<object>} { session_key, session, store_infos, upload_hosts }
 */
export async function requestUploadCredential(credential, filenames, { fetchImpl = fetch, host = TRAE.agentHost, biz_type } = {}) {
  const targets = Array.isArray(filenames) ? filenames : [filenames]
  const body = { targets }
  if (biz_type) body.biz_type = biz_type
  const res = await fetchImpl(`${host}${PATHS.getResourceUploadUrl}`, {
    method: 'POST',
    headers: soloHeaders(credential, { stream: false }),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`trae-video: 获取上传凭证失败 HTTP ${res.status}: ${t.slice(0, 400)}`)
  }
  const json = await res.json()
  // 解码 session_key，拿到返回的最终 uri
  let session
  try {
    session = JSON.parse(Buffer.from(json.session_key, 'base64').toString('utf8'))
  } catch {
    session = undefined
  }
  return { ...json, session }
}

/**
 * 上传本地文件到 TOS，返回最终 TOS key（可直接喂给 generateVideo 的 image_paths / video_paths）。
 *
 * 【抓包实测，2026-11-04】PUT 的正确写法（三条易错点全部踩过）：
 *  1. `Authorization: {accessKey}:version:v2:{jwt}` —— 不是 `X-Auth: {jwt}`。
 *     accessKey 从 store_infos[0].auth 串首段取，jwt 是其后整段。
 *  2. `Content-CRC32: {crc32 小写十六进制}` —— 加这个头才做完整性校验；
 *     传大写或十进制会 400 MismatchChecksum。
 *  3. **不要手动设置 Content-Length** —— 手设会让 TOS 的计算与实际字节不符，同样 400。
 *  成功响应是 200 + `{"success":0,"payload":{"hash","key"}}`（不是 204）。
 *
 * 另：i2v 的 image_paths 必须用 biz_type='image' 上传的 key（落 zaeny81f73 桶）；
 *     v2v 的 video_paths 用 biz_type='video'（落 av28lk49dz 桶）；
 *     key 内含上传账号 uid，故**上传与出片必须用同一账号**。
 *
 * @param {object} credential 已解析凭据
 * @param {string} localPath 本地文件绝对路径
 * @param {object} [opts]
 * @param {string} [opts.filename] 裸文件名（不含目录；默认按 `{ts}_{hex}_{ext}_{w}x{h}` 生成）
 * @param {string} [opts.biz_type] 'image' | 'video'（决定落哪个业务桶）
 * @returns {Promise<{uri: string, store_uri: string, upload_host: string}>}
 */
export async function uploadLocalFile(credential, localPath, opts = {}) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const crypto = await import('node:crypto')
  const zlib = await import('node:zlib')
  const buf = await fs.readFile(localPath)
  const ext = (path.extname(localPath) || '.jpg').replace('.', '').toLowerCase()
  // 默认按图片上传（i2v 是最常见场景）
  const bizType = opts.biz_type ?? 'image'

  // 裸文件名：{毫秒时间戳}_{10位hex}_{扩展名}_{宽}x{高}（TRAE 原始格式，宽高仅作标识）
  const bareName = opts.filename
    ?? `${Date.now()}_${crypto.randomBytes(5).toString('hex')}_${ext}_1024x576`

  const cred = await requestUploadCredential(credential, bareName, { ...opts, biz_type: bizType })
  const storeInfo = cred.store_infos?.[0]
  if (!storeInfo?.auth || !storeInfo?.store_uri) {
    throw new Error('trae-video: 上传凭证缺少 auth / store_uri')
  }
  const uploadHost = (cred.upload_hosts?.[0] ?? '').replace(/^https?:\/\//, '')
  const url = `https://${uploadHost}/${storeInfo.store_uri}`

  // auth 串形如 `{accessKey}:version:v2:{jwt}`，整串即 Authorization 值
  const authHeader = storeInfo.auth.startsWith('Space ')
    ? storeInfo.auth.slice('Space '.length)
    : storeInfo.auth
  const crc32 = (zlib.crc32(buf) >>> 0).toString(16)

  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'PUT',
    headers: {
      Authorization: authHeader,
      'Content-CRC32': crc32,
      'Content-Type': mimeFor(`.${ext}`),
      'X-Storage-U': String(credential.uid ?? ''),
      'x-bridge-transport': 'aha',
    },
    body: buf,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`trae-video: 上传失败 HTTP ${res.status}: ${t.slice(0, 400)}`)
  }
  let body = {}
  try { body = await res.json() } catch { /* 204 或空体 */ }
  if (body?.success !== undefined && body.success !== 0) {
    throw new Error(`trae-video: 上传被拒 ${JSON.stringify(body.error ?? body).slice(0, 300)}`)
  }

  // 最终 TOS key：session_key 里的 uri（等价 store_uri）
  const uri = cred.session?.uri ?? storeInfo.store_uri
  return { uri, store_uri: storeInfo.store_uri, upload_host: uploadHost, biz_type: bizType }
}

/**
 * 兼容旧接口：取 STS 临时凭证（get_resource_upload_token）。
 * 注：实测 get_resource_upload_url 是更直接的路径，本函数保留用于调试/对照。
 */
export async function getUploadToken(credential, { fetchImpl = fetch, host = TRAE.agentHost } = {}) {
  const res = await fetchImpl(`${host}${PATHS.getResourceUploadToken}`, {
    method: 'POST',
    headers: soloHeaders(credential, { stream: false }),
    body: '{}',
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`trae-video: 获取 STS 失败 HTTP ${res.status}: ${t.slice(0, 400)}`)
  }
  return res.json()
}

function mimeFor(ext) {
  const m = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  }
  return m[ext] ?? 'application/octet-stream'
}