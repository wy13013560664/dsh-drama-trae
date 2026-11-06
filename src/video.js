/**
 * TRAE 视频生成三阶段编排 + SSE 消费 —— **已端到端实测跑通（2026-11-03）**。
 *
 * 实测确认的协议：
 *  - 端点 `POST /api/ide/v1/tool_text_to_video_stream`，请求体最小 `{model, prompt}` 即可 200。
 *  - SSE 帧：heartbeat(每3s, {"timestamp_ms","status":"processing"})
 *            → result({"uri":<TOS key>, "last_frame_url":<TOS key>, "video_duration":<秒>})
 *            → done({"finish_reason":"stop"})
 *  - `uri` 是 TOS 对象存储 key（相对路径），不是可直接下载的 URL；需先
 *    `POST /api/ide/v1/get_resource_url` body `{uri_list:[key]}` 换 `url_map`（签名 URL）。
 *
 * @module src/video
 */

import { TRAE, PATHS, STAGES, VIDEO_MODEL, DEFAULT_RESOLUTION, DEFAULT_RATIO, DEFAULT_DURATION, MIN_DURATION, MAX_DURATION, MAX_VIDEO_BYTES } from './constants.js'
import { soloHeaders } from './credential.js'
import { normalizeParams } from './validate.js'

/**
 * 构造 tool_text_to_video_stream 请求体。
 * 字段对齐 GenerateVideoParams（tool Schema），外层加 model。
 *
 * 【wire 字段实测确认】服务端网络层字段是 `image_urls` / `video_urls`
 * （非 tool 层的 `image_paths` / `video_paths`），且对 `_paths` 别名也兼容。
 * 本函数两套都发，确保兼容（实测 image_paths 与 video_urls 均成功）。
 *
 * @param {object} params
 * @param {string} params.prompt
 * @param {string[]} [params.image_paths] 图生视频：图的 TOS key 数组（≤9）
 * @param {string[]} [params.video_paths] 视频续写：视频的 TOS key 数组（≤3）
 * @param {string} [params.resolution] 480p|720p|1080p|4k
 * @param {string} [params.ratio] 16:9|4:3|1:1|3:4|9:16|21:9|adaptive
 * @param {number} [params.duration] 秒；-1 或 4~15（下线以服务端实测为准，见 constants.MIN_DURATION）
 * @param {number} [params.total_input_video_duration_ms] 视频续写时输入视频总时长 ms
 */
export function buildRequestBody(params) {
  const body = {
    model: VIDEO_MODEL,
    prompt: params.prompt,
    resolution: params.resolution ?? DEFAULT_RESOLUTION,
    ratio: params.ratio ?? DEFAULT_RATIO,
    duration: params.duration ?? DEFAULT_DURATION,
    // 图生视频：同时发 image_paths（tool 层名）与 image_urls（wire 层名）
    ...(params.image_paths?.length ? { image_paths: params.image_paths, image_urls: params.image_paths } : {}),
    // 视频续写：同时发 video_paths（tool 层名）与 video_urls（wire 层名）
    ...(params.video_paths?.length ? { video_paths: params.video_paths, video_urls: params.video_paths } : {}),
    // 视频续写：输入视频总时长（ms），来自二进制 StreamRequest.total_input_video_duration_ms
    ...(params.total_input_video_duration_ms !== undefined
      ? { total_input_video_duration_ms: params.total_input_video_duration_ms }
      : {}),
  }
  if (params.duration !== undefined && params.duration !== -1) {
    if (params.duration < MIN_DURATION || params.duration > MAX_DURATION) {
      throw new Error(`duration must be -1 or between ${MIN_DURATION} and ${MAX_DURATION} seconds`)
    }
  }
  return body
}

/**
 * 消费视频生成 SSE 流，yield 每个事件对象。
 *
 * 【已实测确认】trae-api-cn.mchost.guru + /api/ide/v1/tool_text_to_video_stream
 * 的真实帧结构（2026-11-03 实测）：
 *   event:heartbeat  data:{"timestamp_ms":1793691110310,"status":"processing"}   (每 3 秒一次)
 *   event:result?    data:{"uri":"..."}   (字段名 `uri`，见 generate_image/mod.rs 日志
 *                     `[gen_image_stream] result: uri=?`，视频模块对称)
 *   event:done       data:{"reason":"..."}  (generate_image 日志 `done: reason=?`)
 *   event:error      data:{"code":...,"msg":"..."}  (generate_image 日志 `error: code=?, msg=?`)
 *
 * 心跳 status 字段：processing →（生成中）→ 完成后接 result/done 帧。
 */
