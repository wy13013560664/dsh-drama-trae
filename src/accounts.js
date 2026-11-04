/**
 * TRAE 账号池：读 ~/.dsh/.credentials.yaml 里的 TRAE_ACCOUNT_*，支持轮换与冷却。
 *
 * 凭据形态（实测）：
 *   { access_token, refresh_token, expires_at(ms str), uid, nickname, phone,
 *     machine_id, device_id, enterprise_id }
 *
 * 用法：
 *   const pool = await loadAccountPool()          // 读全部账号
 *   const cred = await pool.next(excludeUids)     // 取一个非排除账号
 *   pool.coolDown(uid, untilMs)                   // 标记该账号冷却到某时刻
 *
 * @module src/accounts
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 默认凭据文件路径。 */
export function credentialsPath() {
  return process.env.DSH_CREDENTIALS_FILE || path.join(os.homedir(), '.dsh', '.credentials.yaml')
}

/** 从 .credentials.yaml 解析全部 TRAE_ACCOUNT_* 凭据。 */
export function parseAccountsFromYaml(raw) {
  const out = []
  const re = /^(\s*)(TRAE_ACCOUNT_\w+):\s*'((?:[^']|'')*)'\s*$/gm
  let m
  while ((m = re.exec(raw)) !== null) {
    const ref = m[2]
    const value = m[3].replace(/''/g, "'")
    try {
      const o = JSON.parse(value)
      if (o && typeof o.access_token === 'string') {
        out.push({ ref, ...o })
      }
    } catch { /* 跳过坏条目 */ }
  }
  return out
}

/**
 * 加载账号池。
 * @returns {Promise<Array<object>>} [{ ref, access_token, uid, machine_id, device_id, ... }]
 */
export async function loadAccounts(filename = credentialsPath()) {
  const raw = await fs.promises.readFile(filename, 'utf8')
  return parseAccountsFromYaml(raw)
}

/** 判断凭据是否过期（expires_at 为 ms 字符串）。 */
export function isExpired(cred, now = Date.now()) {
  const exp = cred?.expires_at
  if (exp === undefined || exp === null || exp === '') return false
  const n = typeof exp === 'number' ? exp : Number(exp)
  if (Number.isNaN(n)) return false
  return now >= (n > 1e12 ? n : n * 1e3)
}

/** 账号池轮换器：跳过冷却中与已排除的账号，返回可用账号。 */
export function createAccountPool(accounts) {
  const cooldown = new Map() // uid -> untilMs
  return {
    size: accounts.length,
    all: () => accounts,
    coolDown(uid, untilMs) {
      cooldown.set(uid, untilMs)
    },
    /** 取下一个可用、未过期的账号。 */
    next(excludeUids = new Set(), now = Date.now()) {
      for (const acc of accounts) {
        if (excludeUids.has(acc.uid)) continue
        const until = cooldown.get(acc.uid)
        if (until !== undefined && now < until) continue
        if (isExpired(acc, now)) continue
        return acc
      }
      return null
    },
    /** 排除某 uid 后取下一个。 */
    nextAfter(failedUid, excludeUids = new Set()) {
      const s = new Set(excludeUids)
      if (failedUid) s.add(failedUid)
      return this.next(s)
    },
  }
}