/**
 * dsh-drama-trae —— 新建短剧项目。
 *
 * 与 dsh-plugin-ai-drama 的目录结构**完全对齐**（PROJECT_DIRS 13 个子目录 +
 * .aidrama 元数据目录），保证新建的项目能被 ai-drama 直接打开、被本插件出片。
 *
 * 安全约束（对齐 ai-drama 的写路径校验思路）：
 *   - 剧名长度 1–40，禁路径分隔符 / 控制字符 / 保留名 / 前后空格与点
 *   - 目标目录必须位于已发现的项目根之下，禁止 `..` 与符号链接逃逸
 *   - 已存在则拒绝（不覆盖任何已有项目）
 *
 * 不做的事：不写剧本内容、不写分镜。只创建**空骨架**，内容由 ai-drama 的技能填充。
 * 这样职责边界清晰：本插件负责「出片」，不侵入「创作」。
 *
 * @module src/project
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/** 与 ai-drama PROJECT_DIRS 完全一致（顺序也一致，便于对照）。 */
export const PROJECT_DIRS = [
  '构想',
  '总纲',
  '人物',
  '世界观',
  '分集剧本',
  '分镜',
  '台词与音效',
  '素材',
  '草稿区',
  '定稿',
  '账本',
  '本剧记忆',
  '导出',
]

/** .aidrama 下的元数据子目录。 */
const META_SUBDIRS = ['assets', 'audit', 'history', 'scenes', 'storyboard', 'trae-output']

/** 剧名禁用字符（Windows/macOS 非法字符 + 路径分隔符 + 控制字符）。 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

/** 保留名（避免与系统/约定目录冲突）。 */
const RESERVED_NAMES = new Set(['.', '..', '共享资料', '.aidrama', 'node_modules'])

/**
 * 校验剧名，返回规范化后的名字或抛出错误。
 * @param {unknown} raw
 * @returns {string}
 */
export function validateProjectTitle(raw) {
  const title = String(raw ?? '').trim()
  if (!title) throw new Error('剧名不能为空')
  if (title.length > 40) throw new Error(`剧名过长（${title.length} > 40 字）`)
  if (ILLEGAL_CHARS.test(title)) throw new Error('剧名不能包含 \\ / : * ? " < > | 或控制字符')
  if (RESERVED_NAMES.has(title)) throw new Error(`「${title}」是保留名，请换一个`)
  if (/^[.．]/u.test(title)) throw new Error('剧名不能以点开头')
  if (/[.．]$/u.test(title)) throw new Error('剧名不能以点结尾（部分系统会截断）')
  return title
}

/**
 * 在指定项目根下新建短剧项目骨架。
 *
 * @param {object} opts
 * @param {string} opts.dramaRoot 项目根（形如 <某个目录>/AI短剧）
 * @param {string} opts.title     剧名
 * @param {object} [opts.contract] 初始契约字段（可空，仅写入有限白名单字段）
 * @returns {Promise<{title: string, dir: string, dirs: string[]}>}
 */
export async function createProject({ dramaRoot, title, contract } = {}) {
  if (!dramaRoot) throw new Error('缺少 dramaRoot（项目根目录）')
  const safeTitle = validateProjectTitle(title)

  // 定位到 AI短剧 层
  const rootResolved = path.resolve(dramaRoot)
  const aiRoot = path.basename(rootResolved) === 'AI短剧'
    ? rootResolved
    : path.join(rootResolved, 'AI短剧')

  // 防符号链接逃逸：真实路径必须与解析路径一致（父目录存在时）
  const parentReal = await fs.realpath(aiRoot).catch(() => null)
  if (parentReal !== null) {
    const aiNorm = path.relative(parentReal, aiRoot)
    if (aiNorm !== '' && !aiNorm.startsWith('..')) {
      throw new Error('项目根目录是符号链接，已拒绝写入')
    }
  }

  const dir = path.join(aiRoot, safeTitle)
  // 已存在则拒绝（不覆盖）
  const existed = await fs.stat(dir).catch(() => null)
  if (existed) throw new Error(`短剧《${safeTitle}》已存在`)

  // 创建 13 个内容子目录
  await fs.mkdir(dir, { recursive: true })
  for (const sub of PROJECT_DIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true })
  }
  // 素材子目录（生成产物落这里，与 ai-drama 真实结构一致）
  await fs.mkdir(path.join(dir, '素材', '生成'), { recursive: true })
  await fs.mkdir(path.join(dir, '素材', '参考图'), { recursive: true })

  // 创建 .aidrama 元数据目录
  const meta = path.join(dir, '.aidrama')
  await fs.mkdir(meta, { recursive: true })
  for (const sub of META_SUBDIRS) {
    await fs.mkdir(path.join(meta, sub), { recursive: true })
  }

  // 写最小可用的元数据文件（不覆盖任何已有内容；只填空骨架）
  const now = new Date().toISOString()
  const c = contract && typeof contract === 'object' ? contract : {}

  await writeJsonIfAbsent(path.join(meta, 'contract.json'), {
    schemaVersion: 1,
    title: safeTitle,
    createdAt: now,
    ...(typeof c.platform === 'string' && c.platform ? { platform: c.platform } : {}),
    ...(Number.isFinite(Number(c.episodeDurationSec)) ? { episodeDurationSec: Number(c.episodeDurationSec) } : {}),
    ...(typeof c.orientation === 'string' && c.orientation ? { orientation: c.orientation } : {}),
  })
  // 骨架形状必须与 dsh-plugin-ai-drama 的 save* 签名一致：
  //   saveOutline / saveCharacters / saveMemory 都硬校验 Array.isArray，
  //   写成 { episodes: [] } 这类对象会让官方读取与写入直接抛错。
  await writeJsonIfAbsent(path.join(meta, 'characters.json'), [])
  await writeJsonIfAbsent(path.join(meta, 'outline.json'), [])
  await writeJsonIfAbsent(path.join(meta, 'world.json'), [])
  await writeJsonIfAbsent(path.join(meta, 'memory.json'), [])
  await writeJsonIfAbsent(path.join(meta, 'style.json'), {
    schemaVersion: 1,
    state: 'draft',
    style: { palette: '', lighting: '', texture: '', composition: '', motion: '' },
  })
  await writeJsonIfAbsent(path.join(meta, 'scenes', 'cards.json'), { schemaVersion: 1, scenes: [] })
  await writeJsonIfAbsent(path.join(meta, 'assets', 'cards.json'), { schemaVersion: 1, assets: [] })
  await writeJsonIfAbsent(path.join(meta, 'assets.json'), { schemaVersion: 1, assets: [] })

  return { title: safeTitle, dir, dirs: [...PROJECT_DIRS] }
}

/**
 * 只在该文件不存在时写入（不覆盖任何已有数据）。
 * @param {string} file
 * @param {object} data
 */
async function writeJsonIfAbsent(file, data) {
  const exists = await fs.stat(file).catch(() => null)
  if (exists) return
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}
