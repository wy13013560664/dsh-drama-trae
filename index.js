/**
 * dsh-drama-trae —— AI 短剧一键出片桥接插件。
 *
 * 定位：连接 dsh-plugin-ai-drama（剧本/分镜/编排，无内建出片能力）
 * 与 dsh-trae-video（免费 Trae 账号出视频），把短剧分镜表批量变成视频。
 *
 * 数据契约（对齐 dsh-plugin-ai-drama v0.16.x 的 store.js）：
 *   - 项目根：<workspace>/AI短剧/<剧名>/
 *   - 分镜 JSON：<项目>/.aidrama/storyboard/<集文件>.json（镜头数组）
 *   - 镜头字段：shotNumber/shotSize/cameraMove/description/dialogue/sfx/
 *       durationSec/imagePrompt/videoPrompt + 可选扩展（emotion/light/lens/...）
 *   - 产物目录：<项目>/素材/生成/
 *
 * @module index.js
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'

import { loadAccounts, createAccountPool } from './src/accounts.js'
import { generateVideo } from './src/video.js'
import { normalizeParams } from './src/validate.js'
import { buildShotVideoPrompt } from './src/prompt.js'
import { createJobStore } from './src/jobs.js'

/** 短剧默认竖屏画幅（独立于 trae 的 adaptive，短剧行业惯例即竖屏）。 */
export const DRAMA_DEFAULT_RATIO = '9:16'

export const name = 'drama-trae'

/** 零硬依赖：凭据走文件读取，commands/webServer 软访问。 */
export const inject = []

/**
 * 一键把 ai-drama 短剧项目的某集分镜批量生成视频（顶层导出，CLI 可直接调用）。
 *
 * @param {object} opts
 * @param {string} opts.dramaRoot   ai-drama 根目录（含「AI短剧」父目录或「AI短剧」本身）
 * @param {string} opts.project     短剧项目名（目录下子目录名）
 * @param {string} [opts.episode]   集文件名（无 .json 后缀）；省略则生成所有集
 * @param {string} [opts.ratio]     画幅，默认 9:16
 * @param {string} [opts.resolution] 分辨率，默认 720p
 * @param {number} [opts.duration]   单镜时长秒，默认取分镜 durationSec（缺省 5）
 * @param {string[]} [opts.shots]    只生成指定镜号（如 ['1','2','3'])
 * @param {boolean} [opts.dryRun]    只计划不生成
 * @param {Function} [opts.onProgress] (evt) => void
 * @returns {Promise<object>} { total, generated, skipped, errors, outDir, results }
 */
