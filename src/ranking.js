/**
 * dsh-drama-trae —— 账号选号优先级（按账本证据强度排序）。
 *
 * 为什么需要：账号不是等效的。实测（2026-11-06，山海经第001集）：
 *   · 同一个号连续两次真出片成功（480p 5s / 720p 5s）→ 确定可用
 *   · 同一个号探针拿到 heartbeat（记 pending），3 分钟后真实出片
 *     5 个不同 prompt 全在 0.3 秒内 4040 → heartbeat 根本不能证明可用
 *   · 账本里 15 个 pending、2 个 ok、16 个 quota
 * 旧选号只按数组下标轮转，pending 和 ok 被同等对待，于是把时间全花在
 * 「试一个必然秒拒的号」上。按证据强度排序后，同样的账号池能先出片。
 *
 * 排序（强 → 弱）：
 *   ok      真出过片（唯一确定可用的证据）
 *   unknown 从没跑过（乐观，但至少没有反面证据）
 *   expired 冷却已过的故障记录（值得再试一次）
 *   pending 只拿到过 heartbeat 却从没真出片（最可能秒拒，垫底但仍会试）
 *
 * @module src/ranking
 */

/** 证据强度分值（越小越优先）。cooling 权重最高：正常流程里已被剔除，出现说明调用方漏了兜底。 */
export const EVIDENCE_WEIGHT = {
  ok: 0,
  unknown: 1,
  expired: 2,
  pending: 3,
  cooling: 4,
}

/**
 * 把账号数组按「先确定可用、再没跑过、再冷却过期、最后只有 heartbeat」重排。
 *
 * 稳定性要求：同权重内保持原顺序（调用方依赖下标做轮转偏移），
 * 所以用带原下标的稳定排序，不用裸 sort。
 *
 * @param {object[]} accounts
 * @param {object} ledger { accounts: { uid: { status, at, streak } }
 * @param {object} opts
 * @param {(rec) => boolean} opts.isCooling 冷却判定（已在外部注入，避免重复实现）
 * @param {number} [opts.now]
 * @returns {object[]} 新数组（不改原数组）
 */
export function rankAccounts(accounts = [], ledger = { accounts: {} }, { isCooling = () => false, now = Date.now() } = {}) {
  const led = ledger?.accounts || {}
  return accounts
    .map((a, i) => {
      const uid = String(a?.uid ?? '')
      const rec = led[uid]
      let state
      if (rec?.status === 'ok') state = 'ok'
      else if (!rec) state = 'unknown'
      else if (rec.status === 'pending') state = 'pending'
      else if (isCooling(rec, now)) state = 'cooling'      // 调用方应已剔除；留作兜底
      else state = 'expired'
      const weight = EVIDENCE_WEIGHT[state] ?? 9
      return { account: a, weight, i, state }
    })
    .sort((x, y) => (x.weight - y.weight) || (x.i - y.i))
    .map((x) => x.account)
}

/**
 * 分组统计，供进度事件与前端提示用。
 *
 * @param {object[]} accounts 已排序（或未排序）账号
 * @param {object} ledger
 * @param {{isCooling?:Function, now?:number}} [opts]
 */
export function summarizeAccounts(accounts = [], ledger = { accounts: {} }, opts = {}) {
  const ranked = rankAccounts(accounts, ledger, opts)
  const led = ledger?.accounts || {}
  const counts = { ok: 0, unknown: 0, pending: 0, expired: 0, cooling: 0 }
  for (const a of ranked) {
    const rec = led[String(a?.uid ?? '')]
    if (rec?.status === 'ok') counts.ok += 1
    else if (!rec) counts.unknown += 1
    else if (rec.status === 'pending') counts.pending += 1
    else if ((opts.isCooling ?? (() => false))(rec, opts.now)) counts.cooling += 1
    else counts.expired += 1
  }
  return { counts, ranked }
}
