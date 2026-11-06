/**
 * P2 改造单元测试：首帧链式 / 平台分档 / 合规词表。
 *   node test/p2-changes.mjs
 */

import assert from 'node:assert/strict'
import { canChain, buildChainPlan, BREAK_TRANSITIONS } from '../src/frame-chain.js'
import { getPlatformProfile, checkPlatformPacing, PLATFORM_PROFILES } from '../src/platform.js'
import { checkCompliance, checkShotsCompliance, BLOCK_TERMS, WARN_TERMS } from '../src/compliance.js'

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`) }
}

/* ============================================================ 首帧链式 */
console.log('\n[1] frame-chain —— 首帧链式判定')
t('无末帧 → 不传导', () => {
  const r = canChain({ sceneId: 'SPC-001' }, { sceneId: 'SPC-001' }, null)
  assert.equal(r.chain, false)
  assert.match(r.reason, /无末帧/)
})
t('同场景 → 可传导', () => {
  const r = canChain({ sceneId: 'SPC-001' }, { sceneId: 'SPC-001' }, 'key1')
  assert.equal(r.chain, true)
  assert.match(r.reason, /SPC-001/)
})
t('场景不同 → 不传导', () => {
  const r = canChain({ sceneId: 'SPC-001' }, { sceneId: 'SPC-002' }, 'key1')
  assert.equal(r.chain, false)
  assert.match(r.reason, /场景不同/)
})
t('上一镜 hard-cut 打断 → 不传导', () => {
  const r = canChain({ sceneId: 'SPC-001', transitionToNext: 'hard-cut' }, { sceneId: 'SPC-001' }, 'key1')
  assert.equal(r.chain, false)
  assert.match(r.reason, /hard-cut/)
})
t('上一镜 whip-pan 打断 → 不传导', () => {
  const r = canChain({ sceneId: 'SPC-001', transitionToNext: 'whip-pan' }, { sceneId: 'SPC-001' }, 'key1')
  assert.equal(r.chain, false)
})
t('上一镜 match-cut 可传导', () => {
  const r = canChain({ sceneId: 'SPC-001', transitionToNext: 'match-cut' }, { sceneId: 'SPC-001' }, 'key1')
  assert.equal(r.chain, true)
})
t('下一镜的 hard-cut 不影响本链（语义方向验证）', () => {
  const r = canChain({ sceneId: 'SPC-001', transitionToNext: 'match-cut' }, { sceneId: 'SPC-001', transitionToNext: 'hard-cut' }, 'key1')
  assert.equal(r.chain, true, '应只看上一镜的转场')
})
t('都无 sceneId → 保守可传导', () => {
  const r = canChain({}, {}, 'key1')
  assert.equal(r.chain, true)
})
t('只有一个有 sceneId → 不传导', () => {
  const r = canChain({ sceneId: 'SPC-001' }, {}, 'key1')
  assert.equal(r.chain, false)
  assert.match(r.reason, /不成对/)
})
t('BREAK_TRANSITIONS 含 2 项', () => assert.equal(BREAK_TRANSITIONS.length, 2))

console.log('\n[2] buildChainPlan —— 批量规划')
t('enabled=false 返回空', () => {
  const plan = buildChainPlan([{ shotNumber: '1' }, { shotNumber: '2' }], new Map(), { enabled: false })
  assert.equal(plan.size, 0)
})
t('enabled=true 且同场景 → 有映射', () => {
  const shots = [
    { shotNumber: '1', sceneId: 'SPC-001' },
    { shotNumber: '2', sceneId: 'SPC-001' },
  ]
  const frames = new Map([['1', 'frame-key-1']])
  const plan = buildChainPlan(shots, frames, { enabled: true })
  assert.equal(plan.size, 1)
  assert.equal(plan.get('2').key, 'frame-key-1')
  assert.equal(plan.get('2').fromShot, '1')
})
t('单镜不产生映射', () => {
  const plan = buildChainPlan([{ shotNumber: '1' }], new Map(), { enabled: true })
  assert.equal(plan.size, 0)
})
t('空输入安全', () => {
  assert.equal(buildChainPlan(null, null, { enabled: true }).size, 0)
})

/* ============================================================ 平台 */
console.log('\n[3] platform —— 平台分档')
t('抖音画像正确', () => {
  const p = getPlatformProfile('抖音')
  assert.equal(p.ratio, '9:16')
  assert.equal(p.hookSeconds, 3)
  assert.equal(p.maxShotSec, 8)
})
t('B站横屏且容长镜', () => {
  const p = getPlatformProfile('B站')
  assert.equal(p.ratio, '16:9')
  assert.equal(p.maxShotSec, 15)
})
t('未知平台回落「其他」', () => {
  const p = getPlatformProfile('YouTube')
  assert.equal(p.ratio, 'adaptive')
})
t('空平台回落「其他」', () => assert.equal(getPlatformProfile(null).ratio, 'adaptive'))
t('6 个平台画像', () => assert.equal(Object.keys(PLATFORM_PROFILES).length, 6))

console.log('\n[4] checkPlatformPacing —— 节奏检查')
t('超长镜 → PLAT-01', () => {
  const r = checkPlatformPacing([{ shotNumber: '1-1', durationSec: 12, shotSize: '特写' }], '抖音')
  assert.ok(r.issues.some((i) => i.code === 'PLAT-01'))
})
t('首镜非特写 → PLAT-04（抖音）', () => {
  const r = checkPlatformPacing([{ shotNumber: '1-1', durationSec: 4, shotSize: '远景' }], '抖音')
  assert.ok(r.issues.some((i) => i.code === 'PLAT-04'))
})
t('首镜特写 → 无 PLAT-04', () => {
  const r = checkPlatformPacing([{ shotNumber: '1-1', durationSec: 4, shotSize: '特写' }], '抖音')
  assert.ok(!r.issues.some((i) => i.code === 'PLAT-04'))
})
t('总时长超区间 → PLAT-03', () => {
  const shots = Array.from({ length: 20 }, (_, i) => ({ shotNumber: `${i+1}`, durationSec: 8, shotSize: '特写' }))
  const r = checkPlatformPacing(shots, '抖音')
  assert.ok(r.issues.some((i) => i.code === 'PLAT-03'))
})
t('stats 统计正确', () => {
  const r = checkPlatformPacing([
    { shotNumber: '1', durationSec: 4, shotSize: '特写' },
    { shotNumber: '2', durationSec: 6, shotSize: '近景' },
  ], '抖音')
  assert.equal(r.stats.shots, 2)
  assert.equal(r.stats.totalSec, 10)
  assert.equal(r.stats.avgSec, 5)
})
t('空分镜不报错', () => {
  const r = checkPlatformPacing([], '抖音')
  assert.equal(r.stats.shots, 0)
  assert.equal(r.issues.length, 0)
})
t('B站不因长镜告警（上限 15s）', () => {
  const r = checkPlatformPacing([{ shotNumber: '1', durationSec: 12, shotSize: '中景' }], 'B站')
  assert.ok(!r.issues.some((i) => i.code === 'PLAT-01'))
})

/* ============================================================ 合规 */
console.log('\n[5] compliance —— 合规检查')
t('命中阻断词 → level=block', () => {
  const r = checkCompliance('他在赌场赌博输光了')
  assert.equal(r.level, 'block')
  assert.ok(r.hits.some((h) => h.term === '赌博' && h.level === 'block'))
})
t('命中警告词 → level=warn', () => {
  const r = checkCompliance('两人发生暴力冲突')
  assert.equal(r.level, 'warn')
  assert.ok(r.hits.some((h) => h.term === '暴力'))
})
t('干净文本 → level=none', () => {
  const r = checkCompliance('林夏推开病房的门')
  assert.equal(r.level, 'none')
  assert.equal(r.hits.length, 0)
})
t('空文本 → none', () => {
  assert.equal(checkCompliance('').level, 'none')
  assert.equal(checkCompliance(null).level, 'none')
})
t('block 优先于 warn', () => {
  const r = checkCompliance('暴力殴打之后开始赌博')
  assert.equal(r.level, 'block')
})
t('平台附加词生效', () => {
  const r = checkCompliance('这段内容有点擦边', { platform: '抖音' })
  assert.equal(r.level, 'warn')
  assert.ok(r.hits.some((h) => h.term === '擦边'))
})
t('includeContext 打开后报 context 词', () => {
  const r = checkCompliance('他死在了雨夜', { includeContext: true })
  assert.ok(r.hits.some((h) => h.level === 'context'))
})
t('location 透传', () => {
  const r = checkCompliance('赌博', { location: { shot: '1-2', field: 'dialogue' } })
  assert.equal(r.hits[0].shot, '1-2')
  assert.equal(r.hits[0].field, 'dialogue')
})

console.log('\n[6] checkShotsCompliance —— 批量检查')
t('台词命中阻断词', () => {
  const r = checkShotsCompliance([
    { shotNumber: '1-1', dialogue: '这是赌博', description: '两人对视' },
  ], '抖音')
  assert.equal(r.summary.blocks, 1)
  assert.equal(r.blocks[0].shot, '1-1')
  assert.equal(r.blocks[0].field, 'dialogue')
})
t('多镜多字段汇总', () => {
  const r = checkShotsCompliance([
    { shotNumber: '1', description: '暴力场面' },
    { shotNumber: '2', videoPrompt: '血腥画面' },
  ], '抖音')
  assert.ok(r.summary.warns >= 1)
  assert.ok(r.summary.blocks >= 1)
})
t('干净分镜全零', () => {
  const r = checkShotsCompliance([
    { shotNumber: '1', description: '林夏推开病房门', dialogue: '你来了' },
  ], '抖音')
  assert.equal(r.summary.blocks, 0)
  assert.equal(r.summary.warns, 0)
})
t('空数组安全', () => {
  const r = checkShotsCompliance([], '抖音')
  assert.equal(r.summary.checked, 0)
})
t('词表规模合理', () => {
  assert.ok(BLOCK_TERMS.length >= 20, `BLOCK_TERMS=${BLOCK_TERMS.length}`)
  assert.ok(WARN_TERMS.length >= 15, `WARN_TERMS=${WARN_TERMS.length}`)
})

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
