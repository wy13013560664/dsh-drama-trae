/**
 * dsh-drama-trae —— 账号预热（warmup）。
 *
 * 问题：37 个账号里能用的只有几个，每次出片都要「撞死号」重试，
 * 单镜 146 秒里大半耗在换号。24 镜就要撞几十次。
 *
 * 做法：先用**最省的一次真实请求**把全部账号探一遍，
 * 结果写进账本（ok / quota / broken），后续出片直接按账本选号。
 *
 * 成本：
 *   · 探测成功的账号会真的生成一条 480p/2s 视频（约 1 次积分）
 *   · 探测失败的账号零成本（服务端在参数校验阶段就拒绝了）
 *
 * 所以只在对「死号占比高」的时候值得跑；账本已经有 ok 账号时可直接跳过。
 */

import { classifyAccountFailure, isAccountLevelFailure, recordAccounts, readLedger } from './quota.js'

/** 探测用的最小参数：480p + 极短 prompt。
 *  duration 必须 ≥4：实测 duration=2/3 会被服务端以
 *  InvalidParameter 拒绝（"not valid for model doubao-seedance-2-0-mini in t2v"），
 *  探针自身先失败就看不到真实额度状态。
 *  取 4（可接受的最小值）以省积分。 */
export const PROBE_PARAMS = {
  prompt: '探针',
  duration: 4,
  ratio: '9:16',
  resolution: '480p',
}

/**
 * 探一个账号 —— **不发完整生成请求，只验证到「进入排队」**。
 *
 * 依据：实测服务端对不健康账号会**立刻**返回 `event: error`（3 秒内），
 * 健康账号则开始推 `event: heartbeat`（首帧约 3 秒）。收到 heartbeat 就
 * 立即断开，视频不会真的产出 —— 既不耗积分，也不等 2–3 分钟。
 *
 * 三种判定：
 *   · heartbeat  → pending（进队列，但不保证最终产出；ok 由成功出片确认）
 *   · error 4008 → quota（额度空）
 *   · error 4040/4030 → broken（账号对模型异常）
 *
 * @param {object} credential
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl]
 * @param {number} [deps.waitMs] 等首帧上限，默认 12000
 * @returns {Promise<{uid:string, status:'ok'|'quota'|'broken'|'unknown', note:string, ms:number}>}
 */
export async function probeAccount(credential, deps = {}) {
  const {
    fetchImpl = fetch,
    waitMs = 12000,
  } = deps
  const uid = String(credential?.uid ?? '')
  const t0 = Date.now()

  // 这里的常量从消费方注入，避免本模块直接依赖 constants（便于测试替换）
  const host = deps.host ?? credential?.__host
  const path = deps.path
  const model = deps.model
  if (!host || !path || !model) {
    throw new Error('probeAccount: 缺少 host/path/model（由调用方注入）')
  }

  const res = await fetchImpl(`${host}${path}`, {
    method: 'POST',
    headers: deps.headers ? deps.headers(credential, { stream: true }) : {},
    body: JSON.stringify({
      model,
      prompt: PROBE_PARAMS.prompt,
      resolution: PROBE_PARAMS.resolution,
      ratio: PROBE_PARAMS.ratio,
      duration: PROBE_PARAMS.duration,
    }),
  })

  if (!res.ok || !res.body) {
    return { uid, status: 'unknown', note: `HTTP ${res.status}`, ms: Date.now() - t0 }
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let verdict = null
  let note = ''

  try {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })

      // 注意：heartbeat 只证明「请求进了队列」，**不证明最终能产出**。
      // 实测同一账号可以 heartbeat→稍后 4040，所以这里不能判 ok，
      // 只能记 pending（疑似可用），真正 ok 由成功出片时确认。
      if (buf.includes('event: heartbeat')) { verdict = 'pending'; note = '进入排队（待验证）'; break }

      // 任一 error 帧都足够定论，不必等流结束
      const errFrame = buf.match(/event: error\ndata: (.+)/)
      if (errFrame) {
        const msg = errFrame[1]
        if (isAccountLevelFailure(msg)) {
          const cls = classifyAccountFailure(msg)
          verdict = cls.kind === 'quota' ? 'quota' : 'broken'
          note = cls.kind
        } else {
          verdict = 'unknown'
          note = msg.slice(0, 200)
        }
        break
      }
    }
  } finally {
    // 关键：读完就断，视频不会真的产出 → 不耗积分
    try { await reader.cancel() } catch { /* 已结束 */ }
  }

  if (!verdict) { verdict = 'unknown'; note = note || '等待首帧超时' }
  return { uid, status: verdict, note, ms: Date.now() - t0 }
}

