/**
 * GenerateVideo 参数校验 —— 对齐二进制 tool Schema（generate_video.rs）。
 *
 * 从 libai_agent.dylib strings 实测还原的约束：
 *  - resolution ∈ {480p, 720p, 1080p, 4k}（默认 720p）
 *  - ratio ∈ {16:9, 4:3, 1:1, 3:4, 9:16, 21:9, adaptive}（默认 adaptive）
 *  - duration = -1（默认 5 秒）或 2~15 秒（默认 5）
 *  - image_paths ≤ 9、video_paths ≤ 3
 *  - 生成产物 ≤ 100 MiB
 *
 * @module src/validate
 */

import {
  RESOLUTIONS, RATIOS, DEFAULT_RESOLUTION, DEFAULT_RATIO, DEFAULT_DURATION,
  MAX_DURATION, MIN_DURATION, MAX_IMAGE_REFS, MAX_VIDEO_REFS,
} from './constants.js'

/** 校验并规范化 resolution。 */
export function normalizeResolution(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_RESOLUTION
  if (!RESOLUTIONS.includes(v)) {
    throw new Error(`resolution must be one of ${RESOLUTIONS.join('/')}, got "${v}"`)
  }
  return v
}

/** 校验并规范化 ratio。 */
export function normalizeRatio(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_RATIO
  if (!RATIOS.includes(v)) {
    throw new Error(`ratio must be one of ${RATIOS.join('/')}, got "${v}"`)
  }
  return v
}

/** 校验并规范化 duration（秒）。 */
export function normalizeDuration(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_DURATION
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`duration must be a number, got "${v}"`)
  if (n === -1) return DEFAULT_DURATION // -1 = 默认 5 秒别名
  if (n < MIN_DURATION || n > MAX_DURATION) {
    throw new Error(`duration must be -1 or between ${MIN_DURATION} and ${MAX_DURATION} seconds`)
  }
  return n
}

/** 校验 image_paths / video_paths 数量与类型。 */
export function normalizeRefs(value, limit, label) {
  if (value === undefined || value === null) return undefined
  const arr = Array.isArray(value) ? value : [value]
  if (arr.length > limit) {
    throw new Error(`${label} accepts at most ${limit} items`)
  }
  for (const item of arr) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(`${label} items must be non-empty strings`)
    }
  }
  return arr
}

/**
 * 完整校验并规范化一份 generate 参数。
 * @param {object} params 原始参数
 * @returns {object} 规范化后的参数（resolution/ratio/duration 已填默认值，refs 已转数组）
 */
export function normalizeParams(params = {}) {
  if (!params.prompt || typeof params.prompt !== 'string' || params.prompt.trim().length === 0) {
    throw new Error('prompt is required and must be a non-empty string')
  }
  const out = {
    prompt: params.prompt,
    resolution: normalizeResolution(params.resolution),
    ratio: normalizeRatio(params.ratio),
    duration: normalizeDuration(params.duration),
  }
  const images = normalizeRefs(params.image_paths, MAX_IMAGE_REFS, 'image_paths')
  const videos = normalizeRefs(params.video_paths, MAX_VIDEO_REFS, 'video_paths')
  if (images) out.image_paths = images
  if (videos) out.video_paths = videos
  // 视频续写：输入视频总时长 ms（若给了必须 > 0 且 ≤ 15000ms，因为单条上限 15s）
  if (params.total_input_video_duration_ms !== undefined) {
    const ms = Number(params.total_input_video_duration_ms)
    if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DURATION * 1000) {
      throw new Error(`total_input_video_duration_ms must be 0..${MAX_DURATION * 1000}`)
    }
    out.total_input_video_duration_ms = ms
  }
  return out
}