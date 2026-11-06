/**
 * dsh-drama-trae —— 服务端错误分类与重试策略（单一事实来源）。
 *
 * 为什么单独成模块：错误判定散在三处会互相矛盾。
 *   ① index.js 的选号循环要知道「换号有用吗」
 *   ② quota.js 的账本要知道「这个账号该不该拉黑、黑多久」
 *   ③ explainTraeVError 要给人看得懂的话
 * 三处各写一套正则，必然出现「这层判可重试、那层判账号死」的矛盾——
 * 实测就跑出过 452 次 4010 一镜不重试直接失败的场面。
 *
 * 分类维度两个，必须分开：
 *   · scope：故障归属（account=换号/等冷却；global=平台侧，换号无用，只能退避重试；
 *            content=内容/参数被拒，重试无意义）
 *   · retriable：本次运行内，同一镜头「再试一次」是否有意义
 *
 * 实测证据（2026-11-05/06 山海经第001集跑批，共 1756 条错误帧）：
 *   4010 `We're sorry, access denied. Please wait and try again later.`  452 次
 *        —— 平台侧接入拒绝，message 明说「wait and retry」。换号无效、
 *           重试有效，且 24 镜里 21 镜只撞一次就直接判死是最大损失点。
 *   2001 `usage reservation lock is busy`                               65 次
 *        —— 该账号的用量预留锁被占（并发提交同一账号触发）。锁是秒级的，
 *           稍等再试同一账号即可，拉黑账号是错判。
 *   4008 `exceeded the quota`                                   配额耗尽，账号级，换号
 *   4040/4030 message 为空                                       账号对模型异常，换号
 *   1001 `not able to authenticate`                              该账号本次被拒，换号
 *   3003 + `InvalidParameter ... duration`                       参数错，重试无用
 *   3003 + `callArkVideoGeneration ... Error code: 400`           参数错（同源），重试无用
 *
 * @module src/errors
 */

// ---- 冷却时长（账本视角）：某类故障后这个账号要躲多久再试 ----
/** 额度耗尽：按周期重置，压 6 小时。 */
export const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000
/**
 * 账号对该模型异常（4040/4030）：首次压 10 分钟。
 *
 * 实测（2026-11-06）：同一账号先出片成功、随后 5 个不同 prompt 全在 0.3 秒内
 * 返回 4040 —— 与 prompt/时长无关，说明它更接近「该号本轮额度用尽」
 * 而不是瞬时抖动。所以采用**递进冷却**：同一个号连续撞同一个码，
 * 冷却时间翻倍（10min → 20min → 40min …上限 6h），
 * 第一次不误伤、反复撞就自动当成额度耗尽处理，不用人肉判断。
 */
export const BROKEN_COOLDOWN_MS = 10 * 60 * 1000
/** 鉴权被拒（1001）：给 token 刷新留时间，压 30 分钟。 */
export const AUTH_COOLDOWN_MS = 30 * 60 * 1000
/** 递进冷却的上限。 */
export const MAX_ESCALATED_COOLDOWN_MS = 6 * 60 * 60 * 1000

/**
 * kind → 冷却时长。
 *
 * @param {string} kind
 * @param {number} [streak] 同号连续撞同一码的次数（1=第一次），用于递进冷却
 */
export function cooldownFor(kind, streak = 1) {
  const base = kind === 'quota' ? QUOTA_COOLDOWN_MS
    : kind === 'auth' ? AUTH_COOLDOWN_MS
    : kind === 'account-broken' || kind === 'broken' ? BROKEN_COOLDOWN_MS
    : 0
  if (!base) return 0
  if (kind === 'quota') return base       // 额度本来就是长冷却，无需递进
  const n = Math.max(1, Number(streak) || 1)
  return Math.min(MAX_ESCALATED_COOLDOWN_MS, base * 2 ** (n - 1))
}

/** 平台侧瞬时拒绝（(4010) access denied）：换号无用，等一会儿重试同一镜头。 */
export const ACCESS_DENIED_BACKOFF_MS = 8000
/** 用量锁占用（2001 lock busy）：锁是秒级的，短退避后重试。 */
export const LOCK_BUSY_BACKOFF_MS = 3000
/** 限流（429）：中等退避。 */
export const RATE_LIMIT_BACKOFF_MS = 15000
/** 网络层故障（连接被拒/重置）：短退避后重试。 */
export const NETWORK_BACKOFF_MS = 4000

/**
 * 单条错误 → 分类结果。
 *
 * @param {string} errMessage 服务端原始错误（含嵌套 message）
 * @returns {{
 *   kind: 'quota'|'account-broken'|'auth'|'access-denied'|'lock-busy'|'rate-limit'|'param'|'unknown',
 *   scope: 'account'|'global'|'content',
 *   retriable: boolean,
 *   backoffMs: number,
 *   markAccount: boolean,
 *   label: string
 * }}
 */
