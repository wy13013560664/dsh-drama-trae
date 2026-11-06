/**
 * dsh-drama-trae —— 角色定妆（character casting / look-dev）。
 *
 * 目的：同一角色在 24 个镜头里保持同一张脸。
 *
 * 问题：纯文本 prompt 描述角色长相（「22岁瘦高男性，旧疤，灰夹克」）时，
 * 模型每镜都会重新"想象"一张脸，跨镜一定漂移。这就是串脸的根因。
 *
 * 做法：
 *   ① 每个角色用**文生图**出一张正面定妆照（三视图更佳，但先做单张胸像）
 *   ② 定妆图上传到 TOS，拿到可复用的 key
 *   ③ 出片时把该镜涉及角色的定妆图作为 i2v 的 image_paths 传入
 *   ④ 出片后把结果存成 `<角色>.casting.json`，下次直接复用不重复花钱
 *
 * 关键约束（实测得出）：
 * - 定妆图必须**单人、正面、无遮挡、纯色背景**，否则模型会把人脸和背景混在一起；
 * - prompt 里不能写角色姓名（会被画成文字）；
 * - image_paths 的 key 绑定产出账号，换账号会报 invalid userid —— 所以记录 uid 一起存。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { generateImage } from './image.js'
import { uploadLocalFile } from './upload.js'

/** 定妆图存放目录（相对项目根）。 */
export const CASTING_DIR = path.join('.aidrama', 'casting')

/** 人形角色的定妆后缀：单人正面、纯色背景、可复用于 i2v。 */
const CASTING_STYLE = '单人正面胸像，纯色浅灰背景，柔和顺光，无遮挡，居中对齐，写实摄影质感，竖屏 9:16'

/**
 * 非人形角色（异兽/器物/灵体）的定妆后缀。
 *
 * 强制「单人正面胸像」会把「上古异兽，三丈赤鳞蛇躯」画成一个人 —— 这是错的。
 * 非人形要的是**完整形态入画**：全身/整体，不能裁头。
 */
const CASTING_STYLE_BEAST = '主体完整入画，全身形态，正面视角，纯色浅灰背景，柔和顺光，无遮挡，居中，写实质感，竖屏 9:16'

/**
 * 判断角色是否非人形（异兽 / 器物 / 灵体）。
 *
 * **只看外观字段**（appearancePrompt），不看 bio。
 * 反例：主角 bio 写「从受欺摊主走向半妖」——那是剧情弧线，不是定妆时的长相；
 * 若把 bio 计入，主角会被当成异兽画成兽形，这是错的。
 *
 * 判定用两类线索：
 *   ① 明确物种/形态名（异兽/妖兽/蛇躯/兽躯…）
 *   ② 具体身体结构 + 体型量词（三丈赤鳞蛇躯、双首独角…）
 */
export function isNonHuman(character) {
  const look = String(character?.appearancePrompt ?? '')
  const name = String(character?.name ?? '')
  const text = `${look} ${name}`

  // 明确物种/形态（不含「半妖」这类剧情词）
  const SPECIES = /异兽|妖兽|灵兽|巨兽|魔兽|蛇躯|龙躯|兽躯|妖物|精怪|器灵|鬼魂|灵体|不死族/
  // 具体结构 + 体型量词（「眼底血丝」「市井野气」不算）
  const STRUCTURE = /[一二三四五六七八九十百千万\d]+[丈尺米][^，。]{0,8}(鳞|爪|尾|翼|角|獠牙)|双首|多头|多臂|獠牙|利爪|鳞甲/
  // 体型异常且带结构词
  const HUGE = /[三四五六七八九十]+丈|数丈|丈高|巨型/

  if (SPECIES.test(text)) return true
  if (STRUCTURE.test(text)) return true
  return HUGE.test(text) && /鳞|爪|尾|角/.test(text)
}

