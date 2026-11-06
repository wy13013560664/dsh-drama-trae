/**
 * dsh-drama-trae —— 跑批级熔断（run circuit breaker）。
 *
 * 解决的是「整池账号在几秒内一起失效」时的空转：
 * 实测（2026-11-06 山海经第001集）24 镜 × 33 账号，第一次跑出
 * 21 镜失败、0 镜生成，但服务端其实在**头 1 秒内就拒了**每次请求
 * （4040 平均 0.2~0.3 秒返回）。也就是说：后面 20 次换号重试、
 * 20 镜的排队等待全是空转，唯一的产出是白烧几百次请求。
 *
 * 判据不是「失败了几次」，而是**失败得有多快**：
 *   · 服务端愿意排队 → 首帧心跳要 3 秒左右，失败也要跑完队列才知道
 *   · 服务端直接拒绝 → 亚秒级返回（提交层就拦了）
 * 所以「连续 N 次亚秒级失败且中间没有一次成功」= 整个通道此刻进不去，
 * 该停手并明确告诉用户「补账号/等冷却」，而不是继续把每镜都试一遍。
 *
 * @module src/circuit
 */

/** 亚秒级失败阈值：低于这个耗时算「提交层直接拒绝」。 */
export const FAST_FAIL_MS = 1500
/** 连续多少次亚秒级失败后熔断。 */
export const DEFAULT_TRIP_THRESHOLD = 8
/** 熔断后多久允许半开重试（放一个请求探路）。 */
export const HALF_OPEN_AFTER_MS = 60 * 1000

/**
 * @param {object} [opts]
 * @param {number} [opts.threshold] 连续亚秒级失败次数阈值
 * @param {number} [opts.fastFailMs] 亚秒级判定
 * @param {() => number} [opts.now]
 */
export function createRunCircuit(opts = {}) {
  const threshold = Math.max(1, Number(opts.threshold ?? DEFAULT_TRIP_THRESHOLD))
  const fastFailMs = Math.max(1, Number(opts.fastFailMs ?? FAST_FAIL_MS))
  const now = opts.now ?? Date.now

  let consecutiveFastFails = 0
  let trippedAt = null
  let lastKind = null
  let successes = 0
  let fastFails = 0
  let slowFails = 0

  return {
    /**
     * 记一次结果。
     * @param {{ok:boolean, ms:number, kind?:string}} r
     * @returns {{tripped:boolean, justTripped:boolean, reason?:string}}
     */
    record(r) {
      const ms = Number(r?.ms ?? 0)
      if (r?.ok) {
        successes += 1
        consecutiveFastFails = 0
        trippedAt = null
        lastKind = null
        return { tripped: false, justTripped: false }
      }
      // 只有「平台/账号拒绝」的快速失败才计入熔断；
      // 参数错（content 级）不管多快都不算，它跟通道健康无关。
      if (ms < fastFailMs) {
        fastFails += 1
        consecutiveFastFails += 1
        lastKind = r?.kind ?? lastKind
      } else {
        slowFails += 1
        // 慢失败说明服务端确实排了队、跑过了流程，通道是通的 → 计数归零
        consecutiveFastFails = 0
      }
      const wasTripped = trippedAt !== null
      if (!wasTripped && consecutiveFastFails >= threshold) {
        trippedAt = now()
        return {
          tripped: true,
          justTripped: true,
          reason: `连续 ${consecutiveFastFails} 次请求在 ${fastFailMs}ms 内被服务端直接拒绝（${lastKind ?? '未知'}），`
            + '没有一次进入排队 —— 说明当前账号池在服务端侧整体不可用。'
            + '已停止继续重试以省下请求；请补充账号，或等冷却后重跑。',
        }
      }
      return { tripped: wasTripped, justTripped: false }
    },

    /**
     * 现在还能不能发请求。
     *
     * 熔断后不是永久关闭，而是「半开」：过了 HALF_OPEN_AFTER_MS 放一个探路请求，
     * 成功就彻底恢复（record 里 ok 会清掉 trippedAt），失败就继续保持熔断。
     */
    canAttempt() {
      if (trippedAt === null) return true
      return now() - trippedAt >= HALF_OPEN_AFTER_MS
    },

    snapshot() {
      return {
        tripped: trippedAt !== null,
        consecutiveFastFails,
        threshold,
        fastFailMs,
        successes,
        fastFails,
        slowFails,
        lastKind,
      }
    },
  }
}