export function classifyError(errMessage) {
  const msg = String(errMessage ?? '')

  // 顺序敏感：先判最具体的内层码，再判外层 3003（外层码对所有错误都一样，没有信息量）
  // 码既可能带 `code=` 前缀，也可能以裸数字出现在被序列化的嵌套 JSON 里，
  // 两种都要认（旧实现只认带前缀的，裸 `"4008"` 会漏判成未知）。
  if (/code=4008|\b4008\b|exceeded the quota|quota exceeded/i.test(msg)) {
    return {
      kind: 'quota', scope: 'account', retriable: true, backoffMs: 0, markAccount: true,
      label: '额度耗尽',
    }
  }
  if (/code=4040|code=4030|\b4040\b|\b4030\b/i.test(msg)) {
    return {
      kind: 'account-broken', scope: 'account', retriable: true, backoffMs: 0, markAccount: true,
      label: '账号对该模型异常',
    }
  }
  if (/code=1001|\b1001\b|not able to authenticate|invalid token/i.test(msg)) {
    return {
      kind: 'auth', scope: 'account', retriable: true, backoffMs: 0, markAccount: true,
      label: '账号鉴权被拒',
    }
  }
  if (/code=4010|\b4010\b|access denied/i.test(msg)) {
    // 平台侧接入拒绝。message 自己就写着 "wait and try again later"，
    // 所以退避后重试；账号本身没坏，不能拉黑（否则一次抖动废掉整池账号）。
    return {
      kind: 'access-denied', scope: 'global', retriable: true, backoffMs: ACCESS_DENIED_BACKOFF_MS,
      markAccount: false, label: '平台侧接入拒绝（需退避重试）',
    }
  }
  if (/code=2001|\b2001\b|reservation lock is busy/i.test(msg)) {
    return {
      kind: 'lock-busy', scope: 'global', retriable: true, backoffMs: LOCK_BUSY_BACKOFF_MS,
      markAccount: false, label: '用量预留锁占用（并发过高）',
    }
  }
  if (/429|rate.?limit|too many requests|too many/i.test(msg)) {
    return {
      kind: 'rate-limit', scope: 'global', retriable: true, backoffMs: RATE_LIMIT_BACKOFF_MS,
      markAccount: false, label: '请求频率被限',
    }
  }
  // 参数 / 内容被拒：重试只会重复失败，直接判该镜失败，别浪费配额与时间
  if (/InvalidParameter|Error code: 400|param is invalid|code=4001/i.test(msg)) {
    return {
      kind: 'param', scope: 'content', retriable: false, backoffMs: 0, markAccount: false,
      label: '参数被服务端拒绝',
    }
  }
  // 参考图 key 与账号绑死：换成别的账号必然 invalid userid，
  // 但这不是账号坏了 —— 不能拉黑账号，只能把这一镜降级为纯文生视频。
  if (/invalid userid|invalid_userid/i.test(msg)) {
    return {
      kind: 'binding', scope: 'content', retriable: false, backoffMs: 0, markAccount: false,
      label: '参考图与账号不匹配',
    }
  }
  if (/content|audit|审核|违规|sensitive/i.test(msg)) {
    return {
      kind: 'param', scope: 'content', retriable: false, backoffMs: 0, markAccount: false,
      label: '内容审核未过',
    }
  }
  // 网络层故障（连接被拒/重置/超时/DNS）：通道问题，换号无用但值得退避重试。
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket hang up|fetch failed/i.test(msg)) {
    return {
      kind: 'network', scope: 'global', retriable: true, backoffMs: NETWORK_BACKOFF_MS,
      markAccount: false, label: '网络层故障',
    }
  }
  return { kind: 'unknown', scope: 'global', retriable: true, backoffMs: 4000, markAccount: false, label: '未知错误' }
}

/** 便捷判定：换账号是否有用（账号级故障）。 */
export function isAccountScope(errMessage) {
  return classifyError(errMessage).scope === 'account' && classifyError(errMessage).markAccount
}

/** 便捷判定：本镜头再试一次是否有意义。 */
export function isRetriable(errMessage) {
  return classifyError(errMessage).retriable
}

/**
 * 指数退避（带抖动）：第 n 次重试的实际等待。
 *
 * 抖动是必需的 —— 并发 worker 全被 4010 拒绝时，同步退避会让它们同时醒来
 * 再同时撞墙，形成周期性的失败波。
 *
 * @param {number} baseMs
 * @param {number} attempt 0 基的重试次数
 * @param {number} [capMs]
 * @param {() => number} [rand]
 */
export function backoffFor(baseMs, attempt, capMs = 90_000, rand = Math.random) {
  if (!baseMs) return 0
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
  const jitter = exp * 0.25
  return Math.round(Math.max(500, exp - jitter + rand() * jitter * 2))
}

/** 睡 ms（可被取消信号打断：调用方传 isCancelled 判据）。 */
export async function sleep(ms, isCancelled = () => false, tickMs = 250) {
  const end = Date.now() + Math.max(0, ms)
  while (Date.now() < end) {
    if (isCancelled()) return false
    await new Promise((r) => setTimeout(r, Math.min(tickMs, end - Date.now())))
  }
  return !isCancelled()
}

/**
 * 账本条目是否仍在冷却期内（过期即可重新尝试）。
 *
 * 这是账本最关键的语义：`quota` / `broken` 是**有时效的观测**，不是永久判决。
 * 之前预检只看 status 不看 at，一条 11 小时前的 quota 记录会把账号
 * 永久踢出可用池 —— 33 个账号里 20 个被这样封死，实际却不一定是空的。
 *
 * @param {{status:string, at:string}} rec
 * @param {number} [now]
 * @returns {boolean} true=仍在冷却，应跳过
 */
export function isStillCooling(rec, now = Date.now()) {
  if (!rec || typeof rec !== 'object') return false
  const status = rec.status
  // 账本里存的是 kind 名（quota/broken/auth）；各自按自己的时长（含递进）
  if (!['quota', 'broken', 'auth'].includes(status)) return false
  const t = rec.at ? Date.parse(rec.at) : NaN
  // 没有时间戳 = 不知道这条判决有多旧。按「已过期」处理：
  // 真正的坏处是**多封**账号（旧实现把 11 小时前的 warmup 记录当永久判决，
  // 33 个账号里 20 个被这样挡在门外），而不是偶尔多试一个死号
  // —— 多试一次的代价是一次请求，多封一个号的代价是整批跑不动。
  if (!Number.isFinite(t)) return false
  const cooldown = cooldownFor(status === 'broken' ? 'account-broken' : status, rec.streak)
  return now - t < cooldown
}