export async function* consumeSse(response) {
  if (!response.body) throw new Error('empty stream body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // 两层超时：服务端可能「不发帧也不断连」，裸 await reader.read() 会永久挂住
  // （实测：某账号请求 3 分钟无任何帧，进程卡死）。所以每帧有 idle 上限、整条流有总上限。
  const idleMs = Number(process.env.DSH_TRAE_SSE_IDLE_MS || 30000)
  const totalMs = Number(process.env.DSH_TRAE_SSE_TOTAL_MS || 600000)
  const startedAt = Date.now()
  let lastFrameAt = Date.now()
  while (true) {
    if (Date.now() - startedAt > totalMs) {
      try { await reader.cancel() } catch { /* already closed */ }
      throw new Error(`trae-video: SSE 超过总时长上限 ${Math.round(totalMs / 1000)}s 未结束`)
    }
    if (Date.now() - lastFrameAt > idleMs) {
      try { await reader.cancel() } catch { /* already closed */ }
      throw new Error(`trae-video: SSE 连续 ${Math.round(idleMs / 1000)}s 无任何帧（服务端静默挂起）`)
    }
    let tick
    try {
      tick = await Promise.race([
        reader.read(),
        new Promise((_, rej) => {
          const t = setTimeout(() => rej(new Error('__idle__')), Math.min(idleMs, 5000))
          if (t.unref) t.unref()
        }),
      ])
    } catch (e) {
      if (String(e?.message) === '__idle__') { lastFrameAt = lastFrameAt; continue }
      throw e
    }
    const { done, value } = tick
    if (done) break
    lastFrameAt = Date.now()
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const event = {}
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event.event = line.slice(6).trim()
        else if (line.startsWith('data:')) event.data = line.slice(5).trim()
      }
      if (event.data) {
        let parsed = event.data
        try { parsed = JSON.parse(event.data) } catch { /* 保留原始字符串 */ }
        yield { event: event.event ?? 'message', data: parsed }
      }
    }
  }
}

/** 从 `result` 帧提取产物 TOS key（字段名 `uri`，实测确认）。 */
export function extractVideoUri(frame) {
  const d = frame?.data
  if (typeof d !== 'object' || d === null) return undefined
  return d.uri ?? d.video_url ?? d.media_url ?? d.url ?? undefined
}

/** 从 `result` 帧提取末帧预览图 TOS key（`last_frame_url`）。 */
export function extractLastFrameUri(frame) {
  const d = frame?.data
  if (typeof d !== 'object' || d === null) return undefined
  return d.last_frame_url ?? undefined
}

/**
 * 把 TOS 相对 key 换成带签名的可下载 URL。
 * 实测：POST /api/ide/v1/get_resource_url body {uri_list:[key]} → {url_map:{key: url}}
 */
