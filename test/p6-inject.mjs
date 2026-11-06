/**
 * P6：插件契约单测 —— 防止 inject / apply 形态回归。
 *
 * 背景：v0.9.0 把 inject 误写成 { required, optional } 对象，cordis 的 resolve()
 * 会把**键名**当服务名，导致 fiber.inject 里只有 required/optional 两个空服务，
 * connection 依赖永不满足 → apply 不执行 → 所有路由未注册 → 前端全部报
 * 「服务尚未就绪」。这个测试把该形态钉死。
 *
 *   node test/p6-inject.mjs
 */
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }

const mod = await import('../index.js')

console.log('\n[1] inject 声明形态')
ok('inject 是数组', Array.isArray(mod.inject), `实际 ${typeof mod.inject}`)
ok('只含 connection', mod.inject.length === 1 && mod.inject[0] === 'connection', mod.inject.join(','))
ok('不含 llm（避免变硬依赖）', !mod.inject.includes('llm'))
ok('不含 required/optional 等伪服务名',
  !mod.inject.includes('required') && !mod.inject.includes('optional'))

console.log('\n[2] apply 是可调用函数')
ok('apply 存在', typeof mod.apply === 'function')
ok('apply.length 接受 2 参', mod.apply.length >= 1)

console.log('\n[3] apply 在提供 connection 时注册全部路由')
const routes = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get: (n) => (n === 'llm' ? { stream: () => (async function* () {})() } : undefined),
  inject: (deps, fn) => {
    const list = Array.isArray(deps) ? deps : Object.keys(deps || {})
    if (list.includes('connection') || String(deps).includes('connection')) {
      fn({ connection: { fetch: { register: (s) => { routes.push(s.path); return { dispose() {} } } } } })
    }
  },
}
mod.apply(ctx, {})

ok('路由数 ≥ 20', routes.length >= 20, `实际 ${routes.length}`)
for (const must of ['/list', '/shots', '/generate', '/creation', '/ai-create', '/llm-status', '/save-asset', '/script', '/storyboard-md', '/create-project']) {
  ok(`已注册 ${must}`, routes.some(r => r.endsWith(must)))
}

console.log('\n[4] 无 llm 服务时仍能 apply（出片不受影响）')
const routes2 = []
const ctx2 = {
  logger: { info() {} },
  get: () => undefined,   // 没有任何可选服务
  inject: (deps, fn) => {
    const list = Array.isArray(deps) ? deps : Object.keys(deps || {})
    if (list.includes('connection') || String(deps).includes('connection')) {
      fn({ connection: { fetch: { register: (s) => { routes2.push(s.path); return { dispose() {} } } } } })
    }
  },
}
mod.apply(ctx2, {})
ok('无 llm 时路由数相同', routes2.length === routes.length, `${routes2.length} vs ${routes.length}`)

console.log('\n[5] 顶层导出完整性')
for (const fn of ['runOneShotDrama', 'loadCharacterIndex', 'loadStyleDoc', 'loadSceneCards', 'loadAssetCards', 'collectShots', 'locateProjectDir', 'defaultDramaRoot', 'discoverDramaRoots', 'fileExists']) {
  ok(`导出 ${fn}`, typeof mod[fn] === 'function')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
