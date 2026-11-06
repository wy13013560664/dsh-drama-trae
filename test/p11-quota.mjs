/**
 * P11：配额账本与预估（出片前预检）。
 *   node test/p11-quota.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  isQuotaExhausted, isAccountLevelFailure, classifyAccountFailure,
  isRetriableGenerationError, explainTraeVError,
  readLedger, writeLedger, recordAccount, recordAccounts,
  estimateQuota, LEDGER_FILE,
} from '../src/quota.js'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }
const tj = (n, fn) => { try { fn(); ok(n, true) } catch (e) { fail++; console.log(`  ❌ ${n}\n     ${e.message}`) } }

console.log('\n[1] 配额耗尽判定')
ok('识别 4008', isQuotaExhausted('{"code":3003,"message":"... code=4008 ..."}'))
ok('识别 exceeded the quota', isQuotaExhausted('Your requests have exceeded the quota'))
ok('识别中文/英文 quota 混合', isQuotaExhausted('model call failed: quota exceeded'))
ok('网络错误不算配额', !isQuotaExhausted('ECONNREFUSED'))
ok('鉴权错误不算配额', !isQuotaExhausted('invalid userid'))
ok('空值安全', !isQuotaExhausted(null) && !isQuotaExhausted(undefined) && !isQuotaExhausted(''))

console.log('\n[1a] 账号级故障判定（4040 必须换号，否则镜头直接失败）')
ok('4008 是账号级', isAccountLevelFailure('...code=4008...exceeded the quota'))
ok('4040 是账号级（实测换号即可出片）', isAccountLevelFailure('...code=4040 message='))
ok('4030 是账号级', isAccountLevelFailure('...code=4030...'))
ok('1001 是账号级（实测复现的卡死原因）', isAccountLevelFailure('{"code":1001,"message":"not able to authenticate you"}'))
ok('not able to authenticate 是账号级', isAccountLevelFailure('We are not able to authenticate you'))
ok('1001 可换号重试', isRetriableGenerationError('{"code":1001,"message":"not able to authenticate"}'))
ok('1001 分类为 auth', classifyAccountFailure('code=1001').kind === 'auth')
ok('auth 冷却 30 分钟', classifyAccountFailure('code=1001').cooldownMs === 30 * 60 * 1000)
ok('1001 有可读说明', /code 1001/.test(explainTraeVError('{"code":1001,"message":"not able to authenticate you"}')))
ok('参数错非账号级', !isAccountLevelFailure('InvalidParameter'))
ok('invalid userid 非账号级', !isAccountLevelFailure('invalid userid'))
ok('4008 分类为 quota', classifyAccountFailure('code=4008').kind === 'quota')
ok('4040 分类为 broken', classifyAccountFailure('code=4040').kind === 'broken')
ok('quota 冷却 6 小时', classifyAccountFailure('code=4008').cooldownMs === 6 * 60 * 60 * 1000)
ok('broken 冷却 10 分钟', classifyAccountFailure('code=4040').cooldownMs === 10 * 60 * 1000)
ok('未知错误不冷却', classifyAccountFailure('ECONNREFUSED').cooldownMs === 0)

console.log('\n[1b] 错误分类与可读化（用户报「callArkVideoGeneration」看不懂）')
ok('4008 可换号', isRetriableGenerationError('...code=4008...exceeded the quota'))
ok('4040 可换号', isRetriableGenerationError('{"code":3003,"message":"...code=4040 message="}'))
ok('429 可换号', isRetriableGenerationError('rate limit exceeded'))
ok('参数错不可换号', !isRetriableGenerationError('param is invalid'))
ok('invalid userid 不可换号', !isRetriableGenerationError('failed to sign image url: invalid userid'))
ok('网络错不可换号', !isRetriableGenerationError('ECONNREFUSED'))

ok('4008 翻译成配额说明', /配额已用尽/.test(explainTraeVError('...code=4008...exceeded the quota')))
ok('4040 翻译成生成层拒绝', /code 4040/.test(explainTraeVError('{"code":3003,"message":"...code=4040 message="}')))
ok('callArkVideoGeneration 翻译成内部报错', /callArkVideoGeneration/.test(explainTraeVError('...message=[callArkVideoGeneration]')))
ok('invalid userid 翻译成参考图不匹配', /参考图 key 与当前账号不匹配/.test(explainTraeVError('invalid userid')))
ok('4001 翻译成参数不合法', /参数不合法/.test(explainTraeVError('4001 param is invalid')))
ok('未知错误保留原文', explainTraeVError('some weird error').includes('some weird error'))
ok('空错误给兜底文案', /未知错误/.test(explainTraeVError('')))
ok('翻译结果不含原始 JSON 嵌套',
   !explainTraeVError('{"code":3003,"message":"...4008..."}').includes('"code"'), '仍在透传 JSON')

console.log('\n[2] 账本读写')
const DIR = '/tmp/p11-quota'
await fs.rm(DIR, { recursive: true, force: true })
const PD = path.join(DIR, 'AI短剧', 'q')
await fs.mkdir(PD, { recursive: true })

ok('无账本返回空结构', (await readLedger(PD)).accounts && Object.keys((await readLedger(PD)).accounts).length === 0)

await recordAccount(PD, 'u1', 'ok', '镜 1')
const r1 = await readLedger(PD)
ok('记录后能读回', r1.accounts.u1?.status === 'ok')
ok('记录含时间戳', typeof r1.accounts.u1?.at === 'string')
ok('记录含备注', r1.accounts.u1?.note === '镜 1')
ok('账本落在 .aidrama/quota-ledger.json', (await fs.readdir(path.join(PD, '.aidrama'))).some(f => f === 'quota-ledger.json'))

await recordAccounts(PD, [
  { uid: 'u2', status: 'quota', note: '4008' },
  { uid: 'u1', status: 'quota', note: '后来耗尽' },   // 覆盖
])
const r2 = await readLedger(PD)
ok('批量记账生效', r2.accounts.u2?.status === 'quota')
ok('同 uid 被覆盖为最新状态', r2.accounts.u1?.status === 'quota')
ok('覆盖保留最新备注', r2.accounts.u1?.note === '后来耗尽')
ok('空数组不写盘出错', (await recordAccounts(PD, [])) === null)
ok('无 uid 被忽略', (await recordAccount(PD, '', 'ok')) === null)

tj('坏账本文件不抛错', () => {})
await fs.writeFile(path.join(PD, '.aidrama', 'quota-ledger.json'), 'not json')
ok('坏账本返回空结构', Object.keys((await readLedger(PD)).accounts || {}).length === 0)

console.log('\n[3] 预估')
// 账本条目必须带 at：冷却期判定依赖时间戳，无时间戳的记录视为过期（乐观放回池里）
const NOW = Date.now()
const AT = new Date(NOW - 60 * 1000).toISOString()
const ACCTS = [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }, { uid: 'd' }]
const est = estimateQuota(ACCTS, { accounts: { a: { status: 'ok', at: AT }, b: { status: 'quota', at: AT } } }, 8, NOW)
ok('usable 含 unknown（乐观）', est.usable === 3, String(est.usable))
ok('quotaDead 计数正确', est.quotaDead === 1, String(est.quotaDead))
ok('unknown 计数正确', est.unknown === 2, String(est.unknown))
ok('capacity = usable × 4', est.capacity === 12, String(est.capacity))
ok('enough 判定正确', est.enough === true)
ok('detail 覆盖全部账号', est.detail.length === 4)
ok('detail 标注状态', est.detail.find(d => d.uid === 'b').state === 'quota')

console.log('\n[3a0] 冷却期过期自动解封（真实 bug：11 小时前的 warmup 记录永久封号）')
const OLD = new Date(NOW - 11 * 60 * 60 * 1000).toISOString()
const est3 = estimateQuota([{ uid: 'x' }], { accounts: { x: { status: 'quota', at: OLD } } }, 4, NOW)
ok('过期 quota 不再计入 quotaDead', est3.quotaDead === 0, String(est3.quotaDead))
ok('过期 quota 重新算可用', est3.usable === 1, String(est3.usable))
ok('过期状态标记为 expired', est3.detail.find(d => d.uid === 'x').state === 'expired')
ok('expired 计数存在', est3.expired === 1, String(est3.expired))
const est4 = estimateQuota([{ uid: 'y' }], { accounts: { y: { status: 'broken', at: new Date(NOW - 5 * 60 * 1000).toISOString() } } }, 4, NOW)
ok('10 分钟内的 broken 仍在冷却', est4.quotaDead === 1 && est4.usable === 0)
const est5 = estimateQuota([{ uid: 'y' }], { accounts: { y: { status: 'broken', at: new Date(NOW - 20 * 60 * 1000).toISOString() } } }, 4, NOW)
ok('超过 10 分钟的 broken 自动解封', est5.usable === 1 && est5.quotaDead === 0)
ok('空 at 视为过期（不永久封号）', estimateQuota([{ uid: 'z' }], { accounts: { z: { status: 'quota' } } }, 1, NOW).usable === 1)

const est2 = estimateQuota(ACCTS, { accounts: {
  a: { status: 'quota', at: AT }, b: { status: 'quota', at: AT },
  c: { status: 'quota', at: AT }, d: { status: 'quota', at: AT },
} }, 4, NOW)
ok('全耗尽时 enough=false', est2.enough === false)
ok('全耗尽时 usable=0', est2.usable === 0)
ok('空账号列表不崩', estimateQuota([], { accounts: {} }, 5).usable === 0)
ok('需求为 0 时 enough=true', estimateQuota([{ uid: 'x' }], { accounts: {} }, 0).enough === true)

await fs.rm(DIR, { recursive: true, force: true })

console.log('\n[3a] 全跳过不判失败（真实 bug：文件已存在→skip→被误报「生成失败」）')
const idxS = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
ok('引入 skipped 判断', /const skipped = Number\(result\?\.skipped/.test(idxS))
ok('generated=0 且 errors=0 且 skipped>0 → done',
   idxS.includes('generated === 0 && errors === 0 && skipped > 0'))
ok('force 参数存在', /force = false,/.test(idxS))
ok('force 时不跳过', idxS.includes('exists && !force'))
ok('force 时发 overwrite 事件', idxS.includes("type: 'overwrite'"))
ok('路由透传 force', /force: Boolean\(input\.force\)/.test(idxS))

console.log('\n[3b] 出片函数的变量完整性（真实崩溃过：castings / charCards is not defined）')
const idxSrc = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
// 提取 runOneShotDrama 函数体（顶层括号配对）
const startAt = idxSrc.indexOf('export async function runOneShotDrama')
// 到下一个顶层 export 为止（函数体里含解构花括号，简单括号配对会错位）
const nextExport = idxSrc.indexOf('\nexport ', startAt + 10)
const endAt = nextExport > 0 ? nextExport : idxSrc.length
const body = idxSrc.slice(startAt, endAt)
ok('函数体提取成功', body.length > 1000, String(body.length))

// 出片函数里用到的关键变量必须有声明
const need = ['castings', 'allCharCards', 'quotaEntries', 'deadThisRun', 'ledger', 'knownDead']
for (const v of need) {
  const used = new RegExp(`\\b${v}\\b`).test(body)
  const declared = new RegExp(`(?:const|let|var)\\s+${v}\\b`).test(body)
  ok(`${v} 已声明`, !used || declared, used ? '使用了但未声明' : '未使用')
}
// 出片函数里不能再出现未声明的 charCards（应为 allCharCards）
ok('不再使用未声明的 charCards',
   !/\\bcharCards\\b/.test(body), '应改用 allCharCards')

console.log('\n[3b2] SSE 必须有两层超时（实测裸 await 会永久挂起）')
// SSE 消费在 src/video.js（consumeSse），不在 index.js —— 断言必须读对文件
const vidSrc = await fs.readFile(new URL('../src/video.js', import.meta.url), 'utf8')
ok('有 idle 超时', vidSrc.includes('SSE 连续') && /idleMs/.test(vidSrc))
ok('有总时长超时', vidSrc.includes('SSE 超过总时长上限'))
ok('可经环境变量调整', /DSH_TRAE_SSE_IDLE_MS/.test(vidSrc) && /DSH_TRAE_SSE_TOTAL_MS/.test(vidSrc))
ok('超时会 cancel reader', /reader\.cancel\(\)[\s\S]{0,120}throw new Error/.test(vidSrc) || vidSrc.split('reader.cancel()').length > 2)
ok('不再是无保护的 while(true)+read', !/while \(true\) \{\n    const \{ done, value \} = await reader\.read\(\)/.test(vidSrc))

console.log('\n[3c] 配额耗尽立即拉黑（避免同一账号重试 10 次）')
ok('有本轮黑名单', /const deadThisRun = new Set\(\)/.test(body))
ok('撞配额时立刻拉黑', /deadThisRun\.add\(String\(credential\.uid\)\)/.test(body))
ok('选号前过滤已死账号', /usable\.filter\(\(a\) => !deadThisRun\.has/.test(body))
ok('全部耗尽时提前 break', /alive\.length === 0/.test(body))
ok('发出 quota-dead 事件', /type: 'quota-dead'/.test(body))
ok('定妆图账号已死时明确放弃', /已配额耗尽，且该图只能用它签名/.test(body))

console.log('\n[3d] 任务状态必须反映真实成败（用户报「提示生成完成，实际是失败」）')
const cli2 = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')

// 后端：按 generated / errors 判定
ok('后端按 generated 判定', /const generated = Number\(result\?\.generated/.test(idxSrc))
ok('0 镜成功即判 failed', /if \(generated === 0\)/.test(idxSrc))
ok('部分失败判 partial', /status = 'partial'/.test(idxSrc))
ok('failed 带原因', /全部 \$\{errors\} 镜生成失败/.test(idxSrc))
ok('summary 带 firstError', idxSrc.includes('firstError: results.errors[0]?.error'), '未找到')
ok('summary 带 perShot', /perShot: results\.errors\.slice/.test(idxSrc))
ok('不再无条件 status done',
   !idxSrc.includes("job.status = 'done'\n          job.finishedAt"),
   '仍有硬编码 done')

// 前端：三种状态都要能显示
ok('前端有 partial 状态', /jobProgress\.status === 'partial'/.test(cli2))
ok('failed 显示错误原因', cli2.includes('jobFails') && cli2.includes('jobFails ? h('))
ok('done 才显示生成完成', /jobProgress\.status === 'done' \? \{ icon: '✅', label: '生成完成'/.test(cli2))
ok('不再只看 done 就报完成',
   !cli2.includes("jobProgress.status === 'done' ? '✅ 生成完成'"), '仍是旧写法')

console.log('\n[4] 源码接线')
const idx = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
const cli = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
const errSrc = await fs.readFile(new URL('../src/errors.js', import.meta.url), 'utf8')
ok('出片前置读账本', /readLedger\(projectDir\)/.test(idx))
ok('已知耗尽账号被剔除', /cooling\.includes\(String\(a\.uid\)\)/.test(idx),
   '预检未剔除冷却中的账号')
ok('全耗尽时抛明确错误', /没有可用 TRAE 账号/.test(idx))
ok('跑完写账本', /recordAccounts\(projectDir, quotaEntries\)/.test(idx))
ok('成功记 ok', /quotaEntries\.push\(\{ uid: credential\.uid, status: 'ok'/.test(idx))
ok('配额/账号异常/鉴权都记账', /cls\.markAccount/.test(idx) && /status: cls\.kind === 'quota' \? 'quota'/.test(idx),
   '应把 quota/broken/auth 都记账')
ok('有 /quota-estimate 路由', /apiBase}\/quota-estimate/.test(idx))
ok('出片用统一分类（src/errors.js）', /import \{ classifyError, backoffFor, sleep, isStillCooling \}/.test(idx))
ok('账号级故障走换号', /cls\.markAccount/.test(idx))
ok('全局限流走退避重试（不换号）', /cls\.scope === 'global'/.test(idx) && /backoffFor\(cls\.backoffMs/.test(idx))
ok('参数/内容被拒直接判失败不再重试', /if \(!cls\.retriable\)/.test(idx))
ok('预检按冷却期判定', /isStillCooling\(r\)/.test(idx))
ok('过期记录会被复活并上报', /type: 'quota-revive'/.test(idx))

console.log('\n[4b] 错误分类单一来源（src/errors.js）')
ok('errors.js 定义 classifyError', /export function classifyError/.test(errSrc))
ok('4010 归为全局限流', /code=4010[^\n]*access denied/.test(errSrc) && /kind: 'access-denied', scope: 'global'/.test(errSrc))
ok('2001 锁占用单独分类', /reservation lock is busy/.test(errSrc) && /kind: 'lock-busy'/.test(errSrc))
ok('参数错标记为不可重试', /scope: 'content', retriable: false/.test(errSrc))
ok('invalid userid 不拉黑账号', /kind: 'binding'/.test(errSrc))
ok('冷却时长单一定义', /export const QUOTA_COOLDOWN_MS/.test(errSrc) && /export function cooldownFor/.test(errSrc))
ok('quota.js 不再自带正则（改为转发）', !/exceeded the quota\|quota exceeded/.test(
  (await fs.readFile(new URL('../src/quota.js', import.meta.url), 'utf8'))),
  'quota.js 仍有独立正则，会与 errors.js 出现两套判定')
ok('不再用内联正则判可换号',
   !/isRetriableGenerationError\(msg\)/.test(idx), '出片循环应直接用 classifyError')
ok('错误写给人话', idx.includes('const humanErr = lastError ? explainTraeVError'),
   '未找到 humanErr 转换')
ok('同时保留 rawError 便于排查', /rawError: rawErr\.slice/.test(idx))
ok('前端调 quota-estimate', /api\('quota-estimate'/.test(idx) || /api\('quota-estimate'/.test(cli))
ok('前端有「配额预估」按钮', /配额预估/.test(cli))
ok('不够时禁用出片按钮', /quotaEst && !quotaEst\.enough/.test(cli))
ok('显示可用账号与容量', /可用 \$\{quotaEst\.usable\} 个账号/.test(cli))

// GenerateTab 三项 props 两端齐全（上一轮白屏的教训）
const g = cli.slice(cli.indexOf('function GenerateTab(props)'))
const gEnd = g.indexOf('\n    function ', 10)
const gBody = g.slice(0, gEnd > 0 ? gEnd : 2000)
const gi = cli.indexOf("pane('generate', h(GenerateTab, {")
const call = cli.slice(gi, gi + 900)
for (const p of ['quotaEst', 'quotaLoading', 'onLoadQuotaEstimate']) {
  ok(`GenerateTab 解构含 ${p}`, gBody.includes(p))
  ok(`GenerateTab 调用传入 ${p}`, call.includes(p))
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
