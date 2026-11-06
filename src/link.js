/**
 * dsh-drama-trae —— 跨阶段关联图。
 *
 * 六个阶段各自写一份 JSON，模型生成时会互相读取，但产出**结构里没有互相指认**：
 * 观众/创作者逐个页签看，看到的是六份互不相干的内容。
 *
 * 本模块不生成内容，只做一件事：把六份资产的关联**算出来并显式呈现**——
 * 每个角色出现在哪几集、每条伏笔在哪集埋下/回收、每个场景被哪几集用到、
 * 风格 DNA 承接了哪条世界观设定。
 *
 * 纯读计算，不写盘，不改任何资产。
 *
 * @module src/link
 */

/** 从一段文本里找出包含哪些已知角色名。 */
function findMentioned(text, names) {
  const s = String(text ?? '')
  const hit = []
  for (const n of names) {
    if (n && s.includes(n)) hit.push(n)
  }
  return hit
}

/** 从一段文本里找出包含哪些已知场景/设定名。 */
function findPlaces(text, names) {
  const s = String(text ?? '')
  return names.filter((n) => n && s.includes(n))
}

/**
 * 构建跨阶段关联图。
 *
 * @param {object} bundle loadCreationBundle 的返回
 * @returns {object} 关联图：episodeMap / characterArcs / foreshadowChains / sceneUsage / styleLinks / orphans
 */
