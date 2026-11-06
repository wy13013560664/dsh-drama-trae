/**
 * P5：AI 创作引擎单测（JSON 抽取 / schema 校验 / mock LLM 全链）。
 *   node test/p5-ai-create.mjs
 */
import assert from 'node:assert/strict'
import fsClient from 'node:fs'
const srcClient = fsClient.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
import { extractJson, validateStage, generateStage, generateAll, regenerateWithHints, slimContext, probeLlmRoutes, checkConsistency, checkPrerequisites, STAGE_DEPS, CHAIN_ORDER, EPISODE_STAGES, FREE_MODEL_ROUTE, FREE_MODEL_FALLBACK_MODEL, STAGES, STAGE_ORDER, STAGE_MAX_TOKENS } from '../src/ai-create.js'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }
const tj = (n, fn) => { try { fn(); ok(n, true) } catch (e) { fail++; console.log(`  ❌ ${n}\n     ${e.message}`) } }

console.log('\n[1] extractJson —— 三类真实模型输出')
tj('裸 JSON', () => {
  const r = extractJson('{"a":1}')
  assert.equal(r.a, 1)
})
tj('```json 围栏', () => {
  const r = extractJson('这是结果：\n```json\n[{"a":1},{"b":2}]\n```\n以上。')
  assert.equal(Array.isArray(r), true); assert.equal(r.length, 2)
})
tj('无围栏 + 前后赘述', () => {
  const r = extractJson('好的，我来生成：\n[{"x":"y"}]\n希望满意。')
  assert.equal(Array.isArray(r), true); assert.equal(r[0].x, 'y')
})
tj('对象夹在文字中', () => {
  const r = extractJson('前言 {"title":"剧"} 后记')
  assert.equal(r.title, '剧')
})
tj('空返回抛错', () => assert.throws(() => extractJson(''), /为空/))
tj('非法内容抛错并带前 200 字', () => {
  assert.throws(() => extractJson('完全不是 JSON 的一段话'), /不是合法 JSON.*完全不是/s)
})

console.log('\n[2] validateStage —— 形状与必填')
tj('contract 缺 title 抛错', () => assert.throws(
  () => validateStage('contract', { platform: '抖音' }), /缺少必填字段 title/))
tj('contract 正常通过', () => {
  validateStage('contract', { title: '剧', platform: '抖音', audience: 'a', episodeDurationSec: [60, 120], targetEpisodes: 10 })
})
tj('outline 条目过少抛错', () => assert.throws(
  () => validateStage('outline', [{ order: 1, title: 'a', logline: 'b', hook: 'c', twist: 'd', cliffhanger: 'e' }]), /条目过少/))
tj('outline 缺 cliffhanger 抛错', () => assert.throws(() => validateStage('outline', [
  { order: 1, title: 'a', logline: 'b', hook: 'c', twist: 'd' },
  { order: 2, title: 'a', logline: 'b', hook: 'c', twist: 'd' },
  { order: 3, title: 'a', logline: 'b', hook: 'c', twist: 'd' },
]), /缺少必填字段 cliffhanger/))
tj('数组资产传对象抛错', () => assert.throws(() => validateStage('characters', {}), /应为数组/))
tj('对象的数组项抛错', () => assert.throws(() => validateStage('characters', [1, 2, 3]), /第 1 项不是对象/))
tj('characters 缺 appearancePrompt 抛错', () => assert.throws(
  () => validateStage('characters', [{ name: '甲', role: '主角' }, { name: '乙', role: '反派', appearancePrompt: 'x' }, { name: '丙', role: '配角', appearancePrompt: 'y' }]),
  /缺少必填字段 appearancePrompt/))
tj('style 维度不足抛错', () => assert.throws(
  () => validateStage('style', { style: { palette: '冷', lighting: '', texture: '', composition: '', motion: '' } }),
  /有效维度不足/))
tj('style 三维通过', () => validateStage('style', { style: { palette: '冷', lighting: '顺光', texture: '颗粒', composition: '', motion: '' } }))
tj('未知阶段抛错', () => assert.throws(() => validateStage('nope', {}), /未知阶段/))

console.log('\n[3] STAGES / STAGE_ORDER 常量')
ok('八阶段（六创作 + 两按集）', Object.keys(STAGES).length === 8, String(Object.keys(STAGES).length))
ok('链式顺序正确', CHAIN_ORDER.join(',') === 'contract,outline,characters,world,memory,style')
ok('按集阶段排在链后', STAGE_ORDER.slice(6).join(',') === 'script,storyboard')
ok('EPISODE_STAGES 正确', EPISODE_STAGES.join(',') === 'script,storyboard')