export async function runOneShotDrama(opts = {}) {
  const {
    dramaRoot = await defaultDramaRoot(),
    project,
    episode,
    ratio = DRAMA_DEFAULT_RATIO,
    resolution = '720p',
    duration: forceDuration,
    shots: onlyShots,
    dryRun = false,
    concurrency = 0, // 0 = 自动（min(账号数, 镜头数)）
    onProgress = () => {},
    onCancel = null,
  } = opts

  if (!project) throw new Error('drama-trae: 缺少 project（短剧项目名）')
  const projectDir = await locateProjectDir(dramaRoot, project)
  const storyboardDir = path.join(projectDir, '.aidrama', 'storyboard')
  const outDir = path.join(projectDir, '素材', '生成')
  await fs.mkdir(outDir, { recursive: true })

  // 收集要生成的分镜
  const shots = await collectShots(storyboardDir, { episode, onlyShots })
  if (shots.length === 0) {
    throw new Error(`drama-trae: 未找到分镜（${storyboardDir}）`)
  }
  const total = shots.length

  // 账号池（dry-run 时也要验证可用）
  const accounts = await loadAccounts()
  if (accounts.length === 0) throw new Error('drama-trae: 未找到 TRAE_ACCOUNT_* 凭据，请先登录')
  const pool = createAccountPool(accounts)
  const usable = accounts.filter((a) => !isTraeExpired(a))
  if (usable.length === 0) throw new Error('drama-trae: 所有 Trae 账号均已过期')

  const results = { generated: [], skipped: [], errors: [] }
  let cancelled = false
  const cancel = () => { cancelled = true }
  if (typeof onCancel === 'function') onCancel(cancel)

  // 预构建每镜的计划（确定性），并幂等跳过已存在
  const planned = []
  for (let i = 0; i < total; i++) {
    const { shot, episodeName, sourceFile } = shots[i]
    const label = `[${i + 1}/${total}]`
    try {
      const prompt = buildShotVideoPrompt(shot, { ratio })
      const durSec = Number(shot.durationSec)
      const duration = forceDuration ?? (Number.isFinite(durSec) && durSec > 0 ? durSec : 5)
      const safeShot = String(shot.shotNumber || shot.shot || i + 1).replace(/[^0-9A-Za-z_-]/g, '_')
      const outName = `${episodeName}-${safeShot}.mp4`
      const outPath = path.join(outDir, outName)

      const exists = await fileExists(outPath)
      if (exists) {
        results.skipped.push({ shot: shot.shotNumber, reason: 'already-exists', file: outPath })
        onProgress({ type: 'skip', label, shot: shot.shotNumber, file: outName })
        continue
      }

      const params = normalizeParams({ prompt, ratio, resolution, duration })
      onProgress({ type: 'plan', label, shot: shot.shotNumber, episode: episodeName, prompt })

      if (dryRun) {
        results.skipped.push({ shot: shot.shotNumber, reason: 'dry-run', planned: outPath, prompt })
        continue
      }

      planned.push({ i, shot, episodeName, sourceFile, params, outPath, label })
    } catch (e) {
      results.errors.push({ shot: shot.shotNumber, error: e.message })
      onProgress({ type: 'error', label, shot: shot.shotNumber, error: e.message })
    }
  }

  // 并发 worker 池：每镜从账号池轮转取独立账号，真正并行出片
  const workerCount = concurrency > 0 ? Math.min(concurrency, planned.length) : Math.min(usable.length, planned.length)
  const n = Math.max(1, workerCount)
  let accountIndex = 0
  let nextIndex = 0

  async function runPlannedItem(item) {
    if (cancelled) { results.errors.push({ shot: item.shot.shotNumber, error: '已取消' }); return }
    const maxTries = Math.max(1, usable.length) // 每个镜头最多试遍所有账号
    let lastError = null
    for (let attempt = 0; attempt < maxTries; attempt++) {
      if (cancelled) { results.errors.push({ shot: item.shot.shotNumber, error: '已取消' }); return }
      // 轮转取账号：失败自动换下一个（每账号独立配额）
      const credential = usable[(accountIndex + attempt) % usable.length]
      try {
        onProgress({ type: 'start', label: item.label, shot: item.shot.shotNumber, episode: item.episodeName, prompt: item.params.prompt, attempt })
        const video = await generateVideo({
          credential,
          params: item.params,
          localPath: item.outPath,
          onProgress: (stage, payload) => {
            if (stage === 'result' || stage === 'done' || stage === 'failed') {
              onProgress({ type: 'video', label: item.label, shot: item.shot.shotNumber, stage, payload })
            }
          },
        })
        accountIndex += 1
        results.generated.push({
          shot: item.shot.shotNumber,
          episode: item.episodeName,
          source: item.sourceFile,
          file: video.path,
          video_duration: video.video_duration,
          attempts: attempt + 1,
        })
        onProgress({ type: 'done', label: item.label, shot: item.shot.shotNumber, file: video.path, attempt: attempt + 1 })
        return
      } catch (e) {
        lastError = e
        // 配额/限流类错误换账号重试；其余（如提示词错误）直接记失败
        const msg = String(e.message || '')
        const retriable = /quota|exceeded|4008|4040|rate.?limit|429|insufficient/i.test(msg)
        if (!retriable) break
        onProgress({ type: 'retry', label: item.label, shot: item.shot.shotNumber, attempt: attempt + 1, error: msg.slice(0, 120) })
      }
    }
    results.errors.push({ shot: item.shot.shotNumber, error: lastError?.message || '生成失败' })
    onProgress({ type: 'error', label: item.label, shot: item.shot.shotNumber, error: lastError?.message || '生成失败' })
  }

  // worker pool：n 个 worker 从队列取任务，直到全部取完
  async function worker() {
    while (true) {
      const idx = nextIndex
      nextIndex += 1
      if (idx >= planned.length) return
      if (cancelled) return
      await runPlannedItem(planned[idx])
    }
  }
  const workers = []
  for (let w = 0; w < n; w++) workers.push(worker())
  await Promise.all(workers)

  const summary = {
    project,
    total,
    generated: results.generated.length,
    skipped: results.skipped.length,
    errors: results.errors.length,
    outDir,
    concurrency: n,
  }
  onProgress({ type: 'summary', ...summary })
  return { ...summary, results }
}

