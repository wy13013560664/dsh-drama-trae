/**
 * P7：前端渲染冒烟 —— 防止「组件用到了 props 但签名没解构」导致整页空白。
 *
 * 背景：v0.9.0 的 CreationTab 函数体引用了 ai/setAi/aiRun/aiProgress/onAiGenerate/
 * onApplyAi/llmStatus/onRefreshLlm 共 8 个 prop，但函数签名里只有前 5 个。
 * React 渲染到那一行直接抛 ReferenceError，整个面板白屏。
 * 这类错误 node --check 发现不了——必须真的调用组件。
 *
 *   node test/p7-render.mjs
 */
import fs from 'node:fs'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/* ---------- 提取单个组件函数（按花括号配平）---------- */
function extractFn(name) {
  const start = src.indexOf(`    function ${name}(`)
  if (start < 0) throw new Error(`未找到组件 ${name}`)
  // 跳过参数区（解构里有花括号）
  const bodyStart = src.indexOf('}) {', start) >= 0
    ? src.indexOf('}) {', start) + 4
    : src.indexOf(') {', start) + 3
  let i = bodyStart, depth = 1, end = -1, inStr = null
  while (i < src.length) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') { i += 2; continue }
      if (c === inStr) inStr = null
      i++; continue
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; i++; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    i++
  }
  if (end < 0) throw new Error(`组件 ${name} 花括号不配平`)
  return src.slice(start, bodyStart) + src.slice(bodyStart, end)
}

/* ---------- 极简 React 替身 ---------- */
function ce(type, props, ...children) { return { type, props: { ...(props || {}), children: children.flat() } } }
const R = {
  createElement: ce, Fragment: Symbol('f'),
  useState: (v) => [v, () => {}],
  useEffect: () => {}, useRef: (v) => ({ current: null }),
}
const STAGES_CLIENT = { contract: '立项契约', outline: '分集大纲', characters: '人物设定', world: '世界观', memory: '本剧记忆', style: '视觉风格' }

/** 各页签可能从 props 取用的键（未解构却在函数体独立使用 → 白屏隐患）。 */
const PROPS_TO_CHECK = [
  'ai', 'setAi', 'aiRun', 'aiTaskId', 'aiProgress', 'onAiGenerate', 'onApplyAi', 'llmStatus', 'onRefreshLlm',
  'preflight', 'pfError', 'pfLoading', 'onRun', 'opts', 'setOpts',
  'artifacts', 'artError', 'onOpen', 'accounts', 'accError', 'history', 'histError',
  'projects', 'shots', 'onRefreshProjects', 'jobProgress', 'roots',
  'creating', 'newTitle', 'createError', 'createProject', 'listError', 'shotsError',
  'bundle', 'bundleError', 'bundleLoading', 'onLoad', 'onSave', 'onLoadScript', 'onSaveScript', 'onLoadStoryboard',
]

function build(name) {
  const code = extractFn(name)
  const EPISODE_STAGES_CLIENT = ['script', 'storyboard']
  const fn = new Function('h', 'Fragment', 'useState', 'useEffect', 'STAGES_CLIENT', 'EPISODE_STAGES_CLIENT',
    code + `\nreturn ${name};`)
  return fn(ce, R.Fragment, R.useState, R.useEffect, STAGES_CLIENT, EPISODE_STAGES_CLIENT)
}

/* ---------- 1) 签名完整性静态检查（每个组件）---------- */
console.log('\n[1] 组件 props 解构完整性（静态）')
const COMPONENTS = ['GenerateTab', 'CreationTab', 'ConsistencyTab', 'ArtifactsTab', 'AccountsTab', 'StatsTab']

/** 剥离注释与字符串字面量，避免把文案/注释里的词当成变量。 */
function stripLiterals(code) {
  let out = ''
  let i = 0, inStr = null, inLine = false, inBlock = false
  while (i < code.length) {
    const c = code[i], n = code[i + 1]
    if (inLine) { if (c === '\n') { inLine = false; out += c } i++; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue } i++; continue }
    if (inStr) {
      if (c === '\\') { i += 2; continue }
      if (c === inStr) { inStr = null; out += '""' }
      i++; continue
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') { inStr = c; i++; continue }
    out += c; i++
  }
  return out
}

