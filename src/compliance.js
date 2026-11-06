/**
 * dsh-drama-trae —— 平台合规词表与 CP-01 检查。
 *
 * 目的：AI 短剧投放前需要过平台内容红线。ai-drama 现有的
 * lexicon-rhetoric.json / lexicon-positive-negative.json / lexicon-lens.json
 * 是**写作判据用词表**（找抽象修辞、正负打架、焦段越界），不是平台合规词表。
 * 两者目标不同，不能混用。本模块提供独立的合规词表与检查。
 *
 * 词表分级（参考各平台公开的内容规范方向，非官方词表原文）：
 *   - level: 'block'   —— 命中即应阻断投放
 *   - level: 'warn'    —— 命中建议改写
 *   - level: 'context' —— 视上下文而定，仅提示人工复核
 *
 * 重要说明：以下词条为**经验归纳**（[I] 推断），不是任何平台的官方红线清单。
 * 平台规则随政策更新，投产前须以平台最新规范为准。
 *
 * @module src/compliance
 */

/** 通用高敏词（可能违反内容生态规范）。 */
export const BLOCK_TERMS = [
  '赌博', '博彩', '六合彩', '洗钱', '制毒', '贩毒', '吸毒',
  '枪支', '弹药', '炸药', '雷管', '自制枪',
  '走私', '拐卖', '绑架', '勒索',
  '自杀教程', '自残教程', '轻生方法',
  '血腥', '肢解', '割喉', '开膛',
  '色情', '裸露', '嫖娼', '卖淫',
]

/** 警告级词（可写但需谨慎表达）。 */
export const WARN_TERMS = [
  '暴力', '殴打', '砍杀', '枪击', '血泊', '尸体',
  '酒驾', '醉驾', '逃税', '偷税',
  '诈骗', '骗局', '洗脑',
  '迷信', '算命', '风水', '符咒',
  '减肥药', '壮阳', '丰胸',
]

/** 需上下文判断的词（可能出现在合法剧情中，如反派台词）。 */
export const CONTEXT_TERMS = [
  '死', '杀', '刀', '枪', '毒', '罪', '骗', '偷', '打',
]

/** 平台差异化附加词（按平台追加）。 */
export const PLATFORM_EXTRA_TERMS = {
  抖音: ['低俗', '擦边'],
  快手: ['土味', '恶搞'],
  视频号: ['诱导分享', '集赞'],
  B站: ['鬼畜素材'],
  小红书: ['种草诱导'],
  其他: [],
}

/**
 * 对一段文本做合规检查。
 *
 * @param {string} text 待检文本（台词 / prompt / 描述）
 * @param {object} [opts]
 * @param {string} [opts.platform] 投放平台（追加该平台专属词）
 * @param {boolean} [opts.includeContext] 是否报告 context 级词（默认 false，噪音大）
 * @param {object} [opts.location] 位置信息（如 { episode, shot }）
 * @returns {{ level: 'block'|'warn'|'none', hits: object[] }}
 */
export function checkCompliance(text, opts = {}) {
  const s = String(text ?? '')
  if (!s.trim()) return { level: 'none', hits: [] }

  const { platform, includeContext = false, location = {} } = opts
  const extra = PLATFORM_EXTRA_TERMS[String(platform ?? '').trim()] ?? []
  const hits = []

  for (const term of BLOCK_TERMS) {
    if (s.includes(term)) hits.push({ term, level: 'block', ...location })
  }
  for (const term of [...WARN_TERMS, ...extra]) {
    if (s.includes(term)) hits.push({ term, level: 'warn', ...location })
  }
  if (includeContext) {
    for (const term of CONTEXT_TERMS) {
      if (s.includes(term)) hits.push({ term, level: 'context', ...location })
    }
  }

  const level = hits.some((h) => h.level === 'block')
    ? 'block'
    : hits.some((h) => h.level === 'warn')
      ? 'warn'
      : hits.length ? 'context' : 'none'
  return { level, hits }
}

/**
 * 批量检查分镜数组，汇总合规问题。
 *
 * @param {object[]} shots 分镜（检查 dialogue / description / videoPrompt / imagePrompt）
 * @param {string} platform 投放平台
 * @returns {{ blocks: object[], warns: object[], contexts: object[], summary: object }}
 */
export function checkShotsCompliance(shots, platform) {
  const blocks = []
  const warns = []
  const contexts = []
  const arr = Array.isArray(shots) ? shots : []

  for (const shot of arr) {
    const no = String(shot?.shotNumber ?? shot?.shot ?? '?')
    const fields = ['dialogue', 'description', 'videoPrompt', 'imagePrompt', 'naturalLanguagePrompt', 'prompt']
    for (const f of fields) {
      const val = shot?.[f]
      if (typeof val !== 'string' || !val.trim()) continue
      const { level, hits } = checkCompliance(val, { platform, location: { shot: no, field: f } })
      if (level === 'block') blocks.push(...hits.filter((h) => h.level === 'block'))
      else if (level === 'warn') warns.push(...hits.filter((h) => h.level === 'warn'))
      else if (level === 'context') contexts.push(...hits.filter((h) => h.level === 'context'))
    }
  }

  return {
    blocks, warns, contexts,
    summary: {
      checked: arr.length,
      blocks: blocks.length,
      warns: warns.length,
      contexts: contexts.length,
      platform: String(platform ?? ''),
    },
  }
}
