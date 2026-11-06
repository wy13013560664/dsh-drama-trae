/**
 * P12：账号预热（心跳探针）。
 *   node test/p12-warmup.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { probeAccount, warmupAccounts, shouldWarmup, PROBE_PARAMS } from '../src/warmup.js'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }

console.log('\n[1] 探针参数')
ok('探针时长 ≥4（2/3 会被服务端拒为 InvalidParameter）', PROBE_PARAMS.duration >= 4, String(PROBE_PARAMS.duration))
ok('探针用最小分辨率', PROBE_PARAMS.resolution === '480p')
ok('探针 prompt 极短', PROBE_PARAMS.prompt.length <= 4)

console.log('\n[2] probeAccount 判定')
// 构造假 fetch：可控地返回三种流
function fakeFetch(kind) {
  return async () => ({
    ok: true,
    body: {
      getReader() {
        let sent = false
        return {
          async read() {
            if (sent) return { done: true, value: undefined }
            sent = true
            if (kind === 'heartbeat') return { done: false, value: new TextEncoder().encode('event: heartbeat\ndata: {"t":1}\n\n') }
            if (kind === 'quota') return { done: false, value: new TextEncoder().encode('event: error\ndata: {"code":3003,"message":"...code=4008 exceeded the quota"}\n\n') }
            if (kind === 'broken') return { done: false, value: new TextEncoder().encode('event: error\ndata: {"code":3003,"message":"...code=4040 message="}\n\n') }
            if (kind === 'param') return { done: false, value: new TextEncoder().encode('event: error\ndata: {"code":3003,"message":"InvalidParameter duration"}\n\n') }
            return { done: false, value: new TextEncoder().encode('event: queue\n\n') }
          },
          async cancel() { },
        }
      },
    },
  })
}
const DEPS = { host: 'http://x', path: '/p', model: 'm', headers: () => ({}), waitMs: 12000 }

const mk = (uid) => ({ uid })
// heartbeat 只证明进队列，不证明能产出 → 记 pending，不算 ok。
// 实测同一账号 heartbeat 后仍可能 4040。
ok('heartbeat → pending（不是 ok）', (await probeAccount(mk('a'), { ...DEPS, fetchImpl: fakeFetch('heartbeat') })).status === 'pending')
ok('4008 → quota', (await probeAccount(mk('b'), { ...DEPS, fetchImpl: fakeFetch('quota') })).status === 'quota')
ok('4040 → broken', (await probeAccount(mk('c'), { ...DEPS, fetchImpl: fakeFetch('broken') })).status === 'broken')
ok('参数错 → unknown（不污染账本）', (await probeAccount(mk('d'), { ...DEPS, fetchImpl: fakeFetch('param') })).status === 'unknown')
ok('无关键帧超时 → unknown', (await probeAccount(mk('e'), { ...DEPS, fetchImpl: fakeFetch('none'), waitMs: 200 })).status === 'unknown')
ok('探针返回 uid', (await probeAccount(mk('f'), { ...DEPS, fetchImpl: fakeFetch('heartbeat') })).uid === 'f')
ok('探针记录耗时', typeof (await probeAccount(mk('g'), { ...DEPS, fetchImpl: fakeFetch('heartbeat') })).ms === 'number')
ok('缺 host/path/model 时报错', await probeAccount(mk('h'), { fetchImpl: fakeFetch('heartbeat') }).then(() => false).catch(() => true))

console.log('\n[3] warmupAccounts 汇总与记账')
const DIR = '/tmp/p12-warmup'
await fs.rm(DIR, { recursive: true, force: true })
const PD = path.join(DIR, 'p')
await fs.mkdir(PD, { recursive: true })

// 混合结果：3 ok / 1 quota / 1 broken
let seq = 0
const mixedFetch = async () => {
  const k = ['heartbeat', 'heartbeat', 'heartbeat', 'quota', 'broken'][seq++] || 'heartbeat'
  return fakeFetch(k)()
}
const ACCS = ['a', 'b', 'c', 'd', 'e'].map((u) => ({ uid: u }))
const r = await warmupAccounts({ accounts: ACCS, projectDir: PD, concurrency: 2, probeDeps: { ...DEPS, fetchImpl: mixedFetch } })
ok('ok 数量正确（heartbeat 计入 pending 而非 ok）', r.ok.length === 0, String(r.ok.length))
ok('pending 有计数', r.entries.filter((e) => e.status === 'pending').length >= 1)
ok('quota 分类正确', r.quota.length === 1, String(r.quota.length))
ok('broken 分类正确', r.broken.length === 1, String(r.broken.length))
ok('entries 覆盖全部账号', r.entries.length === 5)
ok('返回耗时', typeof r.elapsedMs === 'number')
ok('账本已写盘', (await fs.readdir(path.join(PD, '.aidrama'))).includes('quota-ledger.json'))

const led = JSON.parse(await fs.readFile(path.join(PD, '.aidrama', 'quota-ledger.json'), 'utf8'))
ok('账本记 pending', Object.values(led.accounts).some((v) => v.status === 'pending'))
ok('账本记 broken', Object.values(led.accounts).some((v) => v.status === 'broken'))

const r2 = await warmupAccounts({ accounts: ACCS, projectDir: PD, probeDeps: { ...DEPS, fetchImpl: mixedFetch }, skipUids: ACCS.map((a) => a.uid) })
ok('skipUids 全部跳过', r2.entries.length === 0)

await fs.rm(DIR, { recursive: true, force: true })

console.log('\n[4] shouldWarmup 决策')
const s1 = shouldWarmup([{ uid: 'a' }, { uid: 'b' }], { accounts: { a: { status: 'ok' } } }, 2)
ok('容量够时不需要预热', s1.needed === false)
ok('capacity = ok数 × 4', s1.capacity === 4, String(s1.capacity))
ok('pending 不计入 capacity', shouldWarmup([{ uid: 'a' }], { accounts: { a: { status: 'pending' } } }, 4).capacity === 0)
const s2 = shouldWarmup([{ uid: 'a' }, { uid: 'b' }], { accounts: {} }, 20)
ok('容量不够时需要预热', s2.needed === true)
ok('candidates 列出未探过账号', s2.candidates.length === 2)
ok('无账号时不崩', shouldWarmup([], { accounts: {} }, 5).needed === true)

console.log('\n[5] 源码接线')
const idx = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
const cli = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
ok('有 /warmup 路由', /apiBase}\/warmup/.test(idx))
ok('路由注入 probeDeps', /probeDeps: \{/.test(idx))
ok('路由用 heartbeat 探针（不产视频）', idx.includes('path: PATHS.textToVideoStream'))
ok('路由并发可配', /input\.concurrency/.test(idx))
ok('前端有「账号预热」按钮', /账号预热/.test(cli))
ok('前端显示预热结果', /预热完成：可用/.test(cli))
ok('前端调 warmup 接口', cli.includes("api('warmup'"))

const g = cli.slice(cli.indexOf('function GenerateTab(props)'))
const gEnd = g.indexOf('\n    function ', 10)
const gBody = g.slice(0, gEnd > 0 ? gEnd : 2500)
const gi = cli.indexOf("pane('generate', h(GenerateTab, {")
const call = cli.slice(gi, gi + 1200)
for (const p of ['warmupRun', 'warmupResult', 'onRunWarmup']) {
  ok(`GenerateTab 解构含 ${p}`, gBody.includes(p))
  ok(`GenerateTab 调用传入 ${p}`, call.includes(p))
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
