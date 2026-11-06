/**
 * P8：跨阶段关联图单测。
 *
 * 背景：六个阶段各写一份 JSON，结构里没有互相指认。逐个页签看像是六份
 * 互不相干的内容。本模块把它们串起来：角色出场弧线、伏笔回收链、场景使用。
 *
 *   node test/p8-link.mjs
 */
import assert from 'node:assert/strict'
import { buildLinkGraph } from '../src/link.js'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }

/** 仿「山海经」的真实形状。 */
const BUNDLE = {
  contract: {
    title: '山海饲妖人',
    worldSpace: '地面是城中村旧货市场，地下是山海市集，顶层为昆仑墟玻璃高塔',
    powerSystem: '以命饲妖',
  },
  outline: [
    { order: 1, title: '血开残卷', logline: '沈砚在旧货摊血溅图鉴', hook: '沈砚：这是我的', twist: '默爷现身', cliffhanger: '烛阴睁眼' },
    { order: 2, title: '以命换爪', logline: '老周带人上门抢图鉴', hook: '老周：交出来', twist: '沈砚唤兽', cliffhanger: '默爷观察' },
    { order: 3, title: '山海市集', logline: '沈砚循暗码下到市集', hook: '沈砚：这骨头是假的', twist: '默爷当众鉴骨', cliffhanger: '烛阴苏醒' },
  ],
  characters: [
    { name: '沈砚', role: '主角' },
    { name: '默爷', role: '反派' },
    { name: '烛阴', role: '配角' },
    { name: '老周', role: '龙套' },
    { name: '陆三爷', role: '反派' },   // 大纲里没出场 → 应为孤儿
  ],
  world: [
    { kind: '地点', name: '城中村旧货市场' },   // 大纲没提 → 孤儿场景
    { kind: '地点', name: '山海市集' },
    { kind: '组织', name: '陆氏御兽世家' },
  ],
  memory: [
    { id: 'm1', kind: '伏笔', content: '沈砚血溅图鉴，第六集证实反噬', episode: 1, payoffEpisode: 6, status: 'open', relatedCharacters: ['沈砚'] },
    { id: 'm2', kind: '伏笔', content: '默爷袖口滑出妖瞳', episode: 3, status: 'open' },   // 无回收点
    { id: 'm3', kind: '伏笔', content: '烛阴只吐半名，第九集又念', episode: 1, status: 'open' }, // 从文字里推第九集
    { id: 'm4', kind: '已用桥段', content: '抢图鉴' },
  ],
  style: { style: { palette: '冷', lighting: '山海市集靠妖火照明', texture: '', composition: '', motion: '' } },
}

console.log('\n[1] 汇总指标')
const g = buildLinkGraph(BUNDLE)
ok('集数正确', g.totals.episodes === 3, String(g.totals.episodes))
ok('角色数正确', g.totals.characters === 5)
ok('场景数正确', g.totals.places === 3, String(g.totals.places))
ok('伏笔数只算伏笔', g.totals.foreshadows === 3, String(g.totals.foreshadows))
ok('平均登场角色为数字', typeof g.totals.avgCharsPerEpisode === 'number')
ok('伏笔回收率为百分比', g.totals.foreshadowCoverage >= 0 && g.totals.foreshadowCoverage <= 100)

console.log('\n[2] 逐集关联（角色/场景/伏笔）')
ok('逐集条数 = 集数', g.episodeMap.length === 3)
const ep1 = g.episodeMap[0]
ok('第1集识别出沈砚', ep1.characters.includes('沈砚'), ep1.characters.join(','))
ok('第1集识别出默爷', ep1.characters.includes('默爷'))
ok('第1集识别出烛阴', ep1.characters.includes('烛阴'))
ok('第3集识别出山海市集场景', g.episodeMap[2].places.includes('山海市集'), g.episodeMap[2].places.join(','))
ok('第1集有伏笔埋入', ep1.foreshadows.length >= 1, String(ep1.foreshadows.length))