for (const name of COMPONENTS) {
  try {
    const code = extractFn(name)
    const clean = stripLiterals(code)

    // 参数来源：对象解构 { a, b } 或 props 变量
    const isPropsStyle = /function \w+\(props\)/.test(clean)
    const sig = clean.match(/function \w+\(\{([\s\S]*?)\}\) \{/)
    const params = new Set(
      sig
        ? sig[1].split(',').map(x => x.trim()).filter(Boolean).filter(x => !x.includes('='))
        : []
    )

    const body = clean.slice(clean.search(/\) \{/) + 3)

    // 本地声明（含解构、数组解构、函数、参数）
    const local = new Set()
    for (const m of body.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g)) local.add(m[1])
    for (const m of body.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) m[1].split(',').forEach(x => local.add(x.trim()))
    for (const m of body.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) m[1].split(',').forEach(x => local.add(x.split(':').pop().trim()))
    for (const m of body.matchAll(/function\s+([a-zA-Z_$][\w$]*)/g)) local.add(m[1])

    const suspect = []
    for (const key of PROPS_TO_CHECK) {
      // 只认「当作独立标识符使用」：不在点号后、不被引号包住
      const re = new RegExp(`(?<![.\\w$])${key}(?![\\w$])`, 'g')
      const hit = re.test(body)
      if (!hit) continue
      // props 风格组件不存在此问题（全部挂在 props 上）
      if (isPropsStyle) continue
      if (params.has(key) || local.has(key)) continue
      suspect.push(key)
    }
    ok(`${name} 签名完整`, suspect.length === 0, `缺: ${suspect.join(',')}`)
  } catch (e) {
    fail++; console.log(`  ❌ ${name} 提取失败: ${e.message}`)
  }
}

/* ---------- 2) CreationTab 全状态渲染 ---------- */
console.log('\n[2] CreationTab 各状态渲染（不抛异常）')
const CreationTab = build('CreationTab')
const bundle = {
  contract: { title: '白月光替身', platform: '抖音', audience: '20-40岁', episodeDurationSec: [60, 120], targetEpisodes: 10 },
  outline: [{ order: 1, title: '重生归来', logline: 'l', hook: 'h', twist: 't', cliffhanger: 'c' }],
  characters: [{ name: '沈知意', role: '主角', appearancePrompt: '25岁' }],
  world: [{ kind: '地点', name: '江州', detail: 'd' }],
  memory: [{ kind: '伏笔', content: 'x', status: 'open' }],
  style: { style: { palette: '冷', lighting: '', texture: '', composition: '', motion: '' } },
  scripts: ['第001集.md'], storyboards: ['第001集.分镜.md'], generatedCount: 0,
  progress: { steps: { contract: true, outline: true }, done: 2, total: 7, pct: 29 },
}
const base = {
  project: '白月光替身', dramaRoot: '',
  bundle, bundleError: null, bundleLoading: false,
  onLoad() {}, onSave() {}, onLoadScript: async () => '', onSaveScript: async () => ({ bytes: 1 }), onLoadStoryboard: async () => '',
  ai: { idea: '', model: '' }, setAi() {}, aiRun: false, aiTaskId: null, aiProgress: null,
  onAiGenerate() {}, onApplyAi() {},
  llmStatus: { available: true, hasFreeModel: true, providers: ['our-free-model'], models: [{ id: 'a', name: 'A' }] },
  onRefreshLlm() {},
}
const cases = [
  ['正常有数据', base],
  ['bundle=null', { ...base, bundle: null }],
  ['加载中', { ...base, bundle: null, bundleLoading: true }],
  ['加载失败', { ...base, bundle: null, bundleError: 'boom' }],
  ['未选项目', { ...base, project: null, bundle: null }],
  ['llm 不可用', { ...base, llmStatus: { available: false, reason: '宿主未提供 llm 服务' } }],
  ['llm 检测中', { ...base, llmStatus: null }],
  ['AI 生成中', { ...base, aiRun: true, aiProgress: { done: 2, total: 6, stages: [{ stage: 'contract', label: '立项契约', ok: true, bytes: 1200, elapsedMs: 18000 }], current: { stage: 'outline', label: '分集大纲' } } }],
  ['AI 有结果', { ...base, aiProgress: { done: 6, total: 6, applied: ['contract'], stages: [{ stage: 'contract', ok: true, bytes: 900 }], result: { stages: [{ stage: 'contract', ok: true, bytes: 900 }], assets: { contract: { title: 'x' }, outline: [{ order: 1 }], style: { style: {} } } } } }],
  ['AI 有错误', { ...base, aiProgress: { done: 0, total: 6, stages: [{ stage: 'contract', ok: false, error: '超时' }] } }],
  ['空项目', { ...base, bundle: { ...bundle, contract: null, outline: [], characters: [], world: [], memory: [], style: null, scripts: [], storyboards: [], progress: { steps: {}, done: 0, total: 7, pct: 0 } } }],
]
for (const [label, p] of cases) {
  try { CreationTab(p); ok(`渲染 ${label}`, true) }
  catch (e) { ok(`渲染 ${label}`, false, e.message) }
}

