/**
 * dsh-drama-trae —— 首帧链式传导（first-frame chaining）。
 *
 * 目的：解决同一场景内连续镜头的**视觉连续性断裂**。当两个相邻镜头属于同一
 * 场景（sceneId 相同）且无硬切（transitionToNext 不是 hard-cut / whip-pan）时，
 * 用上一镜产物的末帧（`last_frame_uri`）作为下一镜 i2v 的首帧参考，
 * 让画面在空间与光影上自然承接。
 *
 * 依据：Trae 的 `tool_text_to_video_stream` 的 result 帧同时返回
 * `uri`（视频 TOS key）与 `last_frame_url`（末帧预览图 TOS key），
 * 两者都可作为下一镜的 `image_paths` 传入（实测 i2v 接受 gen_image 目录的 key）。
 *
 * 约束（来自协议实测）：
 *   - `image_paths` 只接受**同账号**上传/生成的 key（跨账号报 invalid userid），
 *     故链式传导时下一镜必须沿用同一账号
 *   - `last_frame_url` 是否为 i2v 可接受的 key 格式 = **[?] 待验证**，
 *     验证方式：拿一条产物的 last_frame_uri 直接喂 i2v，看是否报
 *     `failed to sign image url`；若报错则回退为「不传导」
 *
 * 默认关闭（chainFrames=false），因为该能力尚待真机验证。
 *
 * @module src/frame-chain
 */

/** 不应传导的转场类型（硬切断了空间连续性）。 */
export const BREAK_TRANSITIONS = ['hard-cut', 'whip-pan']

/**
 * 判断下一镜是否可以承接上一镜首帧。
 *
 * @param {object} prevShot 上一镜分镜
 * @param {object} nextShot 下一镜分镜
 * @param {string} prevLastFrame 上一镜产物末帧 key（空则不可传导）
 * @returns {{ chain: boolean, reason: string }}
 */
export function canChain(prevShot, nextShot, prevLastFrame) {
  if (!prevLastFrame) return { chain: false, reason: '前一镜无末帧 key' }

  const prevScene = String(prevShot?.sceneId ?? '').trim()
  const nextScene = String(nextShot?.sceneId ?? '').trim()
  // 都无 sceneId 时视为同场景（保守但可用）；只有一个有则不匹配
  if (prevScene && nextScene && prevScene !== nextScene) {
    return { chain: false, reason: `场景不同（${prevScene} → ${nextScene}）` }
  }
  if (prevScene !== nextScene) {
    return { chain: false, reason: '场景标识不成对，无法判定同场景' }
  }

  // 语义修正：`transitionToNext` 描述的是「本镜 → 下一镜」的转场，
  // 故判断「上一镜到本镜」是否被打断，应取 **prevShot** 的该字段。
  const transition = String(prevShot?.transitionToNext ?? '').trim().toLowerCase()
  if (BREAK_TRANSITIONS.includes(transition)) {
    return { chain: false, reason: `上一镜转场为 ${transition}，打断连续性` }
  }
  return { chain: true, reason: prevScene ? `同场景 ${prevScene}` : '无场景标识但顺序相邻' }
}

/**
 * 为一组分镜构建「可传导映射」。
 *
 * @param {object[]} shots 按出片顺序排列的分镜
 * @param {Map<string, string>} lastFrames Map<镜号, 末帧 key>
 * @param {{ enabled?: boolean }} [opts]
 * @returns {Map<string, { fromShot: string, key: string, reason: string }>}
 *   Map<目标镜号, { fromShot, key, reason }>
 */
export function buildChainPlan(shots, lastFrames, opts = {}) {
  const { enabled = false } = opts
  const plan = new Map()
  if (!enabled || !Array.isArray(shots) || shots.length < 2) return plan

  for (let i = 1; i < shots.length; i++) {
    const prev = shots[i - 1]
    const next = shots[i]
    const prevNo = String(prev?.shotNumber ?? prev?.shot ?? '').trim()
    const nextNo = String(next?.shotNumber ?? next?.shot ?? '').trim()
    if (!nextNo) continue
    const prevLast = lastFrames?.get(prevNo)
    const { chain, reason } = canChain(prev, next, prevLast)
    if (chain) plan.set(nextNo, { fromShot: prevNo, key: prevLast, reason })
  }
  return plan
}
