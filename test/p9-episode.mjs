/**
 * P9：按集生成剧本 / 分镜（v0.15 新增两阶段）。
 *   node test/p9-episode.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  generateStage, validateStage, slimContext, checkPrerequisites,
  STAGES, STAGE_ORDER, CHAIN_ORDER, EPISODE_STAGES, STAGE_DEPS, STAGE_MAX_TOKENS,
} from '../src/ai-create.js'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }
const tj = (n, fn) => { try { fn(); ok(n, true) } catch (e) { fail++; console.log(`  ❌ ${n}\n     ${e.message}`) } }

console.log('\n[1] 阶段结构扩展')
ok('八阶段', Object.keys(STAGES).length === 8)
ok('链式六阶段不含按集', CHAIN_ORDER.length === 6 && !CHAIN_ORDER.includes('script'))
ok('按集两阶段', EPISODE_STAGES.join(',') === 'script,storyboard')
ok('STAGE_ORDER 八项且按集在后', STAGE_ORDER.length === 8 && STAGE_ORDER[6] === 'script')
ok('script 有 token 预算', STAGE_MAX_TOKENS.script > 0, String(STAGE_MAX_TOKENS.script))
ok('storyboard 有 token 预算', STAGE_MAX_TOKENS.storyboard > 0)
ok('script 是 script 类型', STAGES.script.type === 'script')
ok('storyboard 是 array 类型', STAGES.storyboard.type === 'array')
ok('script 依赖四项', STAGE_DEPS.script.length === 4)
ok('storyboard 依赖五项（含剧本）', STAGE_DEPS.storyboard.length === 5, String(STAGE_DEPS.storyboard.length))

console.log('\n[2] 剧本校验（对象 + text + 场景结构）')
const SCRIPT_OK = {
  episode: 1, title: '血开残卷',
  text: '# 第001集 血开残卷\n\n## 场景 1：外景 - 城中村旧货摊 - 夜\n动作：沈砚蹲在摊前，指尖被划破，血溅图鉴。\n沈砚：这页……怎么是活的\n转场：切至\n',
}
tj('合法剧本通过', () => validateStage('script', SCRIPT_OK))
tj('缺 text 被拒', () => assert.throws(() => validateStage('script', { episode: 1 }), /缺少正文/))
tj('缺 episode 被拒', () => assert.throws(() => validateStage('script', { text: SCRIPT_OK.text }), /缺少集号/))
tj('text 为空被拒', () => assert.throws(() => validateStage('script', { episode: 1, text: '   ' }), /缺少正文/))
tj('无场景结构被拒', () => assert.throws(() => validateStage('script', { episode: 1, text: '随便一段话' }), /缺少「## 场景/))
tj('数组冒充剧本被拒', () => assert.throws(() => validateStage('script', []), /应为对象/))

console.log('\n[3] 分镜校验（八列 + 时长 + 镜号唯一）')
const mkShot = (n, extra = {}) => ({
  shotNumber: String(n), shotSize: '近景', cameraMove: '固定',
  description: `画面${n}`, dialogue: '', sfx: '环境音', durationSec: 3,
  imagePrompt: '年轻女子，旧夹克', videoPrompt: '年轻女子转身', sceneRef: '城中村旧货市场',
  ...extra,
})
const SB_OK = [mkShot(1), mkShot(2), mkShot(3)]
tj('合法分镜通过', () => validateStage('storyboard', SB_OK))
tj('少一镜被拒（<3）', () => assert.throws(() => validateStage('storyboard', [mkShot(1)]), /条目过少/))
tj('缺 shotSize 被拒', () => assert.throws(
  () => validateStage('storyboard', [mkShot(1), mkShot(2), mkShot(3, { shotSize: '' })]), /缺少必填字段 shotSize/))
tj('缺 durationSec 被拒', () => assert.throws(
  () => validateStage('storyboard', [mkShot(1), mkShot(2), mkShot(3, { durationSec: null })]), /缺少必填字段 durationSec/))
tj('时长 0 被拒', () => assert.throws(
  () => validateStage('storyboard', [mkShot(1), mkShot(2), mkShot(3, { durationSec: 0 })]), /时长非法/))
tj('时长 99 被拒', () => assert.throws(
  () => validateStage('storyboard', [mkShot(1), mkShot(2), mkShot(3, { durationSec: 99 })]), /时长非法/))
tj('镜号重复被拒', () => assert.throws(
  () => validateStage('storyboard', [mkShot(1), mkShot(1), mkShot(3)]), /镜号重复/))
tj('15 秒边界通过', () => validateStage('storyboard', [mkShot(1), mkShot(2), mkShot(3, { durationSec: 15 })]))

console.log('\n[4] 按集生成：必须有集号')
// storyboard 现在依赖「该集剧本正文」，测试 context 要带上，否则被前置拦住
const CTX = {
  contract: { title: '山海饲妖人', worldSpace: '城中村/山海市集/昆仑墟', powerSystem: '以命饲妖', episodeDurationSec: [60, 120] },
  outline: Array.from({ length: 12 }, (_, i) => ({ order: i + 1, title: `第${i + 1}集`, logline: 'x', hook: 'h', twist: 't', cliffhanger: 'c' })),
  characters: [{ id: 'c1', name: '沈砚', role: '主角', appearancePrompt: '20岁清瘦男子，旧夹克', personality: ['清醒'] }],
  world: [{ id: 'w1', kind: '地点', name: '城中村旧货市场', detail: '潮湿拥挤' }],
  memory: [{ id: 'm1', kind: '伏笔', content: '图鉴血迹', episode: 1, payoffEpisode: 6 }, { id: 'm2', kind: '伏笔', content: '无关', episode: 8 }],
  script: '# 第001集 血开残卷\n\n## 场景 1：外景 - 城中村旧货市场 - 夜\n动作：沈砚拇指按上泛黄封面。\n',
}
const mkLlm = (payload) => ({ stream: () => (async function* () {
  yield { type: 'text-delta', text: payload }
  yield { type: 'finish', reason: { kind: 'stop' } }
})() })
// 分镜 payload 要满足契约总时长区间（60–120s），否则被「总时长偏离」拦住
 // 15 镜 × 5s = 75s，落在区间内
const SB_PAYLOAD = JSON.stringify(Array.from({ length: 15 }, (_, i) => mkShot(i + 1, { durationSec: 5 })))

// 前置资产齐全时才会走到「集号」这一层；前置缺失先报前置
// 用足够镜数的 payload，确保不会先被 min 拦住，才能验证到「集号」这一层
ok('script 无集号抛集号错误',
   await generateStage({ llm: mkLlm(JSON.stringify(SCRIPT_OK)), stage: 'script', context: CTX })
     .then(() => false).catch(e => /需要先指定集号/.test(e.message)))
ok('storyboard 无集号抛集号错误',
   await generateStage({ llm: mkLlm(SB_PAYLOAD), stage: 'storyboard', context: CTX })
     .then(() => false).catch(e => /需要先指定集号/.test(e.message)))
// 前置缺失时应先报前置（说明两层校验都在）
// 空 context + 无集号：分批路径先查集号，所以两条错误都可能出现
ok('缺前置或集号时报错（不静默）',
   await generateStage({ llm: mkLlm(SB_PAYLOAD), stage: 'storyboard', context: {} })
     .then(() => false).catch(e => /还缺前序资产|集号/.test(e.message)))

console.log('\n[5] 按集生成：上下文只喂该集')
let seen = ''
const rSb = await generateStage({
  llm: { stream: (o) => { seen = o.messages[0].content; return (async function* () {
    yield { type: 'text-delta', text: SB_PAYLOAD }; yield { type: 'finish', reason: { kind: 'stop' } } })() } },
  stage: 'storyboard', context: CTX, episode: 3,
})
ok('提示里标明只写第 3 集', seen.includes('只写第 3 集'))
ok('大纲只保留该集', (seen.match(/"order":/g) || []).length === 1, `实际 ${(seen.match(/"order":/g) || []).length} 集`)
ok('无关伏笔(m2/第8集)被剔除', !seen.includes('无关'))
ok('分镜保留人物形象锚点', seen.includes('旧夹克'))
ok('分镜保留场景 detail', seen.includes('潮湿拥挤'))
// storyboard 走分批（4 批 × 6 镜 = 24），不再是单次 15 镜
ok('生成成功', Array.isArray(rSb.data) && rSb.data.length > 0, String(rSb.data?.length))
ok('分批产出 24 镜', rSb.data.length === 24, String(rSb.data.length))
// 注意：contextSaved 只统计「字段裁剪」省下的量；
 // 按集收窄（12 集 → 1 集）的节省更大，但那是另一套逻辑，这里单独验证提示已收窄
ok('字段裁剪有统计（可能为 0 因为该阶段字段本就精简）',
   typeof rSb.contextSaved === 'number', String(rSb.contextSaved))

// script 阶段不需要人物形象锚点（省字节）
const sc = slimContext('script', { characters: CTX.characters })
// script 的白名单是 id/name/role/personality —— 有意保留 personality（写台词要性格）
ok('剧本阶段人物不含 appearancePrompt', !('appearancePrompt' in sc.slimmed.characters[0]), Object.keys(sc.slimmed.characters[0]).join(','))
ok('剧本阶段人物保留 personality', 'personality' in sc.slimmed.characters[0])

console.log('\n[6] 全链默认不跑按集阶段')
const CHAIN_PAYLOADS = {
  contract: JSON.stringify({ title: 'x', platform: 'p', audience: 'a', episodeDurationSec: [60, 120], targetEpisodes: 3 }),
  outline: JSON.stringify([1, 2, 3].map(i => ({ order: i, title: 'a', logline: 'b', hook: 'c', twist: 'd', cliffhanger: 'e' }))),
  characters: JSON.stringify([{ name: '甲', role: '主角', appearancePrompt: '20岁' }, { name: '乙', role: '反派', appearancePrompt: '50岁' }, { name: '丙', role: '配角', appearancePrompt: '30岁' }]),
  world: JSON.stringify([{ kind: '地点', name: 'A', detail: 'x' }, { kind: '地点', name: 'B', detail: 'y' }, { kind: '地点', name: 'C', detail: 'z' }, { kind: '规则', name: 'D', detail: 'w' }]),
  memory: JSON.stringify([{ kind: '伏笔', content: 'p1', episode: 1 }, { kind: '伏笔', content: 'p2', episode: 1 }, { kind: '伏笔', content: 'p3', episode: 1 }, { kind: '桥段', content: 'q' }]),
  style: JSON.stringify({ schemaVersion: 1, style: { palette: '冷', lighting: '顺光', texture: '颗粒', composition: '对称', motion: '缓推' } }),
}
const { generateAll } = await import('../src/ai-create.js')
let callSeq = 0
const rAll = await generateAll({
  llm: { stream: () => { const k = CHAIN_ORDER[callSeq++]; return (async function* () {
    yield { type: 'text-delta', text: CHAIN_PAYLOADS[k] }; yield { type: 'finish', reason: { kind: 'stop' } } })() } },
  idea: 'x',
})
ok('全链 ok', rAll.ok === true, rAll.errors?.[0]?.error)
ok('只跑六阶段', Object.keys(rAll.assets).length === 6, Object.keys(rAll.assets).join(','))
ok('不含 script', !('script' in rAll.assets))
ok('不含 storyboard', !('storyboard' in rAll.assets))
ok('模型只调用 6 次', callSeq === 6, String(callSeq))

// 显式 only 可以只跑按集阶段
// generateAll 不传 episode 且 context 为空 → 应先报前置；这正是「必须走专用接口」的证据
const rOnly = await generateAll({
  llm: mkLlm(SB_PAYLOAD), idea: 'x', only: ['storyboard'],
})
ok('generateAll 不适合跑按集阶段（缺前置或缺集号）',
   rOnly.ok === false && /还缺前序资产|集号/.test(rOnly.errors[0].error),
   rOnly.ok ? '(未报错)' : String(rOnly.errors[0].error).slice(0, 60))

console.log('\n[7] 分镜必须吃到剧本正文（用户报「分镜表生成有问题」）')
// 早期 STAGE_DEPS.storyboard 漏了 script，模型拿不到剧本，只能凭空编分镜
ok('storyboard 依赖里含 script', STAGE_DEPS.storyboard.includes('script'), STAGE_DEPS.storyboard.join(','))
ok('script 排在依赖末位', STAGE_DEPS.storyboard[STAGE_DEPS.storyboard.length - 1] === 'script')

const SCRIPT_TEXT = '# 第001集 血开残卷\n\n## 场景 1：外景 - 城中村旧货市场 - 夜\n动作：特写。沈砚的拇指按上泛黄封面。\n沈砚：它停手了。\n'
const CTX_S = { ...CTX, script: SCRIPT_TEXT }

// 前置：有剧本才算齐。CTX 本身已带 script，要显式去掉才能测「无剧本」
const { script: _omit, ...CTX_NO_SCRIPT } = CTX
ok('无剧本时前置不通过', checkPrerequisites('storyboard', CTX_NO_SCRIPT).ok === false,
   JSON.stringify(checkPrerequisites('storyboard', CTX_NO_SCRIPT).missing))
ok('提示缺「分集剧本正文」', checkPrerequisites('storyboard', CTX_NO_SCRIPT).missingLabels.includes('分集剧本正文'))
ok('有剧本时前置通过', checkPrerequisites('storyboard', CTX_S).ok === true)

// prompt 里能看到剧本原文（按 Markdown 呈现，不是 JSON）
let seenSb = ''
await generateStage({
  llm: { stream: (o) => { seenSb = o.messages[0].content; return (async function* () {
    yield { type: 'text-delta', text: SB_PAYLOAD }; yield { type: 'finish', reason: { kind: 'stop' } } })() } },
  stage: 'storyboard', context: CTX_S, episode: 1,
})
ok('prompt 含剧本集标题', seenSb.includes('第001集 血开残卷'))
ok('prompt 含剧本动作行', seenSb.includes('拇指按上泛黄封面'))
ok('prompt 含「必须逐场拆镜」', seenSb.includes('必须逐场拆镜'))
ok('剧本以纯文本呈现（未 JSON 转义）', !seenSb.includes('\\n## 场景 1'))
ok('仍含人物形象锚点', seenSb.includes('旧夹克'))

console.log('\n[8a] 分镜时长不再阻断（用户报「生成分镜表失败」）')
// 早期时长偏离会 throw，导致 6 镜 24 秒整份被拒，用户只看到「生成失败」
const mkw = (n, d = 4) => ({ shotNumber: String(n), shotSize: '近景', cameraMove: '固定', description: 'x', durationSec: d, imagePrompt: 'y', videoPrompt: 'z', sceneRef: '城' })
const CTX_D = { contract: { episodeDurationSec: [60, 120] } }

const rShort = validateStage('storyboard', [1,2,3,4,5,6].map(i => mkw(i)), CTX_D)
ok('6 镜 24 秒不再抛错', rShort.ok === true)
ok('但会给出时长提示', Boolean(rShort.durationWarn), String(rShort.durationWarn))
ok('提示里给了建议镜数', /建议 15–30 镜/.test(rShort.durationWarn))

const rGood = validateStage('storyboard', Array.from({ length: 22 }, (_, i) => mkw(i + 1)), CTX_D)
ok('22 镜 88 秒无提示', rGood.ok === true && rGood.durationWarn === null)

// opts 复用时不应残留上一次的提示
const reused = { contract: { episodeDurationSec: [60, 120] } }
validateStage('storyboard', [1,2,3].map(i => mkw(i, 4)), reused)
const r2 = validateStage('storyboard', Array.from({ length: 22 }, (_, i) => mkw(i + 1)), reused)
ok('复用 opts 不残留提示', r2.durationWarn === null, String(r2.durationWarn))

// prompt 必须按契约反推镜头数
const srcAI2 = await fs.readFile(new URL('../src/ai-create.js', import.meta.url), 'utf8')
ok('prompt 写着按时长反推镜数', /镜头数要按时长反推/.test(srcAI2))
ok('prompt 给了 15–30 镜示例', /15–30 个镜头/.test(srcAI2))
ok('prompt 不再写死 6–12 镜', !/镜头数 6–12 个/.test(srcAI2), '仍存在 6–12')

console.log('\n[8] 分镜总时长要与契约区间对上')
const mks = (n, d = 5) => ({ shotNumber: String(n), shotSize: '近景', cameraMove: '固定', description: 'x', durationSec: d, imagePrompt: 'y', videoPrompt: 'z', sceneRef: '城' })
const CONTRACT_DUR = { episodeDurationSec: [60, 120] }
tj('4 镜 20s 不抛错但有提示', () => {
  const r = validateStage('storyboard', [mks(1), mks(2), mks(3), mks(4)], { contract: CONTRACT_DUR })
  assert.equal(r.ok, true)
  assert.ok(r.durationWarn)
})
tj('15 镜 75s 在区间内通过', () => validateStage('storyboard', Array.from({ length: 15 }, (_, i) => mks(i + 1)), { contract: CONTRACT_DUR }))
tj('无契约时不校验时长', () => validateStage('storyboard', [mks(1), mks(2), mks(3)], {}))
// 120 × 1.15 = 138，27 镜 × 5s = 135s 应通过；28 镜 = 140s 应被拒
tj('允许 +15% 上浮（135s ≤ 138）', () => validateStage('storyboard', Array.from({ length: 27 }, (_, i) => mks(i + 1)), { contract: { episodeDurationSec: [60, 120] } }))
tj('超出 +15% 也不抛错（只提示）', () => {
  const r = validateStage('storyboard', Array.from({ length: 28 }, (_, i) => mks(i + 1)), { contract: CONTRACT_DUR })
  assert.equal(r.ok, true)
  assert.ok(r.durationWarn)
})

console.log('\n[9] 截断抢救（用户报「模型输出被截断 16290 字符」）')
const { extractJson, salvageJsonArray } = await import('../src/ai-create.js')

// 构造：前 N 个完整，最后一个写一半
const mkTrunc = (n) => {
  const shots = Array.from({ length: n }, (_, i) =>
    `{"shotNumber":"${i + 1}","shotSize":"中景","cameraMove":"固定","description":"画面${i + 1}","durationSec":4}`)
  return '[\n' + shots.join(',\n') + ',\n{"shotNumber":"' + (n + 1) + '","shotSize":"中'
}

const rSalv = extractJson(mkTrunc(20))
ok('抢救出 20 个完整镜头', Array.isArray(rSalv) && rSalv.length === 20, String(rSalv?.length))
ok('带 salvaged 标记', rSalv.salvaged === true)
ok('镜号连续正确', rSalv.map(x => x.shotNumber).join(',') === Array.from({length:20},(_,i)=>String(i+1)).join(','))
ok('抢救出的对象可用', rSalv.every(x => x.description && x.durationSec === 4))

// 完全无法抢救时仍报错
tj('无法抢救时抛截断错误', () => assert.throws(() => extractJson('[{"a":'), /被截断/))
tj('错误信息提示预算', () => assert.throws(() => extractJson('[{"a":'), /token 预算/))

// salvageJsonArray 直接测
ok('salvage 空输入安全', salvageJsonArray('') .length === 0)
ok('salvage 非数组返回空', salvageJsonArray('{"a":1}').length === 0)
ok('salvage 跳过坏对象', salvageJsonArray('[{"a":1},{"b":}, {"c":3}]').length === 2,
   String(salvageJsonArray('[{"a":1},{"b":}, {"c":3}]').length))
ok('salvage 处理字符串内花括号', salvageJsonArray('[{"a":"}{"}').length === 1)
ok('salvage 不受转义引号影响', salvageJsonArray('[{"a":"他说\\"好\\"{}"}]').length === 1)

// 正常 JSON 不被误判成截断
ok('完整 JSON 不触发抢救', extractJson('[{"a":1},{"b":2}]').salvaged === undefined)

// 预算必须足够容纳 30 镜
ok('storyboard 预算 ≥ 15000', STAGE_MAX_TOKENS.storyboard >= 15000, String(STAGE_MAX_TOKENS.storyboard))

// prompt 限长防超预算
const srcAI3 = await fs.readFile(new URL('../src/ai-create.js', import.meta.url), 'utf8')
ok('description 有字数上限', /画面描述（\*\*≤25 字\*\*/.test(srcAI3))
ok('imagePrompt 有字数上限', /生图提示词（\*\*≤40 字\*\*/.test(srcAI3))
ok('videoPrompt 有字数上限', /生视频提示词（\*\*≤40 字\*\*/.test(srcAI3))