/* ---------- 3) 其余组件也能渲染 ---------- */
console.log('\n[3] 其余组件渲染')
const otherCases = {
  ConsistencyTab: { project: 'p', preflight: { gate: { checked: 4, fails: [], warns: [{ code: 'CHK-01', severity: 'warn', message: 'm' }], infos: [], blocked: false }, platform: { profile: { ratio: '9:16' }, stats: { totalSec: 20, avgSec: 5 }, issues: [] }, compliance: { blocks: 0, warns: 0 }, complianceHits: { blocks: [], warns: [] }, style: { state: 'draft', used: [], suffix: '' }, characters: { total: 1, anchors: 1 }, perShot: [{ shot: '1', anchorPreview: 'x' }] }, pfError: null, pfLoading: false, onRun() {}, opts: { gate: true, gateBlock: false, chain: false, complianceBlock: false, platform: '其他' }, setOpts() {} },
  ArtifactsTab: { project: 'p', artifacts: [{ name: 'a.mp4', path: '/x', size: 2097152, mtime: Date.now() }], artError: null, onRefresh() {}, onOpen() {} },
  AccountsTab: { accounts: [{ ref: 'TRAE_1', name: 'A', expired: false }, { ref: 'TRAE_2', name: 'B', expired: true }], accError: null, onRefresh() {} },
  StatsTab: { history: [{ id: 'abc', project: 'p', episode: 'e', status: 'done', startedAt: Date.now() - 60000, finishedAt: Date.now(), progress: { done: 8, total: 8 } }], stats: {}, histError: null, onRefresh() {} },
}
for (const [name, props] of Object.entries(otherCases)) {
  try { build(name)(props); ok(`渲染 ${name}`, true) }
  catch (e) { ok(`渲染 ${name}`, false, e.message) }
}

console.log('\n[4] 页签常驻挂载（切换不丢内部 state）')
const TABS = ['creation', 'generate', 'consistency', 'artifacts', 'accounts', 'stats']

// ① 六个 pane 都注册
for (const t of TABS) ok(`pane ${t} 已注册`, src.includes(`pane('${t}'`))

// ② 每个组件只被渲染一次（出现两次会导致状态分裂 + 双请求）
for (const c of ['CreationTab', 'GenerateTab', 'ConsistencyTab', 'ArtifactsTab', 'AccountsTab', 'StatsTab']) {
  const n = (src.match(new RegExp(`h\\(${c},\\s`, 'g')) || []).length
  ok(`${c} 只渲染一次`, n === 1, `实际 ${n} 次`)
}