export async function resolveResourceUrls(credential, uriList, { fetchImpl = fetch, host = TRAE.agentHost } = {}) {
  if (!uriList?.length) return {}
  const res = await fetchImpl(`${host}${PATHS.getResourceUrl}`, {
    method: 'POST',
    headers: soloHeaders(credential, { stream: false }),
    body: JSON.stringify({ uri_list: uriList }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`trae-video: 解析下载地址失败 HTTP ${res.status}: ${text.slice(0, 400)}`)
  }
  const body = await res.json().catch(() => ({}))
  return body.url_map ?? {}
}

/**
 * 生成一段视频：预检 → 提交 → SSE 轮询 → 下载 → 落盘。
 *
 * @param {object} deps
 * @param {object} deps.credential 已解析凭据（ensureUsableCredential 产出）
 * @param {object} deps.params    generate 参数（见 buildRequestBody）
 * @param {string} deps.localPath 落盘路径（无扩展名自动补 .mp4）
 * @param {(uri: string) => Promise<Response>} [deps.downloadImpl]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(stage, payload) => void} [deps.onProgress]
 */
export async function generateVideo(deps) {
  const {
    credential,
    params,
    localPath,
    docs = {},
    downloadImpl,
    fetchImpl = fetch,
    onProgress = () => {},
  } = deps

  // 参数校验与规范化（枚举/范围/refs 数量）
  const normalized = normalizeParams(params)
  const body = buildRequestBody(normalized)
  const host = TRAE.agentHost

  // ---- 阶段 A：额度预检（soft-fail）----
  onProgress(STAGES.PREFLIGHT, { host, model: VIDEO_MODEL })
  try {
    const pre = await fetchImpl(`${host}${PATHS.checkEstimatedBalance}`, {
      method: 'POST',
      headers: soloHeaders(credential, { stream: false }),
      body: JSON.stringify({ model: VIDEO_MODEL }),
    })
    onProgress('preflight_status', { status: pre.status })
  } catch (err) {
    // 二进制日志串证实：media budget unavailable; generation will continue
    onProgress('preflight_skip', { reason: err?.message ?? 'budget unavailable' })
  }

  // ---- 阶段 B：提交 + SSE 轮询 ----
  onProgress(STAGES.SUBMIT, { endpoint: PATHS.textToVideoStream, body })
  const res = await fetchImpl(`${host}${PATHS.textToVideoStream}`, {
    method: 'POST',
    headers: soloHeaders(credential, { stream: true }),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`trae-video: 提交失败 HTTP ${res.status}: ${text.slice(0, 400)}`)
  }

  onProgress(STAGES.POLL, {})
  let uri
  let lastFrameUri
  let videoDuration
  for await (const frame of consumeSse(res)) {
    if (frame.event === 'result') {
      uri = extractVideoUri(frame) ?? uri
      lastFrameUri = extractLastFrameUri(frame) ?? lastFrameUri
      videoDuration = frame.data?.video_duration ?? videoDuration
      onProgress('result', { uri, last_frame_uri: lastFrameUri, video_duration: videoDuration })
      continue
    }
    if (isTerminalError(frame)) {
      // 不截断：错误里常嵌三层码（3003 外层 → 4008/4040 内层 → callArkVideoGeneration 细节），
      // 截断就丢掉了真正原因。
      throw new Error(`trae-video: 服务端返回错误 ${JSON.stringify(frame)}`)
    }
    if (frame.event === 'done') {
      onProgress('done', { finish_reason: frame.data?.finish_reason })
      break
    }
    onProgress('frame', { event: frame.event, status: frame.data?.status })
  }
  if (!uri) {
    throw new Error('trae-video: video generation backend returned an empty URI')
  }

  // ---- 阶段 C：解析 TOS key → 签名 URL → 下载 → 落盘 ----
  onProgress(STAGES.DOWNLOAD, { uri })
  const urlMap = await resolveResourceUrls(credential, [uri], { fetchImpl, host })
  const downloadUrl = urlMap[uri]
  if (!downloadUrl) {
    throw new Error('trae-video: url_map 中缺少产物下载地址')
  }
  const dlRes = downloadImpl ? await downloadImpl(downloadUrl) : await fetchImpl(downloadUrl)
  if (!dlRes.ok) throw new Error(`trae-video: 下载产物失败 HTTP ${dlRes.status}`)
  const buffer = Buffer.from(await dlRes.arrayBuffer())
  if (buffer.length > MAX_VIDEO_BYTES) {
    throw new Error('generated video exceeds the 100 MiB limit')
  }
  const finalPath = /\.[a-z0-9]{2,5}$/i.test(localPath) ? localPath : `${localPath}.mp4`
  const { writeFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const dir = path.dirname(finalPath)
  if (dir && dir !== '.') {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
  }
  await writeFile(finalPath, buffer)
  onProgress(STAGES.WRITE, { local_path: finalPath, bytes: buffer.length })

  onProgress(STAGES.DONE, { local_path: finalPath, bytes: buffer.length, video_duration: videoDuration })
  return { path: finalPath, local_path: finalPath, bytes: buffer.length, video_duration: videoDuration, last_frame_uri: lastFrameUri }
}

function isTerminalError(frame) {
  return frame.event === 'error' || frame.data?.code === 4008 /* quota */ || frame.data?.error !== undefined
}