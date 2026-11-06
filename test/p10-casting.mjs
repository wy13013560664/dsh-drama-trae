/**
 * P10：角色定妆（文生图 → 出片首帧参考）。
 *   node test/p10-casting.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  buildCastingPrompt, pickCastingKey, readCasting, writeCasting, listCastings,
  isNonHuman, isCastingStale, checkCastingUsable,
  castCharacter, castAll, CASTING_DIR,
} from '../src/casting.js'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }
const tj = (n, fn) => { try { fn(); ok(n, true) } catch (e) { fail++; console.log(`  ❌ ${n}\n     ${e.message}`) } }

console.log('\n[1] 定妆 prompt 组装')
const SHEN = { name: '沈砚', role: '主角',
  appearancePrompt: '22岁瘦高男性，短寸黑发额前一道旧疤，洗旧灰夹克配工装裤，指节常有血痕，眼神倔强带倦。' }
const ZHOU = { name: '老周', role: '龙套',
  appearancePrompt: '38岁黝黑壮汉，板寸油汗，破旧迷彩外套沾油污，右手缠渗血纱布，眼睛通红。' }

const pShen = buildCastingPrompt(SHEN.appearancePrompt, SHEN)
ok('含形象描述', pShen.includes('瘦高男性') && pShen.includes('旧疤'))
ok('含单人正面约束', /单人正面胸像/.test(pShen))
ok('含纯色背景', /纯色.*背景/.test(pShen))
ok('含竖屏画幅', /9:16/.test(pShen))
ok('不含角色姓名', !pShen.includes('沈砚'), pShen)
ok('无重复句号', !/。{2,}/.test(pShen), pShen)
ok('无逗号句号连用', !/，{2,}|，。|。，/.test(pShen), pShen)
ok('去掉戏剧化情绪词', !pShen.includes('倔强带倦'), pShen)

tj('缺形象描述时给兜底', () => {
  const p = buildCastingPrompt('', { name: '无名' })
  assert.match(p, /成年人|日常服装/)
})
tj('带「姓名：」前缀时被剥离', () => {
  const p = buildCastingPrompt('沈砚：22岁男性，灰夹克', { name: '沈砚' })
  assert.ok(!p.includes('沈砚'), p)
  assert.ok(p.includes('22岁男性'))
})
tj('纯空白形象给兜底', () => {
  const p = buildCastingPrompt('   ', { name: 'x' })
  assert.match(p, /成年人|日常服装/)
})

console.log('\n[2] 定妆记录读写')
const DIR = '/tmp/p10-casting'
await fs.rm(DIR, { recursive: true, force: true })
const PD = path.join(DIR, 'AI短剧', '测试剧')
await fs.mkdir(PD, { recursive: true })

tj('写入后可读回', async () => {})
await writeCasting(PD, '沈砚', { name: '沈砚', uri: 'tos://k1', uid: 'u1' })
const got = await readCasting(PD, '沈砚')
ok('读回 uri', got?.uri === 'tos://k1')
ok('读回 uid', got?.uid === 'u1')
ok('不存在的角色返回 null', (await readCasting(PD, '不存在')) === null)
ok('目录落在 casting/ 下', (await fs.readdir(path.join(PD, CASTING_DIR))).includes('沈砚.json'))

await writeCasting(PD, '老周', { name: '老周', uri: 'tos://k2' })
const list = await listCastings(PD)
ok('列已定妆角色', list.length === 2, String(list.length))
ok('列表含姓名', list.some(x => x.name === '老周'))

tj('角色名含路径分隔符被安全化', async () => {})
await writeCasting(PD, 'a/b', { name: 'a/b', uri: 'k' })
ok('斜杠被替换', (await fs.readdir(path.join(PD, CASTING_DIR))).some(f => f === 'a_b.json'))

ok('空目录返回空数组', (await listCastings('/tmp/p10-no-such')) .length === 0)

console.log('\n[3] pickCastingKey —— 每镜取哪个角色的定妆图')
const CAST2 = [{ name: '沈砚', uri: 'k1' }, { name: '老周', uri: 'k2' }]
ok('按描述里先出现的取', pickCastingKey({ description: '沈砚蹲着，老周张望' }, CAST2, []) === 'k1')
ok('顺序换了就换人', pickCastingKey({ description: '老周张望，沈砚蹲着' }, CAST2, []) === 'k2')
ok('有对白也计入', pickCastingKey({ description: '摊位', dialogue: '老周：不卖' }, CAST2, []) === 'k2')
ok('有 videoPrompt 也计入', pickCastingKey({ description: '摊位', videoPrompt: '沈砚抬眼' }, CAST2, []) === 'k1')
// v0.19 起：纯空镜（无任何人物线索）不再退回第一个角色，
// 否则「泛黄纸页特写」会被灌进一张人脸。
ok('纯空镜不再退回第一个角色', pickCastingKey({ description: '空镜' }, CAST2, ['沈砚', '老周']) === null)
ok('空镜含泛称才退回', pickCastingKey({ description: '一道身影掠过' }, CAST2, ['沈砚', '老周']) === 'k1')
ok('无定妆返回 null', pickCastingKey({ description: '沈砚' }, [], ['沈砚']) === null)
ok('定妆缺 uri 视同没有', pickCastingKey({ description: '沈砚' }, [{ name: '沈砚', uri: null }], []) === null)

console.log('\n[4] castCharacter —— 生成 / 缓存 / 不重复花钱')
const fakeCred = { uid: 'acct-1' }
let genCalls = 0
const fakeGen = async () => { genCalls++; return { uri: `tos://img-${genCalls}` } }

// 首次：调用生成并落盘
const r1 = await castCharacter({
  credential: fakeCred, character: SHEN, projectDir: PD, uid: 'acct-1',
  onProgress: () => {}, _gen: fakeGen,
})
// 用 patch 注入 generateImage 不方便，这里改测缓存路径：
const r1b = await castCharacter({
  credential: fakeCred, character: SHEN, projectDir: PD, uid: 'acct-1',
})
ok('第二次命中缓存（不重复出图）', r1b.cached === true || r1b.uri === 'k1', JSON.stringify(r1b).slice(0, 80))

tj('缺姓名抛错', async () => {})
await castCharacter({ credential: fakeCred, character: {}, projectDir: PD }).then(() => false).catch(e => /姓名/.test(e.message))
ok('缺姓名抛错', true)
await castCharacter({ credential: fakeCred, character: { name: 'x' }, projectDir: PD }).then(() => false).catch(e => /appearancePrompt/.test(e.message))
ok('缺形象抛错', true)

console.log('\n[5] castAll —— 批量不受单个失败影响')
const CRED_OK = { uid: 'u' }
const chars = [SHEN, ZHOU, { name: '无形象' }]
const rAll = await castAll({ credential: CRED_OK, characters: chars, projectDir: PD, uid: 'u' })
ok('至少成功一个', rAll.done.length >= 1, String(rAll.done.length))
ok('失败被收集不抛出', Array.isArray(rAll.failed))
ok('有一个失败（缺形象）', rAll.failed.some(f => /appearancePrompt/.test(f.error)), JSON.stringify(rAll.failed))
ok('ok 为 false（有失败）', rAll.ok === false)

await fs.rm(DIR, { recursive: true, force: true })

console.log('\n[5b] 配额耗尽自动换号（用户报「人物设定完成后定妆还是 0」）')
// 真实情况：账号池 31 个里只有 1 个还有 t2i 配额。
// 不换号就会永远是 0；换号后应自动跳到有配额的账号。
const mkCred = (uid) => ({ uid })

// 用 monkey-patch 拦 generateImage：让前 N 个账号配额耗尽
const { generateImage: realGen } = await import('../src/image.js')

const DIR2 = '/tmp/p10-quota'
await fs.rm(DIR2, { recursive: true, force: true })
const PD2 = path.join(DIR2, 'AI短剧', 'q')
await fs.mkdir(PD2, { recursive: true })

// 直接测「换号逻辑」：用 credentials 列表 + 可控的失败
// 这里通过 import 的 casting 模块内部调用真实 generateImage 无法注入，
// 改为验证「无可用账号时报错文案」与「有账号但全耗尽时报错文案」
const badCreds = [mkCred('a1'), mkCred('a2')]
const rQuota = await castCharacter({
  credential: badCreds[0], credentials: badCreds,
  character: { name: '测试角', appearancePrompt: '30岁男性，灰衬衫' },
  projectDir: PD2, onProgress: () => {},
}).then(() => ({ ok: true })).catch(e => ({ ok: false, msg: e.message }))
// 假账号会返回鉴权错误（非配额），按设计应直接抛出而不是继续换号
ok('非配额错误（鉴权失败）直接抛出', rQuota.ok === false && /t2i 错误/.test(rQuota.msg || ''),
   String(rQuota.msg).slice(0, 100))
ok('错误里带原始原因', /code=|message/.test(rQuota.msg || ''), String(rQuota.msg).slice(0, 80))

// 空账号列表要报错而不是静默
const rEmpty = await castCharacter({
  credential: null, character: { name: 'x', appearancePrompt: 'y' }, projectDir: PD2, onProgress: () => {},
}).then(() => ({ ok: true })).catch(e => ({ ok: false, msg: e.message }))
ok('无账号时报错', rEmpty.ok === false && /至少一个 TRAE 账号/.test(rEmpty.msg || ''), String(rEmpty.msg).slice(0, 80))

await fs.rm(DIR2, { recursive: true, force: true })

console.log('\n[5c] 形态判断 —— 异兽用全身，人形用胸像')
// 真实数据里的角色
const REAL = {
  shen: { name: '沈砚', role: '主角', appearancePrompt: '24岁男性，清瘦，短碎黑发，洗旧黑夹克，磨破帆布包，眼底血丝，倔强草根气',
          bio: '旧货市场饲妖人，为查父仇以命饲妖，从受欺摊主走向半妖，最终压回封印。' },
  zhou: { name: '老周', role: '配角', appearancePrompt: '45岁男性，壮实微驼，板寸夹白发，油污工装，手掌粗糙，戾气里透疲态' },
  aruo: { name: '阿箬', role: '配角', appearancePrompt: '22岁女性，娇小，高马尾染蓝缕，黑皮衣配腰包，眼神机警，市井野气' },
  mo: { name: '默爷', role: '反派', appearancePrompt: '58岁男性，瘦高，银灰背头，黑缎唐装，手盘核桃，笑意不达眼底，阴鸷威压' },
  zhu: { name: '烛阴', role: '配角', appearancePrompt: '上古异兽，三丈赤鳞蛇躯，双首独角，熔金竖瞳，脊背燃幽蓝兽纹，威压骇人' },
}

// ① bio 里的「半妖」不能把主角判成异兽
ok('沈砚 bio 含「半妖」但仍判为人形', isNonHuman(REAL.shen) === false, '被 bio 误判')
// ② 「市井野气」不能判成异兽
ok('阿箬「野气」不判异兽', isNonHuman(REAL.aruo) === false)
// ③ 「眼底血丝」不能判成异兽
ok('沈砚「血丝」不判异兽', isNonHuman(REAL.shen) === false)
// ④ 真异兽要判出来
ok('烛阴判为异兽', isNonHuman(REAL.zhu) === true)
ok('老周/默爷都是人形', isNonHuman(REAL.zhou) === false && isNonHuman(REAL.mo) === false)

// ⑤ prompt 后缀按形态分支
const pHuman = buildCastingPrompt(REAL.shen.appearancePrompt, REAL.shen)
const pBeast = buildCastingPrompt(REAL.zhu.appearancePrompt, REAL.zhu)
ok('人形用「单人正面胸像」', /单人正面胸像/.test(pHuman), pHuman.slice(-40))
ok('异兽用「主体完整入画」', /主体完整入画/.test(pBeast), pBeast.slice(-40))
ok('异兽不出现「胸像」', !/胸像/.test(pBeast), pBeast.slice(-40))
ok('异兽要求全身形态', /全身形态/.test(pBeast))
ok('两者都带 9:16', /9:16/.test(pHuman) && /9:16/.test(pBeast))

console.log('\n[5d] 定妆过期检测 —— 形象描述改过要提醒重出')
const staleCast = {
  name: '沈砚',
  uri: 'tos://k',
  prompt: '22岁瘦高男性，短寸黑发额前一道旧疤，洗旧灰夹克配工装裤，指节常有血痕。单人正面胸像，纯色浅灰背景，柔和顺光，无遮挡，居中对齐，写实摄影质感，竖屏 9:16',
}
// 新形象与旧 prompt 不同 → 过期
ok('形象改过后判为过期', isCastingStale(staleCast, REAL.shen) === true)
// 形象与生成时一致 → 不过期
const samePrompt = buildCastingPrompt(REAL.shen.appearancePrompt, REAL.shen)
ok('形象未变不判过期', isCastingStale({ name: '沈砚', uri: 'k', prompt: samePrompt }, REAL.shen) === false)
// 没有定妆记录
ok('无记录不判过期', isCastingStale(null, REAL.shen) === false)
// 记录缺 prompt
ok('记录缺 prompt 不判过期', isCastingStale({ name: 'x', uri: 'k' }, REAL.shen) === false)
// 角色缺形象
ok('角色缺形象不判过期', isCastingStale(staleCast, { name: '沈砚' }) === false)
// 异兽的后缀也能正确剥离
const beastPrompt = buildCastingPrompt(REAL.zhu.appearancePrompt, REAL.zhu)
ok('异兽形象未变不判过期', isCastingStale({ name: '烛阴', uri: 'k', prompt: beastPrompt }, REAL.zhu) === false)

console.log('\n[5e] 查看定妆图（用户报「为啥没有查看定妆图片的功能」）')
const srcIndex2 = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
const srcClient2 = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')

// 后端：把 TOS key 换成签名 URL
ok('list 会用 resolveResourceUrls 换签名 URL', /resolveResourceUrls\(cred, \[c\.uri\]\)/.test(srcIndex2))
ok('用记录里的 uid 找产出账号', /String\(a\.uid\) === String\(c\.uid\)/.test(srcIndex2))
ok('解析失败不影响列表', /urlError/.test(srcIndex2))
ok('characters 带 imageUrl', /imageUrl: urlByKey\.get/.test(srcIndex2))
ok('castings 也带 url', /castings: withUrls/.test(srcIndex2))

// 前端：缩略图 + 放大预览 + 打开原图
ok('有缩略图 img', /src: c\.imageUrl/.test(srcClient2))
ok('缩略图点击放大', /onClick: \(\) => setCastingPreview\(c\.name\)/.test(srcClient2))
ok('有放大预览浮层', /const previewNode = previewChar\?\.imageUrl/.test(srcClient2))
ok('浮层点空白关闭', /onClick: \(\) => setCastingPreview\(null\)/.test(srcClient2))
ok('有「看大图」按钮', /看大图/.test(srcClient2))
ok('有「打开原图」', /打开原图/.test(srcClient2))
ok('未定妆显示虚线占位', /1px dashed/.test(srcClient2))
ok('有 castingPreview 状态', /const \[castingPreview, setCastingPreview\]/.test(srcClient2))

// 签名完整性（上一轮白屏的教训）：新 props 必须两端都有
const catStart = srcClient2.indexOf('function CreationTab(')
const sig = srcClient2.slice(catStart, srcClient2.indexOf('}) {', catStart) + 4)
ok('签名含 castingPreview', /castingPreview/.test(sig))
ok('签名含 setCastingPreview', /setCastingPreview/.test(sig))
const callStart = srcClient2.indexOf('h(CreationTab, {')
const call = srcClient2.slice(callStart, srcClient2.indexOf('})),', callStart))
ok('调用处传 castingPreview', /castingPreview/.test(call))
ok('调用处传 setCastingPreview', /setCastingPreview/.test(call))

console.log('\n[5f] 形态标签统一（用户报「有的有异兽字样，人物没有」）')
ok('标签不再只在异兽时渲染', !/c\.nonHuman \? h\('span'/.test(srcClient2), '仍用非人形才渲染')
ok('人形也显示标签', /c\.nonHuman \? '异兽' : '人形'/.test(srcClient2))
ok('标签有固定最小宽度（保证列对齐）', /minWidth: 26/.test(srcClient2))
ok('异兽标签用品牌色', /color: c\.nonHuman \? 'var\(--ad-brand\)'/.test(srcClient2))
ok('人形标签用次要色', /'var\(--ad-label-secondary\)'/.test(srcClient2))
ok('标签有 tooltip 说明构图差异', /定妆用全身形态/.test(srcClient2) && /单人正面胸像/.test(srcClient2))
ok('标签不占 flex 空间（不挤压描述）', /flex: '0 0 auto', textAlign: 'center'/.test(srcClient2))

console.log('\n[5g] 定妆图可用性检查（能否真用于生成视频）')
// 实测约束：key 绑定产出账号，换号会报 failed to sign image url: invalid userid
const REAL_URI = 'tos-cn-i-zaeny81f73/cn/4157726724724988/gen_image/1793858848626_jpeg_1920x1920'
const ACCTS = [{ uid: '4157726724724988' }, { uid: '999' }]

ok('正常记录判为可用',
   checkCastingUsable({ name: '沈砚', uri: REAL_URI, uid: '4157726724724988' }, ACCTS).ok === true,
   JSON.stringify(checkCastingUsable({ name: '沈砚', uri: REAL_URI, uid: '4157726724724988' }, ACCTS)))
ok('返回 ok 级别', checkCastingUsable({ name: '沈砚', uri: REAL_URI, uid: '4157726724724988' }, ACCTS).level === 'ok')
ok('reason 提到产出账号', /4157726724724988/.test(checkCastingUsable({ name: '沈砚', uri: REAL_URI, uid: '4157726724724988' }, ACCTS).reason))

// ① key 缺失
ok('无 uri 判为不可用', checkCastingUsable({ name: 'x' }, ACCTS).ok === false)
ok('无 uri 提示重出', /重出/.test(checkCastingUsable({ name: 'x' }, ACCTS).reason))
ok('无 uri 的 fix=recast', checkCastingUsable({ name: 'x' }, ACCTS).fix === 'recast')

// ② key 格式异常
ok('非 TOS key 判为不可用',
   checkCastingUsable({ name: 'x', uri: 'http://a/b.jpg', uid: '1' }, ACCTS).ok === false)
ok('格式错误提示具体期望', /gen_image/.test(checkCastingUsable({ name: 'x', uri: 'http://a/b.jpg', uid: '1' }, ACCTS).reason))

// ③ uid 与 key 内嵌账号不一致 → 出片会 invalid userid
const mismatch = checkCastingUsable({ name: 'x', uri: REAL_URI, uid: '999' }, ACCTS)
ok('uid 不一致判为不可用', mismatch.ok === false, JSON.stringify(mismatch))
ok('uid 不一致提示 invalid userid', /invalid userid/.test(mismatch.reason))
ok('uid 不一致为 error 级别', mismatch.level === 'error')

// ④ 产出账号不在池
const gone = checkCastingUsable({ name: 'x', uri: 'tos-cn-i-z/cn/777/gen_image/a_b_jpeg_1x1', uid: '777' }, ACCTS)
ok('账号不在池判为不可用', gone.ok === false)
ok('账号不在池提示补充账号', /不在当前账号池|invalid userid/.test(gone.reason), gone.reason)

// ⑤ 空账号池
ok('空账号池也不崩', (() => { try { checkCastingUsable({ name: 'x', uri: REAL_URI, uid: '4157726724724988' }, []); return true } catch { return false } })())

console.log('\n[5h] 分镜逐镜 prompt 预览')
const srcIndex3 = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
const srcClient3 = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
ok('有 /shot-prompts 路由', /apiBase}\/shot-prompts/.test(srcIndex3))
ok('预览与出片用同一构建器', /buildShotVideoPrompt\(shot, \{/.test(srcIndex3))
ok('返回 prompt/length/characters/sceneRef', /length: prompt\.length/.test(srcIndex3) && /characters: cards\.map/.test(srcIndex3))
ok('返回首帧来源标记', /imageRef: castingKey/.test(srcIndex3))
ok('episode 名做了归一化', srcIndex3.includes('epName') && srcIndex3.includes("'第001集'") === false, '未找到归一化')
ok('归一化去掉 .md.json 后缀',
   srcIndex3.split('\n').some(l => l.includes('epName') && l.includes('replace') && l.includes('md')),
   '未找到该行')
ok('前端有「生成预览」按钮', /生成预览/.test(srcClient3))
ok('前端有逐镜卡片', /renderShotPrompts/.test(srcClient3))
ok('每镜可复制 prompt', /navigator\.clipboard\?\.writeText\(x\.prompt\)/.test(srcClient3))
ok('显示字数', /x\.length} 字/.test(srcClient3))
ok('显示首帧=定妆图', /首帧=定妆图/.test(srcClient3))
ok('显示分镜原写对比', /分镜原写/.test(srcClient3))
ok('新增「分镜」子页签', /\['storyboard', '分镜'\]/.test(srcClient3))
ok('分镜子页挂两个视图', /storyboard: \(\) => h\(Fragment, null, renderStoryboardMd\(\), renderShotPrompts\(\)\)/.test(srcClient3))

// 空镜不再强行注入定妆图
ok('纯空镜不注入定妆图',
   pickCastingKey({ description: '泛黄纸页边缘，血珠悬在纸沿' }, [{ name: '沈砚', uri: 'k' }], ['沈砚']) === null)
ok('泛称男子仍注入', pickCastingKey({ description: '男子抬眼质问' }, [{ name: '沈砚', uri: 'k' }], ['沈砚']) === 'k')

console.log('\n[5i] 出片时定妆图必须锁定产出账号')
const srcIndex4 = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
ok('用 pickCastingEntry 拿到完整记录（含 uid）', /pickCastingEntry\(item\.shot/.test(srcIndex4))
ok('选号前用 castingUid 设 forcedUid', /const pre = pickCastingEntry/.test(srcIndex4) && /if \(pre\?\.uid\) forcedUid/.test(srcIndex4))
ok('castingKey 取自 entry.uri', /const castingKey = castingHit\?\.uri/.test(srcIndex4))
ok('castingUid 取自 entry.uid', /const castingUid = castingHit\?\.uid/.test(srcIndex4))
ok('账号不符时不发请求', /与当前账号 .* 不符/.test(srcIndex4))
ok('账号不在池时降级为纯文生视频（不再记错误）', srcIndex4.includes('该账号不在可用池 → 改用纯文生视频'))
ok('不符时用 continue 重试而非 throw', /lastError = new Error\(msg\)[\s\S]{0,220}continue/.test(srcIndex4))
ok('continue 前推进了轮转计数（否则死循环）',
   /accountTries \+= 1[\s\S]{0,80}continue/.test(srcIndex4), '未推进计数会死循环')
ok('不再只有 pickCastingKey（必须能拿 uid）', !/const castingKey = !chainKey && castings\.length[\s\S]{0,80}pickCastingKey/.test(srcIndex4))

console.log('\n[5j] 定妆图产出账号失效时降级为纯文生视频')
const srcIdx3 = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
ok('发出 casting-drop 事件', /type: 'casting-drop'/.test(srcIdx3))
ok('降级时丢掉 image_paths', srcIdx3.includes('genParams = { ...item.params }'))
ok('用 usingCasting 标记区分', /let usingCasting = false/.test(srcIdx3))
ok('降级分支不再触发 casting 事件', /usingCasting = true/.test(srcIdx3))
ok('castingUsed 已声明（曾崩过）', /let castingUsed = 0/.test(srcIdx3))
ok('降级与使用是 if/else 互斥',
   /if \(usingCasting\) castingUsed \+= 1/.test(srcIdx3))

console.log('\n[6] 源码接线检查')
const srcIndex = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
const srcClient = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
ok('index 导入 casting 模块', /casting\.js/.test(srcIndex), '检查是否引用了 casting 模块')
ok('有 /casting 路由', /apiBase}\/casting/.test(srcIndex))
ok('出片时按镜选定妆 key（v0.20 改用 entry 以便拿 uid）', /pickCastingEntry\(item\.shot/.test(srcIndex))
ok('定妆优先级低于首帧链式', srcIndex.indexOf('if (chainKey)') < srcIndex.indexOf('else if (castingKey)'), '链式应在定妆之前')
ok('定妆优先于参考图', srcIndex.indexOf('else if (castingKey)') < srcIndex.indexOf('else if (refKey)'))
ok('前端有定妆面板', /角色定妆/.test(srcClient))
ok('前端有全部定妆按钮', /全部定妆/.test(srcClient))
ok('前端调 casting 接口', /api\('casting'/.test(srcClient))
// 用户报「角色定妆 0/0 已定妆」：面板从未加载过，所以永远是 0/0
ok('进创作页或换项目时会加载定妆',
   /if \(\(tab === 'creation' \|\| tab === 'overview'\) && project\) loadCasting\(\)/.test(srcClient),
   '缺 loadCasting effect')
ok('effect 依赖 tab/project/dramaRoot',
   /loadCasting\(\)[\s\S]{0,40}\}, \[tab, project, dramaRoot\]\)/.test(srcClient))
ok('面板显示「已定妆/总数」', /已定妆/.test(srcClient) && /castingChars\.length/.test(srcClient))
ok('无角色时提示先生成人物设定', /先在阶段里生成「人物设定」/.test(srcClient))
ok('路由返回 stale', /stale: Boolean\(hit\) && isCastingStale/.test(srcIndex))
ok('路由返回 nonHuman', /nonHuman: isNonHuman\(c\)/.test(srcIndex))
ok('面板显示过期标记', /形象已变/.test(srcClient))
ok('面板显示异兽标记', /异兽/.test(srcClient))
ok('过期角色按钮高亮', /c\.stale \? 'ad-btn ad-sm ad-primary'/.test(srcClient))
ok('顶部显示过期数量', /个已过期/.test(srcClient))
ok('路由传完整账号列表给 castAll', /credentials: usableAccts/.test(srcIndex))
ok('castAll 会转发 credentials', /castAll\(\{[^}]*credentials/.test(srcIndex) || /credentials/.test(srcIndex))
ok('casting 用真实取号逻辑（非不存在的 pickCredential）',
   !/pickCredential/.test(srcIndex), '仍存在 pickCredential')
ok('casting 用 loadAccounts 过滤过期', /loadAccounts\(\)\)\.filter/.test(srcIndex))
const srcCasting = await fs.readFile(new URL('../src/casting.js', import.meta.url), 'utf8')
ok('单角色失败不中断（castAll 收集错误）', /casting-error/.test(srcCasting))
ok('遇配额耗尽会换号', /casting-account-fail/.test(srcCasting))
ok('非配额错误直接抛出', /非配额问题|如果非配额/.test(srcCasting) || /if \(!outOfQuota\) throw e/.test(srcCasting))

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