/**
 * 预热一批账号。
 *
 * @param {object} opts
 * @param {object[]} opts.accounts 待探账号
 * @param {string} opts.projectDir 账本落点
 * @param {Function} opts.generate 生成函数
 * @param {string[]} [opts.skipUids] 已知可用/刚探过的账号，跳过
 * @param {Function} [opts.onProgress]
 * @param {number} [opts.concurrency] 并发数，默认 4（TRAE 单账号串行，并发靠多账号）
 * @returns {Promise<{ok:string[], quota:string[], broken:string[], unknown:string[], entries:object[], elapsedMs:number}>}
 */
export async function warmupAccounts(opts = {}) {
  const {
    accounts = [],
    projectDir,
    probeDeps = {},
    skipUids = [],
    onProgress = () => {},
    concurrency = 4,
  } = opts

  const skip = new Set(skipUids.map(String))
  const todo = accounts.filter((a) => !skip.has(String(a?.uid ?? '')))
  const t0 = Date.now()
  const entries = []

  onProgress({ type: 'warmup-start', total: todo.length, skipped: accounts.length - todo.length })

  // 简单并发池：TRAE 每个账号独立，多账号并发不会互相限流
  let next = 0
  async function worker() {
    while (true) {
      const i = next
      next += 1
      if (i >= todo.length) return
      const acc = todo[i]
      const r = await probeAccount(acc, probeDeps)
      entries.push(r)
      onProgress({
        type: 'warmup-item',
        uid: r.uid,
        status: r.status,
        ms: r.ms,
        done: entries.length,
        total: todo.length,
      })
    }
  }
  const workers = []
  for (let w = 0; w < Math.max(1, Math.min(concurrency, todo.length)); w++) workers.push(worker())
  await Promise.all(workers)

  if (entries.length && projectDir) {
    try {
      await recordAccounts(projectDir, entries.map((e) => ({
        uid: e.uid, status: e.status, note: `warmup: ${e.note}`,
      })))
    } catch { /* 记账失败不影响探测结果 */ }
  }

  const group = (s) => entries.filter((e) => e.status === s).map((e) => e.uid)
  return {
    ok: group('ok'),
    quota: group('quota'),
    broken: group('broken'),
    unknown: group('unknown'),
    entries,
    elapsedMs: Date.now() - t0,
  }
}

/**
 * 判断是否值得预热：账本里已知可用账号够跑目标镜数就不用再探。
 *
 * @param {object[]} accounts
 * @param {object} ledger
 * @param {number} shotsNeeded
 * @param {number} [perAccount=4] 每账号保守可跑镜数
 */
export function shouldWarmup(accounts = [], ledger = { accounts: {} }, shotsNeeded = 0, perAccount = 4) {
  const okUids = Object.entries(ledger?.accounts || {}).filter(([, r]) => r?.status === 'ok').map(([u]) => u)
  const untested = accounts.filter((a) => !(ledger?.accounts || {})[String(a?.uid ?? '')])
  const capacity = okUids.length * perAccount
  return {
    needed: shotsNeeded > capacity,
    okCount: okUids.length,
    untestedCount: untested.length,
    capacity,
    shotsNeeded,
    // 建议预热的账号：未探过的
    candidates: untested.map((a) => String(a.uid)),
  }
}