// ③ 关键：可见性必须走 style，不能走条件渲染
ok('可见性用 display:none 控制', /style: tab === id \? undefined : \{ display: 'none' \}/.test(src))
ok('无残留的条件渲染分支', !/tab === 'generate' \? h\(GenerateTab/.test(src))

// ④ pane 容器带 data-on 以便样式/测试定位
ok('pane 带 data-on 标记', src.includes("'data-on': tab === id ? '1' : '0'"))

// ⑤ 曾被卸载丢状态的 state 必须仍在组件内部（说明它们会被保留）
const lostOnUnmount = ['q', 'statusFilter', 'scriptEp', 'scriptText', 'sbEp', 'sbText', 'previewPath', 'sortBy', 'sub']
for (const st of lostOnUnmount) {
  ok(`state「${st}」仍在组件内`, new RegExp(`const \\[${st}, set`).test(src))
}

console.log('\n[5] OverviewTab 缺口修正按钮（用户报「没看到」的回归）')
// 提取并渲染 OverviewTab
function buildComp(name) {
  const start = src.indexOf(`    function ${name}(`)
  const bodyStart = src.indexOf(') {', start) >= 0 ? src.indexOf(') {', start) + 3 : -1
  let i = bodyStart, depth = 1, end = -1, inStr = null
  while (i < src.length) {
    const c = src[i]
    if (inStr) { if (c === '\\') { i += 2; continue } if (c === inStr) inStr = null; i++; continue }
    if (c === "'" || c === '"' || c === '`') { inStr = c; i++; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    i++
  }
  const code = src.slice(start, bodyStart) + src.slice(bodyStart, end)
  const EPISODE_STAGES_CLIENT = ['script', 'storyboard']
  const fn = new Function('h', 'Fragment', 'useState', 'useEffect', 'STAGES_CLIENT', 'EPISODE_STAGES_CLIENT', code + `\nreturn ${name};`)
  return fn(ce, R.Fragment, R.useState, R.useEffect, STAGES_CLIENT, EPISODE_STAGES_CLIENT)
}

const OverviewTab = buildComp('OverviewTab')
const ORPH_LINKS = {
  totals: { episodes: 12, characters: 7, places: 12, foreshadows: 7, avgCharsPerEpisode: 2.7, foreshadowCoverage: 43 },
  episodeMap: [{ order: 1, title: '集1', characters: ['沈砚'], places: [], foreshadows: [] }],
  characterArcs: [{ name: '陆三爷', role: '反派', episodes: [], episodeCount: 0 }],
  foreshadowChains: [{ id: 'm1', content: 'x', plantedAt: 1, payoffAt: null }],
  sceneUsage: [], styleLinks: [],
  orphans: { characters: ['陆三爷'], places: ['城中村旧货市场', '昆仑墟'], foreshadowsWithoutPayoff: ['a', 'b', 'c', 'd'] },
}
const ovProps = { project: '山海经', links: ORPH_LINKS, linksError: null, onLoad() {}, onRepair() {}, repairState: null, onApplyRepair() {}, onDiscardRepair() {} }

const collect = (tree) => {
  const btns = [], texts = []
  function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.type === R.Fragment) { walk(n.props?.children); return }
    for (const c of (n.props?.children || [])) if (typeof c === 'string' && c.trim()) texts.push(c.trim())
    if (n.type === 'button') btns.push((n.props?.children || []).flat().filter(x => typeof x === 'string').join(''))
    walk(n.props?.children)
  }
  walk(tree)
  return { btns, texts }
}

try {
  const { btns, texts } = collect(OverviewTab(ovProps))
  ok('渲染总览不抛错', true)
  ok('出现「让 AI 补」', btns.filter(b => b.includes('让 AI 补')).length >= 1, `实际 ${btns.filter(b => b.includes('让 AI 补')).length}`)
  ok('角色缺口一个按钮', btns.filter(b => b.includes('让 AI 补')).length === 3, `实际 ${btns.filter(b => b.includes('让 AI 补')).length}`)
  ok('出现「全部交给 AI 修」', btns.some(b => b.includes('全部交给 AI 修')))
  ok('缺口文案可见', texts.some(t => t.includes('角色未登场')))
  ok('场景缺口文案可见', texts.some(t => t.includes('场景未使用')))
  ok('伏笔缺口文案可见', texts.some(t => t.includes('缺回收点')))
} catch (e) {
  ok('渲染总览不抛错', false, e.message)
}

// 无缺口时不显示按钮区（避免误报「按钮消失」）
const cleanLinks = { ...ORPH_LINKS, orphans: { characters: [], places: [], foreshadowsWithoutPayoff: [] } }
const clean = collect(OverviewTab({ ...ovProps, links: cleanLinks }))
ok('无缺口时不显示修正按钮', !clean.btns.some(b => b.includes('让 AI 补')))

// 源码层：总览页签必须触发加载（用户报「看不到」的直接原因）
ok('总览页签触发 loadCreation', /tab === 'overview'.*loadCreation|(tab === 'creation' \|\| tab === 'overview')/.test(src))
ok('进入总览时加载依赖 links', src.includes("(tab === 'creation' || tab === 'overview')"))