console.log('\n[3] 角色出场弧线')
const arcs = new Map(g.characterArcs.map(c => [c.name, c]))
ok('沈砚覆盖全部 3 集', arcs.get('沈砚').episodeCount === 3, String(arcs.get('沈砚').episodeCount))
ok('沈砚首末集正确', arcs.get('沈砚').firstEpisode === 1 && arcs.get('沈砚').lastEpisode === 3)
ok('陆三爷未登场', arcs.get('陆三爷').episodeCount === 0)
ok('老周只在第2集', arcs.get('老周').episodes.join(',') === '2', arcs.get('老周').episodes.join(','))
ok('角色弧线带 role', arcs.get('沈砚').role === '主角')

console.log('\n[4] 伏笔链')
const fs1 = g.foreshadowChains.find(f => f.id === 'm1')
ok('m1 有回收点', fs1.payoffAt === 6)
ok('m1 跨度正确', fs1.spanEpisodes === 5, String(fs1.spanEpisodes))
ok('m1 标注为已声明', fs1.payoffDeclared === true)
const fs2 = g.foreshadowChains.find(f => f.id === 'm2')
ok('m2 缺回收点', fs2.payoffAt === null)
ok('m2 出现在缺口清单', g.orphans.foreshadowsWithoutPayoff.length >= 1)
const fs3 = g.foreshadowChains.find(f => f.id === 'm3')
ok('m3 从文字推出第九集', fs3.payoffAt === 9, String(fs3.payoffAt))
ok('m3 标注为推断（未声明）', fs3.payoffDeclared === false)
ok('伏笔按埋设集号排序', g.foreshadowChains[0].plantedAt <= g.foreshadowChains[g.foreshadowChains.length-1].plantedAt)
ok('已用桥段不算伏笔', !g.foreshadowChains.some(f => f.id === 'm4'))

console.log('\n[5] 场景使用')
const su = new Map(g.sceneUsage.map(s => [s.name, s]))
ok('山海市集被使用', su.get('山海市集').episodeCount >= 1, String(su.get('山海市集').episodeCount))
ok('城中村旧货市场未被使用', su.get('城中村旧货市场').episodeCount === 0)
ok('场景按使用频率排序', g.sceneUsage[0].episodeCount >= g.sceneUsage[g.sceneUsage.length-1].episodeCount)

console.log('\n[6] 风格 DNA 承接')
const light = g.styleLinks.find(x => x.dimension === 'lighting')
ok('lighting 承接了世界观', light && light.worldRefs.includes('山海市集'), light ? light.worldRefs.join(',') : '(无)')
ok('空维度被过滤', !g.styleLinks.some(x => !x.text))

console.log('\n[7] 孤儿检测')
ok('角色孤儿含陆三爷', g.orphans.characters.includes('陆三爷'), g.orphans.characters.join(','))
ok('场景孤儿含城中村', g.orphans.places.includes('城中村旧货市场'), g.orphans.places.join(','))
ok('已登场角色不在孤儿表', !g.orphans.characters.includes('沈砚'))

console.log('\n[8] 边界：空数据不崩')
const empty = buildLinkGraph({})
ok('空 bundle 不抛错', !!empty)
ok('空集数 0', empty.totals.episodes === 0)
ok('空角色 0', empty.totals.characters === 0)
ok('空伏笔回收率 0', empty.totals.foreshadowCoverage === 0)
ok('空孤儿表为空', Object.values(empty.orphans).every(v => Array.isArray(v) && v.length === 0))

console.log('\n[9] 纯读：不修改输入')
const snapshot = JSON.stringify(BUNDLE)
buildLinkGraph(BUNDLE)
ok('输入 bundle 未被改动', JSON.stringify(BUNDLE) === snapshot)