/** 判断「该角色定妆图是否已过期」（形象描述变了）。 */
export function isCastingStale(casting, character) {
  if (!casting?.prompt) return false
  const look = String(character?.appearancePrompt ?? '').trim()
  if (!look) return false
  // 定妆记录里存的是「生成时的 prompt」，从它反推生成时的形象描述
  const recorded = String(casting.prompt)
  // 生成时的形态片段 = prompt 去掉后缀
  const suffix = isNonHuman(character) ? CASTING_STYLE_BEAST : CASTING_STYLE
  const recordedLook = recorded.replace(new RegExp(`。*${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '').trim()
  if (!recordedLook) return false
  return recordedLook !== look
}

/**
 * 为一个角色生成定妆照。
 *
 * @param {object} opts
 * @param {object} opts.credential TRAE 凭据
 * @param {object} opts.character 角色卡（需 name + appearancePrompt）
 * @param {string} [opts.projectDir] 项目根，给了就把结果落盘缓存
 * @param {string} [opts.uid] 产出账号标识（key 绑定账号，必须一起存）
 * @param {Function} [opts.onProgress]
 * @returns {Promise<{name, uri, prompt, uid, cached}>}
 */
export async function castCharacter({
  credential, characters: _ignore, character, projectDir, uid, onProgress = () => {}, force = false,
  credentials = null,
}) {
  const name = String(character?.name ?? '').trim()
  if (!name) throw new Error('定妆需要角色姓名')
  const look = String(character?.appearancePrompt ?? '').trim()
  if (!look) throw new Error(`角色「${name}」缺少 appearancePrompt，无法定妆`)

  // ① 命中缓存就直接复用（定妆图很贵，一角色只该出一次）
  if (projectDir && !force) {
    const hit = await readCasting(projectDir, name)
    if (hit?.uri) {
      onProgress('casting-cached', { name, uri: hit.uri })
      return { ...hit, cached: true }
    }
  }

  // ② 组装定妆 prompt：形象描述 + 通用摄影约束；姓名一律不入 prompt
  const prompt = buildCastingPrompt(look, character)
  onProgress('casting-start', { name })

  // 配额耗尽要自动换号：账号池里多数账号的 t2i 配额是空的，
  // 不换号就会「定妆永远是 0」。
  const pool = Array.isArray(credentials) && credentials.length ? credentials : (credential ? [credential] : [])
  if (!pool.length) throw new Error('定妆需要至少一个 TRAE 账号')

  let uri = null
  let usedUid = uid ?? null
  const tried = []
  for (const cred of pool) {
    const thisUid = cred?.uid ?? null
    if (tried.some(t => t.uid === thisUid)) continue
    tried.push({ uid: thisUid })
    try {
      const r = await generateImage(cred, { prompt })
      uri = r.uri
      usedUid = thisUid
      break
    } catch (e) {
      const outOfQuota = /4008|exceeded the quota|quota/i.test(e.message)
      onProgress('casting-account-fail', {
        name, uid: thisUid, reason: outOfQuota ? 'quota' : e.message.slice(0, 80),
      })
      if (!outOfQuota) throw e   // 非配额问题（网络/鉴权）不换号，直接报
      // 配额耗尽 → 试下一个账号
    }
  }
  if (!uri) {
    throw new Error(
      `角色「${name}」定妆失败：已尝试 ${tried.length} 个账号，全部配额耗尽。` +
      `请补充新的 TRAE 账号，或等配额重置。`
    )
  }

  const record = { name, uri, prompt, uid: usedUid, at: new Date().toISOString() }

  // ③ 落盘缓存
  if (projectDir) await writeCasting(projectDir, name, record)

  onProgress('casting-done', { name, uri })
  return { ...record, cached: false }
}

/**
 * 组装定妆 prompt：把角色形象描述转成「单人正面照」的拍摄指令。
 *
 * 只取形象里「可拍摄」的部分（年龄/体型/发型/服装/气质），
 * 去掉「眼神倔强」这类需要剧情才有意义的描述，避免定妆照表情过于戏剧化。
 */
export function buildCastingPrompt(appearancePrompt, character) {
  let look = String(appearancePrompt ?? '').trim()
  const name = String(character?.name ?? '').trim()

  // 去掉姓名（任何位置），模型会把中文名画成文字
  if (name) look = look.split(name).join('')
  // 去掉「姓名：」这类前缀
  look = look.replace(/^[^：:]{1,6}[：:]\s*/, '')
  // 去掉过于戏剧化的情绪词（定妆照要中性表情）
  look = look
    .replace(/(眼神|眼中|眼底)[^，。]{0,12}(倔强|凶狠|阴冷|死寂|带倦|带怯)[^，。]{0,4}/g, '')
    .replace(/，{2,}/g, '，')
    .replace(/^[，。]+/, '')
    .trim()

  if (!look) look = '成年人，日常服装'
  // 先判形态，决定用哪套摄影约束（人形 vs 异兽全身）
  const beast = isNonHuman(character)
  look = look
    .replace(/。{2,}/g, '。')
    .replace(/，\s*。$/, '')      // 「，。」结尾 → 去掉逗号句号
    .replace(/，\s*。\s*/g, '，') // 中间「，。」→ 只留逗号
    .replace(/。$/, '')           // 尾部句号，下面统一补
    .replace(/，$/, '')           // 尾部逗号
  return `${look}。${beast ? CASTING_STYLE_BEAST : CASTING_STYLE}`
}

/** 读角色定妆记录。 */
export async function readCasting(projectDir, name) {
  const safe = safeName(name)
  try {
    const txt = await fs.readFile(path.join(projectDir, CASTING_DIR, `${safe}.json`), 'utf8')
    return JSON.parse(txt)
  } catch {
    return null
  }
}

/** 写角色定妆记录（原子写）。 */
export async function writeCasting(projectDir, name, record) {
  const safe = safeName(name)
  const dir = path.join(projectDir, CASTING_DIR)
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, `${safe}.json`)
  const tmp = `${target}.tmp-${Date.now()}`
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, target)
  return target
}

/** 列出项目里已定妆的角色。 */
export async function listCastings(projectDir) {
  try {
    const dir = path.join(projectDir, CASTING_DIR)
    const files = await fs.readdir(dir)
    const out = []
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue
      try {
        const rec = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))
        if (rec?.name) out.push(rec)
      } catch { /* 坏文件跳过 */ }
    }
    return out
  } catch {
    return []
  }
}

/** 批量定妆：逐个出图，单个失败不阻断，最后统一报告。 */
export async function castAll({
  credential, credentials = null, characters = [], projectDir, uid, onProgress = () => {}, force = false,
}) {
  const done = []
  const failed = []
  for (const c of characters) {
    try {
      const r = await castCharacter({ credential, credentials, character: c, projectDir, uid, onProgress, force })
      done.push(r)
    } catch (e) {
      failed.push({ name: String(c?.name ?? '?'), error: e.message })
      onProgress('casting-error', { name: c?.name, error: e.message })
    }
  }
  return { done, failed, ok: failed.length === 0 }
}

/**
 * 把某一镜涉及角色的定妆图 key 组装成 image_paths。
 *
 * 返回**主角色的一张**：TRAE 的 i2v 一次只认一个首帧（多图会互相冲突）。
 * 多人镜取「本镜第一个出现的角色」，其余角色靠 prompt 描述。
 * 若该角色还没有定妆图，返回 null，调用方回退到纯文生视频。
 */
/** 同 pickCastingEntry 的判定规则，只返回 key（兼容老调用点）。 */
export function pickCastingKey(shot, castings = [], names = []) {
  return pickCastingEntry(shot, castings, names)?.uri ?? null
}

/**
 * 选出本镜该用哪张定妆图，**返回完整记录**（含 uid）。
 *
 * 为什么必须返回 uid：定妆图的 TOS key 绑定产出账号，
 * 出片时用别的账号会报 `failed to sign image url: invalid userid`。
 * 所以选图的同时必须拿到产出账号，出片端才能锁号。
 *
 * 判定顺序：
 *   ① 按角色名在 description/dialogue/videoPrompt 里**出现的先后**取第一个；
 *   ② 没有具体姓名但有「人影/男子/女子/他/她」这类泛称 → 取第一个角色；
 *   ③ 纯空镜（如「泛黄纸页特写」）→ 返回 null，不注入人脸。
 */
export function pickCastingEntry(shot, castings = [], names = []) {
  const text = `${shot?.description ?? ''}${shot?.dialogue ?? ''}${shot?.videoPrompt ?? ''}`
  const byName = new Map(castings.filter(c => c?.uri).map(c => [String(c.name), c]))
  // 按在文本里出现的先后顺序排，先出现的是本镜主体
  const candidates = [...byName.keys()]
    .map(n => ({ n, at: text.indexOf(n) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at)
  if (candidates.length) return byName.get(candidates[0].n) ?? null

  // 文本里没有姓名时的兜底要保守：
  //   · 纯空镜（画面/提示词里没有任何人物线索）→ 不注入定妆图，
  //     否则「泛黄纸页特写」会被强行灌进一张人脸，画出来是错的。
  //   · 有「人影/身影/男子/女子」这类泛称但没有具体姓名 → 用第一个角色。
  const TAIL = 'desc'
  const hasFigure = /人影|身影|男子|女子|少年|少女|老者|壮汉|姑娘|他|她/.test(text)
  if (hasFigure && Array.isArray(names) && names.length) {
    for (const n of names) if (byName.has(String(n))) return byName.get(String(n))
  }
  return null
}

/** 文件名安全化：去掉路径分隔符与控制字符。 */
function safeName(name) {
  const s = String(name ?? '').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
  if (!s) throw new Error('角色名不能为空')
  return s.slice(0, 60)
}


/**
 * 检查定妆图能否用于出片。
 *
 * 实测三条硬约束（不满足就直接失败）：
 *   ① 图必须是 TOS key 格式 `gen_image/<ts>_<hex>_jpeg_...`
 *   ② **key 绑定产出账号**：换账号会报 `failed to sign image url: invalid userid`
 *   ③ 该账号必须还有 i2v 配额（4008 = exceeded the quota）
 *
 * 本函数只做「静态可判定」的检查（①和②），配额靠调用方在出片时发现。
 *
 * @param {object} casting 定妆记录 {name, uri, uid}
 * @param {object[]} accounts 可用账号列表
 * @returns {{ok:boolean, level:'ok'|'warn'|'error', reason:string, fix?:string}}
 */
export function checkCastingUsable(casting, accounts = []) {
  const name = String(casting?.name ?? '?')
  const uri = String(casting?.uri ?? '').trim()

  if (!uri) {
    return { ok: false, level: 'error', reason: '定妆记录没有图片 key，需要重出', fix: 'recast' }
  }

  // ① key 格式
  if (!/^tos-cn-i-\w+\/cn\/\d+\/gen_image\//.test(uri)) {
    return {
      ok: false, level: 'error',
      reason: `图片 key 格式异常（应为 tos-cn-i-*/cn/<uid>/gen_image/…）：${uri.slice(0, 40)}`,
      fix: 'recast',
    }
  }

  // key 里嵌了产出账号 uid，和记录里的 uid 必须一致
  const uidInKey = (uri.match(/^tos-cn-i-\w+\/cn\/(\d+)\/gen_image\//) || [])[1]
  if (casting?.uid && uidInKey && String(casting.uid) !== String(uidInKey)) {
    return {
      ok: false, level: 'error',
      reason: `记录 uid(${casting.uid}) 与图片 key 里的账号(${uidInKey}) 不一致，出片时会报 invalid userid`,
      fix: 'recast',
    }
  }

  // ② 产出账号是否还在账号池里
  const uid = String(casting?.uid ?? uidInKey ?? '')
  const has = accounts.some(a => String(a?.uid) === uid)
  if (!uid) {
    return { ok: false, level: 'warn', reason: '记录没写产出账号，无法保证出片时能签名', fix: 'recast' }
  }
  if (!has) {
    return {
      ok: false, level: 'warn',
      reason: `产出账号 ${uid} 不在当前账号池，出片时会报 invalid userid`,
      fix: 'recast-or-add-account',
    }
  }

  return { ok: true, level: 'ok', reason: `可出片（产出账号 ${uid} 在用）` }
}

/** 批量检查。 */
export function checkAllCastingUsable(castings = [], accounts = []) {
  return castings.map(c => ({ name: String(c?.name ?? '?'), ...checkCastingUsable(c, accounts) }))
}
