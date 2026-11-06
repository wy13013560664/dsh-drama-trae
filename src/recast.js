/**
 * dsh-drama-trae —— 定妆图自动重定妆（recast）。
 *
 * 问题（实测 2026-11-06 山海经第001集，[F] 日志原文）：
 *   镜11「定妆图不可用，降级纯文生视频（定妆图产出账号 4157726724724988
 *   与当前账号 1870715324731015 不符，该账号不在可用池）」
 *   镜15 / 镜16 同样的 reason → 一整集的人物一致性全部丢失。
 *
 * 根因：TOS 图片 key 里嵌了产出账号的 uid，签名只能用该账号。
 * 定妆是 11 月 5 日出的（账号 4157726724724988），今天这个号配额空了，
 * 于是这张图**永久作废** —— 但角色形象并没有变，图也只是 prompt 的产物，
 * 换个还活着的账号重新出一张，形象依旧一致。
 *
 * 旧行为的代价：不只是「这镜没有首帧」，而是角色从此每镜重新想象一张脸。
 * 实测 5 个角色里 3 个的产出账号已失效（[F] .aidrama/casting/*.json 核对）。
 *
 * 本模块只在**确实需要**时才重出：
 *   · 账本显示该产出账号已冷却/失效
 *   · 或产出账号已不在当前账号池
 *   · 且没有别的活账号能签这张图（不可能，key 绑死账号）
 * 重出后会写回 casting 记录（新 uri + 新 uid），后续镜头继续复用。
 *
 * @module src/recast
 */

import { checkCastingUsable } from './casting.js'

/**
 * 判断一份定妆记录是否需要重出。
 *
 * @param {object} casting {name, uri, uid}
 * @param {object[]} accounts 当前可用账号（已过滤过期）
 * @param {object} ledger 账本 {accounts:{uid:{status,at,streak}}}
 * @param {object} opts
 * @param {(rec, now) => boolean} opts.isCooling 冷却判定
 * @param {number} [opts.now]
 * @returns {{needsRecast:boolean, reason:string, level:'ok'|'warn'|'error'}}
 */
export function needsRecast(casting, accounts = [], ledger = { accounts: {} }, { isCooling = () => false, now = Date.now() } = {}) {
  const name = String(casting?.name ?? '?')
  const uid = String(casting?.uid ?? '')
  const uri = String(casting?.uri ?? '').trim()

  if (!uri) {
    return { needsRecast: true, reason: `角色「${name}」没有定妆图`, level: 'error' }
  }

  // 静态约束（key 格式、key 内 uid 与记录 uid 一致）不满足 → 必须重出
  const usable = checkCastingUsable(casting, accounts)
  if (!usable.ok && usable.fix === 'recast') {
    return { needsRecast: true, reason: usable.reason, level: 'error' }
  }

  // 产出账号已不在账号池（被删号 / 换设备）
  if (uid && !accounts.some((a) => String(a?.uid) === uid)) {
    return {
      needsRecast: true,
      reason: `定妆图产出账号 ${uid} 不在当前账号池，key 无法签名（invalid userid）`,
      level: 'warn',
    }
  }

  // 产出账号在池里但账本说它坏了/额度空了 → 出片时同样签不了
  const rec = (ledger?.accounts || {})[uid]
  if (rec && isCooling(rec, now)) {
    return {
      needsRecast: true,
      reason: `定妆图产出账号 ${uid} 当前不可用（${rec.status}），该图只能由它签名`,
      level: 'warn',
    }
  }

  return { needsRecast: false, reason: usable.reason || '可用', level: usable.level || 'ok' }
}

/**
 * 给一批定妆记录做「重出计划」：只挑真的需要重出的，并说明为什么。
 *
 * @returns {{recast:object[], keep:object[], skipped:object[]}}
 *   recast  = 需要重出（连同记录一起返回，调用方直接拿去出图）
 *   keep    = 可继续复用
 *   skipped = 角色卡缺失无法重出
 */
export function planRecast(castings = [], accounts = [], ledger = { accounts: {} }, { isCooling = () => false, now = Date.now() } = {}) {
  const recast = []
  const keep = []
  for (const c of castings) {
    const v = needsRecast(c, accounts, ledger, { isCooling, now })
    if (v.needsRecast) recast.push({ ...c, recastReason: v.reason, recastLevel: v.level })
    else keep.push(c)
  }
  return { recast, keep }
}