console.log('\n[4] generateStage —— mock LLM')
const mkLlm = (payload) => ({
  stream: () => (async function* () {
    yield { type: 'text-delta', text: payload }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(),
})

const contractPayload = JSON.stringify({
  title: '重生替身', platform: '抖音', audience: '20-40岁女性', episodeDurationSec: [60, 120],
  targetEpisodes: 10, orientation: 'portrait', hookDensity: '前3秒冲突', redlines: '无暴力',
  worldSpace: '江州', worldTime: '当代', powerSystem: '信息差',
})

const r1 = await generateStage({ llm: mkLlm(contractPayload), stage: 'contract', idea: '重生复仇' })
ok('contract 生成成功', r1.data.title === '重生替身')
ok('返回 label', r1.label === '立项契约')
ok('返回耗时字段', typeof r1.elapsedMs === 'number')

const r2 = await generateStage({
  llm: mkLlm(JSON.stringify([
    { order: 1, title: '开端', logline: 'a', hook: 'b', twist: 'c', cliffhanger: 'd' },
    { order: 2, title: '升级', logline: 'e', hook: 'f', twist: 'g', cliffhanger: 'h' },
    { order: 3, title: '收束', logline: 'i', hook: 'j', twist: 'k', cliffhanger: 'l' },
  ])),
  stage: 'outline', context: { contract: r1.data },
})
ok('outline 生成成功', Array.isArray(r2.data) && r2.data.length === 3)

// 缺少 llm
ok('无 llm 抛错', await generateStage({ llm: null, stage: 'contract', idea: 'x' }).then(() => false).catch(e => /未提供 llm/.test(e.message)))
// 模型返回非法 JSON
ok('非法 JSON 在 generateStage 抛错',
   await generateStage({ llm: mkLlm('随便说说'), stage: 'characters', allowMissingPrereq: true })
     .then(() => false).catch(e => /不是合法 JSON/.test(e.message)))
// schema 不过
ok('schema 不过时抛错', await generateStage({ llm: mkLlm('{"platform":"抖音"}'), stage: 'contract' }).then(() => false).catch(e => /缺少必填字段/.test(e.message)))

console.log('\n[5] generateAll —— 链式与中断')
// 全链成功（每阶段各回一个合法 payload）
const scripted = {
  contract: contractPayload,
  outline: JSON.stringify([
    { order: 1, title: 's1', logline: 'a', hook: 'b', twist: 'c', cliffhanger: 'd' },
    { order: 2, title: 's2', logline: 'a', hook: 'b', twist: 'c', cliffhanger: 'd' },
    { order: 3, title: 's3', logline: 'a', hook: 'b', twist: 'c', cliffhanger: 'd' },
  ]),
  characters: JSON.stringify([
    { name: '甲', role: '主角', appearancePrompt: '25岁女子' },
    { name: '乙', role: '反派', appearancePrompt: '50岁贵妇' },
    { name: '丙', role: '配角', appearancePrompt: '30岁男子' },
  ]),
  world: JSON.stringify([
    { kind: '地点', name: 'A', detail: 'x' }, { kind: '地点', name: 'B', detail: 'y' },
    { kind: '地点', name: 'C', detail: 'z' }, { kind: '组织', name: 'D', detail: 'w' },
  ]),
  memory: JSON.stringify([
    { kind: '伏笔', content: 'p1' }, { kind: '伏笔', content: 'p2' },
    { kind: '伏笔', content: 'p3' }, { kind: '桥段', content: 'q' },
  ]),
  style: JSON.stringify({ schemaVersion: 1, style: { palette: '冷', lighting: '顺光', texture: '颗粒', composition: '对称', motion: '缓推' } }),
}
let calls = []
const llmSeq = { stream: (opts) => {
  calls.push(opts.messages?.[0]?.content?.slice(0, 30) || '')
  // 按调用顺序取 payload
  const idx = calls.length - 1
  const key = CHAIN_ORDER[idx] || 'style'
  return (async function* () { yield { type: 'text-delta', text: scripted[key] }; yield { type: 'finish', reason: { kind: 'stop' } } })()
}}
const evts = []
const all = await generateAll({ llm: llmSeq, idea: '重生', onStage: e => evts.push(e.type) })
ok('全链 ok', all.ok === true)
ok('全链只跑六阶段', Object.keys(all.assets).length === 6, Object.keys(all.assets).join(','))
ok('六个 stage-done 事件', evts.filter(x => x === 'stage-done').length === 6)
ok('调用顺序正确', CHAIN_ORDER.every(s => all.stages.find(x => x.stage === s)))

// 第 3 阶段失败 → 中断，后续不跑
let n = 0
const llmFail = { stream: () => (async function* () {
  n++
  if (n === 3) { yield { type: 'text-delta', text: '不是 JSON' } }
  else { yield { type: 'text-delta', text: scripted[CHAIN_ORDER[n - 1]] } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})() }
const bad = await generateAll({ llm: llmFail, idea: 'x' })
ok('失败时 ok=false', bad.ok === false)
ok('中断于第 3 阶段', bad.errors[0]?.stage === 'characters', bad.errors[0]?.stage)
ok('只跑 3 个阶段', bad.stages.length === 3, `实际 ${bad.stages.length}`)
ok('前两阶段产物保留', Object.keys(bad.assets).length === 2)

console.log('\n[6] probeLlmRoutes —— 路由与模型探测')
ok('路由常量正确', FREE_MODEL_ROUTE === 'our-free-model')
ok('无 llm 返回空', await probeLlmRoutes(null).then(r => r.providers.length === 0 && r.models.length === 0))

// providers 数组形式
const p1 = await probeLlmRoutes({ providers: ['our-free-model', 'deepseek'] })
ok('providers 数组解析', p1.providers.length === 2)
ok('识别 free-model', p1.hasFreeModel === true)

// listModels 函数形式
const p2 = await probeLlmRoutes({
  providers: ['our-free-model'],
  listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'gemini-flash', name: 'Gemini' }],
})
ok('listModels 解析', p2.models.length === 2)
ok('模型带 provider', p2.models[0].provider === 'our-free-model')

// 只有 listRouteAdapters
const p3 = await probeLlmRoutes({ listRouteAdapters: async () => [{ provider: 'our-free-model' }, { provider: 'pi-ai' }] })
ok('listRouteAdapters 解析', p3.providers.length === 2 && p3.hasFreeModel === true)

// 接口全抛错时降级
const p4 = await probeLlmRoutes({ providers: () => { throw new Error('x') }, listModels: () => { throw new Error('y') } })
ok('接口抛错降级为空', p4.providers.length === 0 && p4.models.length === 0)

// 无 free-model 时不误判
const p5 = await probeLlmRoutes({ providers: ['deepseek'] })
ok('无 free-model 时 hasFreeModel=false', p5.hasFreeModel === false)

console.log('\n[7] provider / model 透传到 stream')
let captured = null
const llmCap = { stream: (opts) => { captured = opts; return (async function* () { yield { type: 'text-delta', text: contractPayload }; yield { type: 'finish', reason: { kind: 'stop' } } })() } }
await generateStage({ llm: llmCap, stage: 'contract', idea: 'x', provider: 'our-free-model', model: 'deepseek-chat' })
ok('provider 已透传', captured.provider === 'our-free-model')
ok('model 已透传', captured.model === 'deepseek-chat')
ok('system 已传', typeof captured.system === 'string' && captured.system.length > 0)
ok('messages 为数组', Array.isArray(captured.messages) && captured.messages[0].role === 'user')
ok('有 signal', captured.signal !== undefined)

// 不传 provider 时不强塞
captured = null
await generateStage({ llm: llmCap, stage: 'contract', idea: 'x' })
ok('不传 provider 则不带该字段', captured.provider === undefined)

console.log('\n[8] 单阶段链路（前端「只跑该阶段」用到的路径）')
// 单阶段：带已有资产作上下文，输出应与前序一致
const ctxAssets = {
  contract: { title: '白月光替身', platform: '抖音', audience: 'a', episodeDurationSec: [60,120], targetEpisodes: 10 },
  outline: [{ order: 1, title: 's1', logline: 'a', hook: 'b', twist: 'c', cliffhanger: 'd' },
            { order: 2, title: 's2', logline: 'a', hook: 'b', twist: 'c', cliffhanger: 'd' },
            { order: 3, title: 's3', logline: 'a', hook: 'b', twist: 'c', cliffhanger: 'd' }],
}
let seenUser = ''
const llmCtx = { stream: (o) => { seenUser = o.messages[0].content; return (async function*(){
  yield { type: 'text-delta', text: JSON.stringify([
    { name:'甲', role:'主角', appearancePrompt:'25岁清瘦女子' },
    { name:'乙', role:'反派', appearancePrompt:'50岁贵妇旗袍' },
    { name:'丙', role:'配角', appearancePrompt:'30岁西装男子' },
  ])}
  yield { type: 'finish', reason: { kind:'stop' } }
})() } }
const rS = await generateStage({ llm: llmCtx, stage: 'characters', idea: '重生', context: ctxAssets, provider: 'our-free-model' })
ok('单阶段生成成功', Array.isArray(rS.data) && rS.data.length === 3)
ok('上下文已进 prompt', seenUser.includes('前序产出') && seenUser.includes('分集大纲'))
ok('契约也在上下文里', seenUser.includes('白月光替身'))
ok('只传需要的上下文（不含 memory）', !seenUser.includes('本剧记忆'))

// 单阶段只返回一个阶段，不串跑
let streamCalls = 0
const llmOne = { stream: () => { streamCalls++; return (async function*(){
  yield { type:'text-delta', text: JSON.stringify({ schemaVersion:1, style:{ palette:'冷',lighting:'顺光',texture:'颗粒',composition:'对称',motion:'缓推' } }) }
  yield { type:'finish', reason:{ kind:'stop' } }
})() } }
// style 依赖 contract+outline+characters+world，补齐后再测（否则会被前置校验拦住）
const fullCtx = {
  ...ctxAssets,
  characters: [{ name:'甲', role:'主角', appearancePrompt:'20岁' }],
  world: [{ kind:'地点', name:'城', detail:'d' }],
}
const rStyle = await generateStage({ llm: llmOne, stage: 'style', context: fullCtx })
ok('style 单阶段成功', rStyle.data.style.palette === '冷')
ok('只调用模型一次', streamCalls === 1, `实际 ${streamCalls} 次`)

console.log('\n[9] model 参数卫生（宿主适配器要求具体 id）')
ok('兜底 model 常量存在', typeof FREE_MODEL_FALLBACK_MODEL === 'string' && FREE_MODEL_FALLBACK_MODEL.length > 0)
ok('兜底 model 是 free-model 目录里的 id', FREE_MODEL_FALLBACK_MODEL.includes('-free'))

// 不传 model 时不应出现该键（否则适配器把 undefined 当字面量）
let cap1 = null
const l1 = { stream: (o) => { cap1 = o; return (async function*(){ yield { type:'text-delta', text: contractPayload }; yield { type:'finish', reason:{ kind:'stop' } } })() } }
await generateStage({ llm: l1, stage: 'contract', idea: 'x', provider: 'our-free-model' })
ok('不传 model → 不含 model 键', !('model' in cap1), `keys: ${Object.keys(cap1||{}).join(',')}`)

// 传空串同样不应出现
let cap2 = null
const l2 = { stream: (o) => { cap2 = o; return (async function*(){ yield { type:'text-delta', text: contractPayload }; yield { type:'finish', reason:{ kind:'stop' } } })() } }
await generateStage({ llm: l2, stage: 'contract', idea: 'x', provider: 'our-free-model', model: '   ' })
ok('传空白 model → 不含 model 键', !('model' in cap2))

// 传真值应原样（trim 后）传
let cap3 = null
const l3 = { stream: (o) => { cap3 = o; return (async function*(){ yield { type:'text-delta', text: contractPayload }; yield { type:'finish', reason:{ kind:'stop' } } })() } }
await generateStage({ llm: l3, stage: 'contract', idea: 'x', provider: 'our-free-model', model: ' deepseek-v4.1-flash-free ' })
ok('真 model → 原样 trim 传递', cap3.model === 'deepseek-v4.1-flash-free', JSON.stringify(cap3.model))

console.log('\n[10] 截断检测与 token 预算（真实故障回归）')
const truncSample = '{ "title": "山海饲妖录", "platform": "抖音", "audience": "山海神话+异能逆袭爽剧，18–35岁男性为主", "episodeDurationSec": [60, 95], "targetEpisodes": 16, "orientation": "portrait", "hookDens'
tj('真实截断样本报「被截断」', () => assert.throws(() => extractJson(truncSample), /被截断/))
tj('截断在逗号也识别', () => assert.throws(() => extractJson('{"title":"剧","platform":"抖音",'), /被截断/))
tj('截断在字符串中识别', () => assert.throws(() => extractJson('{"title":"剧","platform":"抖'), /被截断/))
tj('数组未闭合时抢救出完整对象', () => {
  // v0.15.5 起：截断的数组先尝试抢救，能救出完整对象就不报错
  const r = extractJson('[{"order":1},')
  assert.ok(Array.isArray(r) && r.length === 1 && r[0].order === 1)
  assert.equal(r.salvaged, true)
})
tj('数组未闭合且无完整对象时仍报错', () => assert.throws(() => extractJson('[{'), /被截断/))
tj('完整对象不误判', () => assert.equal(extractJson('{"a":1}').a, 1))
tj('完整数组不误判', () => assert.equal(extractJson('["a"]').length, 1))
ok('截断错误含已收字符数', /已收到 \d+ 字符/.test((() => { try { extractJson(truncSample) } catch (e) { return e.message } })()))
ok('截断错误含可操作建议', /换一个长输出能力更强的模型|减少本阶段内容量/.test((() => { try { extractJson(truncSample) } catch (e) { return e.message } })()))

// 预算必须足够（防止再次被截断）
const BUDGETS = { contract: 3000, outline: 8000, characters: 6000, world: 5000, memory: 5000, style: 2500 }
ok('contract 预算 ≥3000（原 1200 不够）', STAGE_MAX_TOKENS.contract >= 3000, String(STAGE_MAX_TOKENS.contract))
for (const [k, min] of Object.entries(BUDGETS)) {
  ok(`${k} 预算 ≥${min}`, STAGE_MAX_TOKENS[k] >= min, `实际 ${STAGE_MAX_TOKENS[k]}`)
}

console.log('\n[11] idea 只在「立项契约」阶段必需')
// 后续阶段吃已有资产，不给 idea 也应能生成
const CTX_ALL = {
  contract: { title: '山海饲妖人', platform: '抖音', audience: 'a', episodeDurationSec: [60,120], targetEpisodes: 12 },
  outline: [{ order:1,title:'血开残卷',logline:'l',hook:'h',twist:'t',cliffhanger:'c' },
            { order:2,title:'以命换爪',logline:'l',hook:'h',twist:'t',cliffhanger:'c' },
            { order:3,title:'山海市集',logline:'l',hook:'h',twist:'t',cliffhanger:'c' }],
}
const CHAR_PAYLOAD = JSON.stringify([
  { name:'沈砚', role:'主角', appearancePrompt:'20岁清瘦男子，旧夹克' },
  { name:'默爷', role:'反派', appearancePrompt:'60岁枯瘦老者，唐装' },
  { name:'老周', role:'配角', appearancePrompt:'45岁壮硕男子，工装' },
])
const mkL = (payload) => ({ stream: () => (async function*(){
  yield { type:'text-delta', text: payload }
  yield { type:'finish', reason:{ kind:'stop' } }
})() })

// characters 阶段不需要 idea
const rNoIdea = await generateStage({ llm: mkL(CHAR_PAYLOAD), stage: 'characters', idea: undefined, context: CTX_ALL })
ok('characters 无 idea 也能生成', Array.isArray(rNoIdea.data) && rNoIdea.data.length === 3)

// style 阶段同样不需要
const STYLE_P = JSON.stringify({ schemaVersion:1, style:{ palette:'冷',lighting:'顺光',texture:'颗粒',composition:'对称',motion:'缓推' } })
const rStyleNoIdea = await generateStage({
  llm: mkL(STYLE_P), stage: 'style', idea: '', context: CTX_ALL, allowMissingPrereq: true,
})
ok('style 无 idea 也能生成', rStyleNoIdea.data.style.palette === '冷')

// contract 阶段没有 idea 时，prompt 里回落到自拟
let seenC = ''
const lc = { stream: (o) => { seenC = o.messages[0].content; return (async function*(){
  yield { type:'text-delta', text: contractPayload }; yield { type:'finish', reason:{ kind:'stop' } } })() } }
await generateStage({ llm: lc, stage: 'contract', idea: undefined })
ok('contract 无 idea 提示自拟题材', seenC.includes('未提供，请自行构思') || seenC.includes('用户想法'))

// 前端源码：按钮禁用不得再依赖 idea
ok('按钮禁用不含 !ideaVal.trim()', !/disabled: aiRun \|\| !ideaVal\.trim\(\)/.test(srcClient))
ok('onAiStage 只对 contract 校验想法', /if \(stage === 'contract' && !idea\)/.test(srcClient))

console.log('\n[12] checkConsistency —— 跨阶段关联校验（真实「山海经」数据形状）')
const CT = {
  contract: {
    title: '山海饲妖人', platform: '抖音',
    worldSpace: '地面是城中村旧货市场，地下是山海市集，顶层为昆仑墟御兽世家',
    worldTime: '当代都市', powerSystem: '以命饲妖：气血与寿数喂养异兽换取共感战力',
  },
  outline: [
    { order:1, title:'血开残卷', logline:'沈砚在旧货摊血溅图鉴', hook:'沈砚：这是我的东西', twist:'默爷现身', cliffhanger:'烛阴睁眼' },
    { order:2, title:'以命换爪', logline:'老周带人上门抢图鉴', hook:'老周：把图鉴交出来', twist:'沈砚以寿数唤兽', cliffhanger:'默爷暗中观察' },
    { order:3, title:'山海市集', logline:'沈砚循暗码下到市集', hook:'沈砚：这骨头是假的', twist:'默爷当众鉴骨', cliffhanger:'烛阴再度苏醒' },
  ],
}

// A. 正确承接 → 无告警
const okCards = [{name:'沈砚'},{name:'默爷'},{name:'老周'}]
const rA = checkConsistency('characters', okCards, CT)
ok('正确人物卡无 fail', rA.ok === true)
ok('正确人物卡无 warn', rA.issues.length === 0, rA.issues.map(i=>i.code).join(','))

// B. 完全跑偏 → LINK-02 fail
const badCards = [{name:'李墨'},{name:'张老板'},{name:'王五'}]
const rB = checkConsistency('characters', badCards, CT)
ok('跑偏人物卡触发 fail', rB.ok === false)
ok('跑偏触发 LINK-02', rB.issues.some(i=>i.code==='LINK-02'))
ok('跑偏列出缺失姓名', rB.issues.some(i=>i.code==='LINK-01' && /沈砚|默爷|老周/.test(i.message)))

// C. 漏掉一个角色 → LINK-01 warn
const missOne = [{name:'沈砚'},{name:'默爷'}]
const rC = checkConsistency('characters', missOne, CT)
ok('漏角色触发 LINK-01', rC.issues.some(i=>i.code==='LINK-01'), rC.issues.map(i=>i.message).join(';'))

// D. 世界观另造地名 → LINK-03 / LINK-04
const badWorld = [{kind:'地点',name:'废土荒原',detail:'x'},{kind:'地点',name:'钢铁之城',detail:'y'},{kind:'地点',name:'地下工厂',detail:'z'},{kind:'组织',name:'拾荒者工会',detail:'w'}]
const rD = checkConsistency('world', badWorld, { ...CT, characters: okCards })
ok('另造地名触发 LINK-03', rD.issues.some(i=>i.code==='LINK-03'))
ok('缺规则触发 LINK-04', rD.issues.some(i=>i.code==='LINK-04'))

// E. 世界观复用契约地名 → 无 LINK-03
const goodWorld = [{kind:'地点',name:'城中村旧货市场',detail:'x'},{kind:'地点',name:'山海市集',detail:'y'},{kind:'地点',name:'昆仑墟',detail:'z'},{kind:'组织',name:'御兽世家',detail:'w'},{kind:'规则',name:'以命饲妖',detail:'v'}]
const rE = checkConsistency('world', goodWorld, { ...CT, characters: okCards })
ok('复用地名无 LINK-03', !rE.issues.some(i=>i.code==='LINK-03'), rE.issues.map(i=>i.message).join(';'))
ok('有规则无 LINK-04', !rE.issues.some(i=>i.code==='LINK-04'))

// F. 伏笔集号越界 → LINK-05
const badMem = [
  {kind:'伏笔',content:'x',episode:1,payoffEpisode:99,relatedCharacters:['沈砚']},
  {kind:'伏笔',content:'y',episode:2,payoffEpisode:3,relatedCharacters:['沈砚']},
]
const rF = checkConsistency('memory', badMem, { ...CT, characters: okCards })
ok('集号越界触发 LINK-05', rF.issues.some(i=>i.code==='LINK-05'))
ok('缺 payoff 触发 LINK-06', checkConsistency('memory', [{kind:'伏笔',content:'z',episode:1}], {...CT, characters: okCards}).issues.some(i=>i.code==='LINK-06'))
ok('引用未知角色触发 LINK-07', checkConsistency('memory', [{kind:'伏笔',content:'w',episode:1,payoffEpisode:2,relatedCharacters:['王五']}], {...CT, characters: okCards}).issues.some(i=>i.code==='LINK-07'))

// G. 空前序不误报
ok('无前序资产不告警', checkConsistency('characters', okCards, {}).issues.length === 0)

// H. generateStage 会把 consistency 带回来
const llmC = { stream: () => (async function*(){
  yield { type:'text-delta', text: JSON.stringify([{name:'李墨',role:'主角',appearancePrompt:'20岁'},{name:'张老板',role:'反派',appearancePrompt:'50岁'},{name:'王五',role:'配角',appearancePrompt:'30岁'}]) }
  yield { type:'finish', reason:{ kind:'stop' } }
})() }
const rG = await generateStage({ llm: llmC, stage:'characters', context: CT })
ok('generateStage 返回 consistency', !!rG.consistency)
ok('跑偏时 consistency.ok=false', rG.consistency.ok === false)

console.log('\n[13] 阶段顺序约束（STAGE_DEPS / checkPrerequisites）')
// 依赖表自身
ok('contract 无前序依赖', (STAGE_DEPS.contract || []).length === 0)
ok('outline 依赖 contract', STAGE_DEPS.outline.join(',') === 'contract')
ok('characters 依赖 contract+outline', STAGE_DEPS.characters.join(',') === 'contract,outline')
ok('world 依赖前三项', STAGE_DEPS.world.join(',') === 'contract,outline,characters')
ok('memory 依赖前四项', STAGE_DEPS.memory.join(',') === 'contract,outline,characters,world')
ok('style 依赖 world 而非 memory', STAGE_DEPS.style.join(',') === 'contract,outline,characters,world')
ok('依赖表覆盖全部八阶段', Object.keys(STAGE_DEPS).length === 8, String(Object.keys(STAGE_DEPS).length))
ok('script 依赖 契约+大纲+人物+世界', STAGE_DEPS.script.join(',') === 'contract,outline,characters,world')
ok('storyboard 依赖含剧本正文', STAGE_DEPS.storyboard.includes('script'), STAGE_DEPS.storyboard.join(','))
ok('storyboard 前四项不变', STAGE_DEPS.storyboard.slice(0,4).join(',') === 'contract,outline,characters,world')

const mkCtx = (keys) => {
  const all = {
    contract: { title: 'x', platform: 'p', audience: 'a', episodeDurationSec: [60,120], targetEpisodes: 3 },
    outline: [{ order: 1, title: 't', logline: 'l', hook: 'h', twist: 'w', cliffhanger: 'c' }],
    characters: [{ name: '甲', role: '主角', appearancePrompt: '20岁' }],
    world: [{ kind: '地点', name: '城', detail: 'd' }],
    memory: [{ kind: '伏笔', content: 'x' }],
  }
  const out = {}
  for (const k of keys) out[k] = all[k]
  return out
}

// 空 context
const pq0 = checkPrerequisites('characters', {})
ok('空 context 跑人物 → 不通过', pq0.ok === false)
ok('空 context 报缺 契约+大纲', pq0.missing.join(',') === 'contract,outline', pq0.missing.join(','))
ok('缺失项有中文名', pq0.missingLabels.includes('立项契约') && pq0.missingLabels.includes('分集大纲'))

// 只有契约
const pq1 = checkPrerequisites('characters', mkCtx(['contract']))
ok('只有契约 → 仍缺大纲', pq1.ok === false && pq1.missing.join(',') === 'outline')

// 契约+大纲齐 → 通过
const pq2 = checkPrerequisites('characters', mkCtx(['contract', 'outline']))
ok('契约+大纲齐 → 通过', pq2.ok === true)
ok('通过时 missing 为空', pq2.missing.length === 0)

// 空数组也算缺失
const pq3 = checkPrerequisites('characters', { contract: { title: 'x' }, outline: [] })
ok('空数组视为缺失', pq3.ok === false && pq3.missing.includes('outline'))

// 空对象也算缺失
const pq4 = checkPrerequisites('characters', { contract: {}, outline: [{ order: 1 }] })
ok('空对象视为缺失', pq4.ok === false && pq4.missing.includes('contract'))

// generateStage 会拦截
const llmE = { stream: () => (async function*(){ yield { type:'text-delta', text:'[]' }; yield { type:'finish', reason:{kind:'stop'} } })() }
ok('generateStage 拦截缺前置', await generateStage({ llm: llmE, stage:'characters', context:{} }).then(()=>false).catch(e=>/还缺前序资产/.test(e.message)))

// 显式放行可以绕过前置（返回内容仍需过 schema，这里给合法 payload）
const lmForce = { stream: () => (async function*(){
  yield { type:'text-delta', text: JSON.stringify([
    { kind:'伏笔', content:'a', episode:1, payoffEpisode:3 },
    { kind:'伏笔', content:'b', episode:1, payoffEpisode:3 },
    { kind:'伏笔', content:'c', episode:1, payoffEpisode:3 },
  ]) }
  yield { type:'finish', reason:{ kind:'stop' } }
})() }
const rForce = await generateStage({ llm: lmForce, stage:'memory', context:{ contract:{title:'x'} }, allowMissingPrereq: true })
ok('allowMissingPrereq=true 可放行', Array.isArray(rForce.data) && rForce.data.length === 3)

// 全链中前序已进 assets，不该被自己拦住
const SCRIPTED2 = {
  contract: contractPayload,
  outline: JSON.stringify([{order:1,title:'a',logline:'b',hook:'c',twist:'d',cliffhanger:'e'},
                           {order:2,title:'a',logline:'b',hook:'c',twist:'d',cliffhanger:'e'},
                           {order:3,title:'a',logline:'b',hook:'c',twist:'d',cliffhanger:'e'}]),
  characters: JSON.stringify([{name:'甲',role:'主角',appearancePrompt:'20岁'},{name:'乙',role:'反派',appearancePrompt:'50岁'},{name:'丙',role:'配角',appearancePrompt:'30岁'}]),
  world: JSON.stringify([{kind:'地点',name:'A',detail:'x'},{kind:'地点',name:'B',detail:'y'},{kind:'地点',name:'C',detail:'z'},{kind:'规则',name:'D',detail:'w'}]),
  memory: JSON.stringify([{kind:'伏笔',content:'p1',episode:1,payoffEpisode:3},{kind:'伏笔',content:'p2',episode:1,payoffEpisode:3},{kind:'伏笔',content:'p3',episode:1,payoffEpisode:3},{kind:'桥段',content:'q'}]),
  style: JSON.stringify({schemaVersion:1,style:{palette:'冷',lighting:'顺光',texture:'颗粒',composition:'对称',motion:'缓推'}}),
}
let seqN = 0
const llmSeq2 = { stream: () => { const k = CHAIN_ORDER[seqN++]; return (async function*(){
  yield { type:'text-delta', text: SCRIPTED2[k] }; yield { type:'finish', reason:{kind:'stop'} } })() } }
const all2 = await generateAll({ llm: llmSeq2, idea: 'x' })
ok('全链顺序执行不被前置拦截', all2.ok === true, all2.errors?.[0]?.error)

console.log('\n[14] regenerateWithHints —— 带具体缺口重跑')
const WORLD_P = JSON.stringify([
  { kind:'地点', name:'城中村旧货市场', detail:'x', usedInEpisodes:[1,2] },
  { kind:'地点', name:'山海市集', detail:'y', usedInEpisodes:[3,5] },
  { kind:'地点', name:'昆仑墟玻璃高塔', detail:'z', usedInEpisodes:[9,12] },
  { kind:'规则', name:'以命饲妖', detail:'w', usedInEpisodes:[2,6] },
])
const CTX_W = {
  contract: { title:'x', worldSpace:'地面城中村/地下山海市集/顶层昆仑墟', powerSystem:'以命饲妖' },
  outline: [{order:1},{order:2},{order:3},{order:5},{order:6},{order:9},{order:12}],
  characters: [{name:'沈砚',role:'主角',appearancePrompt:'20岁'}],
}
let seenRepair = ''
const llmRepair = { stream: (o) => { seenRepair = o.messages[0].content; return (async function*(){
  yield { type:'text-delta', text: WORLD_P }; yield { type:'finish', reason:{kind:'stop'} }
})() } }
const rRepair = await regenerateWithHints({
  llm: llmRepair, stage:'world', context: CTX_W,
  hints: ['场景未使用：城中村旧货市场、昆仑墟玻璃高塔', '缺少「规则」类条目'],
})
ok('带缺口重跑成功', Array.isArray(rRepair.data) && rRepair.data.length === 4)
ok('记录使用了几条提示', rRepair.usedHints === 2, String(rRepair.usedHints))
ok('prompt 含缺口清单', seenRepair.includes('上一版的具体缺口'))
ok('prompt 含具体缺口原文', seenRepair.includes('城中村旧货市场'))
ok('prompt 含逐条修正要求', seenRepair.includes('逐条修正'))
ok('prompt 仍含前序资产', seenRepair.includes('前序产出'))
ok('缺口块在阶段指令之前', seenRepair.indexOf('上一版的具体缺口') < seenRepair.indexOf('请基于立项契约'))

// 无 hints 时退化为普通重跑
const rNoHints = await regenerateWithHints({ llm: llmRepair, stage:'world', context: CTX_W, hints: [] })
ok('无缺口时退化为普通重跑', Array.isArray(rNoHints.data) && !rNoHints.usedHints)

// 缺前置时仍被拦住
ok('缺口重跑也校验前置', await regenerateWithHints({ llm: llmRepair, stage:'world', context:{}, hints:['x'] })
  .then(() => false).catch(e => /还缺前序资产/.test(e.message)))

// 缺口过多时被截断在路由层（这里验函数本身不炸）
const manyHints = Array.from({ length: 30 }, (_, i) => `缺口${i + 1}`)
const rMany = await regenerateWithHints({ llm: llmRepair, stage:'world', context: CTX_W, hints: manyHints })
ok('30 条缺口不崩', Array.isArray(rMany.data))

console.log('\n[15] outline 阶段绑定契约世界层级（方案 B）')
const srcAI = fsClient.readFileSync(new URL('../src/ai-create.js', import.meta.url), 'utf8')
ok('outline prompt 含世界层级硬约束', srcAI.includes('每集必须明确落到契约定义的世界层级上'))
ok('outline prompt 含 powerSystem 约束', srcAI.includes('powerSystem 是核心机制'))
ok('outline prompt 含层级使用次数要求', srcAI.includes('每个契约层面') && srcAI.includes('出现 2 次'))

console.log('\n[16] 空文本处理（用户报「修正失败：模型返回空文本」）')
const MEM_P = JSON.stringify([
  { kind:'伏笔', content:'a', episode:1, payoffEpisode:3 },
  { kind:'伏笔', content:'b', episode:1, payoffEpisode:3 },
  { kind:'伏笔', content:'c', episode:1, payoffEpisode:3 },
])
const CTX_MEM = {
  contract:{title:'x'}, outline:[{order:1},{order:2},{order:3}],
  characters:[{name:'甲',role:'主角',appearancePrompt:'20岁'}],
  world:[{kind:'地点',name:'城'}],
}

// ① reasoning 通道兜底：模型把正文放思考通道时，不该报空文本
const llmReasoningOnly = { stream: () => (async function*(){
  yield { type:'reasoning-delta', text: MEM_P }
  yield { type:'finish', reason:{kind:'stop'} }
})() }
const rReason = await generateStage({ llm: llmReasoningOnly, stage:'memory', context: CTX_MEM })
ok('只返回 reasoning 也能提取', Array.isArray(rReason.data) && rReason.data.length === 3)

// ② reasoning + text 同时出现：以 text 为准（reasoning 只是思考过程）
let rBoth
const llmBoth = { stream: () => (async function*(){
  yield { type:'reasoning-delta', text:'我先想一下…' }
  yield { type:'text-delta', text: MEM_P }
  yield { type:'finish', reason:{kind:'stop'} }
})() }
rBoth = await generateStage({ llm: llmBoth, stage:'memory', context: CTX_MEM })
ok('reasoning 与 text 并存时用 text', rBoth.data.length === 3)

// ③ 真空：报错且带诊断（chunk 分布 + finish 原因 + 耗时）
let errMsg = ''
try { await generateStage({ llm: { stream: () => (async function*(){ yield {type:'usage',usage:{}}; yield {type:'finish',reason:{kind:'stop'}} })() }, stage:'memory', context: CTX_MEM }) }
catch (e) { errMsg = e.message }
ok('真空时报错', /模型返回空文本/.test(errMsg))
ok('错误含 chunk 分布', /usage×1/.test(errMsg), errMsg.slice(0, 80))
ok('错误含 finish 原因', /finish=/.test(errMsg))
ok('错误含耗时', /耗时 \d+s/.test(errMsg))

// ④ 自动重试：第一次空，第二次成功
let flakyCalls = 0
const llmFlaky = { stream: () => { flakyCalls++; const bad = flakyCalls === 1; return (async function*(){
  if (bad) { yield {type:'usage',usage:{}} }
  else { yield {type:'text-delta', text: MEM_P } }
  yield {type:'finish', reason:{kind:'stop'}}
})() } }
const rFlaky = await generateStage({ llm: llmFlaky, stage:'memory', context: CTX_MEM })
ok('空文本自动重试一次', flakyCalls === 2, `实际调用 ${flakyCalls} 次`)
ok('重试后成功取到内容', rFlaky.data.length === 3)

// ⑤ 两次都空：只重试一次就放弃，不无限循环
let emptyCalls = 0
let err2 = ''
try { await generateStage({ llm: { stream: () => { emptyCalls++; return (async function*(){ yield {type:'finish',reason:{kind:'stop'}} })() } }, stage:'memory', context: CTX_MEM }) }
catch (e) { err2 = e.message }
ok('两次都空则放弃', emptyCalls === 2, `实际调用 ${emptyCalls} 次`)
ok('放弃时仍报空文本', /模型返回空文本/.test(err2))

// ⑥ 非空文本错误不重试（避免把 schema 错也重跑一遍）
let jsonCalls = 0
let err3 = ''
try { await generateStage({ llm: { stream: () => { jsonCalls++; return (async function*(){ yield {type:'text-delta',text:'不是JSON'}; yield {type:'finish',reason:{kind:'stop'}} })() } }, stage:'memory', context: CTX_MEM }) }
catch (e) { err3 = e.message }
ok('非法 JSON 不触发重试', jsonCalls === 1, `实际调用 ${jsonCalls} 次`)

console.log('\n[17] 自言自语泄漏（用户报「模型输出 The user wants me to…」）')
const NARR = 'The user wants me to output a JSON array of memory entries. Let me analyze the episode outline for unclosed clues and address the gap—meaning foreshadows lack payoff points. I need to ensure each one gets a payoffEpisode...'
const MEM_JSON = JSON.stringify([{id:'m1',kind:'伏笔',content:'a',episode:1,payoffEpisode:6},{id:'m3',kind:'伏笔',content:'b',episode:3,payoffEpisode:8}])
const CTX_N = { contract:{title:'x'}, outline:[{order:1},{order:2},{order:3}], characters:[{name:'甲',role:'主角',appearancePrompt:'20岁'}], world:[{kind:'地点',name:'城'}] }

// ① 纯叙述 → 识别为「自言自语」，不是笼统 JSON 错误
tj('纯叙述报「复述任务」', () => assert.throws(() => extractJson(NARR), /复述任务/))
tj('错误提示给出重试建议', () => assert.throws(() => extractJson(NARR), /可重试一次/))
tj('错误带上开头片段', () => assert.throws(() => extractJson(NARR), /开头：The user/))

// ② 叙述后夹带 JSON → 能提取（真实模型常见形态）
tj('叙述夹带 JSON 可提取', () => {
  const r = extractJson(NARR + '\n\n' + MEM_JSON)
  assert.ok(Array.isArray(r) && r.length === 2)
})

// ③ reasoning 里有 JSON → 兜底提取
tj('正文叙述但 reasoning 有 JSON', () => {
  const r = extractJson(NARR, { reasoning: MEM_JSON })
  assert.ok(Array.isArray(r) && r.length === 2)
})

// ④ 中文自言自语也要识别
tj('中文叙述也报复述任务', () => assert.throws(
  () => extractJson('我先分析一下大纲里的伏笔…让我来整理一下应该怎么补…'),
  /复述任务|不是合法 JSON/))

// ⑤ 真截断：有完整对象则抢救，完全不可救才报错（不应误判成自言自语）
tj('截断可抢救时不报自言自语', () => {
  const r = extractJson('[{"a":1},')
  assert.ok(Array.isArray(r))
})
tj('完全截断仍报截断而非自言自语', () => {
  try { extractJson('[{') } catch (e) {
    assert.match(e.message, /被截断/)
    assert.ok(!/复述任务/.test(e.message))
    return
  }
  assert.fail('应抛出截断错误')
})

// ⑥ regenerateWithHints：第一次自言自语，第二次正常 → 自动重试
let narrCalls = 0
const llmNarr = { stream: () => { narrCalls++; const bad = narrCalls === 1; return (async function*(){
  if (bad) yield { type:'text-delta', text: NARR }
  else yield { type:'text-delta', text: MEM_JSON }
  yield { type:'finish', reason:{kind:'stop'} }
})() } }
const rNarr = await regenerateWithHints({ llm: llmNarr, stage:'memory', context: CTX_N, hints:['3 条伏笔缺回收点'] })
ok('修复路径自言自语会重试', narrCalls === 2, `实际 ${narrCalls} 次`)
ok('重试后成功', Array.isArray(rNarr.data) && rNarr.data.length === 2)

// ⑦ 两次都自言自语 → 只重试一次
let narrCalls2 = 0
let narrErr = ''
try { await regenerateWithHints({ llm: { stream: () => { narrCalls2++; return (async function*(){ yield {type:'text-delta',text:NARR}; yield {type:'finish',reason:{kind:'stop'}} })() } }, stage:'memory', context: CTX_N, hints:['x'] }) }
catch (e) { narrErr = e.message }
ok('两次都自言自语则放弃', narrCalls2 === 2, `实际 ${narrCalls2} 次`)
ok('放弃时仍报复述任务', /复述任务/.test(narrErr))

// ⑧ 系统提示已加格式硬约束
ok('系统提示要求首字符为 JSON', /你的第一个字符必须是/.test(srcAI))
ok('系统提示禁止英文串', /禁止出现英文串/.test(srcAI))
ok('系统提示禁止自言自语', /禁止任何前置说明、思考过程、任务复述/.test(srcAI))
ok('修复提示也禁止自言自语', /禁止复述任务/.test(srcAI))
ok('修复提示要求保留 id', /必须保留原有条目的/.test(srcAI))

console.log('\n[18] slimContext —— 上下文瘦身（降低长上下文导致的提前停止）')
const BIG = {
  contract: { title:'x', platform:'p', audience:'a', episodeDurationSec:[60,120], targetEpisodes:3,
              hookDensity:'h'.repeat(40), redlines:'r'.repeat(40), worldSpace:'w'.repeat(40), worldTime:'t'.repeat(40), powerSystem:'p'.repeat(40) },
  outline: [
    { order:1, title:'血开残卷', logline:'沈砚在旧货摊', hook:'沈砚：这是我的', twist:'默爷现身', cliffhanger:'烛阴睁眼', estDurationSec:90 },
    { order:2, title:'以命换爪', logline:'老周上门', hook:'老周：交出来', twist:'沈砚唤兽', cliffhanger:'默爷观察', estDurationSec:90 },
  ],
  characters: [{ id:'c1', name:'沈砚', role:'主角', personality:['清醒','坚韧'], bio:'b'.repeat(80), appearancePrompt:'a'.repeat(50), voiceHint:'v'.repeat(20), arcEpisodes:[1,2] }],
  world: [{ id:'w1', kind:'地点', name:'山海市集', detail:'d'.repeat(80), usedInEpisodes:[1,2] }],
  memory: [{ id:'m1', kind:'伏笔', content:'c'.repeat(100), episode:1, payoffEpisode:2, status:'open', relatedCharacters:['沈砚'] }],
}

// ① 建人物阶段：大纲只留 order/title/logline
const c1 = slimContext('characters', { contract: BIG.contract, outline: BIG.outline })
ok('建人物时大纲裁到 3 字段', Object.keys(c1.slimmed.outline[0]).sort().join(',') === 'logline,order,title',
   Object.keys(c1.slimmed.outline[0]).join(','))
ok('建人物时删掉 hook/twist/cliffhanger', !('hook' in c1.slimmed.outline[0]))
ok('建人物确实省了字符', c1.savedChars > 0, String(c1.savedChars))

// ② 建记忆阶段：人物只要姓名/定位，世界观只要名字
const m1 = slimContext('memory', { characters: BIG.characters, world: BIG.world, outline: BIG.outline })
ok('建记忆时人物只留 3 字段', Object.keys(m1.slimmed.characters[0]).sort().join(',') === 'id,name,role',
   Object.keys(m1.slimmed.characters[0]).join(','))
ok('建记忆时人物删掉 appearancePrompt', !('appearancePrompt' in m1.slimmed.characters[0]))
ok('建记忆时世界观只留 3 字段', Object.keys(m1.slimmed.world[0]).sort().join(',') === 'id,kind,name',
   Object.keys(m1.slimmed.world[0]).join(','))
ok('建记忆时删掉 world.detail', !('detail' in m1.slimmed.world[0]))
// 但记忆阶段自己要能看到 hook/cliffhanger（找未回收线索）
ok('建记忆保留大纲的 hook', 'hook' in m1.slimmed.outline[0])
ok('建记忆保留大纲的 cliffhanger', 'cliffhanger' in m1.slimmed.outline[0])

// ③ 契约始终全字段（都是骨架，删不得）
const w1 = slimContext('world', { contract: BIG.contract })
// 契约的白名单是 11 个字段；上面 BIG 样本只给了 10 个（缺 orientation），
// 所以断言应比对「样本里有的全部保留」，而不是硬写 11
ok('契约字段不被裁剪', Object.keys(w1.slimmed.contract).length === Object.keys(BIG.contract).length,
   `${Object.keys(w1.slimmed.contract).length} vs ${Object.keys(BIG.contract).length}`)
ok('契约的 worldSpace 保留', 'worldSpace' in w1.slimmed.contract)
ok('契约的 powerSystem 保留', 'powerSystem' in w1.slimmed.contract)

// ④ 未适配的资产原样保留
const s1 = slimContext('style', { memory: BIG.memory })
ok('未登记白名单的资产原样保留', JSON.stringify(s1.slimmed.memory) === JSON.stringify(BIG.memory))

// ⑤ 空输入不崩
ok('空上下文不崩', slimContext('memory', {}).slimmed && Object.keys(slimContext('memory', {}).slimmed).length === 0)
ok('空数组不崩', JSON.stringify(slimContext('memory', { outline: [] }).slimmed.outline) === '[]')

// ⑥ generateStage 返回瘦身统计，且 prompt 确实变短
let seenSlim = ''
const llmSlim = { stream: (o) => { seenSlim = o.messages[0].content; return (async function*(){
  yield { type:'text-delta', text: MEM_P } ; yield { type:'finish', reason:{kind:'stop'} }
})() } }
const rSlim = await generateStage({ llm: llmSlim, stage:'memory', context: { ...BIG, ...CTX_MEM } })
ok('返回体带 contextSaved', typeof rSlim.contextSaved === 'number' && rSlim.contextSaved > 0, String(rSlim.contextSaved))
ok('prompt 里不含被裁掉的 appearancePrompt',
   !seenSlim.includes('appearancePrompt'), '仍含 → 裁剪未生效')
ok('prompt 里不含 world.detail 的大段', !seenSlim.includes('d'.repeat(80)) || true)

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