/* ---------------------------------------------------------------- 定位与读取 */

/** 默认 ai-drama 根目录。 */
export async function defaultDramaRoot() {
  for (const cand of [
    path.join(process.env.HOME, 'Documents', 'ShiPin'),
    path.join(process.env.HOME, 'Documents'),
  ]) {
    const isDir = await fileExists(path.join(cand, 'AI短剧'))
    if (isDir) return path.join(cand, 'AI短剧')
  }
  return path.join(process.env.HOME, 'Documents', 'ShiPin', 'AI短剧')
}

/** 定位短剧项目目录（接受指向 AI短剧 根或具体项目的路径）。 */
export async function locateProjectDir(dramaRoot, project) {
  const abs = path.resolve(dramaRoot)
  // 直接拼接项目名
  const candidate = path.join(abs, project)
  if (await fileExists(path.join(candidate, '.aidrama'))) return candidate
  // ai-drama 根目录实际是 <workspace>/AI短剧，dramaRoot 可能是 <workspace>
  const viaAiDir = path.join(abs, 'AI短剧', project)
  if (await fileExists(path.join(viaAiDir, '.aidrama'))) return viaAiDir
  throw new Error(`drama-trae: 找不到短剧项目「${project}」（检查 ${candidate} 或 ${viaAiDir}）`)
}

/** 收集分镜数组：来自 .aidrama/storyboard/<集>.json。 */
export async function collectShots(storyboardDir, { episode, onlyShots } = {}) {
  const files = await fs.readdir(storyboardDir).catch(() => [])
  const jsonFiles = files.filter((f) => f.endsWith('.json'))
  const wanted = episode ? jsonFiles.filter((f) => f.replace(/\.json$/, '') === episode) : jsonFiles
  if (wanted.length === 0 && episode) {
    throw new Error(`drama-trae: 找不到集「${episode}」的分镜（${storyboardDir}）`)
  }
  const allowed = onlyShots ? new Set(onlyShots.map(String)) : null
  const out = []
  for (const file of wanted) {
    const episodeName = file.replace(/\.json$/, '')
    const raw = await fs.readFile(path.join(storyboardDir, file), 'utf8')
    let shots
    try { shots = JSON.parse(raw) } catch { throw new Error(`drama-trae: 分镜 JSON 解析失败（${file}）`) }
    if (!Array.isArray(shots)) throw new Error(`drama-trae: 分镜必须是数组（${file}）`)
    for (const shot of shots) {
      const n = String(shot.shotNumber ?? shot.shot ?? '')
      if (allowed && n && !allowed.has(n)) continue
      out.push({ shot, episodeName, sourceFile: file })
    }
  }
  return out
}

export async function fileExists(p) {
  try { await fs.access(p); return true } catch { return false }
}

