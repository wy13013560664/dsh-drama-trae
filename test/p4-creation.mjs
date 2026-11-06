/**
 * P4：创作流程集成单测（读取 / 写入 / 备份 / 安全）。
 *   node test/p4-creation.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  loadCreationBundle, saveAsset, saveScript, readScript, readStoryboardMd, ASSET_KINDS,
} from '../src/creation.js'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }

const ROOT = '/tmp/p4-creation'
const PD = path.join(ROOT, 'AI短剧', '测试剧')

async function seed() {
  await fs.rm(ROOT, { recursive: true, force: true })
  const meta = path.join(PD, '.aidrama')
  await fs.mkdir(meta, { recursive: true })
  await fs.mkdir(path.join(PD, '分集剧本'), { recursive: true })
  await fs.mkdir(path.join(PD, '分镜'), { recursive: true })
  await fs.mkdir(path.join(PD, '素材', '生成'), { recursive: true })
  await fs.writeFile(path.join(meta, 'contract.json'), JSON.stringify({ title: '测试剧', platform: '抖音' }))
  await fs.writeFile(path.join(meta, 'outline.json'), JSON.stringify([{ order: 1, title: '开端' }]))
  await fs.writeFile(path.join(meta, 'characters.json'), JSON.stringify([{ id: 'c1', name: '主角', role: '主角' }]))
  await fs.writeFile(path.join(meta, 'world.json'), JSON.stringify([{ id: 'w1', kind: '地点', name: '城' }]))
  await fs.writeFile(path.join(meta, 'memory.json'), JSON.stringify([{ id: 'm1', kind: '伏笔', content: 'x' }]))
  await fs.writeFile(path.join(meta, 'style.json'), JSON.stringify({ schemaVersion: 1, style: { palette: '冷色', lighting: '', texture: '颗粒', composition: '', motion: '' } }))
  await fs.writeFile(path.join(PD, '分集剧本', '第001集.md'), '# 第001集\n正文')
  // 分镜的真实位置是 .aidrama/storyboard/<集>.md.json（出片也读这里）
  await fs.mkdir(path.join(meta, 'storyboard'), { recursive: true })
  await fs.writeFile(path.join(meta, 'storyboard', '第001集.md.json'), JSON.stringify([
    { shotNumber: '1', shotSize: '全景', cameraMove: '固定', description: '城', dialogue: '', sfx: '风声', durationSec: 4 },
  ]))
}

await seed()

console.log('\n[1] loadCreationBundle —— 全资产读取')
const b = await loadCreationBundle(PD)
ok('契约读取', b.contract?.title === '测试剧')
ok('大纲/人物/世界/记忆均为数组', Array.isArray(b.outline) && Array.isArray(b.characters) && Array.isArray(b.world) && Array.isArray(b.memory))
ok('大纲 1 条', b.outline.length === 1)
ok('人物 1 人', b.characters.length === 1)
ok('世界观 1 条', b.world.length === 1)
ok('记忆 1 条', b.memory.length === 1)
ok('风格五维对象', b.style?.style && Object.keys(b.style.style).length === 5)
ok('剧本清单', b.scripts.includes('第001集.md'), b.scripts.join(','))
ok('分镜清单读 .aidrama/storyboard/', b.storyboards.includes('第001集.md.json'), b.storyboards.join(','))
ok('进度 7 步', b.progress.total === 7)
ok('进度步数正确', b.progress.done === 6, `done=${b.progress.done}`)
ok('progress 百分比', b.progress.pct === Math.round(6 / 7 * 100))

console.log('\n[2] 空项目不报错')
const empty = await loadCreationBundle(path.join(ROOT, 'AI短剧', '不存在'))
ok('缺失全部返回空', empty.contract === null && empty.outline.length === 0 && empty.characters.length === 0)
ok('进度为 0', empty.progress.done === 0)

console.log('\n[3] readScript / readStoryboardMd')
ok('读剧本', (await readScript(PD, '第001集.md'))?.includes('正文'))
ok('读不存在的剧本返回 null', (await readScript(PD, '第999集.md')) === null)
ok('读分镜 md', (await readStoryboardMd(PD, '第001集.分镜.md'))?.includes('镜号'))
ok('非法集名拒绝', await readScript(PD, '../x.md').then(() => false).catch(() => true))
ok('非 md 拒绝', await readScript(PD, 'x.txt').then(() => false).catch(() => true))

console.log('\n[4] saveAsset —— 形状校验')
ok('数组资产传对象被拒', await saveAsset(PD, 'characters', {}).then(() => false).catch(() => true))
ok('对象资产传数组被拒', await saveAsset(PD, 'contract', []).then(() => false).catch(() => true))
ok('未知 kind 被拒', await saveAsset(PD, 'nope', {}).then(() => false).catch(() => true))

console.log('\n[5] saveAsset —— 原子写 + 备份')
const r1 = await saveAsset(PD, 'contract', { title: '测试剧', platform: '快手', updated: true })
ok('写入返回字节数', r1.bytes > 0)
ok('首次覆盖产生备份', typeof r1.backup === 'string' && r1.backup.startsWith('.aidrama/history/'), String(r1.backup))
const after = await loadCreationBundle(PD)
ok('内容已更新', after.contract.platform === '快手')
ok('备份文件存在', !!(await fs.stat(path.join(PD, r1.backup)).catch(() => null)))

const r2 = await saveAsset(PD, 'outline', [{ order: 1, title: '新开端' }, { order: 2, title: '第二集' }])
ok('数组资产可写', r2.bytes > 0)
ok('大纲已更新为 2 条', (await loadCreationBundle(PD)).outline.length === 2)

console.log('\n[6] 备份保留上限（10 份）')
for (let i = 0; i < 12; i++) {
  await saveAsset(PD, 'contract', { title: '测试剧', rev: i })
}
const hist = (await fs.readdir(path.join(PD, '.aidrama', 'history')))
  .filter(f => f.startsWith('contract.json.') && f.endsWith('.bak'))
ok('合同备份 ≤10 份', hist.length <= 10, `实际 ${hist.length}`)

console.log('\n[7] saveScript —— 剧本正文')
const s1 = await saveScript(PD, '第001集.md', '# 第001集\n改写后的正文')
ok('剧本写入', s1.bytes > 0)
ok('剧本内容已变', (await readScript(PD, '第001集.md'))?.includes('改写'))
ok('剧本覆盖有备份', typeof s1.backup === 'string')
ok('路径穿越被拒', await saveScript(PD, '../../evil.md', 'x').then(() => false).catch(() => true))

console.log('\n[8] ASSET_KINDS 元数据')
ok('6 类资产', Object.keys(ASSET_KINDS).length === 6)
ok('每类有 label 与 type', Object.values(ASSET_KINDS).every(v => v.label && (v.type === 'object' || v.type === 'array')))

await fs.rm(ROOT, { recursive: true, force: true })
console.log('\n[9] 资产形状兼容（数组为准，对象包装也能读）')
// 官方 dsh-plugin-ai-drama 的 save* 硬校验 Array.isArray，
// 但历史/手写文件可能是 { episodes: [...] } 之类包装，两种都要能读。
const SHAPE_ROOT = '/tmp/p4-shape'
await fs.rm(SHAPE_ROOT, { recursive: true, force: true })

async function seedShape(kind, payload) {
  const meta = path.join(SHAPE_ROOT, 'AI短剧', kind, '.aidrama')
  await fs.mkdir(meta, { recursive: true })
  await fs.writeFile(path.join(meta, 'outline.json'), JSON.stringify(payload))
  await fs.writeFile(path.join(meta, 'characters.json'), JSON.stringify(payload))
  await fs.writeFile(path.join(meta, 'world.json'), JSON.stringify(payload))
  await fs.writeFile(path.join(meta, 'memory.json'), JSON.stringify(payload))
  return path.join(SHAPE_ROOT, 'AI短剧', kind)
}

const rows = [{ order: 1, title: 'A' }, { order: 2, title: 'B' }]

// 数组（官方格式）
const pArr = await seedShape('arr', rows)
const bArr = await loadCreationBundle(pArr)
ok('数组格式 outline 读到 2 条', bArr.outline.length === 2, `实际 ${bArr.outline.length}`)

// 对象包装：episodes
const pObj1 = await seedShape('obj1', { episodes: rows })
const bObj1 = await loadCreationBundle(pObj1)
ok('{episodes:[]} 包装能读', bObj1.outline.length === 2, `实际 ${bObj1.outline.length}`)

// 对象包装：characters / entries / foreshadow
const pObj2 = await seedShape('obj2', { characters: rows, entries: rows, foreshadow: rows, items: rows })
const bObj2 = await loadCreationBundle(pObj2)
ok('{characters:[]} 包装能读', bObj2.characters.length === 2)
ok('{entries:[]} 包装能读', bObj2.world.length === 2)
ok('{foreshadow:[]} 包装能读', bObj2.memory.length === 2)

// 空对象 / null / 字符串 → 空数组不报错
const pBad = await seedShape('bad', {})
const bBad = await loadCreationBundle(pBad)
ok('空对象退化为空数组', bBad.outline.length === 0 && bBad.characters.length === 0)

await fs.rm(SHAPE_ROOT, { recursive: true, force: true })

console.log('\n[10] 新建项目骨架必须是数组（ai-drama 硬校验）')
const { createProject: cp } = await import('../src/project.js')
const PR = '/tmp/p4-skeleton'
await fs.rm(PR, { recursive: true, force: true })
const cr = await cp({ dramaRoot: PR, title: '骨架测试' })
for (const f of ['outline.json', 'characters.json', 'world.json', 'memory.json']) {
  const d = JSON.parse(await fs.readFile(path.join(cr.dir, '.aidrama', f), 'utf8'))
  ok(`${f} 骨架是数组`, Array.isArray(d), `实际 ${Array.isArray(d) ? 'array' : typeof d}`)
}
await fs.rm(PR, { recursive: true, force: true })

console.log('\n[11] mergeAsset —— 修复必须合并而非覆盖（防丢数据）')
const MR = '/tmp/p4-merge'
await fs.rm(MR, { recursive: true, force: true })
const mpd = path.join(MR, 'AI短剧', '测试')
await fs.mkdir(path.join(mpd, '.aidrama'), { recursive: true })

const orig = Array.from({ length: 16 }, (_, i) => ({
  id: `m${i + 1}`, kind: '伏笔', content: `内容${i + 1}`, episode: 1, status: 'open',
}))
await fs.writeFile(path.join(mpd, '.aidrama', 'memory.json'), JSON.stringify(orig, null, 2))

const { mergeAsset } = await import('../src/creation.js')
const incoming = [
  { id: 'm1', kind: '伏笔', content: '内容1', episode: 1, payoffEpisode: 6, status: 'open' },
  { id: 'm3', kind: '伏笔', content: '内容3', episode: 3, payoffEpisode: 8, status: 'open' },
]
const mr = await mergeAsset(mpd, 'memory', incoming)
ok('模式为 merge', mr.mode === 'merge')
ok('更新 2 条', mr.updated === 2, String(mr.updated))
ok('未新增', mr.added === 0, String(mr.added))
ok('总数保持 16', mr.total === 16, String(mr.total))

const mergedMem = JSON.parse(await fs.readFile(path.join(mpd, '.aidrama', 'memory.json'), 'utf8'))
ok('文件仍是 16 条', mergedMem.length === 16, String(mergedMem.length))
ok('m1 补上了 payoffEpisode', mergedMem[0].payoffEpisode === 6)
ok('m3 补上了 payoffEpisode', mergedMem[2].payoffEpisode === 8)
ok('未改动的 m5 仍在', mergedMem[4].id === 'm5')
ok('未改动的 m5 内容未变', mergedMem[4].content === '内容5')
ok('合并时保留未提供字段', mergedMem[2].status === 'open')

// 新 id 应追加
const mr2 = await mergeAsset(mpd, 'memory', [{ id: 'm17', kind: '伏笔', content: '新条目', episode: 5 }])
ok('新 id 追加', mr2.added === 1, String(mr2.added))
ok('追加后 17 条', mr2.total === 17, String(mr2.total))

// 无 id 时用 name 作键（角色场景）
await fs.mkdir(path.join(mpd, '.aidrama'), { recursive: true })
await fs.writeFile(path.join(mpd, '.aidrama', 'characters.json'), JSON.stringify([
  { name: '沈砚', role: '主角', appearancePrompt: '20岁' },
  { name: '默爷', role: '反派', appearancePrompt: '60岁' },
], null, 2))
const mr3 = await mergeAsset(mpd, 'characters', [{ name: '沈砚', arcEpisodes: [1, 12] }])
const chars = JSON.parse(await fs.readFile(path.join(mpd, '.aidrama', 'characters.json'), 'utf8'))
ok('按 name 匹配更新', mr3.updated === 1 && mr3.total === 2, JSON.stringify({ u: mr3.updated, t: mr3.total }))
ok('name 匹配时保留原字段', chars[0].role === '主角' && chars[0].appearancePrompt === '20岁')
ok('新字段已并入', Array.isArray(chars[0].arcEpisodes))

// 对象类资产退化为 replace
const mr4 = await mergeAsset(mpd, 'contract', { title: 'x' })
ok('对象资产退化为 replace', mr4.mode === 'replace-object', mr4.mode)

// 备份仍然生成
ok('合并写入也产生了备份', typeof mr.backup === 'string' && mr.backup.includes('history'), String(mr.backup))

await fs.rm(MR, { recursive: true, force: true })

console.log('\n[12] 修复模式校验放宽（修缺口不该套用全量下限）')
const { validateStage, STAGES } = await import('../src/ai-create.js')
ok('STAGES 带 minRepair', Object.values(STAGES).every(s => typeof s.minRepair === 'number'))
ok('memory minRepair=1', STAGES.memory.minRepair === 1)
const TWO = [{ kind: '伏笔', content: 'a', episode: 1, payoffEpisode: 3 }, { kind: '伏笔', content: 'b', episode: 1, payoffEpisode: 3 }]
ok('全量模式 2 条被拒', await Promise.resolve().then(() => { try { validateStage('memory', TWO); return false } catch { return true } }))
ok('修复模式 2 条通过', await Promise.resolve().then(() => { try { validateStage('memory', TWO, { repair: true }); return true } catch { return false } }))
ok('修复模式仍要求 ≥1 条', await Promise.resolve().then(() => { try { validateStage('memory', [], { repair: true }); return false } catch { return true } }))

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
