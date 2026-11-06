#!/usr/bin/env node
/**
 * dsh-drama-trae CLI —— AI 短剧一键出片。
 *
 * 用法：
 *   node cli.mjs --list                     列出 ai-drama 项目与分镜
 *   node cli.mjs --project <剧名> [--episode <集>] [--shots 1,2,3] [--dry-run]
 *          [--ratio 9:16] [--resolution 720p] [--duration 5]
 *          [--drama-root <AI短剧目录>]
 *          [--no-gate]            关闭一致性门禁（默认开启但只报告）
 *          [--gate-block]         门禁命中 FAIL 时阻断出片
 *          [--gate-strict CHK-06,CHK-05]  只阻断指定检查项
 *          [--style-draft]        草稿态风格 DNA 也注入
 *          [--chain]              首帧链式传导（同场景连续镜承接上一镜末帧，强制串行）
 *          [--platform 抖音]      按平台检查节奏（抖音/快手/视频号/B站/小红书）
 *          [--compliance-block]   合规命中阻断词时阻断
 *   node cli.mjs --create <剧名>          新建项目骨架（13 内容目录 + .aidrama）
 *   node cli.mjs --brief-init             打印简报模板
 *   node cli.mjs --brief-check <path>     校验简报文件
 *
 * 数据源：dsh-plugin-ai-drama 写盘的分镜 JSON
 *   <drama-root>/<project>/.aidrama/storyboard/<集>.json
 * 产物：  <drama-root>/<project>/素材/生成/<集>-<镜号>.mp4
 *
 * @module cli.mjs
 */

import { runOneShotDrama, locateProjectDir, collectShots, discoverDramaRoots, defaultDramaRoot } from './index.js'
import { buildShotVideoPrompt } from './src/prompt.js'
import { validateBrief, renderBriefPrompt, emptyBrief } from './src/brief.js'
import { createProject, validateProjectTitle } from './src/project.js'
import { runGate } from './src/gate.js'
import fs from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++ }
      else out.flags[key] = true
    } else out._.push(a)
  }
  return out
}

async function listProjects(dramaRoot) {
  const base = path.resolve(dramaRoot)
  // dramaRoot 就是「AI短剧」根目录（含各项目子目录）。
  // 若传入的是 <workspace>/AI短剧 的父目录，自动补上「AI短剧」。
  let aiRoot = base
  if (path.basename(aiRoot) !== 'AI短剧') {
    const maybe = path.join(aiRoot, 'AI短剧')
    if (await exists(maybe)) aiRoot = maybe
  }
  let dirs = []
  try { dirs = await fs.readdir(aiRoot) } catch { /* 空 */ }
  console.log(`drama-root: ${aiRoot}`)
  console.log('--- ai-drama 项目 ---')
  let found = false
  for (const d of dirs) {
    if (d === '.aidrama' || d === '共享资料' || d.startsWith('.')) continue
    const p = path.join(aiRoot, d)
    if (!(await isDir(p))) continue
    const storyboardDir = path.join(p, '.aidrama', 'storyboard')
    const files = await fs.readdir(storyboardDir).catch(() => [])
    const eps = files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    const shots = await collectShots(storyboardDir, {}).catch(() => [])
    found = true
    console.log(`\n《${d}》: ${eps.length} 集, ${shots.length} 镜`)
    for (const ep of eps) {
      const epShots = await collectShots(storyboardDir, { episode: ep }).catch(() => [])
      console.log(`  - ${ep}: ${epShots.length} 镜`)
    }
  }
  if (!found) console.log('（无项目。先用 dsh-plugin-ai-drama 建项目并写分镜）')
}

