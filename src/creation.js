/**
 * dsh-drama-trae —— AI 短剧创作流程集成（读取 + 可编辑写入）。
 *
 * 目的：把 ai-drama 工作区的**完整创作链路**收进本插件，让用户不用在两个插件间来回切换：
 *   立项契约 → 分集大纲 → 人物设定 → 世界观 → 本剧记忆 → 分集剧本 → 分镜 → 出片
 *
 * 数据契约（与 dsh-plugin-ai-drama 完全对齐，实测结构 2026-11-05）：
 *   .aidrama/contract.json   对象  { title, platform, audience, episodeDurationSec:[min,max], ... }
 *   .aidrama/outline.json    数组  [{ order, title, logline, hook, twist, cliffhanger, estDurationSec }]
 *   .aidrama/characters.json 数组  [{ id, name, role, personality[], bio, appearancePrompt, voiceHint }]
 *   .aidrama/world.json      数组  [{ id, kind, name, detail }]
 *   .aidrama/memory.json     数组  [{ id, kind, content, episode, status, createdAt }]
 *   .aidrama/style.json      对象  { schemaVersion, style:{palette,lighting,texture,composition,motion} }
 *   分集剧本/第NNN集.md              Markdown 正文
 *   分镜/第NNN集.分镜.md              Markdown 表格（由 JSON 渲染）
 *
 * 写入安全（对齐 ai-drama 的原子写思路）：
 *   - 所有写入走「临时文件 → rename」原子替换
 *   - 覆盖前把旧版本备份到 .aidrama/history/<文件名>.<时间戳>.bak（保留最近 10 份）
 *   - 非法路径 / 项目外路径 / 符号链接逃逸一律拒绝
 *
 * @module src/creation
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/** 可编辑的创作资产。 */
export const ASSET_KINDS = Object.freeze({
  contract: { file: 'contract.json', type: 'object', label: '剧集契约' },
  outline: { file: 'outline.json', type: 'array', label: '分集大纲' },
  characters: { file: 'characters.json', type: 'array', label: '人物设定' },
  world: { file: 'world.json', type: 'array', label: '世界观' },
  memory: { file: 'memory.json', type: 'array', label: '本剧记忆' },
  style: { file: 'style.json', type: 'object', label: '视觉风格 DNA' },
})

/** 备份保留份数。 */
const HISTORY_KEEP = 10

/* ---------------------------------------------------------------- 读取 */

/** 读取 .aidrama 下的 JSON，缺失返回 null。 */
async function readJson(projectDir, relPath) {
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir, '.aidrama', relPath), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 把资产统一成数组。
 *
 * dsh-plugin-ai-drama 官方格式是**数组**（saveOutline 硬校验 Array.isArray），
 * 但历史项目/手写文件可能是 `{ episodes: [...] }` 这类对象包装。两种都收，
 * 避免同一份数据在界面上显示成空。
 *
 * @param {any} value
 * @param {string[]} keys 对象包装时依次尝试的承载键
 * @returns {any[]}
 */
function asArray(value, keys) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    for (const k of keys) {
      if (Array.isArray(value[k])) return value[k]
    }
  }
  return []
}

/**
 * 一次读取全部创作资产，供「创作」页签展示。
 * @param {string} projectDir 项目根
 * @returns {Promise<object>}
 */
export async function loadCreationBundle(projectDir) {
  const [contract, outlineRaw, charactersRaw, worldRaw, memoryRaw, style] = await Promise.all([
    readJson(projectDir, 'contract.json'),
    readJson(projectDir, 'outline.json'),
    readJson(projectDir, 'characters.json'),
    readJson(projectDir, 'world.json'),
    readJson(projectDir, 'memory.json'),
    readJson(projectDir, 'style.json'),
  ])
  const outline = asArray(outlineRaw, ['episodes', 'rows', 'outline'])
  const characters = asArray(charactersRaw, ['characters', 'cards', 'rows'])
  const world = asArray(worldRaw, ['entries', 'items', 'rows'])
  const memory = asArray(memoryRaw, ['entries', 'items', 'rows', 'foreshadow'])

  // 分集剧本与分镜文件清单
  const scripts = await listMarkdown(projectDir, '分集剧本')
  const storyboards = await listStoryboardFiles(projectDir)

  // 进度：以「有契约 → 有大纲 → 有角色 → 有剧本 → 有分镜 → 已出片」判定
  const generated = await listVideos(projectDir)
  const steps = {
    contract: Boolean(contract?.title),
    outline: Array.isArray(outline) && outline.length > 0,
    characters: Array.isArray(characters) && characters.length > 0,
    world: Array.isArray(world) && world.length > 0,
    script: scripts.length > 0,
    storyboard: storyboards.length > 0,
    generated: generated.length > 0,
  }
  const done = Object.values(steps).filter(Boolean).length
  const total = Object.keys(steps).length

  return {
    contract,
    outline,
    characters,
    world,
    memory,
    style,
    scripts,
    storyboards,
    generatedCount: generated.length,
    progress: { steps, done, total, pct: Math.round(done / total * 100) },
  }
}

