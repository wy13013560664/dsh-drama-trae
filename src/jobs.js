/**
 * dsh-drama-trae —— 生成任务状态管理（磁盘持久化，供前端轮询 + 历史统计）。
 *
 * 任务写入 <dshHome>/drama-trae/jobs.jsonl，每行一个任务快照（追加式）。
 * 重启后可通过 list() 恢复历史。内存态 Map 作为热缓存，磁盘为 source of truth。
 * @module src/jobs.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export function createJobStore({ dataDir = null, ttlMs = 30 * 60 * 1000 } = {}) {
  const base = dataDir || path.join(os.homedir(), '.dsh', 'drama-trae')
  const logFile = path.join(base, 'jobs.jsonl')
  const jobs = new Map()

  async function ensureDir() {
    await fs.mkdir(base, { recursive: true })
  }

  // 追加式日志会随进度无限膨胀（实测 1MB / 507 行里大半是同一任务的重复快照）。
  // 超过 SOFT_LIMIT 就先压实一次：只保留每个任务的最新快照。
  const SOFT_LIMIT = 1.5 * 1024 * 1024
  let appendBytes = 0

  async function compact() {
    try {
      const lines = []
      for (const j of jobs.values()) lines.push(JSON.stringify(j))
      const tmp = `${logFile}.tmp-${Date.now()}`
      await fs.writeFile(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf8')
      await fs.rename(tmp, logFile)
      appendBytes = 0
    } catch { /* 压实失败不影响主流程 */ }
  }

  async function append(job) {
    await ensureDir()
    const line = JSON.stringify(job) + '\n'
    await fs.appendFile(logFile, line, 'utf8')
    appendBytes += Buffer.byteLength(line)
    if (appendBytes > SOFT_LIMIT) await compact()
  }

  async function restore() {
    try {
      const raw = await fs.readFile(logFile, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          if (j.id) jobs.set(j.id, j)
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 无历史文件，忽略 */ }
  }
  // 启动即恢复（异步，不阻塞 apply）
  restore().catch(() => {})

  async function createJob(meta) {
    const id = crypto.randomUUID()
    const job = {
      id,
      status: 'queued',
      project: meta.project ?? '',
      episode: meta.episode ?? '',
      startedAt: Date.now(),
      finishedAt: null,
      progress: { done: 0, total: 0, current: null },
      results: [],
      errors: [],
      error: null,
    }
    jobs.set(id, job)
    await append(job)
    return job
  }

  function get(id) {
    return jobs.get(id)
  }

  function list() {
    return [...jobs.values()].map((j) => ({ ...j }))
  }

  async function update(id, patch) {
    const job = jobs.get(id)
    if (!job) return
    Object.assign(job, patch)
    await append(job) // 追加最新快照（JSONL 幂等：前端取最后一条同 id）
  }

  return { createJob, get, list, update, prune: () => {} }
}