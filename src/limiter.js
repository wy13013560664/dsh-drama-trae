/**
 * dsh-drama-trae —— 自适应并发闸门（AIMD）。
 *
 * 为什么需要：实测一集 24 镜、18 并发跑批，收到 452 次
 * `4010 access denied. Please wait and try again later.` —— 这不是账号坏，
 * 是接入通道被并发打满后的整体拒绝。并发越高拒绝越多，且拒绝是**全局**的：
 * 换账号没用，只能降并发。
 *
 * 做法沿用 TCP 拥塞控制（AIMD：加性增、乘性减）：
 *   · 每次被 4010/429 拒绝 → 上限乘性减半（乘性减）
 *   · 连续成功若干次     → 上限 +1（加性增），慢慢探回原目标
 *
 * 这样既不会一撞就永久降到 1，也不会一直以打满的并发反复撞墙。
 *
 * @module src/limiter
 */

/**
 * @param {object} opts
 * @param {number} opts.target 目标并发上限（不再往上加的天花板）
 * @param {number} [opts.successStreak] 连续成功多少次后 +1，默认 6
 * @returns {object} 闸门
 */
export function createLimiter({ target, successStreak = 6 } = {}) {
  const ceiling = Math.max(1, Number(target) || 1)
  let limit = ceiling           // 当前允许的在飞数
  let inFlight = 0
  let streak = 0
  const waiters = []
  let peak = limit

  const pump = () => {
    while (waiters.length && inFlight < limit) {
      const resolve = waiters.shift()
      inFlight += 1
      resolve(() => release())
    }
  }

  function release() {
    inFlight = Math.max(0, inFlight - 1)
    pump()
  }

  return {
    /** 拿一个许可（返回 release 函数）。 */
    acquire() {
      return new Promise((resolve) => {
        waiters.push(resolve)
        pump()
      })
    },
    /** 撞到全局限流：乘性减半。返回新上限，便于上报进度。 */
    penalize() {
      limit = Math.max(1, Math.floor(limit / 2))
      streak = 0
      return limit
    },
    /** 一次成功：连续成功后加性 +1，不超过天花板。 */
    reward() {
      streak += 1
      if (streak >= successStreak && limit < ceiling) {
        limit += 1
        streak = 0
        peak = Math.max(peak, limit)
        pump()
      }
      return limit
    },
    /** 当前状态（进度上报用）。 */
    snapshot() {
      return { limit, ceiling, inFlight, waiting: waiters.length, peak }
    },
  }
}