/** 列出目录下的 md 文件（只返回文件名）。 */
/**
 * 列出 `.aidrama/storyboard/` 里的分镜文件。
 *
 * 分镜的真实位置是 `.aidrama/storyboard/<集>.json`（出片 collectShots 也读这里），
 * 而不是 `分镜/` 目录 —— 早期 listMarkdown 只扫 `分镜/`（那个目录放的是导出的
 * Markdown），导致生成成功但界面永远「看不到分镜」。
 */
/** 分镜集号的安全校验：允许「第001集」这类名字，禁止路径穿越与控制字符。 */
function assertSafeStoryboardEpisode(name) {
  const s = String(name ?? '').trim()
  if (!s) throw new Error('集文件名不能为空')
  if (/[\/\\]/.test(s)) throw new Error(`集文件名不能含路径分隔符：${s}`)
  if (/\.\./.test(s)) throw new Error(`集文件名不能含 ..：${s}`)
  if (/[\x00-\x1f]/.test(s)) throw new Error('集文件名含控制字符')
  if (s.length > 80) throw new Error('集文件名过长')
  return s
}

async function listStoryboardFiles(projectDir) {
  try {
    const dir = path.join(projectDir, '.aidrama', 'storyboard')
    const files = await fs.readdir(dir)
    return files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort()
  } catch {
    return []
  }
}

async function listMarkdown(projectDir, sub) {
  try {
    const files = await fs.readdir(path.join(projectDir, sub))
    return files.filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort()
  } catch {
    return []
  }
}

/** 列出已生成视频数量。 */
async function listVideos(projectDir) {
  try {
    const files = await fs.readdir(path.join(projectDir, '素材', '生成'))
    return files.filter((f) => /\.(mp4|mov)$/i.test(f))
  } catch {
    return []
  }
}

/* ---------------------------------------------------------------- 读取正文 */

/**
 * 读取某集剧本正文。
 * @param {string} projectDir
 * @param {string} episode 集文件名（含 .md），如 "第001集.md"
 */
export async function readScript(projectDir, episode) {
  const safe = assertSafeEpisode(episode)
  try {
    return await fs.readFile(path.join(projectDir, '分集剧本', safe), 'utf8')
  } catch {
    return null
  }
}

/**
 * 读取某集分镜 Markdown 表格。
 * @param {string} projectDir
 * @param {string} episode 分镜文件名（含 .md），如 "第001集.分镜.md"
 */
/**
 * 读某一集的分镜，渲染成可读的 Markdown 表格。
 *
 * 优先读 `.aidrama/storyboard/<集>.json`（生成产物），
 * 若该集没有 JSON 再回退到 `分镜/` 里可能存在的 .md 导出。
 *
 * @param {string} projectDir
 * @param {string} episode 形如 `第001集` 或 `第001集.md.json` 或 `第001集.md`
 * @returns {Promise<string|null>}
 */
export async function readStoryboardMd(projectDir, episode) {
  const raw = String(episode ?? '').trim()
  if (!raw) return null
  // 归一化成「第NNN集」前缀（分镜文件名是 <集>.md.json，不适合用剧本的 .md 校验）
  // 兼容老命名：`第001集.分镜.md` / `第001集.分镜.md.json`
  const base = raw
    .replace(/\.md\.json$/, '')
    .replace(/\.分镜\.md\.json$/, '')
    .replace(/\.分镜\.md$/, '')
    .replace(/\.json$/, '')
    .replace(/\.md$/, '')
    .replace(/\.分镜$/, '')
  const safe = assertSafeStoryboardEpisode(base)
  // 真实命名是 `<集>.md.json`（与 ai-drama / collectShots 一致），
  // 但也兼容手写的 `<集>.json`
  const candidates = [
    path.join(projectDir, '.aidrama', 'storyboard', `${safe}.md.json`),
    path.join(projectDir, '.aidrama', 'storyboard', `${safe}.json`),
  ]

  let shots = null
  for (const jsonPath of candidates) {
    try {
      const txt = await fs.readFile(jsonPath, 'utf8')
      const parsed = JSON.parse(txt)
      if (Array.isArray(parsed)) { shots = parsed; break }
    } catch { /* 试下一个 */ }
  }

  if (Array.isArray(shots) && shots.length) {
    return storyboardToMarkdown(safe, shots)
  }

  // 回退：分镜/ 目录下的老文件（`.分镜.md` 是 ai-drama 早期导出命名）
  for (const name of [`${safe}.md`, `${safe}.分镜.md`, safe]) {
    try {
      return await fs.readFile(path.join(projectDir, '分镜', name), 'utf8')
    } catch { /* 继续 */ }
  }
  return null
}

