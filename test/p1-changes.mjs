/**
 * P1 改造单元测试：风格 DNA / 一致性门禁 / brief 模板 / 情绪映射。
 *   node test/p1-changes.mjs
 */

import assert from 'node:assert/strict'
import { normalizeStyleDoc, renderStyleSuffix, STYLE_DIMENSIONS } from '../src/style.js'
import { runGate, SEVERITY } from '../src/gate.js'
import { validateBrief, renderBriefPrompt, emptyBrief, BRIEF_PLATFORMS } from '../src/brief.js'
import { renderObservableEmotion, EMOTION_MAP, intensityWord } from '../src/emotion.js'
import { buildShotVideoPrompt } from '../src/prompt.js'
import { indexCharacters } from '../src/characters.js'

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`) }
}

/* ================================================================ 风格 DNA */
console.log('\n[1] style —— 归一与渲染')
const frozenDoc = {
  schemaVersion: 1, state: 'frozen',
  style: { palette: '冷青蓝为主调，暖橙作冲突点缀', lighting: '高光比，暗部占画面六成', texture: '颗粒感胶片', composition: '', motion: '' },
}
t('归一五维、填了 3 维', () => {
  const n = normalizeStyleDoc(frozenDoc)
  assert.equal(n.filled, 3)
  assert.equal(n.state, 'frozen')
  assert.deepEqual(Object.keys(n.dna).sort(), [...STYLE_DIMENSIONS].sort())
})
t('frozen 渲染出 [视觉风格] 前缀', () => {
  const r = renderStyleSuffix(frozenDoc)
  assert.match(r.suffix, /^\[视觉风格\]/)
  assert.match(r.suffix, /色板：/)
  assert.match(r.suffix, /质感：/)
  assert.equal(r.used.length, 3)
})
t('空维度不进渲染', () => {
  const r = renderStyleSuffix(frozenDoc)
  assert.doesNotMatch(r.suffix, /构图：/)
  assert.doesNotMatch(r.suffix, /运镜：/)
})
t('draft 但五维充实 → 视为可用并注入（v0.5 放宽）', () => {
  const r = renderStyleSuffix({ state: 'draft', style: frozenDoc.style })  // 3 维有内容
  assert.match(r.suffix, /\[视觉风格\]/, '≥3 维有内容应注入')
  assert.ok(r.used.length >= 3)
})
t('draft 且内容稀薄 → 不注入', () => {
  const r = renderStyleSuffix({ state: 'draft', style: { palette: '冷色', lighting: '', texture: '', composition: '', motion: '' } })
  assert.equal(r.suffix, '')
})
t('includeDraft=true 时草稿也注入', () => {
  const r = renderStyleSuffix({ state: 'draft', style: frozenDoc.style }, { includeDraft: true })
  assert.match(r.suffix, /\[视觉风格\]/)
})
t('全空返回空串不报错', () => {
  assert.equal(renderStyleSuffix(null).suffix, '')
  assert.equal(renderStyleSuffix({}).suffix, '')
  assert.equal(renderStyleSuffix({ style: {} }).suffix, '')
})
t('兼容五维写在顶层', () => {
  const r = renderStyleSuffix({ palette: '黑白', state: 'directed' })
  assert.match(r.suffix, /色板：黑白/)
})
t('单维超 300 字被截断', () => {
  const long = '色'.repeat(500)
  const n = normalizeStyleDoc({ style: { palette: long } })
  assert.equal(n.dna.palette.length, 300)
})

/* ================================================================ 门禁 */
console.log('\n[2] gate —— 一致性门禁')
const charIdx = indexCharacters({ characters: [
  { name: '林夏', appearancePrompt: '齐肩黑发' },
  { name: '陈默', appearancePrompt: '寸头' },
] })
t('干净输入 → 通过', () => {
  const r = runGate({
    shots: [{ shotNumber: '1-1', description: '林夏推门', characters: ['林夏'], durationSec: 5 }],
    charIndex: charIdx, styleDoc: frozenDoc,
  })
  assert.equal(r.ok, true)
  assert.equal(r.fails.length, 0)
})
t('无任何描述 → CHK-05 FAIL', () => {
  const r = runGate({ shots: [{ shotNumber: '1-1' }] })
  assert.equal(r.ok, false)
  assert.ok(r.fails.some((f) => f.code === 'CHK-05'))
})
t('镜号重复 → CHK-06 FAIL', () => {
  const r = runGate({ shots: [
    { shotNumber: '1-1', description: 'a' },
    { shotNumber: '1-1', description: 'b' },
  ]})
  assert.ok(r.fails.some((f) => f.code === 'CHK-06'))
})
t('时长越界 → CHK-07 FAIL', () => {
  const r = runGate({ shots: [{ shotNumber: '1-1', description: 'a', durationSec: 20 }] })
  assert.ok(r.fails.some((f) => f.code === 'CHK-07'))
})
t('时长过短 → CHK-08 WARN 而非 FAIL', () => {
  const r = runGate({ shots: [{ shotNumber: '1-1', description: 'a', durationSec: 1 }] })
  assert.equal(r.fails.length, 0)
  assert.ok(r.warns.some((w) => w.code === 'CHK-08'))
})
t('角色不存在 → CHK-01 FAIL', () => {
  const r = runGate({
    shots: [{ shotNumber: '1-1', description: 'a', characters: ['查无此人'] }],
    charIndex: charIdx,
  })
  assert.ok(r.fails.some((f) => f.code === 'CHK-01'))
})
t('无人物卡时 CHK-01 降级 WARN', () => {
  const r = runGate({ shots: [{ shotNumber: '1-1', description: 'a', characters: ['林夏'] }] })
  assert.equal(r.fails.length, 0)
  assert.ok(r.warns.some((w) => w.code === 'CHK-01'))
})
t('无 characters.json → RES-01 WARN（旧项目不误伤）', () => {
  const r = runGate({ shots: [{ shotNumber: '1-1', description: 'a' }] })
  assert.ok(r.warns.some((w) => w.code === 'RES-01'))
  assert.equal(r.fails.length, 0)
})
t('无 style.json → RES-02 WARN', () => {
  const r = runGate({ shots: [{ shotNumber: '1-1', description: 'a' }] })
  assert.ok(r.warns.some((w) => w.code === 'RES-02'))
})
t('draft 且内容稀薄 → RES-03 WARN', () => {
  const r = runGate({
    shots: [{ shotNumber: '1-1', description: 'a' }],
    styleDoc: { state: 'draft', style: { palette: '冷色' } },  // 只 1 维
  })
  assert.ok(r.warns.some((w) => w.code === 'RES-03'))
})
t('draft 但内容充实 → 无 RES-03 告警（v0.5）', () => {
  const r = runGate({
    shots: [{ shotNumber: '1-1', description: 'a' }],
    styleDoc: { state: 'draft', style: frozenDoc.style },  // 3 维
  })
  assert.ok(!r.warns.some((w) => w.code === 'RES-03'), '充实内容不应告警')
})
t('sceneId 缺失 → 默认 WARN', () => {
  const r = runGate({
    shots: [{ shotNumber: '1-1', description: 'a', sceneId: 'SPC-999' }],
    sceneCards: [{ id: 'SPC-001' }],
  })
  assert.ok(r.warns.some((w) => w.code === 'CHK-02'))
  assert.equal(r.fails.length, 0)
})
t('requireScene=true → CHK-02 升级 FAIL', () => {
  const r = runGate({
    shots: [{ shotNumber: '1-1', description: 'a', sceneId: 'SPC-999' }],
    sceneCards: [{ id: 'SPC-001' }],
    requireScene: true,
  })
  assert.ok(r.fails.some((f) => f.code === 'CHK-02'))
})
t('一镜多动作 → PD-08 WARN', () => {
  const r = runGate({ shots: [{ shotNumber: '1-1', description: '他站起转身推门走出去' }] })
  assert.ok(r.warns.some((w) => w.code === 'PD-08'))
})
t('summary 计数正确', () => {
  const r = runGate({ shots: [{ shotNumber: '1-1', description: 'a' }, { shotNumber: '1-2' }] })
  assert.equal(r.summary.checked, 2)
  assert.equal(r.summary.blocked, true)
  assert.equal(r.summary.fails, r.fails.length)
})
t('空 shots 不报错', () => {
  const r = runGate({ shots: [] })
  assert.equal(r.summary.checked, 0)
  assert.equal(r.ok, true)
})

/* ================================================================ brief */
console.log('\n[3] brief —— 输入模板校验')
t('空模板校验报必填缺失', () => {
  // emptyBrief 自带时长/集数/平台默认值，故缺的是题材/核心冲突/主角 3 项
  const r = validateBrief(emptyBrief())
  assert.ok(r.errors.length >= 3, `期望 ≥3 项错误，实际 ${r.errors.length}`)
  assert.ok(r.errors.some((e) => e.includes('题材')))
  assert.ok(r.errors.some((e) => e.includes('核心冲突')))
  assert.ok(r.errors.some((e) => e.includes('主角')))
})
t('完整输入通过', () => {
  const r = validateBrief({
    genre: '都市悬疑', coreConflict: '林夏要真相，院长要掩盖',
    targetDurationSec: 90, episodeCount: 12, platform: '抖音',
    protagonists: [{ name: '林夏', identity: '夜班护士', want: '查清姐姐坠楼真相' }],
    visualTone: { palette: '冷青蓝为主调，暖橙点缀', contrast: '高光比，暗部六成', texture: '颗粒感胶片' },
  })
  assert.equal(r.errors.length, 0)
})
t('非法平台报错', () => {
  const r = validateBrief({ ...emptyBrief(), genre: 'a', coreConflict: 'b', targetDurationSec: 90, episodeCount: 12, platform: 'YouTube', protagonists: [{ name: 'x' }] })
  assert.ok(r.errors.some((e) => e.includes('投放平台')))
})
t('集数越界报错', () => {
  const r = validateBrief({ ...emptyBrief(), genre: 'a', coreConflict: 'b', targetDurationSec: 90, episodeCount: 999, platform: '抖音', protagonists: [{ name: 'x' }] })
  assert.ok(r.errors.some((e) => e.includes('集数')))
})
t('主角为空报错', () => {
  const r = validateBrief({ ...emptyBrief(), genre: 'a', coreConflict: 'b', targetDurationSec: 90, episodeCount: 12, platform: '抖音' })
  assert.ok(r.errors.some((e) => e.includes('主角')))
})
t('空词被识别为笼统', () => {
  const r = validateBrief({ ...emptyBrief(), genre: 'a', coreConflict: 'b', targetDurationSec: 90, episodeCount: 12, platform: '抖音', protagonists: [{ name: 'x' }], visualTone: { palette: '高级感' } })
  assert.ok(r.warnings.some((w) => w.includes('过于笼统')))
})
t('主角>3 人给警告', () => {
  const r = validateBrief({ ...emptyBrief(), genre: 'a', coreConflict: 'b', targetDurationSec: 90, episodeCount: 12, platform: '抖音', protagonists: [{name:'a'},{name:'b'},{name:'c'},{name:'d'}] })
  assert.ok(r.warnings.some((w) => w.includes('稀释')))
})
t('渲染文本含关键字段', () => {
  const txt = renderBriefPrompt({
    genre: '都市悬疑', coreConflict: '真相 vs 掩盖', targetDurationSec: 90, episodeCount: 12, platform: '抖音',
    protagonists: [{ name: '林夏', identity: '护士', want: '查真相' }],
    visualTone: { palette: '冷青蓝' },
  })
  assert.match(txt, /题材：都市悬疑/)
  assert.match(txt, /90 秒 × 12 集/)
  assert.match(txt, /投放平台：抖音/)
  assert.match(txt, /林夏/)
})
t('平台枚举含 6 项', () => assert.equal(BRIEF_PLATFORMS.length, 6))

/* ================================================================ emotion */
console.log('\n[4] emotion —— 可观测映射')
t('已映射情绪转画面语言', () => {
  const s = renderObservableEmotion({ label: '警觉', intensity: 70 })
  assert.match(s, /情绪外化/)
  assert.match(s, /瞳孔收缩/)
  assert.match(s, /幅度明显/)
})
t('未映射情绪标为内在状态', () => {
  const s = renderObservableEmotion({ label: '惆怅' })
  assert.match(s, /内在状态/)
  assert.match(s, /勿画抽象符号/)
})
t('字符串输入可用', () => {
  assert.match(renderObservableEmotion('愤怒'), /情绪外化/)
})
t('空输入返回空串', () => {
  assert.equal(renderObservableEmotion(null), '')
  assert.equal(renderObservableEmotion({}), '')
  assert.equal(renderObservableEmotion(''), '')
})
t('强度分档', () => {
  assert.equal(intensityWord(90), '幅度极大')
  assert.equal(intensityWord(70), '幅度明显')
  assert.equal(intensityWord(50), '幅度适中')
  assert.equal(intensityWord(30), '幅度轻微')
  assert.equal(intensityWord(10), '几乎不可察')
  assert.equal(intensityWord('x'), '')
})
t('映射表覆盖 ≥30 情绪', () => assert.ok(Object.keys(EMOTION_MAP).length >= 30))

/* ================================================================ prompt 集成 */
console.log('\n[5] prompt —— 三件套同时注入')
const shot = { shotNumber: '1-1', description: '林夏推门而入', emotion: { label: '警觉', intensity: 70 } }
t('锚点 + 风格 + 情绪齐全（v2 结构）', () => {
  const cards = [{ name: '林夏', appearancePrompt: '齐肩黑发，左眉有疤' }]
  const p = buildShotVideoPrompt(shot, {
    ratio: '9:16',
    characterAnchor: '[角色锚点] 林夏：齐肩黑发，左眉有疤',
    characterNames: cards,
    styleDna: { palette: '冷青蓝', texture: '颗粒感' },
  })
  assert.match(p, /^齐肩黑发/, '锚点形象在开头')
  assert.doesNotMatch(p, /林夏/, '姓名已剔除')
  assert.match(p, /色调偏冷青蓝/, '风格色板已注入')
  assert.match(p, /竖屏构图 9:16/)
  assert.doesNotMatch(p, /情绪：警觉（强度/, '不应再有裸元数据')
  assert.match(p, /瞳孔收缩/, '情绪已转可观测描述')
})
t('画幅声明在末尾且只出现一次', () => {
  const p = buildShotVideoPrompt(shot, { styleDna: { palette: '冷青蓝' } })
  const hits = (p.match(/9:16/g) || []).length
  assert.equal(hits, 1, `画幅应只出现一次，实际 ${hits} 次`)
})
t('最小输入也能构建（无锚点无风格）', () => {
  const p = buildShotVideoPrompt({ shotNumber: '1-1', shotSize: '中景', description: '她推门' }, {})
  assert.match(p, /她推门/)
  assert.match(p, /竖屏构图 9:16/)
  assert.doesNotMatch(p, /角色锚点|视觉风格/)
})

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
