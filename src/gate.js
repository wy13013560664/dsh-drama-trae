/**
 * dsh-drama-trae —— 出片前一致性门禁（gate）。
 *
 * 目的：解决「结构性缺口」——drama-trae 此前对 ai-drama 的角色卡/场景卡/风格
 * DNA 全部零引用，导致一致性风险无法在出片环节被拦住，只能靠上游自觉。
 *
 * 设计原则（与 ai-drama「判据默认 WARN 不阻断」保持兼容）：
 *   - 门禁分三级：FAIL（阻断）/ WARN（放行但记录）/ INFO（仅记录）
 *   - 只有明确的**结构性错误**升级为 FAIL；风格/节拍类主观判据保持 WARN
 *   - 任一条 FAIL 命中 → 默认阻断出片（可用 --no-gate 或 allowFail 放开）
 *   - 缺失资源（无 characters.json / style.json）→ 记 WARN 而非 FAIL，
 *     保证旧项目（无这些文件）不被误伤
 *
 * 检查项编号与可行性对照见 REPORT-pipeline-upgrade.md §九。
 * 本模块为**纯函数**，不做 I/O——由调用方预加载资源后传入。
 *
 * @module src/gate
 */

/** 检查结果严重级。 */
export const SEVERITY = Object.freeze({ FAIL: 'fail', WARN: 'warn', INFO: 'info' })

function issue(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra }
}

/**
 * 出片前一致性门禁。
 *
 * @param {object} ctx
 * @param {object[]} ctx.shots          本次计划出片的分镜（已过滤只出指定镜）
 * @param {object}   [ctx.charIndex]    indexCharacters() 结果
 * @param {object}   [ctx.styleDoc]     style.json 解析结果
 * @param {object[]} [ctx.sceneCards]   scenes/cards.json 的 cards 数组
 * @param {object[]} [ctx.assetCards]   assets/cards.json 的 cards 数组
 * @param {number}   [ctx.maxDuration]  单镜时长上限（默认 15）
 * @param {boolean}  [ctx.requireScene] 是否要求 sceneId 存在（默认 false）
 * @returns {{ ok: boolean, fails: object[], warns: object[], infos: object[], summary: object }}
 */