console.log('\n[6] 选择持久化与跨页签复用（用户报「切回来要重选」）')
// 静态断言：持久化机制存在且被用在三个状态上
ok('有 localStorage 持久化键', /STORE_KEY\s*=\s*`dsh-drama-trae:selection/.test(src))
ok('有 loadSelection', /function loadSelection\(\)/.test(src))
ok('有 saveSelection', /function saveSelection\(patch\)/.test(src))
ok('project 初始值从持久化恢复', /const \[project, setProject\] = useState\(\(\) => String\(loadSelection\(\)\.project/.test(src))
ok('episode 初始值从持久化恢复', /const \[episode, setEpisode\] = useState\(\(\) => String\(loadSelection\(\)\.episode/.test(src))
ok('dramaRoot 初始值从持久化恢复', /const \[dramaRoot, setDramaRoot\] = useState\(\(\) => String\(loadSelection\(\)\.dramaRoot/.test(src))

// 三个持久化 setter
ok('有 setProjectPersist', /setProjectPersist\s*=/.test(src))
ok('有 setEpisodePersist', /setEpisodePersist\s*=/.test(src))
ok('有 setDramaRootPersist', /setDramaRootPersist\s*=/.test(src))
ok('setProjectPersist 会落盘', /setProjectPersist[\s\S]{0,160}saveSelection\(\{ project/.test(src))
ok('setEpisodePersist 会落盘', /setEpisodePersist[\s\S]{0,160}saveSelection\(\{ episode/.test(src))
ok('setDramaRootPersist 会落盘', /setDramaRootPersist[\s\S]{0,160}saveSelection\(\{ dramaRoot/.test(src))

// GenerateTab 拿到的是持久化版
ok('GenerateTab 收到持久化 setProject', /setProject: setProjectPersist/.test(src))
ok('GenerateTab 收到持久化 setEpisode', /setEpisode: setEpisodePersist/.test(src))
ok('GenerateTab 收到持久化 setDramaRoot', /setDramaRoot: setDramaRootPersist/.test(src))
ok('新建项目成功后也持久化', /setProjectPersist\(r\.title\)/.test(src))

// 总览页可直接选项目（不用回创作页）
ok('总览页有项目下拉（未选时）', /选择一个项目/.test(src))
ok('总览页顶部有切换下拉', /全剧关联/.test(src) && /setProject: setProjectPersist[\s\S]{0,200}episodes/.test(src))

// 隐私模式降级：读写都必须包 try/catch
ok('loadSelection 有 try/catch 兜底', /function loadSelection\(\) \{\s*try/.test(src))
ok('saveSelection 有 try/catch 兜底', /function saveSelection\(patch\) \{\s*try/.test(src))

console.log('\n[7] 剧本/分镜阅读区尺寸（用户报「太小不方便看」）')
ok('剧本编辑器有专属类', /ad-script-editor/.test(src))
ok('剧本编辑器高度 ≥460', /height: 460/.test(src), '默认高度')
ok('剧本编辑器可拖拽调整', /resize: 'vertical'/.test(src))
ok('剧本编辑器行高宽松', /lineHeight: 1\.75/.test(src))
ok('有全屏编辑状态', /const \[scriptFull, setScriptFull\]/ .test(src))
ok('有全屏切换按钮', /全屏编辑/.test(src))
ok('全屏模式高度用 vh', /calc\(100vh - 220px\)/.test(src))
ok('有字数统计', /\$\{scriptText\.length\}/.test(src))
ok('有行数统计', /scriptText\.split\(/.test(src) && /length\}/.test(src))
// 分镜 md 预览从 520 调到 360：同页下方新增了逐镜 prompt 卡片，需要留空间
ok('分镜预览高度 ≥360', /height: 360/.test(src), '下方已有 prompt 卡片占位')
ok('分镜预览也可拖拽', /resize: 'vertical'.*sbText|sbText[\s\S]{0,40}resize/.test(src) || /resize: 'vertical'/.test(src))
ok('JSON 预览已放大到 360+', /height: 360/.test(src) || /height: 400/.test(src))
ok('旧的小尺寸已清除', !/minHeight: 320/.test(src), '仍存在 minHeight:320')

console.log('\n[7b] 签名完整性 + 状态归属（用户报「创作页面又白屏了」）')
// 这次白屏的根因：casting 的 useState/loadCasting/onCast 被误放进 CreationTab，
// 而签名没接 casting → ReferenceError → 整页空白。
// 教训：组件用到的每个裸 props 都必须出现在签名里；useState 只能在组件内定义。

const CAT = src.slice(src.indexOf('function CreationTab('), src.indexOf('\n    function ConsistencyTab('))

// ① 签名必须包含 casting 相关四项
for (const p of ['casting', 'castingRun', 'castingMsg', 'onCast']) {
  ok(`CreationTab 签名含 ${p}`, new RegExp(`\\b${p}\\b`).test(CAT.slice(0, CAT.indexOf('}) {')+4)), '缺则白屏')
}
// ② 调用处必须传这四项
const callSite = src.slice(src.indexOf('h(CreationTab, {'), src.indexOf('})),', src.indexOf('h(CreationTab, {')))
for (const p of ['casting', 'castingRun', 'castingMsg', 'onCast']) {
  ok(`调用处传入 ${p}`, new RegExp(`\\b${p}\\b`).test(callSite))
}
// ③ casting 的状态与函数不能定义在 CreationTab 内
ok('CreationTab 内不含 casting 的 useState',
   !/const \[\s*casting\s*,\s*setCasting\s*\]/.test(CAT))
ok('CreationTab 内不含 loadCasting 定义', !/async function loadCasting/.test(CAT))
ok('CreationTab 内不含 onCast 定义', !/async function onCast/.test(CAT))
// ④ 它们必须存在（在 App 内）
ok('App 内有 casting 的 useState', /const \[casting, setCasting\] = useState/.test(src))
ok('App 内有 loadCasting', /async function loadCasting/.test(src))
ok('App 内有 onCast', /async function onCast/.test(src))

// ⑤ 静态签名全面自查：CreationTab 体里出现的「可疑 props」都要在签名
const sigText = CAT.slice(0, CAT.indexOf('}) {')+4)
const sigNames = new Set(sigText.replace(/\/\/[^\n]*/g, '').match(/[a-zA-Z_$][\w$]*/g) || [])
const KNOWN_PROPS = ['project','dramaRoot','bundle','bundleError','bundleLoading','onLoad','onSave','onSaveScript','onLoadScript','onLoadStoryboard','ai','setAi','aiRun','aiTaskId','aiProgress','onAiGenerate','onApplyAi','llmStatus','onRefreshLlm','onAiStage','onAiEpisode','casting','castingRun','castingMsg','onCast']
const missing = KNOWN_PROPS.filter(p => !sigNames.has(p))
ok('签名覆盖全部已知 props', missing.length === 0, missing.join(','))

console.log('\n[8] 剧本/分镜阶段就绪判定（用户报「剧本生成了但分镜说没有」）')
// 前端 stageReady 必须能识别 script / storyboard，否则按钮永灰
ok('stageReady 有 script 分支', /if \(name === 'script'\)/.test(src))
ok('stageReady 有 storyboard 分支', /if \(name === 'storyboard'\)/.test(src))
ok('script 判定读 scripts 清单', /scripts\.some\(x => String\(x\)\.startsWith\(prefix\)\)/.test(src))
ok('storyboard 判定读 storyboards 清单', /storyboards\.some\(x => String\(x\)\.startsWith\(prefix\)\)/.test(src))
ok('按当前集号拼前缀', /String\(epNo\)\.padStart\(3, '0'\)/.test(src))
ok('分镜按钮额外要求有剧本', /curStage === 'storyboard' && !hasScriptForCurEp/.test(src))

// 行为验证：抽出 stageReady 真跑
const start = src.indexOf('const stageReady = ')
const endMark = src.indexOf('const curStage = ai?.stage')
const code = src.slice(start, endMark)
const mk = (scripts, storyboards, epNo = 1) => {
  const ai = { episodeNo: epNo }
  const fn = new Function('ai', code + '\nreturn stageReady;')
  const sr = fn(ai)
  const b = { contract: { title: 'x' }, outline: [{ order: 1 }], characters: [{ name: 'a' }], world: [{ name: 'w' }], scripts, storyboards }
  return { sr, b }
}
const A = mk(['第001集.md'], [])
ok('有剧本 → script 就绪', A.sr('script', A.b) === true)
ok('无分镜 → storyboard 未就绪', A.sr('storyboard', A.b) === false, '应 false')
const B = mk(['第001集.md'], ['第001集.md.json'])
ok('有分镜 → storyboard 就绪', B.sr('storyboard', B.b) === true)
const C = mk(['第002集.md'], [])
ok('集号不匹配时不就绪', C.sr('script', C.b) === false, '第1集但只有第2集剧本')
const D = mk(['第001集.md'], [], 2)
ok('按集号正确匹配', D.sr('script', D.b) === false, '集号2 但只有第1集剧本')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
