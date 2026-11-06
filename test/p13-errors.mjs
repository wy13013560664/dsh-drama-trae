/**
 * P13：错误分类 / 自适应并发 / 时长抬升 / 账本冷却 —— 本次优化的回归测试。
 *   node test/p13-errors.mjs
 *
 * 覆盖的都是「实测踩过的坑」，不是假想场景：
 *   · 4010 access denied 被当未知错 → 换一次号就判死（452 次/集）
 *   · 2001 lock busy 被当账号坏 → 白拉黑好账号
 *   · 18 并发打满 → 整片 4010，必须能自动降并发
 *   · 分镜 durationSec=2/3 → InvalidParameter，24 镜里 8 镜白跑
 *   · 11 小时前的 warmup quota 记录永久封号 → 33 个账号 20 个进不来
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  classifyError, isAccountScope, isRetriable, backoffFor, sleep, isStillCooling,
  cooldownFor, QUOTA_COOLDOWN_MS, BROKEN_COOLDOWN_MS, AUTH_COOLDOWN_MS,
} from '../src/errors.js'
import { createLimiter } from '../src/limiter.js'
import { createRunCircuit, FAST_FAIL_MS, DEFAULT_TRIP_THRESHOLD, HALF_OPEN_AFTER_MS } from '../src/circuit.js'
import { rankAccounts, summarizeAccounts, EVIDENCE_WEIGHT } from '../src/ranking.js'
import { needsRecast, planRecast } from '../src/recast.js'
import { clampDurationToModel, normalizeDuration } from '../src/validate.js'
import { MIN_DURATION, MAX_DURATION, AUTOCONCURRENCY_CAP } from '../src/constants.js'
import { explainTraeVError, classifyAccountFailure, estimateQuota, nextStreak } from '../src/quota.js'
import { cooldownFor as cdFor, MAX_ESCALATED_COOLDOWN_MS } from '../src/errors.js'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }

console.log('\n[1] 错误分类：4010 / 2001 必须与账号级故障分开')
const t4010 = classifyError('{"event":"error","data":{"code":3003,"message":"model call failed: LLMRawChatV2 error: code=4010 message=We\'re sorry, access denied. Please wait and try again later."}}')
ok('4010 识别为 access-denied', t4010.kind === 'access-denied', t4010.kind)
ok('4010 是全局限流（换号无用）', t4010.scope === 'global', t4010.scope)
ok('4010 可重试', t4010.retriable === true)
ok('4010 不拉黑账号', t4010.markAccount === false, '拉黑会把整池账号一次抖动废掉')
ok('4010 有退避时长', t4010.backoffMs > 0, String(t4010.backoffMs))
ok('裸 4010（无 code= 前缀）也认', classifyError('LLMRawChatV2 error: code=4010 access denied').kind === 'access-denied')

const t2001 = classifyError('{"code":3003,"message":"...code=2001 message=usage reservation lock is busy"}')
ok('2001 识别为 lock-busy', t2001.kind === 'lock-busy', t2001.kind)
ok('2001 不拉黑账号（锁是秒级的）', t2001.markAccount === false)
ok('2001 可重试且退避短', t2001.retriable && t2001.backoffMs <= 5000, String(t2001.backoffMs))

console.log('\n[2] 错误分类：账号级 / 内容级 / 网络级')
ok('4008 账号级且记 quota', classifyError('...code=4008...exceeded the quota').kind === 'quota'
  && classifyError('...code=4008...').markAccount === true)
ok('4040 账号级', isAccountScope('...code=4040 message='))
ok('1001 账号级', classifyError('{"code":1001,"message":"not able to authenticate"}').markAccount === true)
ok('InvalidParameter 不可重试（重试只会重复失败）', isRetriable('InvalidParameter duration') === false)
ok('InvalidParameter 不拉黑账号', classifyError('InvalidParameter duration').markAccount === false)
ok('invalid userid 不再重试', isRetriable('failed to sign image url: invalid userid') === false)
ok('invalid userid 不拉黑账号（图绑账号，不是号坏）', classifyError('invalid userid').markAccount === false)
ok('ECONNREFUSED 可重试', isRetriable('ECONNREFUSED') === true)
ok('ECONNREFUSED 不拉黑账号', classifyError('ECONNREFUSED').markAccount === false)
ok('429 可重试且有退避', classifyError('429 too many requests').retriable
  && classifyError('429 too many requests').backoffMs > 0)
ok('空错误不炸', classifyError(null).kind === 'unknown' && classifyError('').kind === 'unknown')

console.log('\n[3] 退避：指数增长 + 抖动 + 封顶')
ok('attempt=0 约等于 base', backoffFor(8000, 0, 60000, () => 0.5) >= 6000, String(backoffFor(8000, 0, 60000, () => 0.5)))
const b1 = backoffFor(8000, 1, 60000, () => 0.5)
const b2 = backoffFor(8000, 2, 60000, () => 0.5)
ok('指数增长', b2 > b1, `${b1} → ${b2}`)
ok('有封顶', backoffFor(8000, 20, 60000, () => 0.5) <= 60000, String(backoffFor(8000, 20, 60000, () => 0.5)))
ok('抖动生效（两次结果不同）',
   backoffFor(8000, 0, 60000, () => 0.1) !== backoffFor(8000, 0, 60000, () => 0.9))
ok('base=0 返回 0（账号级换号无需等）', backoffFor(0, 3) === 0)

console.log('\n[4] sleep 可被取消打断')
let woke = await sleep(30, () => false, 10)
ok('正常睡完返回 true', woke === true)
const t0 = Date.now()
woke = await sleep(500, () => true, 10)
ok('取消立即返回 false', woke === false && Date.now() - t0 < 200, `${Date.now() - t0}ms`)

console.log('\n[5] 自适应并发闸门（AIMD）')
{
  const l = createLimiter({ target: 8, successStreak: 3 })
  ok('初始等于目标', l.snapshot().limit === 8)
  const rl = await l.acquire()
  ok('acquire 占一个许可', l.snapshot().inFlight === 1)
  l.penalize()
  ok('penalize 乘性减半', l.snapshot().limit === 4, String(l.snapshot().limit))
  rl()
  ok('release 归还许可', l.snapshot().inFlight === 0)
  ok('下限不低于 1', (() => { const m = createLimiter({ target: 1 }); m.penalize(); return m.snapshot().limit === 1 })())
  // 连续成功后加性 +1，且不超过天花板
  const l2 = createLimiter({ target: 4, successStreak: 1 })
  l2.penalize() // limit=2
  l2.reward(); l2.reward(); l2.reward(); l2.reward()
  ok('加性增有天花板', l2.snapshot().limit === 4, String(l2.snapshot().limit))
  // 并发不超过 limit
  const l3 = createLimiter({ target: 2 })
  const held = []
  const a = l3.acquire().then((rel) => held.push(rel))
  const b = l3.acquire().then((rel) => held.push(rel))
  const c = l3.acquire().then((rel) => held.push(rel))
  await Promise.all([a, b]); await Promise.resolve()
  ok('第 3 个许可被排队（不超上限）', l3.snapshot().waiting === 1 && l3.snapshot().inFlight === 2, JSON.stringify(l3.snapshot()))
  held[0]()
  await c
  ok('释放后排队者被唤醒', l3.snapshot().inFlight === 2, JSON.stringify(l3.snapshot()))
  held.slice(1).forEach((r) => r())
  ok('全部归还后归零', l3.snapshot().inFlight === 0)
}

console.log('\n[5b] 跑批熔断：整池秒拒时立刻停手（实测 21 镜空转的来源）')
{
  const c = createRunCircuit({ threshold: 3, fastFailMs: 1500 })
  ok('阈值默认 8', DEFAULT_TRIP_THRESHOLD === 8, String(DEFAULT_TRIP_THRESHOLD))
  ok('亚秒判定 1.5s', FAST_FAIL_MS === 1500, String(FAST_FAIL_MS))
  ok('半开等待 60s', HALF_OPEN_AFTER_MS === 60000)
  let tripped = null
  for (let i = 0; i < 3; i += 1) {
    const r = c.record({ ok: false, ms: 200, kind: 'broken' })
    if (r.justTripped) tripped = r
  }
  ok('连续 3 次亚秒失败即熔断', Boolean(tripped))
  ok('熔断原因说明可读', /连续 3 次请求/.test(tripped?.reason || ''), tripped?.reason)
  ok('熔断后 canAttempt=false', c.canAttempt() === false)
  ok('快照含计数', c.snapshot().consecutiveFastFails === 3, JSON.stringify(c.snapshot()))
}
{
  const c = createRunCircuit({ threshold: 2 })
  c.record({ ok: false, ms: 200 })
  c.record({ ok: true, ms: 90000 })     // 成功 → 计数清零
  c.record({ ok: false, ms: 200 })
  ok('中间成功一次就归零（不误判）', c.canAttempt() === true && c.snapshot().consecutiveFastFails === 1,
     JSON.stringify(c.snapshot()))
}
{
  const c = createRunCircuit({ threshold: 2 })
  c.record({ ok: false, ms: 20000 })    // 慢失败 = 通道通过，只是内容/生成失败
  c.record({ ok: false, ms: 20000 })
  ok('慢失败不熔断（服务端确实排了队）', c.canAttempt() === true && c.snapshot().slowFails === 2,
     JSON.stringify(c.snapshot()))
}
{
  let clock = 0
  const c = createRunCircuit({ threshold: 1, now: () => clock })
  c.record({ ok: false, ms: 100 })
  ok('刚熔断时不可尝试', c.canAttempt() === false)
  clock = HALF_OPEN_AFTER_MS + 1
  ok('冷却后半开可探路', c.canAttempt() === true)
  ok('探路成功彻底恢复', (() => { c.record({ ok: true, ms: 5000 }); return c.snapshot().tripped === false })())
}

console.log('\n[5c] 递进冷却：同一号反复撞同一个码就翻倍')
ok('首次 broken 冷却 10min', cdFor('account-broken', 1) === 10 * 60 * 1000)
ok('第二次 20min', cdFor('account-broken', 2) === 20 * 60 * 1000)
ok('第三次 40min', cdFor('account-broken', 3) === 40 * 60 * 1000)
ok('有上限 6h', cdFor('account-broken', 20) === MAX_ESCALATED_COOLDOWN_MS, String(cdFor('account-broken', 20)))
ok('quota 不递进（本来就是 6h）', cdFor('quota', 5) === 6 * 60 * 60 * 1000)
ok('成功清零 streak', nextStreak({ status: 'broken', streak: 4 }, 'ok') === 0)
ok('pending 清零 streak', nextStreak({ status: 'broken', streak: 4 }, 'pending') === 0)
ok('连续故障累加', nextStreak({ status: 'broken', streak: 4 }, 'broken') === 5)
ok('不同故障类也累加（都是「用不了」）', nextStreak({ status: 'broken', streak: 2 }, 'quota') === 3)
ok('上一轮是 ok 则从 1 开始', nextStreak({ status: 'ok' }, 'broken') === 1)
ok('无旧记录从 1 开始', nextStreak(undefined, 'broken') === 1)

console.log('\n[5d] 选号优先级：ok 先于 pending（实测 pending 号真实出片 0.3s 被拒）')
{
  const accts = [{ uid: 'p1' }, { uid: 'ok1' }, { uid: 'u1' }, { uid: 'old1' }, { uid: 'cool1' }]
  const AT = new Date().toISOString()
  const OLD = new Date(Date.now() - 11 * 3600_000).toISOString()
  const led = { accounts: {
    p1: { status: 'pending', at: AT },
    ok1: { status: 'ok', at: AT },
    old1: { status: 'quota', at: OLD },
    cool1: { status: 'quota', at: AT },
  } }
  const ranked = rankAccounts(accts, led, { isCooling: isStillCooling })
  ok('ok 排第一', ranked[0].uid === 'ok1', ranked.map(a => a.uid).join(','))
  ok('unknown 排第二', ranked[1].uid === 'u1')
  ok('冷却已过的 expired 排第三', ranked[2].uid === 'old1')
  ok('pending 排在 expired 之后', ranked[3].uid === 'p1', ranked.map(a => a.uid).join(','))
  // 冷却中的号正常流程已被预检剔除，能走到这里说明漏了兜底，
  // 所以它的权重最高（排最后），保证不会被优先使用。
  ok('仍在冷却的号排最后（兜底）', ranked[4].uid === 'cool1', ranked.map(a => a.uid).join(','))
  ok('不改动原数组', accts[0].uid === 'p1')
  ok('同权重保持原顺序', (() => {
    const two = [{ uid: 'a' }, { uid: 'b' }]
    return rankAccounts(two, { accounts: {} }).map(a => a.uid).join(',') === 'a,b'
  })())
  ok('权重表 ok<unknown<expired<pending',
     EVIDENCE_WEIGHT.ok < EVIDENCE_WEIGHT.unknown
     && EVIDENCE_WEIGHT.unknown < EVIDENCE_WEIGHT.expired
     && EVIDENCE_WEIGHT.expired < EVIDENCE_WEIGHT.pending)
  const sum = summarizeAccounts(accts, led, { isCooling: isStillCooling })
  ok('分组统计正确', sum.counts.ok === 1 && sum.counts.unknown === 1 && sum.counts.pending === 1
     && sum.counts.expired === 1 && sum.counts.cooling === 1, JSON.stringify(sum.counts))
  ok('空账号不炸', rankAccounts([], { accounts: {} }).length === 0)
  ok('缺账本不炸', rankAccounts([{ uid: 'x' }], null).length === 1)
}

console.log('\n[5e] 定妆图重出判定（实测：一集里 3/5 张定妆图的产出账号已失效）')
{
  const mk = (name, uid) => ({ name, uri: `tos-cn-i-zaeny81f73/cn/${uid}/gen_image/1_a_jpeg_1920x1920`, uid })
  // key 路径段是纯数字 uid（实测格式 tos-cn-i-xxx/cn/<uid数字>/gen_image/…），
  // 用字母占位会被 key 格式校验拦下，测不到真正想测的分支。
  const accts = [{ uid: '111' }, { uid: '222' }]
  const AT = new Date().toISOString()
  const OLD = new Date(Date.now() - 11 * 3600_000).toISOString()
  const led = {
    accounts: {
      333: { status: 'quota', at: AT },
      444: { status: 'broken', at: AT },
      555: { status: 'quota', at: OLD },
      666: { status: 'ok', at: AT },
    },
  }
  ok('产出账号不在池 → 重出', needsRecast(mk('甲', '777'), accts, led, { isCooling: isStillCooling }).needsRecast,
     '应在账号不在池时判定需重出')
  ok('不在池有可读原因', /不在当前账号池/.test(needsRecast(mk('甲', '777'), accts, led, { isCooling: isStillCooling }).reason),
     needsRecast(mk('甲', '777'), accts, led, { isCooling: isStillCooling }).reason)
  ok('产出账号额度空 → 重出', needsRecast(mk('乙', '333'), [...accts, { uid: '333' }], led, { isCooling: isStillCooling }).needsRecast)
  ok('额度空原因可读', /当前不可用（quota）/.test(needsRecast(mk('乙', '333'), [...accts, { uid: '333' }], led, { isCooling: isStillCooling }).reason),
     needsRecast(mk('乙', '333'), [...accts, { uid: '333' }], led, { isCooling: isStillCooling }).reason)
  ok('产出账号 broken → 重出', needsRecast(mk('丙', '444'), [...accts, { uid: '444' }], led, { isCooling: isStillCooling }).needsRecast)
  ok('冷却已过 → 不必重出（还能用）', !needsRecast(mk('丁', '555'), [...accts, { uid: '555' }], led, { isCooling: isStillCooling }).needsRecast,
     needsRecast(mk('丁', '555'), [...accts, { uid: '555' }], led, { isCooling: isStillCooling }).reason)
  ok('产出账号正常 → 不必重出', !needsRecast(mk('戊', '666'), [...accts, { uid: '666' }], led, { isCooling: isStillCooling }).needsRecast,
     needsRecast(mk('戊', '666'), [...accts, { uid: '666' }], led, { isCooling: isStillCooling }).reason)
  ok('空图 → 重出', needsRecast({ name: '己', uri: '', uid: '111' }, accts, led, { isCooling: isStillCooling }).needsRecast)
  ok('key 内 uid 与记录不符 → 重出', needsRecast(
    { name: '庚', uri: 'tos-cn-i-zaeny81f73/cn/999/gen_image/1_a_jpeg_1920x1920', uid: '111' },
    accts, led, { isCooling: isStillCooling }).needsRecast)
  ok('无账本记录 + 账号在池 → 复用', !needsRecast(mk('辛', '111'), accts, { accounts: {} }, { isCooling: isStillCooling }).needsRecast)

  const plan = planRecast([mk('甲', '777'), mk('乙', '333'), mk('戊', '666')], [...accts, { uid: '333' }, { uid: '666' }], led, { isCooling: isStillCooling })
  ok('重出计划只挑坏的', plan.recast.length === 2 && plan.keep.length === 1,
     JSON.stringify({ r: plan.recast.map(c => c.name), k: plan.keep.map(c => c.name) }))
  ok('重出项带原因', /账号/.test(plan.recast[0].recastReason || ''))

  const idx2 = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
  ok('出片前调用重出计划', /const plan = planRecast\(castings, usable, ledger/.test(idx2))
  ok('重出走 castCharacter + force', /castCharacter\({[\s\S]{0,200}force: true/.test(idx2))
  ok('可关闭重出（--no-recast）', /recastCastings = true/.test(idx2) && /recastCastings !== false/.test(idx2))
  ok('重出后重读定妆列表', /castings = await listCastings\(projectDir\)/.test(idx2))
  ok('重出上报事件', /type: 'recast-plan'/.test(idx2) && /type: 'recast-done'/.test(idx2))
  ok('角色卡按 list 查而不是 map.get（key 是归一化名）',
     /charIndex\.list\s*\?\?\s*\[\]/ .test(idx2) || idx2.includes('charIndex.list'),
     'map 的 key 经 normalizeName，用原名 get 会找不到')
}

console.log('\n[6] 时长：分镜意图 vs 模型下限')
ok('MIN_DURATION 是 4（服务端实测下限，非二进制 Schema 的 2）', MIN_DURATION === 4, String(MIN_DURATION))
ok('AUTOCONCURRENCY_CAP 封顶 6', AUTOCONCURRENCY_CAP === 6, String(AUTOCONCURRENCY_CAP))
const c2 = clampDurationToModel(2)
ok('2s 抬到下限', c2.duration === MIN_DURATION && c2.clamped === 'below', JSON.stringify(c2))
const c3 = clampDurationToModel(3)
ok('3s 抬到下限', c3.duration === MIN_DURATION)
const c5 = clampDurationToModel(5)
ok('5s 原样不动', c5.duration === 5 && c5.clamped === null)
const c20 = clampDurationToModel(20)
ok('20s 截到上限', c20.duration === MAX_DURATION && c20.clamped === 'above')
ok('缺值走默认', clampDurationToModel(undefined).duration > 0)
ok('负数走默认', clampDurationToModel(-3).duration > 0)
ok('normalizeDuration 对 2 抛错（参数层仍严格）', (() => {
  try { normalizeDuration(2); return false } catch { return true }
})())
ok('normalizeDuration 对 4 通过', normalizeDuration(4) === 4)

console.log('\n[7] 账本冷却：观测有时效，不是永久判决')
const NOW = Date.now()
ok('1 分钟前的 quota 仍在冷却', isStillCooling({ status: 'quota', at: new Date(NOW - 60_000).toISOString() }, NOW))
ok('7 小时前的 quota 已解封', !isStillCooling({ status: 'quota', at: new Date(NOW - 7 * 3600_000).toISOString() }, NOW))
ok('5 分钟前的 broken 仍在冷却', isStillCooling({ status: 'broken', at: new Date(NOW - 300_000).toISOString() }, NOW))
ok('20 分钟前的 broken 已解封', !isStillCooling({ status: 'broken', at: new Date(NOW - 1200_000).toISOString() }, NOW))
ok('auth 冷却 30 分钟', isStillCooling({ status: 'auth', at: new Date(NOW - 20 * 60_000).toISOString() }, NOW))
ok('ok 状态不算冷却', !isStillCooling({ status: 'ok', at: new Date().toISOString() }, NOW))
ok('无时间戳按过期处理（宁可多试一个号，不多封一个号）', !isStillCooling({ status: 'quota' }, NOW))
ok('坏时间戳按过期处理', !isStillCooling({ status: 'quota', at: 'not-a-date' }, NOW))
ok('quota 冷却 6h', cooldownFor('quota') === QUOTA_COOLDOWN_MS)
ok('broken 冷却 10min', cooldownFor('account-broken') === BROKEN_COOLDOWN_MS || cooldownFor('broken') === BROKEN_COOLDOWN_MS)
ok('auth 冷却 30min', cooldownFor('auth') === AUTH_COOLDOWN_MS)

console.log('\n[8] 账本预估与冷却一致')
const AT = new Date(NOW - 60_000).toISOString()
const est = estimateQuota([{ uid: 'a' }, { uid: 'b' }], { accounts: { b: { status: 'quota', at: AT } } }, 2, NOW)
ok('活跃冷却的账号不可用', est.usable === 1 && est.quotaDead === 1, JSON.stringify(est))
const OLDAT = new Date(NOW - 11 * 3600_000).toISOString()
const est2 = estimateQuota([{ uid: 'b' }], { accounts: { b: { status: 'quota', at: OLDAT } } }, 2, NOW)
ok('过期记录放回可用池（真实 bug 回归）', est2.usable === 1 && est2.quotaDead === 0, JSON.stringify(est2))

console.log('\n[9] 错误文案：用户能从文字里知道该做什么')
ok('4010 文案提到并发', /并发/.test(explainTraeVError('code=4010 access denied')))
ok('2001 文案提到并发/锁', /锁|并发/.test(explainTraeVError('code=2001 usage reservation lock is busy')))
ok('时长参数错文案给出区间', /4~15/.test(explainTraeVError('InvalidParameter ... duration ... received: "2"')))
ok('配额文案提到换账号', /换账号|换号/.test(explainTraeVError('code=4008 exceeded the quota')))
ok('文案不透传原始 JSON', !explainTraeVError('{"code":3003,"message":"...4008..."}').includes('"code"'))

console.log('\n[10] 分类结果不再有两套判定（quota.js 转发 errors.js）')
ok('4008 时 classifyAccountFailure.kind=quota', classifyAccountFailure('code=4008').kind === 'quota')
ok('4040 时 kind=broken（对外仍是三值）', classifyAccountFailure('code=4040').kind === 'broken')
ok('4010 不算账号故障', classifyAccountFailure('code=4010 access denied').fault === false)
ok('2001 不算账号故障', classifyAccountFailure('code=2001 lock busy').fault === false)

console.log('\n[11] 源码接线：出片循环必须用统一分类 + 两套重试预算')
const idx = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
ok('出片循环调用 classifyError', /const cls = classifyError\(msg\)/.test(idx))
ok('全局限流单独重试预算', /const maxGlobalRetries = Number\(process\.env\.DSH_TRAE_GLOBAL_RETRIES/.test(idx))
ok('全局限流不推进账号轮转计数', (() => {
  // 全局限流分支里绝不能碰 accountTries —— 一旦碰了，24 个账号预算会把
  // 「3 次退避」压成「1 次」，等于没加重试。这里直接切出该分支检查。
  const at = idx.indexOf("if (cls.scope === 'global')")
  if (at < 0) return false
  const block = idx.slice(at, idx.indexOf('// 账号级：换下一个账号继续', at))
  return block.length > 100 && !/accountTries \+=/.test(block) && /continue/.test(block)
})(), '全局限流分支改动了账号轮转计数')
ok('撞限流立刻降并发', /limiter\.penalize\(\)/.test(idx))
ok('成功一次给闸门加分', /limiter\.reward\(\)/.test(idx))
ok('请求段才占并发许可', /const release = await limiter\.acquire\(\)/.test(idx) && /finally[\s\S]{0,60}release\(\)/.test(idx))
ok('自动并发受上限约束', /Math\.min\(usable\.length, planned\.length, autoCap\)/.test(idx))
ok('预览按冷却期判定', /isStillCooling\(r\)/.test(idx))
ok('时长走 clampDurationToModel', /clampDurationToModel\(rawDur\)/.test(idx))
ok('summary 带 limiter 快照', /limiter: limiter\.snapshot\(\)/.test(idx))
ok('summary 带 circuit 快照', /circuit: circuit\.snapshot\(\)/.test(idx))
ok('熔断期间不再发请求', /if \(!circuit\.canAttempt\(\)\)[\s\S]{0,120}break/.test(idx))
ok('熔断时发 circuit-open 事件', /type: 'circuit-open'/.test(idx))
ok('熔断结果同时给人话原因', /cb\.reason/.test(idx))
ok('出片前按证据强度重排账号', /const ranked = rankAccounts\(usable, ledger/.test(idx) && /usable = ranked/.test(idx))
ok('重排后上报 account-rank 事件', /type: 'account-rank'/.test(idx))

console.log('\n[11b] 账号租约：并发 worker 不得挑中同一个号（实测同一死号被撞两次）')
ok('有租约集合', /const busyUids = new Set\(\)/.test(idx))
ok('取号时过滤被占住的号', /!busyUids\.has\(String\(a\.uid\)\)/.test(idx))
ok('取到号即占住', /busyUids\.add\(String\(credential\.uid\)\)/.test(idx))
ok('成功路径释放租约', /busyUids\.delete\(String\(credential\.uid\)\)[\s\S]{0,40}accountIndex/.test(idx)
   || (idx.match(/busyUids\.delete\(String\(credential\.uid\)\)/g) || []).length >= 2,
   '失败/成功两条路径都要释放，否则租约泄漏后全池被占死')
ok('全池被占时不报错而是等一轮', /所有存活号都在被别的 worker 使用/.test(idx))

console.log('\n[11c] 并发惩罚必须分类型（实测：2 次 lock-busy 把并发从 3 降到 1，整集串行）')
ok('只有通道级故障才降并发',
   /const channelWide = cls\.kind === 'access-denied' \|\| cls\.kind === 'rate-limit'/.test(idx),
   'lock-busy 是单账号用量锁，降全局并发是过度反应')
ok('非通道级保持原并发', /: limiter\.snapshot\(\)\.limit/.test(idx))
ok('事件区分是否惩罚', /penalized: channelWide/.test(idx))
ok('探回速度 3 次成功', /successStreak = 3/.test((await fs.readFile(new URL('../src/limiter.js', import.meta.url), 'utf8'))),
   '取 6 时 14 镜内探不回 2')
{
  const l = createLimiter({ target: 4, successStreak: 3 })
  l.penalize(); l.penalize()   // 4 → 2 → 1
  ok('连续惩罚能到 1', l.snapshot().limit === 1)
  l.reward(); l.reward(); l.reward()
  ok('3 次成功探回 2', l.snapshot().limit === 2, String(l.snapshot().limit))
}

console.log('\n[12] 前端：partial 也必须停轮询（真实 bug：按钮永久禁用）')
const cli = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
ok('终态集合含 partial', /TERMINAL_JOB_STATUS = new Set\(\['done', 'failed', 'partial', 'cancelled'\]\)/.test(cli))
ok('轮询停止用终态集合', /if \(TERMINAL_JOB_STATUS\.has\(j\.status\)\)/.test(cli))
ok('不再只判 done/failed 停轮询',
   !/if \(j\.status === 'done' \|\| j\.status === 'failed'\) \{\n              clearInterval/.test(cli))
ok('partial 也刷新产物列表', /j\.status === 'done' \|\| j\.status === 'partial'\) refreshArtifacts/.test(cli))
ok('有当前动作翻译器', /function describeJobEvent/.test(cli))
ok('进度条显示当前动作', /jobProgress\.currentText/.test(cli))
ok('翻译覆盖 4010 退避', /case 'retry': return cur\.waitMs/.test(cli))
ok('翻译覆盖降并发', /case 'throttle'/.test(cli))
ok('翻译覆盖换号', /case 'quota-dead'/.test(cli))

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) process.exitCode = 1