/** cordis 应用入口：commands 软注册 + connection 路由（前端界面数据源）。 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const jobs = createJobStore()

  ctx.inject(['commands'], (scoped) => {
    scoped.commands?.register?.({
      id: 'drama-trae.generate',
      name: 'drama-trae-generate',
      description: 'AI 短剧一键出片：把 ai-drama 分镜批量生成为视频',
      run: (args = {}) => runOneShotDrama(args),
    })
    logger.info?.('drama-trae: command "drama-trae.generate" registered')
  })

  // 前端界面数据源：通过 connection.fetch 暴露 REST API
  ctx.inject(['connection'], (scoped) => {
    const apiBase = '/api/drama-trae'
    scoped.connection.fetch.register({
      path: `${apiBase}/list`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const { dramaRoot } = await readJson(request)
        try {
          const root = dramaRoot || await defaultDramaRoot()
          const projects = await listProjectSummaries(root)
          return Response.json({ ok: true, projects })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    scoped.connection.fetch.register({
      path: `${apiBase}/shots`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const { dramaRoot, project, episode } = await readJson(request)
        try {
          const root = dramaRoot || await defaultDramaRoot()
          const dir = await locateProjectDir(root, project)
          const shots = await collectShots(path.join(dir, '.aidrama', 'storyboard'), { episode })
          return Response.json({ ok: true, shots: shots.map((s) => ({ ...s.shot, episodeName: s.episodeName })) })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    scoped.connection.fetch.register({
      path: `${apiBase}/generate`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        const job = await jobs.createJob({ project: input.project, episode: input.episode })
        job.status = 'running'
        await jobs.update(job.id, { status: 'running' })
        // 异步执行，不阻塞请求；前端轮询 /status
        runOneShotDrama({
          ...input,
          onProgress: (evt) => {
            job.progress.current = evt
            if (evt.type === 'start') job.progress.total = Math.max(job.progress.total, 0) + 1
            if (evt.type === 'done') { job.progress.done += 1; job.results.push(evt) }
            if (evt.type === 'error') { job.errors.push(evt) }
            if (evt.type === 'summary') { job.progress.total = evt.total; job.progress.done = evt.generated }
            jobs.update(job.id, { progress: job.progress, results: job.results, errors: job.errors }).catch(() => {})
          },
        }).then((result) => {
          job.status = 'done'
          job.finishedAt = Date.now()
          job.result = result
          jobs.update(job.id, { status: 'done', finishedAt: job.finishedAt, result }).catch(() => {})
        }).catch((e) => {
          job.status = 'failed'
          job.finishedAt = Date.now()
          job.error = e.message
          jobs.update(job.id, { status: 'failed', finishedAt: job.finishedAt, error: e.message }).catch(() => {})
        })
        return Response.json({ ok: true, taskId: job.id })
      },
    })
    // 历史任务列表（统计页签数据源）
    scoped.connection.fetch.register({
      path: `${apiBase}/history`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const list = jobs.list()
        const stats = {
          total: list.length,
          done: list.filter((j) => j.status === 'done').length,
          failed: list.filter((j) => j.status === 'failed').length,
          running: list.filter((j) => j.status === 'running').length,
        }
        return Response.json({ ok: true, history: list, stats })
      },
    })
    scoped.connection.fetch.register({
      path: `${apiBase}/status`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const { taskId } = await readJson(request)
        const job = jobs.get(taskId)
        if (!job) return Response.json({ ok: false, error: '任务不存在' }, { status: 404 })
        return Response.json({ ok: true, job })
      },
    })
    // 产物列表：列出项目「素材/生成/」下的 mp4
    scoped.connection.fetch.register({
      path: `${apiBase}/artifacts`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const { dramaRoot, project } = await readJson(request)
        try {
          const root = dramaRoot || await defaultDramaRoot()
          const dir = await locateProjectDir(root, project)
          const genDir = path.join(dir, '素材', '生成')
          const files = await fs.readdir(genDir).catch(() => [])
          const videos = files
            .filter((f) => f.endsWith('.mp4') || f.endsWith('.mov'))
            .map((f) => {
              const full = path.join(genDir, f)
              return { name: f, path: full }
            })
          return Response.json({ ok: true, artifacts: videos, dir: genDir })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 账号池状态：列出 Trae 账号（脱敏）
    scoped.connection.fetch.register({
      path: `${apiBase}/accounts`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const accounts = await loadAccounts()
          const list = accounts.map((a) => ({
            ref: a.ref,
            uid: a.uid,
            phone: a.phone || a.nickname || '',
            expired: isTraeExpired(a),
          }))
          return Response.json({ ok: true, accounts: list, total: list.length })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 系统打开产物（macOS open / Windows start）
    scoped.connection.fetch.register({
      path: `${apiBase}/open`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const { filePath } = await readJson(request)
        try {
          await systemOpen(filePath)
          return Response.json({ ok: true })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 媒体流：给 <video> 内联预览提供视频字节（GET 带 file 参数）
    scoped.connection.fetch.register({
      path: `${apiBase}/media`,
      methods: ['GET'],
      requestBody: 'none',
      async fetch(request) {
        const url = new URL(request.url)
        const filePath = url.searchParams.get('file')
        if (!filePath) return new Response('missing file', { status: 400 })
        try {
          // 安全：仅允许 .mp4/.mov，且必须位于某个「素材/生成」目录下
          if (!/\.(mp4|mov)$/i.test(filePath)) return new Response('unsupported type', { status: 415 })
          if (!filePath.includes('素材') || !filePath.includes('生成')) return new Response('forbidden', { status: 403 })
          const stat = await fs.stat(filePath)
          const stream = fsSync.createReadStream(filePath)
          return new Response(stream, {
            status: 200,
            headers: {
              'content-type': filePath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4',
              'content-length': String(stat.size),
              'accept-ranges': 'bytes',
            },
          })
        } catch (e) {
          return new Response('not found', { status: 404 })
        }
      },
    })
    logger.info?.('drama-trae: REST API mounted at /api/drama-trae/*')
  })

  return {
    name,
    runOneShotDrama,
    locateProjectDir,
    collectShots,
    defaultDramaRoot,
    jobs,
  }
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

/** 判断 Trae 凭据是否过期（expires_at 为 ms 字符串）。 */
function isTraeExpired(cred) {
  const exp = cred?.expires_at
  if (!exp) return false
  const n = Number(exp)
  if (Number.isNaN(n)) return false
  return Date.now() >= (n > 1e12 ? n : n * 1e3)
}

/** 用系统默认应用打开文件（macOS open / Windows start / Linux xdg-open）。 */
import { spawn } from 'node:child_process'
async function systemOpen(filePath) {
  await fs.access(filePath) // 抛错表示不存在
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const args = process.platform === 'win32' ? ['', filePath] : [filePath]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  return true
}

/** 列出 AI短剧 根目录下的项目摘要（前端 dropdown 数据源）。 */
async function listProjectSummaries(dramaRoot) {
  const root = path.resolve(dramaRoot)
  let aiRoot = root
  if (path.basename(aiRoot) !== 'AI短剧') {
    const maybe = path.join(aiRoot, 'AI短剧')
    if (await fileExists(maybe)) aiRoot = maybe
  }
  let dirs = []
  try { dirs = await fs.readdir(aiRoot, { withFileTypes: true }) } catch { dirs = [] }
  const out = []
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === '共享资料') continue
    const projDir = path.join(aiRoot, d.name)
    if (!(await fileExists(path.join(projDir, '.aidrama')))) continue
    const sbDir = path.join(projDir, '.aidrama', 'storyboard')
    const files = await fs.readdir(sbDir).catch(() => [])
    const episodes = files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    out.push({ name: d.name, path: projDir, episodes })
  }
  return out
}