export function buildLinkGraph(bundle = {}) {
  const outline = Array.isArray(bundle.outline) ? bundle.outline : []
  const characters = Array.isArray(bundle.characters) ? bundle.characters : []
  const world = Array.isArray(bundle.world) ? bundle.world : []
  const memory = Array.isArray(bundle.memory) ? bundle.memory : []
  const style = bundle.style?.style ?? {}

  const charNames = characters.map((c) => String(c?.name ?? '').trim()).filter(Boolean)
  const placeNames = world
    .filter((w) => ['地点', '组织', '物品'].some((k) => String(w?.kind ?? '').includes(k)))
    .map((w) => String(w?.name ?? '').trim())
    .filter(Boolean)

  /* ---------- ① 每集登场：从大纲文本反查角色与场景 ---------- */
  const episodeMap = outline.map((e) => {
    const blob = [e?.title, e?.logline, e?.hook, e?.twist, e?.cliffhanger].map((x) => String(x ?? '')).join('\n')
    return {
      order: Number(e?.order) || 0,
      title: String(e?.title ?? ''),
      characters: findMentioned(blob, charNames),
      places: findPlaces(blob, placeNames),
      // 记忆里标记为该集的伏笔
      foreshadows: memory
        .filter((m) => String(m?.kind ?? '').includes('伏笔') && Number(m?.episode) === Number(e?.order))
        .map((m) => ({ id: String(m?.id ?? ''), content: String(m?.content ?? '') })),
    }
  })

  /* ---------- ② 角色出场弧线 ---------- */
  const characterArcs = characters.map((c) => {
    const name = String(c?.name ?? '').trim()
    const eps = episodeMap.filter((e) => e.characters.includes(name)).map((e) => e.order)
    // 记忆里关联到该角色的条目
    const memos = memory.filter((m) => {
      const blob = `${m?.content ?? ''}`
      return blob.includes(name) || (Array.isArray(m?.relatedCharacters) && m.relatedCharacters.includes(name))
    })
    // 同样合并两条证据：大纲文本反查 + 资产声明的 arcEpisodes
    const fromDecl = Array.isArray(c?.arcEpisodes)
      ? c.arcEpisodes.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : []
    const merged = [...new Set([...eps, ...fromDecl])].sort((a, b) => a - b)
    return {
      name,
      role: String(c?.role ?? ''),
      episodes: merged,
      episodeCount: merged.length,
      firstEpisode: merged.length ? Math.min(...merged) : null,
      lastEpisode: merged.length ? Math.max(...merged) : null,
      memoryRefs: memos.length,
      declaredArc: fromDecl.length ? fromDecl : null,
      evidence: eps.length && fromDecl.length ? 'both' : fromDecl.length ? 'declared' : eps.length ? 'text' : 'none',
    }
  })

  /* ---------- ③ 伏笔链：埋下 → 回收 ---------- */
  const foreshadowChains = memory
    .filter((m) => String(m?.kind ?? '').includes('伏笔'))
    .map((m) => {
      const planted = Number(m?.episode) || null
      const payoff = Number(m?.payoffEpisode) || null
      // 从 content 里兜底解析「第六集」「第九集」这类字样
      let inferredPayoff = payoff
      if (!inferredPayoff) {
        const cn = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10, 十一:11, 十二:12, 十三:13, 十四:14, 十五:15 }
        const text = String(m?.content ?? '')
        // 优先「第N集」，其次「N集后/N集揭晓」，再次「第N回」
        const m2 = text.match(/第([一二三四五六七八九十]+|\d+)集/)
          || text.match(/([一二三四五六七八九十]+|\d+)集(?:后|揭晓|揭|回收)/)
          || text.match(/第([一二三四五六七八九十]+|\d+)回/)
        if (m2) inferredPayoff = /\d/.test(m2[1]) ? Number(m2[1]) : (cn[m2[1]] ?? null)
      }
      return {
        id: String(m?.id ?? ''),
        content: String(m?.content ?? ''),
        plantedAt: planted,
        payoffAt: inferredPayoff,
        payoffDeclared: Boolean(m?.payoffEpisode),
        status: String(m?.status ?? ''),
        spanEpisodes: planted && inferredPayoff ? inferredPayoff - planted : null,
        characters: Array.isArray(m?.relatedCharacters)
          ? m.relatedCharacters.map(String)
          : findMentioned(String(m?.content ?? ''), charNames),
      }
    })
    .sort((a, b) => (a.plantedAt ?? 99) - (b.plantedAt ?? 99))

  /* ---------- ④ 场景使用情况 ---------- */
  // 两条证据合并：
  //   ① 大纲文本里直接提到该场景名（强证据）
  //   ② 资产自带的 usedInEpisodes 声明（AI 修复后产出的字段）
  // 早期只认 ①，导致模型明明声明「第1,2集用到城中村」，只要大纲文字没写这四个字
  // 就被判为「未使用」，缺口永远修不掉。
  const sceneUsage = world.map((w) => {
    const name = String(w?.name ?? '').trim()
    const fromText = episodeMap.filter((e) => e.places.includes(name)).map((e) => e.order)
    const fromDecl = Array.isArray(w?.usedInEpisodes)
      ? w.usedInEpisodes.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : []
    const eps = [...new Set([...fromText, ...fromDecl])].sort((a, b) => a - b)
    return {
      name,
      kind: String(w?.kind ?? ''),
      episodes: eps,
      episodeCount: eps.length,
      evidence: fromText.length && fromDecl.length ? 'both' : fromDecl.length ? 'declared' : fromText.length ? 'text' : 'none',
      declared: fromDecl,
      fromText,
    }
  }).sort((a, b) => b.episodeCount - a.episodeCount)

  /* ---------- ⑤ 风格 DNA 与世界观/契约的承接关系 ---------- */
  const contract = bundle.contract ?? {}
  const styleLinks = Object.entries(style)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([dim, text]) => {
      const t = String(text)
      // 该维描述里提到了哪些世界观条目
      const refs = world
        .filter((w) => String(w?.name ?? '').trim() && t.includes(String(w.name).trim()))
        .map((w) => String(w.name))
      // 是否提到了契约的空间层级
      const contractRefs = String(contract.worldSpace ?? '')
        .split(/[／/、，。；：与和及\s]+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 2 && x.length <= 8 && t.includes(x))
      return { dimension: dim, text: t, worldRefs: refs, contractRefs }
    })

  /* ---------- ⑥ 孤儿检测：哪些资产完全没有被引用 ---------- */
  const orphans = {
    characters: characterArcs.filter((c) => c.episodeCount === 0 && !c.declaredArc).map((c) => c.name),
    places: sceneUsage.filter((s) => s.episodeCount === 0).map((s) => s.name),
    foreshadowsWithoutPayoff: foreshadowChains.filter((f) => !f.payoffAt).map((f) => f.content.slice(0, 40)),
  }

  /* ---------- ⑦ 汇总指标 ---------- */
  const totals = {
    episodes: outline.length,
    characters: characters.length,
    places: sceneUsage.length,
    foreshadows: foreshadowChains.length,
    // 关联密度：平均每集登场角色数
    avgCharsPerEpisode: episodeMap.length
      ? Math.round(episodeMap.reduce((n, e) => n + e.characters.length, 0) / episodeMap.length * 10) / 10
      : 0,
    // 伏笔覆盖率：有回收点的占比
    foreshadowCoverage: foreshadowChains.length
      ? Math.round(foreshadowChains.filter((f) => f.payoffAt).length / foreshadowChains.length * 100)
      : 0,
  }

  return { episodeMap, characterArcs, foreshadowChains, sceneUsage, styleLinks, orphans, totals }
}
