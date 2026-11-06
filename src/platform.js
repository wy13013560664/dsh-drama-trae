/**
 * dsh-drama-trae —— 平台投放参数分档。
 *
 * 目的：不同平台对画幅、单集时长、钩子密度的偏好差异很大；此前插件用全局
 * 默认画幅 9:16，不区分投放平台。本模块把「平台」映射成一组可在出片时套用
 * 的节奏/画幅参数。
 *
 * 依据：dsh-plugin-ai-drama 的 `drama-storyboard` 技能已给出竖屏短剧的节奏纪律
 * （开场 3 秒内必须特写或强冲突、平均每 3–5 秒切镜、不要超过 8 秒的长镜、
 * 全集合计时长必须落在契约区间），但未按平台分档。本模块补上分档。
 *
 * 注意：以下参数是**经验值**（[I] 推断），非平台官方规范。抖音/快手的具体
 * 阈值会随平台规则变化。用于生成前的合理性提示，不用于硬性校验。
 *
 * @module src/platform
 */

/**
 * 平台画像。字段含义：
 *   ratio:          推荐画幅
 *   hookSeconds:    开场必须出现强钩子的秒数上限
 *   maxShotSec:     单镜时长上限（超过则节奏拖沓）
 *   avgShotSec:     建议平均单镜时长
 *   episodeSecRange: 单集时长建议区间 [min, max]
 *   note:           平台特征说明
 */
export const PLATFORM_PROFILES = {
  抖音: {
    ratio: '9:16', hookSeconds: 3, maxShotSec: 8, avgShotSec: 4, episodeSecRange: [60, 120],
    note: '强钩子快节奏，前 3 秒决定完播率',
  },
  快手: {
    ratio: '9:16', hookSeconds: 5, maxShotSec: 10, avgShotSec: 5, episodeSecRange: [60, 150],
    note: '节奏略缓，生活化表达接受度更高',
  },
  视频号: {
    ratio: '9:16', hookSeconds: 5, maxShotSec: 10, avgShotSec: 5, episodeSecRange: [60, 150],
    note: '社交分发，中老年用户占比高，信息密度不宜过密',
  },
  B站: {
    ratio: '16:9', hookSeconds: 10, maxShotSec: 15, avgShotSec: 7, episodeSecRange: [120, 300],
    note: '横屏为主，可容长镜与片头片尾，观众耐心较高',
  },
  小红书: {
    ratio: '9:16', hookSeconds: 4, maxShotSec: 8, avgShotSec: 4, episodeSecRange: [45, 90],
    note: '审美导向，画面质感权重高于剧情密度',
  },
  其他: {
    ratio: 'adaptive', hookSeconds: 5, maxShotSec: 12, avgShotSec: 5, episodeSecRange: [60, 180],
    note: '通用配置',
  },
}

/**
 * 取平台画像。
 * @param {string} platform
 * @returns {object} 画像对象（未命中返回「其他」）
 */
export function getPlatformProfile(platform) {
  const key = String(platform ?? '').trim()
  return PLATFORM_PROFILES[key] ?? PLATFORM_PROFILES['其他']
}

/**
 * 按平台画像检查分镜节奏，返回提示（不阻断）。
 *
 * @param {object[]} shots 分镜数组
 * @param {string} platform 投放平台
 * @returns {{ profile: object, issues: object[], stats: object }}
 */
export function checkPlatformPacing(shots, platform) {
  const profile = getPlatformProfile(platform)
  const issues = []
  const arr = Array.isArray(shots) ? shots : []
  if (!arr.length) return { profile, issues, stats: { shots: 0, totalSec: 0, avgSec: 0 } }

  const durs = arr.map((s) => Number(s?.durationSec)).filter((n) => Number.isFinite(n) && n > 0)
  const totalSec = durs.reduce((a, b) => a + b, 0)
  const avgSec = durs.length ? totalSec / durs.length : 0

  // 单镜过长
  for (const s of arr) {
    const d = Number(s?.durationSec)
    const no = String(s?.shotNumber ?? s?.shot ?? '?')
    if (Number.isFinite(d) && d > profile.maxShotSec) {
      issues.push({ code: 'PLAT-01', shot: no,
        message: `镜 ${no} 时长 ${d}s 超过 ${platform} 建议上限 ${profile.maxShotSec}s，节奏可能拖沓` })
    }
  }

  // 平均单镜偏离
  if (avgSec > 0 && Math.abs(avgSec - profile.avgShotSec) > profile.avgShotSec) {
    issues.push({ code: 'PLAT-02',
      message: `平均单镜 ${avgSec.toFixed(1)}s，${platform} 建议 ${profile.avgShotSec}s 左右` })
  }

  // 单集总时长偏离
  const [lo, hi] = profile.episodeSecRange
  if (totalSec > 0 && (totalSec < lo || totalSec > hi)) {
    issues.push({ code: 'PLAT-03',
      message: `本集合计 ${totalSec}s，${platform} 建议 ${lo}–${hi}s` })
  }

  // 开场钩子：首镜是否特写/强冲突（启发式：景别为特写类）
  const first = arr[0]
  const firstSize = String(first?.shotSize ?? '').trim()
  const isCloseUp = ['特写', '大特写', '近景'].some((k) => firstSize.includes(k))
  if (!isCloseUp && profile.hookSeconds <= 3) {
    issues.push({ code: 'PLAT-04',
      message: `首镜景别「${firstSize || '未填'}」，${platform} 建议 ${profile.hookSeconds}s 内用特写或强冲突开场` })
  }

  return {
    profile,
    issues,
    stats: { shots: arr.length, totalSec, avgSec: Number(avgSec.toFixed(2)) },
  }
}
