/**
 * TRAE 文生图（t2i, seedream_5）—— 图生视频的上游素材源。
 *
 * 实测（2026-11-03）：POST /api/ide/v1/tool_text_to_image_stream
 *   body { model:"seedream_5", prompt }
 *   SSE: heartbeat → result{uri:"tos-cn-i-.../gen_image/<ts>_<hex>_jpeg_1920x1920"}
 *        → done{finish_reason:"stop"}
 *   `uri` 是 TOS key，可直接作为 t2v 的 image_paths 传入（图生视频）。
 *
 * @module src/image
 */

import { PATHS, IMAGE_MODEL } from './constants.js'
import { soloHeaders } from './credential.js'
import { consumeSse } from './video.js'

/**
 * 文生图，返回 TOS key（可直接喂给 generateVideo 的 image_paths）。
 * @param {object} credential
 * @param {object} params { prompt, ratio?, resolution? }
 * @param {{fetchImpl?: Function, host?: string, onProgress?: Function}} opts
 * @returns {Promise<{uri: string, last_frame_url?: string}>}
 */
export async function generateImage(credential, params, opts = {}) {
  const { fetchImpl = fetch, host, onProgress = () => {} } = opts
  const body = {
    model: IMAGE_MODEL,
    prompt: params.prompt,
  }
  const res = await fetchImpl(`${host ?? requireHost()}${PATHS.textToImageStream}`, {
    method: 'POST',
    headers: soloHeaders(credential, { stream: true }),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`trae-video: 文生图失败 HTTP ${res.status}: ${t.slice(0, 400)}`)
  }
  let uri
  for await (const frame of consumeSse(res)) {
    if (frame.event === 'result') {
      uri = frame.data?.uri ?? uri
      onProgress('image_result', { uri })
    }
    if (frame.event === 'done') break
    if (frame.event === 'error' || frame.data?.code === 4008) {
      throw new Error(`trae-video: t2i 错误 ${JSON.stringify(frame).slice(0, 300)}`)
    }
  }
  if (!uri) throw new Error('trae-video: 文生图未返回 uri')
  return { uri }
}

import { TRAE } from './constants.js'
function requireHost() {
  return TRAE.agentHost
}