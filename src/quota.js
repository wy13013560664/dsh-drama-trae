/**
 * dsh-drama-trae —— 账号配额状态记录（quota ledger）。
 *
 * 目的：让「出片」在开始前就知道还能不能跑，而不是跑几秒才发现配额空了。
 *
 * 为什么不做主动探测：
 *   · `check_estimated_balance` 的参数格式试不出来（各种组合都返回 4001 invalid param）；
 *   · 发最小请求探测会**真的消耗配额**（480p/2s 也算一次生成）；
 *   · 33 个账号逐个探测要 1 分钟以上。
 * 所以改成**从结果学习**：每次出片/定妆的真实结果（成功 / 4008 配额耗尽）都记账，
 * 下次预检直接用记账结果。零成本、零延迟、只增不探测。
 *
 * 记账位置：`.aidrama/quota-ledger.json`
 *   { "accounts": { "<uid>": { "status": "ok"|"quota"|"unknown", "at": ISO, "note": "" } } }
 */

import fs from 'node:fs/promises'
import path from 'node:path'

// 错误判定的唯一事实来源在 src/errors.js —— 这里只做「账本视角」的转译，
// 不再自己维护一套正则。两套正则会互相矛盾（实测：errors 判可重试、
// quota 判账号死，同一帧得出两种结论）。
import { MIN_DURATION, MAX_DURATION } from './constants.js'
import {
  classifyError, isStillCooling as stillCooling, cooldownFor,
  QUOTA_COOLDOWN_MS as Q_MS, BROKEN_COOLDOWN_MS as B_MS, AUTH_COOLDOWN_MS as A_MS,
} from './errors.js'

export const LEDGER_FILE = path.join('.aidrama', 'quota-ledger.json')

/** 配额耗尽的判定（服务端把 4008 包在 3003 外层里）。 */
export function isQuotaExhausted(errMessage) {
  return classifyError(errMessage).kind === 'quota'
}

/**
 * 「这个账号本身有问题、换一个就好」的判定（含配额与账号异常）。
 *
 * 结论来自 dsh-trae-video/src/rotate.js 的实测记录：
 *   · 4008 = 该账号当日额度已空
 *   · 4040 = 该账号对该模型异常（message 为空），换号即可出片
 * 两者都属于**账号级**，都不该让镜头直接失败。
 */
export function isAccountLevelFailure(errMessage) {
  // 账号级 = 换号有用（4008 额度空 / 4040/4030 账号异常 / 1001 鉴权被拒）。
  // 4010 access denied 与 2001 lock busy 是平台侧，换号无效，不算账号级。
  const c = classifyError(errMessage)
  return c.scope === 'account' && c.markAccount
}

/** 账号级故障的冷却时长（唯一定义在 errors.js，这里只做转发以免双源漂移）。 */
export const QUOTA_COOLDOWN_MS = Q_MS
export const BROKEN_COOLDOWN_MS = B_MS
export const AUTH_COOLDOWN_MS = A_MS

export function classifyAccountFailure(errMessage) {
  const c = classifyError(errMessage)
  if (!c.markAccount) return { fault: false, kind: 'none', cooldownMs: 0 }
  const cooldownMs = cooldownFor(c.kind)
  // kind 对外保持既有三值（quota / broken / auth）：账本与前端都按这三个值判断，
  // 内部更细的分类不泄漏到持久化格式。
  const kind = c.kind === 'account-broken' ? 'broken' : c.kind
  return { fault: true, kind, cooldownMs }
}

/**
 * 「换账号可能好」的错误判定。
 *
 * 实测遇到的三类：
 *   · 4008 exceeded the quota   —— 该账号额度用完（换号有效）
 *   · 4040 (message 为空)        —— 服务端生成层拒绝（换号可能有效，也可能是内容审核）
 *   · 429 / rate limit          —— 频率限制（等或换号）
 *
 * 注意：`callArkVideoGeneration` 这类是**更深一层的内部错误**，
 * 消息里常带 3003 外层码 —— 只看外层码会把所有错误都当成同一类，必须看内层。
 */
