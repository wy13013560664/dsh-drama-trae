/**
 * dsh-drama-trae —— 视觉风格 DNA 加载与注入。
 *
 * 目的：解决「视觉风格断裂」——此前 style.json 虽有五维风格 DNA，
 * 但出片侧完全不读，跨镜/跨集的色调、光感、质感无约束。
 *
 * 数据来源（实测结构，见 dsh-plugin-ai-drama 的 lib/style-dna.js）：
 *   .aidrama/style.json → {
 *     schemaVersion: 1,
 *     state?: 'draft'|'directed'|'frozen',
 *     style: { palette, lighting, texture, composition, motion }   // 各 ≤300 字
 *   }
 * 该卡在 ai-drama 侧「只存储/读取，不参与生成注入」——本模块补上注入这一环。
 *
 * 注入策略：
 *   - frozen / directed 状态的 DNA 才注入（draft 视为未定稿，不注入，避免把草稿
 *     当约束）；可用 opts.includeDraft 放开
 *   - 只拼接非空维度；五维全空 → 返回空串（出片照常）
 *   - 渲染成自然语句而非裸列字段，提高视频模型可读性
 *
 * @module src/style
 */

/** 五维维度顺序与中文标签（与 ai-drama 一致）。 */
export const STYLE_DIMENSIONS = ['palette', 'lighting', 'texture', 'composition', 'motion']

export const STYLE_DIMENSION_LABELS = {
  palette: '色板',
  lighting: '光感',
  texture: '质感',
  composition: '构图',
  motion: '运镜',
}

/** 单维长度上限（与 ai-drama STYLE_TEXT_LIMIT 一致）。 */
export const STYLE_TEXT_LIMIT = 300

/**
 * 归一化 style.json 文档，取出 DNA 与状态。
 * @param {object} doc .aidrama/style.json 解析结果
 * @returns {{ dna: Record<string,string>, state: string, filled: number }}
 */
export function normalizeStyleDoc(doc) {
  const dna = {}
  let filled = 0
  const raw = doc && typeof doc === 'object' && doc.style && typeof doc.style === 'object'
    ? doc.style
    // 兼容直接把五维写在顶层的写法
    : doc && typeof doc === 'object' && !Array.isArray(doc)
      ? doc
      : {}
  for (const d of STYLE_DIMENSIONS) {
    const v = String(raw?.[d] ?? '').trim().slice(0, STYLE_TEXT_LIMIT)
    dna[d] = v
    if (v) filled += 1
  }
  const state = String(doc?.state ?? doc?.styleState ?? 'draft').trim() || 'draft'
  return { dna, state, filled }
}

/**
 * 渲染风格尾缀，用于拼在 prompt 末尾（画幅提示之前）。
 *
 * @param {object} doc .aidrama/style.json 解析结果
 * @param {{ includeDraft?: boolean }} [opts]
 * @returns {{ suffix: string, state: string, used: string[] }}
 */
export function renderStyleSuffix(doc, opts = {}) {
  const { includeDraft = false } = opts
  const { dna, state, filled } = normalizeStyleDoc(doc)
  if (!filled) return { suffix: '', state, used: [] }
  // 判定策略（v0.5 调整）：
  //   ① 显式 frozen/directed → 注入
  //   ② 五维**至少 3 维有内容** → 视为实质可用，注入（很多项目不写 state 字段，
  //      若只认 state 会把已写完的 DNA 白白浪费）
  //   ③ 其余（draft 且内容稀薄）→ 不注入，除非显式 includeDraft
  const substantive = filled >= 3
  if (!includeDraft && state !== 'directed' && state !== 'frozen' && !substantive) {
    return { suffix: '', state, used: [] }
  }
  const parts = []
  const used = []
  for (const d of STYLE_DIMENSIONS) {
    const v = dna[d]
    if (!v) continue
    parts.push(`${STYLE_DIMENSION_LABELS[d]}：${v}`)
    used.push(d)
  }
  return { suffix: `[视觉风格] ${parts.join('；')}`, state, used }
}
