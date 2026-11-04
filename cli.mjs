#!/usr/bin/env node
/**
 * dsh-drama-trae CLI —— AI 短剧一键出片。
 *
 * 用法：
 *   node cli.mjs --list                     列出 ai-drama 项目与分镜
 *   node cli.mjs --project <剧名> [--episode <集>] [--shots 1,2,3] [--dry-run]
 *          [--ratio 9:16] [--resolution 720p] [--duration 5]
 *          [--drama-root <AI短剧目录>]
 *
 * 数据源：dsh-plugin-ai-drama 写盘的分镜 JSON
 *   <drama-root>/<project>/.aidrama/storyboard/<集>.json
 * 产物：  <drama-root>/<project>/素材/生成/<集>-<镜号>.mp4
 *
 * @module cli.mjs
 */

import { runOneShotDrama, locateProjectDir, collectShots } from './index.js'
import { buildShotVideoPrompt } from './src/prompt.js'
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
    if (!dramaRoot) {
      for (const c of [path.join(process.env.HOME, 'Documents', 'ShiPin', 'AI短剧'), path.join(process.env.HOME, 'Documents', 'AI短剧')]) {
        if (await exists(c)) { await listProjects(c); return }
      }
      console.log('未找到 ai-drama 目录，用 --drama-root 指定')
      return
    }
    await listProjects(dramaRoot)
    return
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
    dryRun: Boolean(args.flags['dry-run']),
    onProgress: (evt) => {
      const { type, label, shot, episode, prompt, stage, file, error } = evt
      switch (type) {
        case 'start': console.log(`${label} 🎬 镜${shot} (${episode}): ${prompt?.slice(0, 70)}...`); break
        case 'skip': console.log(`${label} ⏭️ 镜${shot} 跳过（${evt.reason}）`); break
        case 'retry': console.log(`${label} 🔁 镜${shot} 换账号重试（${evt.error?.slice(0, 40)}）`); break
        case 'video': if (stage === 'result') console.log(`${label}   ✅ 出片 镜${shot}`); break
        case 'done': console.log(`${label}   ✅ 完成 ${file}`); break
        case 'error': console.log(`${label}   ❌ 镜${shot}: ${error}`); break
        case 'summary': console.log(`\n=== 完成: ${evt.generated}/${evt.total} 生成, ${evt.skipped} 跳过, ${evt.errors} 失败, 并发 ${evt.concurrency} ===`); console.log(`产物目录: ${evt.outDir}`); break
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