console.log('\n[10] 修复回归：声明字段必须被采信（用户报「修完仍提示」）')
// 早前只认「大纲文本里出现场景名」，模型声明了 usedInEpisodes=[1,2] 也被判未使用，
// 导致缺口永远修不掉。现在两条证据合并。
const DECLARED = {
  contract: { worldSpace: 'a', powerSystem: 'b' },
  // 大纲文字里完全没提这些场景名
  outline: [{ order: 1, title: 'a', logline: 'l', hook: 'h', twist: 't', cliffhanger: 'c' },
            { order: 2, title: 'b', logline: 'l', hook: 'h', twist: 't', cliffhanger: 'c' }],
  characters: [
    { name: '沈砚', role: '主角', arcEpisodes: [1, 2] },   // 只靠声明，文本没提
  ],
  world: [
    { kind: '地点', name: '城中村旧货市场', usedInEpisodes: [1, 2] },
    { kind: '地点', name: '昆仑墟玻璃高塔', usedInEpisodes: [2] },
    { kind: '组织', name: '陆氏御兽世家', usedInEpisodes: [1] },
  ],
  memory: [{ id: 'm1', kind: '伏笔', content: 'x', episode: 1, payoffEpisode: 2 }],
  style: { style: { palette: '冷' } },
}
const dg = buildLinkGraph(DECLARED)

ok('usedInEpisodes 被采信', dg.sceneUsage.find(s => s.name === '城中村旧货市场').episodeCount === 2,
   String(dg.sceneUsage.find(s => s.name === '城中村旧货市场').episodeCount))
ok('证据标记为 declared', dg.sceneUsage.find(s => s.name === '城中村旧货市场').evidence === 'declared')
ok('有声明的场景不是孤儿', dg.orphans.places.length === 0, dg.orphans.places.join(','))
ok('arcEpisodes 被采信', dg.characterArcs.find(c => c.name === '沈砚').episodeCount === 2)
ok('有 arcEpisodes 的角色不是孤儿', dg.orphans.characters.length === 0)

// 两条证据都有时标 both
const BOTH = {
  ...DECLARED,
  outline: [{ order: 1, title: '城中村旧货市场', logline: '沈砚去城中村', hook: 'h', twist: 't', cliffhanger: 'c' }],
  world: [{ kind: '地点', name: '城中村旧货市场', usedInEpisodes: [1, 2] }],
}
const bg = buildLinkGraph(BOTH)
ok('两条证据合并后不重复', bg.sceneUsage[0].episodes.join(',') === '1,2', bg.sceneUsage[0].episodes.join(','))
ok('证据标记为 both', bg.sceneUsage[0].evidence === 'both')

// 无声明仍靠文本
const TEXTONLY = {
  ...DECLARED,
  characters: [{ name: '沈砚', role: '主角' }],
  world: [{ kind: '地点', name: '城中村旧货市场' }],
  outline: [{ order: 1, title: 'a', logline: '沈砚在城中村旧货市场', hook: 'h', twist: 't', cliffhanger: 'c' }],
}
const tg = buildLinkGraph(TEXTONLY)
ok('无声明时靠文本仍能识别', tg.sceneUsage[0].episodeCount === 1)
ok('证据标记为 text', tg.sceneUsage[0].evidence === 'text')
ok('两者都无则为 none', buildLinkGraph({
  ...DECLARED, world: [{ kind:'地点', name:'某地' }], outline: [{ order:1, title:'a', logline:'l', hook:'h', twist:'t', cliffhanger:'c' }],
}).sceneUsage.find(s=>s.name==='某地').evidence === 'none')

// 伏笔回收推断放宽：认「N集后」「第十一集」
ok('推断「N集后」',
   buildLinkGraph({ ...DECLARED, memory: [{ id:'m', kind:'伏笔', content:'三集后揭晓', episode:1 }] })
     .foreshadowChains[0].payoffAt === 3)
ok('推断中文数字集号',
   buildLinkGraph({ ...DECLARED, memory: [{ id:'m', kind:'伏笔', content:'第十一集揭真相', episode:1 }] })
     .foreshadowChains[0].payoffAt === 11)

// 真实无回收的仍应报（不误放行）
ok('真缺口仍被检出',
   buildLinkGraph({ ...DECLARED, memory: [{ id:'m', kind:'伏笔', content:'某个暗示，未提回收', episode:1 }] })
     .orphans.foreshadowsWithoutPayoff.length === 1)

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