export function isRetriableGenerationError(errMessage) {
  // 「换号是否有用」：账号级故障 + 限流。参数/内容/绑图被拒、网络故障都不在此列
  //（网络故障由 errors.js 归类为 global，走退避重试而非换号）。
  const c = classifyError(errMessage)
  return c.markAccount || c.kind === 'rate-limit'
}

/**
 * 把服务端的原始错误翻译成人能看懂的说明。
 *
 * 服务端返回是嵌套的：`3003` 外层 + `4008/4040` 内层，
 * message 里还嵌 JSON —— 直接透给用户等于什么都没说。
 */
export function explainTraeVError(errMessage) {
  const msg = String(errMessage ?? '')
  const c = classifyError(msg)

  // 先按分类讲「该怎么办」，再落到具体码上 —— 用户要的是动作，不是码表。
  if (c.kind === 'quota') return '账号配额已用尽。免费额度按账号计，请换账号或等周期重置。'
  if (c.kind === 'account-broken') {
    return '服务端生成层拒绝（code 4040/4030，未给具体原因）。常见原因：内容审核未过、模型繁忙、或该账号被限。已自动换账号重试。'
  }
  if (c.kind === 'auth') {
    return '该账号在第 2 层接口被鉴权拒绝（code 1001）。token 本身仍有效（/ping 正常），多为此账号被限或会话失效；已自动换账号。'
  }
  if (c.kind === 'access-denied') {
    return '平台侧接入拒绝（code 4010：access denied）。这不是账号问题，是整个接入通道被临时限流；已自动退避重试。若连续多次仍失败，通常是并发过高，把并发降到 2~4 再试。'
  }
  if (c.kind === 'lock-busy') {
    return '账号用量预留锁被占（code 2001：usage reservation lock is busy）。同一账号并发提交会撞锁，已退避重试；把并发降到账号数以下可基本消除。'
  }
  if (c.kind === 'rate-limit') {
    return '请求过于频繁（限流）。降低并发或降低单镜时长后重试。'
  }
  if (/InvalidParameter/i.test(msg)) {
    const dur = msg.match(/duration[^"]*received: \\?"?([0-9.]+)/i)
    if (dur) {
      return `服务端拒绝该时长参数（duration=${dur[1]}）。模型只接受 ${MIN_DURATION}~${MAX_DURATION} 秒，已按区间自动调整；若仍报错请检查分镜时长字段。`
    }
    return '参数被服务端拒绝（InvalidParameter）。检查画幅/分辨率/时长是否在模型支持范围（时长 4~15 秒）。'
  }
  if (/invalid userid/i.test(msg)) {
    return '参考图 key 与当前账号不匹配（invalid userid）。定妆图/末帧只能用产出它的账号出片。'
  }
  if (/4001|param is invalid/i.test(msg)) {
    return '参数不合法（code 4001）。检查画幅/分辨率/时长是否在模型支持范围内。'
  }
  if (/callArkVideoGeneration/i.test(msg)) {
    return '视频生成服务内部报错（callArkVideoGeneration）。多为方舟侧瞬时故障或账号被限，稍后重试或换账号。'
  }
  return msg.slice(0, 300) || '未知错误（服务端未返回详情）'
}

/** 读账本。 */
export async function readLedger(projectDir) {
  try {
    const txt = await fs.readFile(path.join(projectDir, LEDGER_FILE), 'utf8')
    const doc = JSON.parse(txt)
    if (doc && typeof doc === 'object' && doc.accounts) return doc
  } catch { /* 无账本或坏文件 */ }
  return { accounts: {} }
}

/** 写账本（原子写）。 */
export async function writeLedger(projectDir, doc) {
  const target = path.join(projectDir, LEDGER_FILE)
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${target}.tmp-${Date.now()}`
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, target)
  return target
}

/**
 * 记一笔账号结果。
 *
 * @param {string} projectDir
 * @param {string} uid
 * @param {'ok'|'quota'} status
 * @param {string} [note]
 */
export async function recordAccount(projectDir, uid, status, note = '') {
  if (!uid) return null
  const doc = await readLedger(projectDir)
  doc.accounts[String(uid)] = { status, at: new Date().toISOString(), note: String(note).slice(0, 200) }
  await writeLedger(projectDir, doc)
  return doc
}

/**
 * 连续故障计数：同一账号连续撞同一类故障时累加，成功/状态变化即清零。
 * @param {object|undefined} prev 账本里的旧记录
 * @param {string} status 本次状态
 */
export function nextStreak(prev, status) {
  const failKinds = ['quota', 'broken', 'auth']
  if (!failKinds.includes(status)) return 0            // ok / pending 视为恢复
  if (!prev || !failKinds.includes(prev.status)) return 1  // 上一轮不是故障 → 第一次
  const prevStreak = Number(prev.streak) || 1
  // quota 与 broken 互换视为同类（都是「这个号现在用不了」），继续累加
  return prevStreak + 1
}

/** 批量记账（出片一轮结束后一次性写，避免频繁 IO）。 */
export async function recordAccounts(projectDir, entries = []) {
  if (!entries.length) return null
  const doc = await readLedger(projectDir)
  for (const e of entries) {
    if (!e?.uid) continue
    const prev = doc.accounts[String(e.uid)]
    doc.accounts[String(e.uid)] = {
      // ok=确认可出片 · pending=进过队列但未产出真片 · quota=额度耗尽 · broken=账号异常
      // auth 也要能记账：1001 鉴权被拒不落账，下次又会挑中这个号白撞一轮
      status: ['ok', 'pending', 'broken', 'quota', 'auth'].includes(e.status) ? e.status : 'quota',
      at: new Date().toISOString(),
      note: String(e.note ?? '').slice(0, 200),
      // 递进冷却的依据：同一个号连续撞同一个码就翻倍冷却。
      // 只在「新状态与旧状态同类且是故障类」时累加，成功即清零。
      streak: nextStreak(prev, e.status),
    }
  }
  await writeLedger(projectDir, doc)
  return doc
}

/**
 * 预估：给定账号列表 + 账本，算出「还有几个账号可用、够不够跑 N 镜」。
 *
 * 只按账本判断，未记录的账号视为 unknown（乐观可用，因为第一次跑才知道）。
 *
 * @param {object[]} accounts 可用账号（已过滤过期）
 * @param {object} doc 账本
 * @param {number} shotsNeeded 待跑镜数
 * @returns {{usable:number, quotaDead:number, unknown:number, enough:boolean, detail:object[]}}
 */
export function estimateQuota(accounts = [], doc = { accounts: {} }, shotsNeeded = 0, now = Date.now()) {
  // 注意：TRAE 是**积分制**，不是按次的免费配额。
  // 一个账号的免费积分用完后不会自动恢复（除非充值/周期重置），
  // 所以「每账号 4 镜」只是保守估计，真实上限取决于剩余积分。
  const led = doc?.accounts || {}
  let usable = 0, quotaDead = 0, unknown = 0, pending = 0, expired = 0
  const detail = []
  for (const a of accounts) {
    const uid = String(a?.uid ?? '')
    const rec = led[uid]
    let state = 'unknown'
    if (rec?.status === 'ok') { state = 'ok'; usable++ }
    else if (rec?.status === 'quota' || rec?.status === 'broken' || rec?.status === 'auth') {
      // 冷却过期就自动解封：quota/broken 是「某时刻的观测」，不是永久判决。
      // 实测：账本里 20 个账号被 11 小时前的 warmup 记录封死，实际早就该重试了。
      if (stillCooling(rec, now)) { state = rec.status; quotaDead++ }
      else { state = 'expired'; expired++; usable++ }
    }
    else if (rec?.status === 'pending') {
      // 进过队列但未验证能不能真出片：算半可用（乐观但仅供参考）
      state = 'pending'; pending++
    }
    else { unknown++; usable++ }   // 没记录过 → 乐观算可用
    detail.push({ uid, state, at: rec?.at ?? null, note: rec?.note ?? '', streak: rec?.streak ?? 0 })
  }
  // 免费额度实测：一个账号能连续跑约 4 镜（之后报 4008）
  const capacity = usable * 4
  return {
    usable, quotaDead, unknown, pending, expired,
    capacity,
    enough: capacity >= shotsNeeded,
    shotsNeeded,
    detail,
  }
}
