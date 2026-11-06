/**
 * P0 改造单元测试：角色锚点解析 / 注入 / 时长预检。
 * 纯 Node 运行，不依赖任何外部服务。
 *   node test/p0-changes.mjs
 */

import assert from 'node:assert/strict'
import {
  indexCharacters, resolveShotCharacters, renderAnchor, normalizeName,
} from '../src/characters.js'
import { buildShotVideoPrompt } from '../src/prompt.js'

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`) }
}

console.log('\n[1] normalizeName')
t('去空白与标点、小写', () => {
  assert.equal(normalizeName(' 林 夏· '), '林夏')
  assert.equal(normalizeName('Lin Xia'), 'linxia')
})

console.log('\n[2] indexCharacters')
const doc = {
  characters: [
    { name: '林夏', role: '主角', appearancePrompt: '齐肩黑发，左眉有疤，藏青护士服' },
    { name: '陈默', role: '反派', appearancePrompt: '寸头，金丝眼镜，深灰西装' },
    { name: '路人', role: '龙套' }, // 无 appearancePrompt
  ],
}
const idx = indexCharacters(doc)
t('索引 3 张卡', () => assert.equal(idx.map.size, 3))
t('有锚点的 2 张', () => assert.equal(idx.anchorCount, 2))
t('空输入不炸', () => {
  assert.equal(indexCharacters(null).map.size, 0)
  assert.equal(indexCharacters({}).anchorCount, 0)
})

console.log('\n[3] resolveShotCharacters')
t('显式 characters[] 命中', () => {
  const r = resolveShotCharacters({ characters: ['林夏'] }, idx)
  assert.equal(r.via, 'characters')
  assert.equal(r.cards.length, 1)
  assert.equal(r.cards[0].name, '林夏')
})
t('多角色', () => {
  const r = resolveShotCharacters({ characters: ['林夏', '陈默'] }, idx)
  assert.equal(r.cards.length, 2)
})
t('短语包含角色名', () => {
  const r = resolveShotCharacters({ characters: ['主角林夏'] }, idx)
  assert.equal(r.cards.length, 1)
})
t('subject 兜底', () => {
  const r = resolveShotCharacters({ subject: '林夏站在窗前' }, idx)
  assert.equal(r.via, 'subject')
  assert.equal(r.cards[0].name, '林夏')
})
t('无匹配返回空且不报错', () => {
  const r = resolveShotCharacters({ characters: ['查无此人'] }, idx)
  assert.equal(r.cards.length, 0)
  assert.equal(r.via, null)
})
t('空索引安全降级', () => {
  const r = resolveShotCharacters({ characters: ['林夏'] }, indexCharacters(null))
  assert.equal(r.cards.length, 0)
})

console.log('\n[4] renderAnchor')
t('渲染格式', () => {
  const anchor = renderAnchor([idx.map.get('林夏')])
  assert.match(anchor, /\[角色锚点\]/)
  assert.match(anchor, /林夏：齐肩黑发/)
})
t('多角色用；分隔', () => {
  const anchor = renderAnchor([idx.map.get('林夏'), idx.map.get('陈默')])
  assert.match(anchor, /林夏：.*；陈默：/)
})
t('无锚点卡返回空串', () => {
  assert.equal(renderAnchor([idx.map.get('路人')]), '')
  assert.equal(renderAnchor([]), '')
  assert.equal(renderAnchor(null), '')
})

console.log('\n[5] buildShotVideoPrompt —— 锚点注入不破坏原行为')
const shot = { shotNumber: '1-1', shotSize: '中景', cameraMove: '推', description: '她推门而入' }
t('不传锚点时给出结构化 prompt', () => {
  const p = buildShotVideoPrompt(shot, { ratio: '9:16' })
  assert.match(p, /中景/)
  assert.match(p, /竖屏构图 9:16/)
  assert.doesNotMatch(p, /沈知意|角色锚点/, '不含姓名与锚点标记')
})
t('传锚点时锚点紧跟镜头段且不含姓名', () => {
  // v0.20 起按 Seedance 配方把「镜头动作」放最前，锚点紧随其后为第二段
  const anchor = renderAnchor([idx.map.get('林夏')])
  const cards = [idx.map.get('林夏')]
  const p = buildShotVideoPrompt(shot, { ratio: '9:16', characterAnchor: anchor, characterNames: cards })
  // 第一段是镜头语言，第二段以锚点形象描述开头
  const seg2 = p.split('。')[1] || ''
  assert.match(seg2, /^齐肩黑发/, `第二段应锚点在先，实际: ${seg2.slice(0, 30)}`)
  assert.doesNotMatch(p, /林夏/, '姓名已剔除')
  assert.doesNotMatch(p, /\[角色锚点\]/, '不再有裸标记')
})
t('锚点形象描述在画面描述之前（索引）', () => {
  const anchor = renderAnchor([idx.map.get('林夏')])
  const cards = [idx.map.get('林夏')]
  const p = buildShotVideoPrompt(shot, { characterAnchor: anchor, characterNames: cards })
  assert.ok(p.indexOf('齐肩黑发') < p.indexOf('她推门'), '锚点应排在画面描述前面')
})
t('镜头段排在最前（Seedance 配方）', () => {
  const anchor = renderAnchor([idx.map.get('林夏')])
  const cards = [idx.map.get('林夏')]
  const p = buildShotVideoPrompt(shot, { characterAnchor: anchor, characterNames: cards })
  assert.match(p, /^(大特写|特写|中景|近景|全景|远景)/, `开头应为景别，实际: ${p.slice(0, 20)}`)
})
t('空锚点等同不传', () => {
  const a = buildShotVideoPrompt(shot, { characterAnchor: '' })
  const b = buildShotVideoPrompt(shot, {})
  assert.equal(a, b)
})
t('constraints 转否定句', () => {
  const p = buildShotVideoPrompt({ ...shot, constraints: ['刀', '血'] })
  assert.match(p, /不得出现刀、血/)
})
t('无内容仍抛错', () => {
  assert.throws(() => buildShotVideoPrompt({}), /无法生成/)
})

console.log('\n[6] 时长上限常量')
t('MAX_DURATION = 15', async () => {
  const c = await import('../src/constants.js')
  assert.equal(c.MAX_DURATION, 15)
})

console.log('\n[9] 分镜能否满足出片模型（用户问「能否满足 dsh-trae-video 规范」）')

t('分镜 videoPrompt 被采纳', () => {
  const shot = {
    shotNumber: '1', shotSize: '特写', cameraMove: '推', description: '泛黄纸页血珠渗开',
    dialogue: '', sfx: '雨声', durationSec: 3,
    imagePrompt: '纸页特写', videoPrompt: '镜头缓推向纸面血珠，指尖微颤，压抑不安，大特写',
    sceneRef: '城中村旧货市场',
  }
  const p = buildShotVideoPrompt(shot, {})
  assert.match(p, /指尖微颤|缓推/)
})

t('4 个同名标签不产生 undefined', () => {
  const four = ['甲', '乙', '丙', '丁'].map((n, i) => ({
    name: n, role: '配角', appearancePrompt: `${25 + i * 5}岁男性，西装`,
  }))
  const p = buildShotVideoPrompt(
    { shotNumber: '1', description: '甲对乙说，丙看着丁', durationSec: 3 },
    { allCharCards: four })
  assert.ok(!/undefined/.test(p), p)
  assert.ok((p.match(/年轻男子|年长男子/g) || []).length >= 3, p)
})

t('「壮汉/板寸」判定为男性', () => {
  const man = { name: '老周', role: '龙套',
    appearancePrompt: '38岁黝黑壮汉，板寸油汗，破旧迷彩外套沾油污，右手缠渗血纱布，眼睛通红。' }
  const p = buildShotVideoPrompt(
    { shotNumber: '1', description: '老周守在摊后张望', durationSec: 3 },
    { allCharCards: [man] })
  assert.match(p, /男子|男性/)
  assert.ok(!/女子|女性|贵妇/.test(p), p)
})

t('背头/唐装也判为男性且年长', () => {
  const man = { name: '默爷', role: '反派',
    appearancePrompt: '50岁矮胖男性，油亮背头，暗红唐装盘扣。' }
  const p = buildShotVideoPrompt(
    { shotNumber: '1', description: '默爷袖口滑出妖瞳', durationSec: 3 },
    { allCharCards: [man] })
  assert.match(p, /男子|男性/)
  assert.match(p, /年长男子/)
})

t('完整分镜 + 锚点：长度/画幅/景别/清名都正确', () => {
  const shot = {
    shotNumber: '1', shotSize: '中景', cameraMove: '固定',
    description: '黄灯旧货摊，沈砚蹲着攥纸', dialogue: '沈砚：我爹留下的东西',
    sfx: '雨棚滴水', durationSec: 4,
    imagePrompt: '22岁瘦高男性，旧夹克，潮湿摊位，中景',
    videoPrompt: '固定中景，两人对峙，气氛紧绷', sceneRef: '城中村旧货市场',
  }
  const anchor = '22岁瘦高男性，短寸黑发额前一道旧疤，洗旧灰夹克配工装裤，指节常有血痕，眼神倔强带倦。'
  const p = buildShotVideoPrompt(shot, {
    characterAnchor: anchor,
    allCharCards: [{ name: '沈砚', appearancePrompt: anchor }],
  })
  assert.ok(p.length <= 200, `${p.length} 字`)
  assert.match(p, /9:16/)
  assert.match(p, /中景/)
  assert.match(p, /机位不动|固定/)
  assert.ok(!p.includes('沈砚'), p)
  assert.ok(p.includes('旧疤'))
})

t('最小必需字段齐备即可出片', () => {
  const minimal = { shotNumber: '1', shotSize: '中景', cameraMove: '固定', description: 'x', durationSec: 4 }
  for (const f of ['shotNumber', 'shotSize', 'cameraMove', 'description', 'durationSec']) {
    assert.ok(minimal[f] !== undefined, f)
  }
  assert.equal(typeof buildShotVideoPrompt(minimal, {}), 'string')
})

console.log('\n[10] Seedance 2.0 prompt 配方（技能规范对齐）')
// 规范：「一句镜头动作 + 画面要素 + 统一风格后缀」
const SDNA = { palette: '主色墨青黑 #0E1116 占画面 55%', texture: '数码高动态拍摄，后期叠 35mm 胶片颗粒', composition: '竖屏9:16，留白，仰拍' }
const SD_SHOT = {
  shotNumber: '1', shotSize: '大特写', cameraMove: '推',
  description: '泛黄纸页边缘，血珠悬在纸沿，大特写固定，血珠缓缓坠向纸面',
  videoPrompt: '镜头缓推向纸面血珠，指尖微颤', durationSec: 3,
}

const sdp = buildShotVideoPrompt(SD_SHOT, { styleDna: SDNA })

t('镜头动作排在最前', () => {
  assert.match(sdp, /^大特写/)
})
t('无十六进制色值', () => {
  assert.ok(!/#[0-9A-Fa-f]{3,}/.test(sdp), sdp)
})
t('无百分比量化', () => {
  assert.ok(!/\d+%/.test(sdp), sdp)
})
t('繁体字已正字化', () => {
  assert.ok(!/極|檔|體|現/.test(sdp), sdp)
})
t('分镜原写的 videoPrompt 被采纳', () => {
  assert.match(sdp, /指尖微颤/)
})
t('景别不重复出现', () => {
  const n = (sdp.match(/大特写/g) || []).length
  assert.equal(n, 1, `出现 ${n} 次`)
})
t('景别+运镜粘连被清理', () => {
  assert.ok(!/大特写固定/.test(sdp), sdp)
})
t('长度收敛到 150 字内', () => {
  assert.ok(sdp.length <= 150, `${sdp.length} 字`)
})
t('保留画幅声明', () => {
  assert.match(sdp, /9:16/)
})
t('段落数不超过 6', () => {
  assert.ok(sdp.split('。').filter(Boolean).length <= 6)
})

// 无风格 DNA 时也不能崩
t('无 styleDna 仍可用', () => {
  assert.equal(typeof buildShotVideoPrompt(SD_SHOT, {}), 'string')
})

console.log('\n[11] 色板长描述只留主色（避免半截残渣）')
t('只取主色，丢弃辅色/色温等细节', () => {
  const dna = { palette: '主色墨青黑 #0E1116 占画面 55%，辅色锈红 #8C2E24 与旧铜金 #B08A4F 合计 30%，点缀光妖瞳青绿 #6FE3C0 与封印幽蓝 #3A6FF0 占 15%，仅用于兽瞳。整体冷调偏青；城中村色温 3200K 并加土黄灰' }
  const p = buildShotVideoPrompt({ shotNumber: '1', description: '纸页特写', durationSec: 3 }, { styleDna: dna })
  assert.ok(!/合计/.test(p), `不应残留合计: ${p}`)
  assert.ok(!/点缀光妖瞳/.test(p), `不应残留点缀色: ${p}`)
  assert.ok(!/3200K/.test(p), `不应残留色温: ${p}`)
  assert.ok(!/占$/.test(p), `不应以「占」结尾: ${p}`)
  assert.ok(p.includes('墨青黑'), `应保留主色: ${p}`)
})
t('色板只剩「主色」二字时不产生空段', () => {
  const p = buildShotVideoPrompt({ shotNumber: '1', description: 'x', durationSec: 3 }, { styleDna: { palette: '主色 #000000 占画面 100%' } })
  assert.ok(!/色调偏\s*(，|。)/.test(p), p)
})
t('色板为空不崩', () => {
  assert.equal(typeof buildShotVideoPrompt({ shotNumber: '1', description: 'x', durationSec: 3 }, { styleDna: { palette: '' } }), 'string')
})

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
