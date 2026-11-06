/**
 * dsh-drama-trae —— 情绪 → 可观测画面描述映射。
 *
 * 目的：解决「情绪元数据污染 prompt」。此前 buildShotVideoPrompt 把
 * `emotion: {label, intensity}` 渲染成「情绪：警觉（强度70）」直接塞进 prompt。
 * 视频模型不理解这类元数据，可能把它当成画面内容处理，产出怪异画面。
 *
 * 做法：内置情绪 → 可观测生理/体态描述的映射表；命中则替换为画面语言，
 * 未命中则保留原标签并追加「（内在状态）」提示，明确其为心理描述而非画面元素。
 *
 * 依据：ai-drama 的 PD-01「可观测性」判据——抽象心理/修辞必须换算为
 * 尺寸/位置/清晰度/边界/明暗等可拍变量。
 *
 * @module src/emotion
 */

/**
 * 情绪标签 → 可观测描述。键为常见中文情绪词（含同义词）。
 * 值优先选「可被镜头拍到」的生理或体态信号。
 */
export const EMOTION_MAP = {
  警觉: '瞳孔收缩，肩颈绷紧，视线快速扫向画面边缘',
  紧张: '手指无意识收紧，喉结上下滚动，呼吸变浅',
  恐惧: '瞳孔放大，身体后倾，手掌撑在身后物体上',
  害怕: '肩膀内收，下巴微收，脚尖朝向出口方向',
  愤怒: '下颌咬紧，鼻翼张开，颈侧血管轻微凸起',
  愤恨: '嘴角单侧下压，眼神直视对方不眨眼',
  悲伤: '眼睑下垂，视线落在下方，嘴角松弛下滑',
  难过: '眉心上抬，眼眶微红，手指停在半空',
  绝望: '双肩塌陷，头部低垂，重心不稳地向前倾',
  崩溃: '身体蜷缩，双手抱住头，指节发白',
  喜悦: '眼角挤出细纹，嘴角上扬露出牙齿，肩膀轻抬',
  开心: '眼睛弯成弧线，步伐变轻快，手部动作幅度变大',
  兴奋: '呼吸加快，躯干前倾，手指不停交握又松开',
  平静: '呼吸均匀，肩膀松弛，视线平稳不闪动',
  冷静: '面部肌肉放松，眼神稳定，下颌线平直',
  疲惫: '眼窝凹陷，上眼睑下垂，肩线明显下沉',
  释然: '长呼一口气，肩头落下，嘴角缓慢松开',
  犹豫: '视线在两点之间来回移动，手指停在半空未落',
  纠结: '眉心紧皱，嘴唇抿成一条线，手指反复摩挲',
  惊讶: '眉毛上抬，眼睛睁圆，嘴唇微张，身体定住',
  震惊: '瞳孔骤缩，身体僵直，手中物体开始滑落',
  疑惑: '单侧眉毛上挑，头部微侧，视线聚焦在一点',
  轻蔑: '嘴角单侧上扬，眼睑半垂，头部后仰',
  压抑: '嘴唇紧抿，肩背僵硬，手指压住桌面',
  委屈: '下唇前突，眼眶盈满，视线向下躲闪',
  温柔: '目光放软，嘴角浅弧，头部略微前倾',
  决绝: '下颌绷紧，视线直刺前方，身体重心前移',
  痛苦: '牙关紧咬，额角渗汗，手指抓住身边物体',
  孤独: '背部微弓，视线落在远处虚焦，双手垂落',
  期待: '身体前倾，眼睛睁大，嘴唇微微张开',
  后悔: '视线向下偏移，手抚额头，肩线塌下',
  羞愧: '头部低垂，视线避开对方，耳根泛红',
  偏执: '瞳孔聚焦过紧，呼吸急促，手指反复同一个动作',
}

/** 强度 → 幅度修饰。 */
export function intensityWord(level) {
  const n = Number(level)
  if (!Number.isFinite(n)) return ''
  if (n >= 85) return '幅度极大'
  if (n >= 65) return '幅度明显'
  if (n >= 45) return '幅度适中'
  if (n >= 25) return '幅度轻微'
  return '几乎不可察'
}

/**
 * 把 emotion 对象渲染成可观测画面描述。
 *
 * @param {object|string} emotion `{ label, intensity }` 或纯字符串
 * @returns {string} 空串表示无可渲染内容
 */
export function renderObservableEmotion(emotion) {
  if (!emotion) return ''
  if (typeof emotion === 'string') {
    const label = emotion.trim()
    if (!label) return ''
    const mapped = EMOTION_MAP[label]
    return mapped ? `情绪外化：${mapped}` : `内在状态：${label}`
  }
  if (typeof emotion !== 'object') return ''

  const label = String(emotion.label ?? emotion.name ?? '').trim()
  if (!label) return ''
  const amp = intensityWord(emotion.intensity)
  const mapped = EMOTION_MAP[label]
  if (mapped) {
    return amp ? `情绪外化（${amp}）：${mapped}` : `情绪外化：${mapped}`
  }
  // 未命中：保留标签但明确标注为内在状态，避免被当成画面元素
  const tail = amp ? `（${amp}）` : ''
  return `内在状态${tail}：${label}（请以体态与呼吸变化外化，勿画抽象符号）`
}