async function exists(p) { try { await fs.access(p); return true } catch { return false } }
async function isDir(p) { try { return (await fs.stat(p)).isDirectory() } catch { return false } }

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.flags.list) {
    const dramaRoot = args.flags['drama-root'] || null
    if (dramaRoot) { await listProjects(dramaRoot); return }
    const roots = await discoverDramaRoots()
    if (!roots.length) {
      console.log('未发现含项目的 ai-drama 目录。')
      console.log('可用 --drama-root <路径> 指定，或用环境变量 DSH_DRAMA_ROOT。')
      return
    }
    for (const r of roots) await listProjects(r)
    return
  }

  // ---- --create <剧名>：新建项目骨架 ----
  if (args.flags.create) {
    const title = String(args.flags.create)
    try {
      const root = args.flags['drama-root'] || (await discoverDramaRoots())[0] || await defaultDramaRoot()
      const r = await createProject({ dramaRoot: root, title })
      console.log(`✅ 已创建《${r.title}》`)
      console.log(`   目录: ${r.dir}`)
      console.log(`   子目录: ${r.dirs.join(' / ')}`)
      console.log(`\n下一步: 在 AI 短剧工作区写大纲/人物/剧本/分镜，或用 CLI 出片。`)
    } catch (e) {
      console.error('❌', e.message)
      process.exit(1)
    }
    return
  }

  // ---- --brief-init：打印空模板（供用户填） ----
  if (args.flags['brief-init']) {
    console.log(JSON.stringify(emptyBrief(), null, 2))
    return
  }

  // ---- --brief-check <path>：校验 brief 文件 ----
  if (args.flags['brief-check']) {
    const p0 = String(args.flags['brief-check'])
    try {
      const txt = await fs.readFile(p0, 'utf8')
      const { errors, warnings, normalized } = validateBrief(JSON.parse(txt))
      if (errors.length) { console.error('❌ 校验失败：'); for (const e of errors) console.error('  - ' + e) }
      if (warnings.length) { console.warn('⚠️  提示：'); for (const w of warnings) console.warn('  - ' + w) }
      if (!errors.length) {
        console.log('✅ brief 校验通过\n')
        console.log('--- 立项输入预览 ---')
        console.log(renderBriefPrompt(normalized))
      }
      if (errors.length) process.exit(1)
    } catch (e) {
      console.error('读取/解析失败：', e.message)
      process.exit(1)
    }
    return
  }

  // ---- --gate-only：只跑门禁，不出片 ----
  if (args.flags['gate-only']) {
    const dr = args.flags['drama-root']
    const pj = args.flags.project || args._[0]
    // 复用 runOneShotDrama 的 dryRun + gate，但提前返回摘要
    args.flags['dry-run'] = true
  }

  const project = args.flags.project || args._[0]
  if (!project) {
    console.error('用法: node cli.mjs --project <剧名> [--episode <集>] [--shots 1,2] [--dry-run]')
    console.error('      node cli.mjs --list  列出项目与分镜')
    process.exit(1)
  }

  const opts = {
    project,
    ...(args.flags.episode ? { episode: args.flags.episode } : {}),
    ...(args.flags.ratio ? { ratio: args.flags.ratio } : {}),
    ...(args.flags.resolution ? { resolution: args.flags.resolution } : {}),
    ...(args.flags.duration !== undefined ? { duration: Number(args.flags.duration) } : {}),
    ...(args.flags.shots ? { shots: String(args.flags.shots).split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(args.flags['drama-root'] ? { dramaRoot: args.flags['drama-root'] } : {}),
    ...(args.flags.concurrency !== undefined ? { concurrency: Number(args.flags.concurrency) } : {}),
    // 一致性门禁：默认启用但只报告；--gate-block 阻断，--no-gate 关闭
    ...(args.flags['no-gate'] ? { gate: false } : {}),
    ...(args.flags['gate-block'] ? { gateBlockOnFail: true } : {}),
    ...(args.flags['gate-strict'] ? { gateStrict: String(args.flags['gate-strict']).split(',').map((x) => x.trim()).filter(Boolean) } : {}),
    ...(args.flags['style-draft'] ? { styleIncludeDraft: true } : {}),
    ...(args.flags['no-recast'] ? { recastCastings: false } : {}),
    // P2：首帧链式传导 / 平台分档 / 合规阻断
    ...(args.flags['chain'] ? { chainFrames: true } : {}),
    ...(args.flags.platform ? { platform: String(args.flags.platform) } : {}),
    ...(args.flags['compliance-block'] ? { complianceBlock: true } : {}),
    dryRun: Boolean(args.flags['dry-run']),
    onProgress: (evt) => {
      const { type, label, shot, episode, prompt, stage, file, error } = evt
      switch (type) {
        case 'start': console.log(`${label} 🎬 镜${shot} (${episode}): ${prompt?.slice(0, 70)}...`); break
        case 'skip': console.log(`${label} ⏭️ 镜${shot} 跳过（${evt.reason}）`); break
        case 'retry': console.log(evt.waitMs
          ? `${label} ⏸️ 镜${shot} ${evt.kind || '限流'}，退避 ${Math.round(evt.waitMs / 1000)}s 后重试（${evt.error?.slice(0, 40)}）`
          : `${label} 🔁 镜${shot} 换账号重试（${evt.kind || ''} ${evt.error?.slice(0, 40)}）`); break
        case 'quota-dead': console.log(`${label} 🔒 镜${shot} 账号 ${evt.uid} 不可用（${evt.kind}），剩余 ${evt.remaining} 个`); break
        case 'throttle': console.log(`🐢 并发自动降到 ${evt.limit}（${evt.kind}）`); break
        case 'quota-prune': console.log(`🧾 ${evt.note}`); break
        case 'account-rank': console.log(`🏅 ${evt.note}`); break
        case 'circuit-open': console.log(`⛔ ${evt.reason}`); break
        case 'recast-plan': console.log(`🧑‍🎤 ${evt.note}`); for (const r of evt.reasons || []) console.log(`   · ${r}`); break
        case 'recast-item': if (evt.stage === 'casting-done') console.log(`🧑‍🎤 重出定妆：${evt.name}`); break
        case 'recast-fail': console.log(`🧑‍🎤 定妆重出失败 ${evt.name}：${evt.error}`); break
        case 'recast-done': console.log(`🧑‍🎤 定妆重出完成：成功 ${evt.rebuilt} / 失败 ${evt.failed}，可用定妆 ${evt.usable} 张`); break
        case 'quota-revive': console.log(`🧾 ${evt.note}`); break
        case 'casting': console.log(`${label} 🧑‍🎤 镜${shot} 用角色定妆图作首帧`); break
        case 'casting-drop': console.log(`${label} 🧑‍🎤 镜${shot} 定妆图不可用，降级纯文生视频（${evt.reason}）`); break
        case 'upload': console.log(`${label} ⬆️ 镜${shot} 上传参考图`); break
        case 'video': if (stage === 'result') console.log(`${label}   ✅ 出片 镜${shot}`); break
        case 'done': console.log(`${label}   ✅ 完成 ${file}`); break
        case 'error': console.log(`${label}   ❌ 镜${shot}: ${error}`); break
        case 'characters': console.log(`👥 人物卡 ${evt.count} 张（${evt.anchors} 张有形象锚点），将注入角色锚点`); break
        case 'style': console.log(`🎨 视觉风格已注入（状态 ${evt.state}）：${evt.dimensions?.join('/')}`); break
        case 'gate': console.log(`🚦 一致性门禁：检查 ${evt.checked} 镜 → FAIL ${evt.fails} / WARN ${evt.warns}`); break
        case 'gate-fail': console.log(`🚦   ❌ [${evt.code}] ${evt.message}`); break
        case 'gate-warn': console.log(`🚦   ⚠️ [${evt.code}] ${evt.message}`); break
        case 'warn': if (evt.code === 'duration-clamped') console.log(`${evt.label} ⚠️ 镜${evt.shot}: ${evt.message}`); break
        case 'platform': console.log(`📱 平台节奏（${evt.platform}）：${evt.stats.shots} 镜 / 共 ${evt.stats.totalSec}s / 均 ${evt.stats.avgSec}s`); break
        case 'platform-issue': console.log(`📱   ℹ️ [${evt.code}] ${evt.message}`); break
        case 'compliance': console.log(`🛡️ 合规检查：block ${evt.blocks} / warn ${evt.warns}（${evt.platform}）`); break
        case 'compliance-block': console.log(`🛡️   ⛔ [${evt.term}] 镜${evt.shot} ${evt.field}: 命中阻断词`); break
        case 'compliance-warn': console.log(`🛡️   ⚠️ [${evt.term}] 镜${evt.shot} ${evt.field}`); break
        case 'chain': console.log(`${label} 🔗 镜${shot} 首帧承接自镜${evt.fromShot}`); break
        case 'summary': console.log(`\n=== 完成: ${evt.generated}/${evt.total} 生成, ${evt.skipped} 跳过, ${evt.errors} 失败, 并发 ${evt.concurrency}${evt.limiter ? `（自适应当前 ${evt.limiter.limit}）` : ''} ===`); console.log(`产物目录: ${evt.outDir}`); break
      }
    },
  }

  try {
    await runOneShotDrama(opts)
  } catch (e) {
    console.error('[drama-trae] 错误:', e.message)
    process.exit(1)
  }
}

main().catch((e) => { console.error('[drama-trae] 错误:', e.message); process.exit(1) })