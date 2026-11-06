/**
 * dsh-drama-trae —— 「一个想法」结构化输入模板（brief.json）。
 *
 * 目的：解决「阶段 1 想法结构化 100% 人工」的问题。此前两插件都没有输入模板，
 * 用户的一句话想法要靠对话反复澄清才能进入立项。本模块提供可校验的结构化模板。
 *
 * 落点：<项目>/.aidrama/brief.json（add-only，不影响 ai-drama 现有 contract.json）
 * 与 ai-drama 八大设定的关系：brief 只补 contract 未覆盖的三项
 *   （投放平台 / 可量化视觉基调 / 合规档位），其余交由 contract 承载。
 *
 * @module src/brief
 */

/** 支持的投放平台（决定画幅、钩子密度、合规词表）。 */
export const BRIEF_PLATFORMS = ['抖音', '快手', '视频号', 'B站', '小红书', '其他']

/** 必填字段与其约束。 */
export const BRIEF_REQUIRED = {
  genre: { label: '题材', maxLen: 40 },
  coreConflict: { label: '核心冲突', maxLen: 200 },
  targetDurationSec: { label: '单集时长（秒）', min: 15, max: 600 },
  episodeCount: { label: '集数', min: 1, max: 200 },
  platform: { label: '投放平台', enum: BRIEF_PLATFORMS },
}

/** visualTone 三子项（可量化，禁空词）。 */
export const VISUAL_TONE_KEYS = ['palette', 'contrast', 'texture']

/** 空词黑名单（写了等于没写，判为无效）。 */
const EMPTY_WORDS = ['高级感', '电影感', '唯美', '大气', '精致', '有质感', '好看']

/** 空模板（供 UI 生成表单 / CLI 打印）。 */
export function emptyBrief() {
  return {
    briefVersion: 1,
    genre: '',
    protagonists: [],
    coreConflict: '',
    targetDurationSec: 90,
    episodeCount: 12,
    platform: '抖音',
    visualTone: { palette: '', contrast: '', texture: '' },
    complianceProfile: '',
  }
}

/**
 * 校验 brief（返回问题列表；空数组表示通过）。
 * @param {object} brief
 * @returns {{ errors: string[], warnings: string[], normalized: object }}
 */
export function validateBrief(brief) {
  const errors = []
  const warnings = []
  const b = brief && typeof brief === 'object' && !Array.isArray(brief) ? brief : null
  if (!b) {
    return { errors: ['brief 必须是对象'], warnings: [], normalized: emptyBrief() }
  }

  // 必填
  for (const [key, rule] of Object.entries(BRIEF_REQUIRED)) {
    const v = b[key]
    if (v === undefined || v === null || v === '') {
      errors.push(`缺少必填项 ${rule.label}（${key}）`)
      continue
    }
    if (rule.enum) {
      if (!rule.enum.includes(String(v))) errors.push(`${rule.label}（${key}）必须是 ${rule.enum.join('/')} 之一，当前「${v}」`)
    }
    if (rule.maxLen !== undefined) {
      const s = String(v).trim()
      if (s.length > rule.maxLen) errors.push(`${rule.label}（${key}）超长：${s.length} > ${rule.maxLen}`)
    }
    if (rule.min !== undefined) {
      const n = Number(v)
      if (!Number.isFinite(n)) errors.push(`${rule.label}（${key}）必须是数字，当前「${v}」`)
      else if (n < rule.min || n > rule.max) errors.push(`${rule.label}（${key}）须在 ${rule.min}–${rule.max}，当前 ${n}`)
    }
  }

  // 主角
  const pros = Array.isArray(b.protagonists) ? b.protagonists : []
  if (!pros.length) errors.push('缺少主角（protagonists 至少 1 人）')
  if (pros.length > 3) warnings.push(`主角 ${pros.length} 人（建议 1–3 人，过多会稀释一致性约束）`)
  for (const [i, p] of pros.entries()) {
    if (!p || typeof p !== 'object') { errors.push(`主角[${i}] 必须是对象`); continue }
    if (!String(p.name ?? '').trim()) errors.push(`主角[${i}] 缺少 name`)
    if (!String(p.want ?? '').trim()) warnings.push(`主角[${i}]（${p.name || '?'}）缺少 want（欲望驱动），剧情推进可能乏力`)
  }

  // visualTone 空词检测
  const vt = b.visualTone && typeof b.visualTone === 'object' ? b.visualTone : {}
  for (const k of VISUAL_TONE_KEYS) {
    const s = String(vt[k] ?? '').trim()
    if (!s) { warnings.push(`visualTone.${k} 为空，视觉风格将缺少可量化约束`); continue }
    if (EMPTY_WORDS.some((w) => s === w || s.length <= 3)) {
      warnings.push(`visualTone.${k}「${s}」过于笼统，建议改为可量化描述（色调/光比/质感）`)
    }
  }

  // 时长 × 集数 合理性
  const dur = Number(b.targetDurationSec)
  const eps = Number(b.episodeCount)
  if (Number.isFinite(dur) && Number.isFinite(eps)) {
    const totalMin = (dur * eps) / 60
    if (totalMin > 180) warnings.push(`总时长 ${totalMin.toFixed(0)} 分钟，单部体量偏大，建议拆季或削减集数`)
  }

  const normalized = {
    ...emptyBrief(),
    ...b,
    genre: String(b.genre ?? '').trim(),
    coreConflict: String(b.coreConflict ?? '').trim(),
    targetDurationSec: Number(b.targetDurationSec),
    episodeCount: Number(b.episodeCount),
    platform: String(b.platform ?? '').trim(),
    protagonists: pros.slice(0, 3).map((p) => ({
      name: String(p?.name ?? '').trim(),
      identity: String(p?.identity ?? '').trim(),
      want: String(p?.want ?? '').trim(),
      flaw: String(p?.flaw ?? '').trim(),
    })),
    visualTone: {
      palette: String(vt.palette ?? '').trim(),
      contrast: String(vt.contrast ?? '').trim(),
      texture: String(vt.texture ?? '').trim(),
    },
    complianceProfile: String(b.complianceProfile ?? '').trim(),
  }
  return { errors, warnings, normalized }
}

/**
 * 把 brief 渲染成一段可直接交给立项的技能输入文本。
 * @param {object} brief
 * @returns {string}
 */
export function renderBriefPrompt(brief) {
  const { normalized } = validateBrief(brief)
  const n = normalized
  const lines = [
    `题材：${n.genre}`,
    `核心冲突：${n.coreConflict}`,
    `单集时长：${n.targetDurationSec} 秒 × ${n.episodeCount} 集`,
    `投放平台：${n.platform}`,
  ]
  if (n.protagonists.length) {
    lines.push('主角：' + n.protagonists
      .map((p) => `${p.name}${p.identity ? `（${p.identity}）` : ''}${p.want ? `，想要${p.want}` : ''}${p.flaw ? `，软肋${p.flaw}` : ''}`)
      .join('；'))
  }
  const vt = n.visualTone
  const vtParts = []
  if (vt.palette) vtParts.push(`色板 ${vt.palette}`)
  if (vt.contrast) vtParts.push(`光比 ${vt.contrast}`)
  if (vt.texture) vtParts.push(`质感 ${vt.texture}`)
  if (vtParts.length) lines.push('视觉基调：' + vtParts.join('，'))
  if (n.complianceProfile) lines.push(`合规档位：${n.complianceProfile}`)
  return lines.join('\n')
}