/** 把镜头数组渲染成 Markdown 表格，方便人读。 */
export function storyboardToMarkdown(episode, shots) {
  const rows = shots.map((sh) => {
    const dur = Number(sh?.durationSec) || 0
    const cells = [
      String(sh?.shotNumber ?? ''),
      String(sh?.shotSize ?? ''),
      String(sh?.cameraMove ?? ''),
      String(sh?.description ?? '').replace(/\|/g, '\\|'),
      String(sh?.dialogue ?? '').replace(/\|/g, '\\|'),
      String(sh?.sfx ?? ''),
      `${dur}s`,
    ]
    return `| ${cells.join(' | ')} |`
  })
  const total = shots.reduce((n, sh) => n + (Number(sh?.durationSec) || 0), 0)
  return [
    `# ${episode} 分镜表`,
    '',
    `共 **${shots.length}** 镜，合计 **${total} 秒**。`,
    '',
    '| 镜号 | 景别 | 运镜 | 画面 | 台词 | 音效 | 时长 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## 生图/生视频提示词',
    '',
    ...shots.map((sh) => [
      `### 镜 ${sh?.shotNumber ?? ''}`,
      `- 生图：${sh?.imagePrompt || '（空）'}`,
      `- 生视频：${sh?.videoPrompt || '（空）'}`,
      `- 场景：${sh?.sceneRef || '（空）'}`,
    ].join('\n')),
    '',
  ].join('\n')
}

/* ---------------------------------------------------------------- 写入 */

/**
 * 保存一个创作资产（原子写 + 备份）。
 *
 * @param {string} projectDir
 * @param {keyof ASSET_KINDS} kind
 * @param {object|object[]} data
 * @returns {Promise<{kind: string, file: string, bytes: number, backup: string|null}>}
 */
export async function saveAsset(projectDir, kind, data) {
  const meta = ASSET_KINDS[kind]
  if (!meta) throw new Error(`未知的创作资产类型：${kind}`)

  // 形状校验：避免把对象写成数组（会导致 ai-drama 读取失败）
  if (meta.type === 'array' && !Array.isArray(data)) {
    throw new Error(`${meta.label} 必须是数组`)
  }
  if (meta.type === 'object' && (Array.isArray(data) || typeof data !== 'object' || data === null)) {
    throw new Error(`${meta.label} 必须是对象`)
  }

  const target = path.join(projectDir, '.aidrama', meta.file)
  assertInside(projectDir, target)

  // 备份旧版本
  const backup = await backupFile(projectDir, target)

  // 原子写：临时文件 → rename
  const tmp = `${target}.tmp-${Date.now()}`
  await fs.mkdir(path.dirname(target), { recursive: true })
  const body = JSON.stringify(data, null, 2) + '\n'
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, target)

  return { kind, file: meta.file, bytes: Buffer.byteLength(body), backup }
}

/**
 * 合并写入：把新条目按 id（无 id 时按 name/value）并进已有数组。
 *
 * 修缺口的正确语义是「补/改」，不是「替换整份」：
 * ～memory 原有 16 条，模型只回 3 条被修改的伏笔，直接覆盖会把其余 13 条抹掉。
 * 匹配规则：
 *   - 有 id 且已有同 id → 用新条目**覆盖**该条（保留其它字段）
 *   - 有 id 但无同 id → 追加
 *   - 无 id 时用 name（角色/地点）或 content 前 40 字（记忆）做键
 *
 * @param {string} projectDir
 * @param {string} kind
 * @param {any[]} incoming 模型返回的条目
 * @param {object} [opts]
 * @param {'merge'|'replace'} [opts.mode] 默认 merge
 * @returns {Promise<{kind, merged, added, updated, total, backup}>}
 */
