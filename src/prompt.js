/**
 * dsh-drama-trae —— 分镜 → 视频 prompt 构建。
 *
 * 对齐 dsh-plugin-ai-drama 的分镜字段（shotNumber/shotSize/cameraMove/
 * description/dialogue/sfx/durationSec/imagePrompt/videoPrompt + 可选扩展）。
 * 优先用 videoPrompt / imagePrompt / description，否则按字段拼装自然语句。
 * @module src/prompt
 */

/** 整镜 prompt 上限（与 ai-drama PROMPT_MAX_CHARS 对齐）。 */
const PROMPT_MAX_CHARS = 2000

function clip(text, max = PROMPT_MAX_CHARS) {
  const s = String(text == null ? '' : text).trim()
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

function pick(shot, ...keys) {
  for (const k of keys) {
    const v = shot?.[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** 把分镜情感对象渲染成自然短句。 */
function emotionText(emotion) {
  if (!emotion || typeof emotion !== 'object') return ''
  const label = String(emotion.label || '').trim()
  const intensity = Number(emotion.intensity)
  if (!label) return ''
  return intensity && Number.isFinite(intensity) ? `${label}（强度${intensity}）` : label
}

/**
 * 构建单镜视频 prompt（确定性）。
 * @param {object} shot 分镜行
 * @param {{ratio?: string}} [opts]
 * @returns {string}
 */
export function buildShotVideoPrompt(shot, opts = {}) {
  const s = shot || {}
  const shotNumber = String(s.shotNumber || s.shot || '').trim()
  const explicit = pick(s, 'videoPrompt', 'imagePrompt', 'prompt', '提示词')
  const parts = []
  if (explicit) {
    parts.push(explicit)
  } else {
    const size = pick(s, 'shotSize', '景别')
    const cam = pick(s, 'cameraMove', 'camera', '运镜')
    const desc = pick(s, 'description', '画面')
    if (size) parts.push(`${size}`)
    if (cam) parts.push(`${cam}`)
    if (desc) parts.push(desc)
  }
  // 自然语言提示词（可选扩展字段，优先）
  const natural = pick(s, 'naturalLanguagePrompt')
  if (natural) parts.push(natural)
  // 光影/情绪/镜头（自然语句，不裸列字段）
  const light = pick(s, 'light')
  if (light) parts.push(`光影：${light}`)
  const emo = emotionText(s.emotion)
  if (emo) parts.push(`情绪：${emo}`)
  const lens = pick(s, 'lens')
  if (lens) parts.push(`镜头焦段：${lens}`)
  const subject = pick(s, 'subject')
  if (subject) parts.push(`主体：${subject}`)

  if (!parts.length) {
    throw new Error(`镜 ${shotNumber || '?'} 既没有提示词也没有画面描述，无法生成`)
  }
  const ratio = opts.ratio || '9:16'
  const ratioNote = ratio === '9:16' ? '竖屏 9:16' : ratio === '16:9' ? '横屏 16:9' : `画幅 ${ratio}`
  const body = parts.join('，')
  const head = shotNumber ? `【镜头 ${shotNumber}】${body}` : body
  return clip(`${head}，${ratioNote}`)
}