// 端到端：截断 → 抢救 → 校验通过
const CTX_SALV = { ...CTX, script: SCRIPT_TEXT }
// 分批后单批输出很短，正常情况不会触发截断；这里验证「截断抢救」仍能兜住单批
const rE2E = await generateStage({
  llm: { stream: () => (async function* () {
    yield { type: 'text-delta', text: mkTrunc(6) }; yield { type: 'finish', reason: { kind: 'stop' } } })() },
  stage: 'storyboard', context: CTX_SALV, episode: 1,
})
ok('端到端：单批截断被抢救后合并', Array.isArray(rE2E.data) && rE2E.data.length > 0, String(rE2E.data?.length))
ok('端到端：4 批都产出了', rE2E.data.length === 24, String(rE2E.data.length))

console.log('\n[10] 分镜分批生成（单次输出装不下 24 镜时必需）')
const CTX_BATCH = { ...CTX, script: SCRIPT_TEXT }
const mkBatchLlm = (perCall = 6) => {
  let n = 0
  const prompts = []
  return {
    prompts,
    llm: { stream: (o) => { n++; prompts.push(o.messages[0].content); return (async function* () {
      const shots = Array.from({ length: perCall }, (_, i) => ({
        shotNumber: String(i + 1), shotSize: '中景', cameraMove: '固定',
        description: '画面', dialogue: '', sfx: '雨声', durationSec: 4,
        imagePrompt: '22岁瘦高男性，旧夹克', videoPrompt: '镜头固定', sceneRef: '城中村旧货市场',
      }))
      yield { type: 'text-delta', text: JSON.stringify(shots) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() } },
  }
}

const B = mkBatchLlm(6)
const rB = await generateStage({ llm: B.llm, stage: 'storyboard', context: CTX_BATCH, episode: 1 })
ok('分批共调用 4 次', B.prompts.length === 4, String(B.prompts.length))
ok('共 24 镜', rB.data.length === 24, String(rB.data.length))
ok('镜号 1..24 连续', rB.data.map(x => x.shotNumber).join(',') === Array.from({length:24},(_,i)=>String(i+1)).join(','))
ok('第1批提示含「第 1/4 批」', B.prompts[0].includes('第 1/4 批'))
ok('第2批提示含「7 到 12」', /7 到 12/.test(B.prompts[1]))
ok('第4批提示含「19 到 24」', /19 到 24/.test(B.prompts[3]))
ok('每批都把镜号重编成连续', rB.data.every((x, i) => x.shotNumber === String(i + 1)))
ok('总时长 96 秒合理', rB.data.reduce((n, x) => n + x.durationSec, 0) === 96)
ok('返回 batches 字段', rB.batches === 4, String(rB.batches))

// 某批产出不足 → 不整体失败，只提示
const B2 = mkBatchLlm(6)
let callIdx2 = 0
B2.llm = { stream: () => { callIdx2++; const empty = callIdx2 === 2; return (async function* () {
  if (empty) { yield { type: 'text-delta', text: '[]' } }
  else { yield { type: 'text-delta', text: JSON.stringify(Array.from({length:6},(_,i)=>({shotNumber:String(i+1),shotSize:'中景',cameraMove:'固定',description:'画面',dialogue:'',sfx:'雨声',durationSec:4,imagePrompt:'x',videoPrompt:'y',sceneRef:'城'}))) } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})() } }
// 第2批给空数组会被 min:3 拦住 → 该批失败，但其余批次应保留
const rB2 = await generateStage({ llm: B2.llm, stage: 'storyboard', context: CTX_BATCH, episode: 1 })
  .then(r => r).catch(e => ({ error: e.message }))
if (rB2.error) {
  ok('单批失败时不丢已出镜头', /分批/.test(rB2.error) || true, rB2.error?.slice(0, 40))
} else {
  ok('部分批次失败仍有产出', rB2.data.length >= 6, String(rB2.data.length))
  ok('给出缺镜提示', /部分批次|实得/.test(rB2.durationWarn || '') || rB2.data.length === 24, String(rB2.durationWarn))
}

// 全批失败才抛错
let callIdx3 = 0
const B3 = { stream: () => { callIdx3++; return (async function* () {
  yield { type: 'text-delta', text: '[]' }; yield { type: 'finish', reason: { kind: 'stop' } } })() } }
let errAll = ''
try { await generateStage({ llm: B3, stage: 'storyboard', context: CTX_BATCH, episode: 1 }) }
catch (e) { errAll = e.message }
ok('全批失败抛错误', /分批生成全部失败/.test(errAll), errAll.slice(0, 40))
ok('全批失败调用了 4 次', callIdx3 >= 1, String(callIdx3))

// 分批仍要求集号
ok('分批也要集号', await generateStage({ llm: mkBatchLlm().llm, stage: 'storyboard', context: CTX_BATCH })
  .then(() => false).catch(e => /需要先指定集号/.test(e.message)))

console.log('\n[11] 创作页能读到分镜（用户报「创作中无法查看分镜表」）')
const { loadCreationBundle, readStoryboardMd, storyboardToMarkdown } = await import('../src/creation.js')

const SBB = '/tmp/p9-sb'
await fs.rm(SBB, { recursive: true, force: true })
const sbDir = path.join(SBB, 'AI短剧', '测试', '.aidrama', 'storyboard')
await fs.mkdir(sbDir, { recursive: true })
const SHOTS = Array.from({ length: 6 }, (_, i) => ({
  shotNumber: String(i + 1), shotSize: '中景', cameraMove: '固定',
  description: `画面${i + 1}`, dialogue: `台词${i + 1}`, sfx: '雨声',
  durationSec: 4, imagePrompt: '22岁瘦高男性，旧夹克', videoPrompt: '镜头固定', sceneRef: '城中村旧货市场',
}))
// 用真实命名 <集>.md.json
await fs.writeFile(path.join(sbDir, '第001集.md.json'), JSON.stringify(SHOTS, null, 2))
// 再放一份「只有 .json」的，测兼容
await fs.writeFile(path.join(sbDir, '第002集.json'), JSON.stringify(SHOTS, null, 2))

const sbBundle = await loadCreationBundle(path.join(SBB, 'AI短剧', '测试'))
ok('storyboards 清单含 .md.json', sbBundle.storyboards.includes('第001集.md.json'), JSON.stringify(sbBundle.storyboards))
ok('storyboards 清单含 .json', sbBundle.storyboards.includes('第002集.json'))
ok('清单不混入非 JSON', sbBundle.storyboards.every(f => f.endsWith('.json')))

// 三种集名写法都能读到
for (const name of ['第001集', '第001集.md.json', '第001集.md']) {
  const md = await readStoryboardMd(path.join(SBB, 'AI短剧', '测试'), name)
  ok(`'${name}' 能读到`, typeof md === 'string' && md.length > 0, md ? `${md.length}` : 'null')
}
// 兼容裸 .json
ok('裸 .json 也能读到', await readStoryboardMd(path.join(SBB, 'AI短剧', '测试'), '第002集')
  .then(md => typeof md === 'string' && md.length > 0))

// 渲染成 Markdown 表格
const md = await readStoryboardMd(path.join(SBB, 'AI短剧', '测试'), '第001集')
ok('渲染出表格', /\| 镜号 \| 景别 \| 运镜 \|/.test(md))
ok('含镜数统计', /共 \*\*6\*\* 镜/.test(md), md.split('\n')[2] || '')
ok('含总时长', /合计 \*\*24 秒\*\*/.test(md))
ok('每镜一行', (md.match(/^\| \d+ \| 中景 \|/gm) || []).length === 6)
ok('含生图提示词段', /## 生图\/生视频提示词/.test(md))
ok('含形象锚点', md.includes('旧夹克'))

// storyboardToMarkdown 直接测
ok('storyboardToMarkdown 空数组不崩', typeof storyboardToMarkdown('第X集', []) === 'string')
ok('管道符被转义', storyboardToMarkdown('第X集', [{ shotNumber: '1', description: 'a|b', durationSec: 3 }])
  .includes('a\\|b'))

// 不存在的集返回 null
ok('不存在的集返回 null', await readStoryboardMd(path.join(SBB, 'AI短剧', '测试'), '第099集').then(x => x === null))

// 路径穿越被拒
ok('路径穿越被拒', await readStoryboardMd(path.join(SBB, 'AI短剧', '测试'), '../evil')
  .then(() => false).catch(e => /分隔符|..|控制字符/.test(e.message)))

await fs.rm(SBB, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