export async function mergeAsset(projectDir, kind, incoming, opts = {}) {
  const meta = ASSET_KINDS[kind]
  if (!meta) throw new Error(`未知的创作资产类型：${kind}`)
  if (meta.type !== 'array') {
    // 对象类资产没有「合并」语义，退化为普通保存
    const r = await saveAsset(projectDir, kind, incoming)
    return { ...r, mode: 'replace-object', merged: 0, added: 0, updated: 0, total: 0 }
  }
  if (!Array.isArray(incoming)) throw new Error(`${meta.label} 必须是数组`)

  const current = await readJson(projectDir, meta.file)
  const base = Array.isArray(current) ? current.slice() : []

  // 唯一键：id → name → 内容前 40 字
  const keyOf = (it) => {
    if (!it || typeof it !== 'object') return null
    if (typeof it.id === 'string' && it.id.trim()) return `id:${it.id.trim()}`
    if (typeof it.name === 'string' && it.name.trim()) return `name:${it.name.trim()}`
    if (typeof it.content === 'string' && it.content.trim()) return `content:${it.content.trim().slice(0, 40)}`
    if (typeof it.title === 'string' && it.title.trim()) return `title:${it.title.trim()}`
    return null
  }

  const index = new Map()
  base.forEach((it, i) => { const k = keyOf(it); if (k) index.set(k, i) })

  let added = 0, updated = 0
  const result = base.slice()
  for (const it of incoming) {
    if (!it || typeof it !== 'object') continue
    const k = keyOf(it)
    if (k && index.has(k)) {
      const i = index.get(k)
      result[i] = { ...result[i], ...it }   // 字段级合并，保留未提供的原字段
      updated++
    } else {
      result.push(it)
      if (k) index.set(k, result.length - 1)
      added++
    }
  }

  const r = await saveAsset(projectDir, kind, result)
  return { ...r, mode: 'merge', merged: added + updated, added, updated, total: result.length }
}

/**
 * 保存某集剧本正文（原子写 + 备份）。
 * @param {string} projectDir
 * @param {string} episode 如 "第001集.md"
 * @param {string} content Markdown 正文
 */
export async function saveScript(projectDir, episode, content) {
  const safe = assertSafeEpisode(episode)
  const target = path.join(projectDir, '分集剧本', safe)
  assertInside(projectDir, target)
  const backup = await backupFile(projectDir, target)
  const tmp = `${target}.tmp-${Date.now()}`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(tmp, String(content ?? ''), 'utf8')
  await fs.rename(tmp, target)
  return { episode: safe, bytes: Buffer.byteLength(String(content ?? '')), backup }
}

/* ---------------------------------------------------------------- 内部工具 */

/** 集文件名安全校验（禁路径分隔与上级目录）。 */
function assertSafeEpisode(name) {
  const s = String(name ?? '').trim()
  if (!s) throw new Error('集文件名不能为空')
  if (s.includes('/') || s.includes('\\') || s.includes('..')) {
    throw new Error(`非法集文件名：${s}`)
  }
  if (!s.endsWith('.md')) throw new Error(`集文件名必须以 .md 结尾：${s}`)
  return s
}

/** 断言目标路径位于项目目录内（防 `..` 与绝对路径逃逸）。 */
function assertInside(projectDir, target) {
  const rel = path.relative(path.resolve(projectDir), path.resolve(target))
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('目标路径越出项目目录，已拒绝写入')
  }
}

/** 备份待覆盖文件到 .aidrama/history/，返回备份相对路径或 null。 */
async function backupFile(projectDir, target) {
  const exists = await fs.stat(target).catch(() => null)
  if (!exists) return null
  const histDir = path.join(projectDir, '.aidrama', 'history')
  await fs.mkdir(histDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `${path.basename(target)}.${stamp}.bak`
  const dest = path.join(histDir, name)
  await fs.copyFile(target, dest)

  // 只保留最近 HISTORY_KEEP 份同类备份
  try {
    const same = (await fs.readdir(histDir))
      .filter((f) => f.startsWith(`${path.basename(target)}.`) && f.endsWith('.bak'))
      .sort()
    while (same.length > HISTORY_KEEP) {
      const oldest = same.shift()
      await fs.unlink(path.join(histDir, oldest)).catch(() => {})
    }
  } catch { /* 清理失败不影响主流程 */ }

  return path.relative(projectDir, dest)
}