export function runGate(ctx = {}) {
  const {
    shots = [],
    charIndex = null,
    styleDoc = null,
    sceneCards = null,
    assetCards = null,
    maxDuration = 15,
    requireScene = false,
    minLightWords = 0,
  } = ctx

  const fails = []
  const warns = []
  const infos = []

  const charMap = charIndex?.map ?? new Map()
  const hasChars = charMap.size > 0
  const sceneIds = new Set(
    Array.isArray(sceneCards)
      ? sceneCards.map((c) => String(c?.id ?? c?.sceneId ?? '').trim()).filter(Boolean)
      : [],
  )
  const assetIds = new Set(
    Array.isArray(assetCards)
      ? assetCards.map((c) => String(c?.id ?? '').trim()).filter(Boolean)
      : [],
  )

  // ---- RES-01/02/03：资源存在性（缺失记 WARN，旧项目零误伤）
  if (!hasChars) warns.push(issue(SEVERITY.WARN, 'RES-01', '无 characters.json 或人物卡为空，本次不注入角色锚点'))
  const styleMeta = normalizeStyleLite(styleDoc)
  if (!styleMeta.filled) {
    warns.push(issue(SEVERITY.WARN, 'RES-02', '无 style.json 或五维风格 DNA 全空，本次不注入视觉风格'))
  } else if (styleMeta.state !== 'directed' && styleMeta.state !== 'frozen' && styleMeta.filled < 3) {
    // v0.5：≥3 维有内容视为实质可用（很多项目不写 state 字段），此时不再告警
    warns.push(issue(SEVERITY.WARN, 'RES-03',
      `风格 DNA 仅 ${styleMeta.filled} 维有内容且状态为 ${styleMeta.state}，本次不注入`))
  }

  // ---- 逐镜检查
  const seenShotNo = new Map()
  for (const shot of shots) {
    const no = String(shot?.shotNumber ?? shot?.shot ?? '?').trim()

    // CHK-05 缺必填可拍字段（FAIL：连 prompt 都构建不出）
    const hasAnyText = ['description', '画面', 'videoPrompt', 'imagePrompt', 'prompt', '提示词',
      'naturalLanguagePrompt'].some((k) => typeof shot?.[k] === 'string' && shot[k].trim())
    if (!hasAnyText) {
      fails.push(issue(SEVERITY.FAIL, 'CHK-05', `镜 ${no}：无任何画面描述或提示词，无法构建 prompt`, { shot: no }))
    }

    // CHK-06 镜号重复（FAIL：产物会被覆盖）
    if (no && no !== '?') {
      const n = seenShotNo.get(no) ?? 0
      seenShotNo.set(no, n + 1)
      if (n === 1) fails.push(issue(SEVERITY.FAIL, 'CHK-06', `镜号 ${no} 重复，产物文件名冲突将被覆盖`, { shot: no }))
    }

    // CHK-07 时长越界（FAIL：模型会拒绝）
    const dur = Number(shot?.durationSec)
    if (Number.isFinite(dur) && dur > 0 && dur > maxDuration) {
      fails.push(issue(SEVERITY.FAIL, 'CHK-07', `镜 ${no}：durationSec=${dur} 超过上限 ${maxDuration}s`, { shot: no }))
    }
    if (Number.isFinite(dur) && dur > 0 && dur < 2) {
      warns.push(issue(SEVERITY.WARN, 'CHK-08', `镜 ${no}：durationSec=${dur} 低于下限 2s`, { shot: no }))
    }

    // CHK-01 角色卡存在性（FAIL：声明了角色却查不到 → 锚点必然缺失）
    const declared = Array.isArray(shot?.characters)
      ? shot.characters
      : shot?.characters === undefined ? [] : [shot.characters]
    if (declared.length && hasChars) {
      for (const name of declared) {
        const key = normalizeKey(name)
        if (!key) continue
        const hit = charMap.has(key) || [...charMap.keys()].some((k) => key.includes(k))
        if (!hit) {
          fails.push(issue(SEVERITY.FAIL, 'CHK-01',
            `镜 ${no}：角色「${name}」在 characters.json 中不存在`, { shot: no, character: String(name) }))
        }
      }
    } else if (declared.length && !hasChars) {
      warns.push(issue(SEVERITY.WARN, 'CHK-01',
        `镜 ${no}：声明了角色但项目无人物卡，无法校验`, { shot: no }))
    }

    // CHK-02 场景卡存在性（默认 WARN，requireScene=true 时 FAIL）
    const sceneId = String(shot?.sceneId ?? '').trim()
    if (sceneId && Array.isArray(sceneCards)) {
      if (!sceneIds.has(sceneId)) {
        const sev = requireScene ? SEVERITY.FAIL : SEVERITY.WARN
        ;(sev === SEVERITY.FAIL ? fails : warns).push(issue(sev, 'CHK-02',
          `镜 ${no}：sceneId「${sceneId}」在 scenes/cards.json 中不存在`, { shot: no, sceneId }))
      }
    } else if (sceneId && !Array.isArray(sceneCards)) {
      warns.push(issue(SEVERITY.WARN, 'CHK-02', `镜 ${no}：有 sceneId 但项目无场景卡，无法校验`, { shot: no }))
    }

    // CHK-09 资产引用存在性（WARN）
    const assetRefs = Array.isArray(shot?.assets) ? shot.assets : []
    if (assetRefs.length && Array.isArray(assetCards)) {
      for (const id of assetRefs) {
        if (!assetIds.has(String(id).trim())) {
          warns.push(issue(SEVERITY.WARN, 'CHK-09',
            `镜 ${no}：资产「${id}」在 assets/cards.json 中不存在`, { shot: no, assetId: String(id) }))
        }
      }
    }

    // PD-04 每镜光影（WARN，minLightWords>0 才检查）
    if (minLightWords > 0) {
      const light = String(shot?.light ?? '').trim()
      if (light && light.length < minLightWords) {
        warns.push(issue(SEVERITY.WARN, 'PD-04',
          `镜 ${no}：光影描述仅 ${light.length} 字（建议 ≥${minLightWords}）`, { shot: no }))
      }
    }

    // PD-08 一镜一事（WARN，动作事件词计数）
    const actions = countActions(shot?.description)
    if (actions > 2) {
      warns.push(issue(SEVERITY.WARN, 'PD-08',
        `镜 ${no}：画面描述含 ${actions} 个动作事件（建议 ≤2，一镜一事）`, { shot: no }))
    }
  }

  // ---- CHK-03 风格可用性（INFO）
  if (styleMeta.filled && (styleMeta.state === 'directed' || styleMeta.state === 'frozen' || styleMeta.filled >= 3)) {
    infos.push(issue(SEVERITY.INFO, 'CHK-03',
      `视觉风格 DNA 已就绪（${styleMeta.filled} 维，状态 ${styleMeta.state}），将注入 prompt`))
  }

  // ---- 锚点覆盖率（INFO，用于可观测性）
  if (hasChars && charIndex?.anchorCount > 0) {
    infos.push(issue(SEVERITY.INFO, 'CHK-04',
      `人物卡 ${charMap.size} 张，其中 ${charIndex.anchorCount} 张有形象锚点`))
  }

  const summary = {
    checked: shots.length,
    fails: fails.length,
    warns: warns.length,
    infos: infos.length,
    blocked: fails.length > 0,
  }
  return { ok: fails.length === 0, fails, warns, infos, summary }
}

/* ---------------------------------------------------------------- 内部工具 */

/** 宽松归一角色名（与本模块外部 characters.js 保持同策略，避免循环依赖故内联）。 */
function normalizeKey(s) {
  return String(s ?? '')
    .replace(/[\s\u3000·・.、,，。:：;；!！?？"'“”‘’()（）[\]【】-]/g, '')
    .toLowerCase()
}

/** 动作事件词表（与 ai-drama thresholds.json eventVerbs 同源，取常用子集）。 */
const EVENT_VERBS = [
  '走', '跑', '站起', '坐下', '转身', '转头', '抬手', '点头', '摇头',
  '推', '拉', '抓', '扔', '捡', '跳', '笑', '哭', '喊', '说', '问', '答',
  '看', '盯', '低头', '抬头',
]

/** 统计描述里的动作事件数（去重，避免同词重复计数）。 */
function countActions(text) {
  const s = String(text ?? '')
  if (!s) return 0
  const hit = new Set()
  for (const v of EVENT_VERBS) if (s.includes(v)) hit.add(v)
  return hit.size
}

/** 轻量读取 style 元信息（不引 src/style.js，避免该模块被门禁强耦合）。 */
function normalizeStyleLite(doc) {
  const dims = ['palette', 'lighting', 'texture', 'composition', 'motion']
  const raw = doc && typeof doc === 'object' && doc.style && typeof doc.style === 'object' ? doc.style : (doc ?? {})
  let filled = 0
  for (const d of dims) if (String(raw?.[d] ?? '').trim()) filled += 1
  const state = String(doc?.state ?? doc?.styleState ?? 'draft').trim() || 'draft'
  return { filled, state }
}
