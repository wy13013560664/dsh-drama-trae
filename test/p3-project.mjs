/**
 * P3：新建项目能力单测。
 *   node test/p3-project.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { validateProjectTitle, createProject, PROJECT_DIRS } from '../src/project.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}
function t(name, fn) {
  try { fn(); ok(name, true) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`) }
}

console.log('\n[1] validateProjectTitle —— 剧名校验')
t('正常剧名通过', () => {
  assert.equal(validateProjectTitle('白月光替身'), '白月光替身')
  assert.equal(validateProjectTitle('  含空格剧名  '), '含空格剧名')
})
t('空名拒绝', () => assert.throws(() => validateProjectTitle(''), /不能为空/))
t('纯空格拒绝', () => assert.throws(() => validateProjectTitle('   '), /不能为空/))
t('超 40 字拒绝', () => assert.throws(() => validateProjectTitle('剧'.repeat(41)), /过长/))
t('恰好 40 字通过', () => assert.equal(validateProjectTitle('剧'.repeat(40)), '剧'.repeat(40)))
t('路径分隔符拒绝', () => {
  assert.throws(() => validateProjectTitle('a/b'), /不能包含/)
  assert.throws(() => validateProjectTitle('a\\b'), /不能包含/)
})
t('非法字符拒绝', () => {
  for (const ch of ['*', '?', '"', '<', '>', '|', ':']) {
    assert.throws(() => validateProjectTitle(`a${ch}b`), /不能包含/)
  }
})
t('保留名拒绝', () => {
  assert.throws(() => validateProjectTitle('共享资料'), /保留名/)
  assert.throws(() => validateProjectTitle('.aidrama'), /保留名/)
})
t('点开头/结尾拒绝', () => {
  assert.throws(() => validateProjectTitle('.隐藏'), /不能以点开头/)
  assert.throws(() => validateProjectTitle('结尾.'), /不能以点结尾/)
})
t('中文与数字组合通过', () => assert.equal(validateProjectTitle('第2季·夜雨'), '第2季·夜雨'))

console.log('\n[2] PROJECT_DIRS —— 与 ai-drama 对齐')
ok('13 个内容目录', PROJECT_DIRS.length === 13, `实际 ${PROJECT_DIRS.length}`)
ok('包含关键目录', ['构想','总纲','人物','世界观','分集剧本','分镜','素材','本剧记忆'].every(d => PROJECT_DIRS.includes(d)))

console.log('\n[3] createProject —— 实际建目录')
const ROOT = '/tmp/p3-test-root'
await fs.rm(ROOT, { recursive: true, force: true })

const r1 = await createProject({ dramaRoot: ROOT, title: '测试新剧' })
ok('返回 dir 含 AI短剧 层级', r1.dir.includes('/AI短剧/'), r1.dir)

const top = (await fs.readdir(r1.dir, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.'))
ok('13 个内容目录齐全', top.length === 13, `实际 ${top.length}`)
ok('目录名与 PROJECT_DIRS 一致', PROJECT_DIRS.every(d => top.some(x => x.name === d)))
ok('素材/生成 存在', !!(await fs.stat(r1.dir + '/素材/生成').catch(() => null)))
ok('素材/参考图 存在', !!(await fs.stat(r1.dir + '/素材/参考图').catch(() => null)))

const meta = await fs.readdir(r1.dir + '/.aidrama')
ok('.aidrama/storyboard 存在', meta.includes('storyboard'))
ok('写出关键 json', ['contract.json','characters.json','outline.json','style.json','memory.json'].every(f => meta.includes(f)), meta.join(','))

const contract1 = JSON.parse(await fs.readFile(r1.dir + '/.aidrama/contract.json', 'utf8'))
ok('contract 含剧名', contract1.title === '测试新剧')

const chars1 = JSON.parse(await fs.readFile(r1.dir + '/.aidrama/characters.json', 'utf8'))
// 骨架必须是**裸数组**：ai-drama 的 saveCharacters 硬校验 Array.isArray
ok('characters 骨架是裸数组', Array.isArray(chars1) && chars1.length === 0, JSON.stringify(chars1).slice(0,40))

const style1 = JSON.parse(await fs.readFile(r1.dir + '/.aidrama/style.json', 'utf8'))
ok('style 五维骨架', style1.style && Object.keys(style1.style).length === 5)

let threw = false
try { await createProject({ dramaRoot: ROOT, title: '测试新剧' }) } catch (e) { threw = /已存在/.test(e.message) }
ok('同名项目重复创建被拒', threw)

const r2 = await createProject({ dramaRoot: ROOT + '/AI短剧', title: '第二部' })
ok('传 AI短剧 层路径可用', r2.dir === ROOT + '/AI短剧/第二部', r2.dir)

const r3 = await createProject({
  dramaRoot: ROOT, title: '带契约',
  contract: { platform: '抖音', episodeDurationSec: 90, orientation: '9:16' },
})
const c3 = JSON.parse(await fs.readFile(r3.dir + '/.aidrama/contract.json', 'utf8'))
ok('契约字段已透传', c3.platform === '抖音' && c3.episodeDurationSec === 90)

// 新项目能被本插件直接读取（空分镜，应报"未找到分镜"）
const { collectShots } = await import('../index.js')
const shots = await collectShots(r3.dir + '/.aidrama/storyboard', {}).catch(() => [])
ok('新项目分镜为空（可被读取不报错）', Array.isArray(shots) && shots.length === 0)

await fs.rm(ROOT, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
