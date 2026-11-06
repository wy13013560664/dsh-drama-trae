/**
 * dsh-drama-trae —— 角色锚点加载与注入。
 *
 * 目的：解决「人物设定漂移」——出片阶段此前完全不读 ai-drama 的人物卡，
 * prompt 里没有任何跨镜一致的形象约束，导致同一角色在不同镜头长得不一样。
 *
 * 数据来源（实测结构，读 dsh-plugin-ai-drama 的 drama_save_characters schema）：
 *   .aidrama/characters.json → { characters: [
 *       { name, role, personality[], bio, appearancePrompt, voiceHint }
 *   ]}
 * 锚点字段是 `appearancePrompt`（「形象提示词，用于生图一致性」）。
 *
 * 匹配策略（分镜 → 角色卡）：
 *   1. 分镜显式 `characters[]`（字符串数组，元素为角色 name 或包含 name 的短语）
 *   2. 分镜 `subject` 字段里出现角色名
 *   3. 分镜 `description` / `dialogue` 中出现角色名（仅在开启正文兜底时）
 *   一次都匹配不上 → 不注入（保持原有行为），不阻断出片。
 *
 * @module src/characters
 */

/**
 * 归一化角色名用于宽松比较：去空白、去常见标点、小写。
 * @param {string} s
 * @returns {string}
 */
export function normalizeName(s) {
  return String(s ?? '')
    .replace(/[\s\u3000·・.、,，。:：;；!！?？"'“”‘’()（）[\]【】-]/g, '')
    .toLowerCase()
}

/**
 * 把人物卡数组索引成 Map<归一化名, 卡>。
 * @param {object} doc .aidrama/characters.json 解析结果
 * @returns {{ map: Map<string, object>, list: object[], anchorCount: number }}
 */
export function indexCharacters(doc) {
  const arr = Array.isArray(doc?.characters) ? doc.characters : Array.isArray(doc) ? doc : []
  const map = new Map()
  let anchorCount = 0
  for (const card of arr) {
    if (!card || typeof card !== 'object') continue
    const name = String(card.name ?? '').trim()
    if (!name) continue
    if (String(card.appearancePrompt ?? '').trim()) anchorCount += 1
    const key = normalizeName(name)
    if (!map.has(key)) map.set(key, card)
  }
  return { map, list: arr, anchorCount }
}

/**
 * 从分镜推断本镜涉及的角色卡。
 *
 * @param {object} shot 分镜行
 * @param {ReturnType<typeof indexCharacters>} index 角色索引
 * @param {{ scanText?: boolean }} [opts] scanText: 是否允许从 description/dialogue 兜底匹配
 * @returns {{ cards: object[], via: 'characters'|'subject'|'text'|null }}
 */
export function resolveShotCharacters(shot, index, opts = {}) {
  const { scanText = false } = opts
  if (!index?.map?.size) return { cards: [], via: null }

  const find = (raw) => {
    const key = normalizeName(raw)
    if (!key) return null
    if (index.map.has(key)) return index.map.get(key)
    // 宽松：raw 是短语时，看是否包含某个已知角色名
    for (const [k, card] of index.map) {
      if (k && key.includes(k)) return card
    }
    return null
  }

  // 1) 显式 characters[]
  const explicit = Array.isArray(shot?.characters)
    ? shot.characters
    : shot?.characters === undefined
      ? []
      : [shot.characters]
  if (explicit.length) {
    const cards = []
    for (const raw of explicit) {
      const card = find(raw)
      if (card && !cards.includes(card)) cards.push(card)
    }
    if (cards.length) return { cards, via: 'characters' }
  }

  // 2) subject 字段
  const subject = String(shot?.subject ?? '').trim()
  if (subject) {
    const cards = []
    for (const [k, card] of index.map) {
      if (k && normalizeName(subject).includes(k) && !cards.includes(card)) cards.push(card)
    }
    if (cards.length) return { cards, via: 'subject' }
  }

  // 3) 正文兜底（默认关，避免误匹配）
  if (scanText) {
    const text = `${shot?.description ?? ''} ${shot?.dialogue ?? ''}`
    const norm = normalizeName(text)
    const cards = []
    for (const [k, card] of index.map) {
      if (k && norm.includes(k) && !cards.includes(card)) cards.push(card)
    }
    if (cards.length) return { cards, via: 'text' }
  }

  return { cards: [], via: null }
}

/**
 * 把角色卡的 appearancePrompt 渲染成一段锚点前缀。
 * 输出形如： `[角色锚点] 林夏：齐肩黑发，左眉有疤，藏青护士服`
 *
 * @param {object[]} cards 角色卡数组
 * @returns {string} 空串表示无需注入
 */
export function renderAnchor(cards) {
  if (!Array.isArray(cards) || !cards.length) return ''
  const parts = []
  for (const card of cards) {
    const name = String(card?.name ?? '').trim()
    const ap = String(card?.appearancePrompt ?? '').trim()
    if (!ap) continue
    parts.push(name ? `${name}：${ap}` : ap)
  }
  if (!parts.length) return ''
  return `[角色锚点] ${parts.join('；')}`
}
