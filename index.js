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
import { generateVideo, resolveResourceUrls } from './src/video.js'
import { uploadLocalFile } from './src/upload.js'
import { normalizeParams, clampDurationToModel } from './src/validate.js'
import { buildShotVideoPrompt } from './src/prompt.js'
import { listCastings, pickCastingKey, pickCastingEntry, castAll, castCharacter, CASTING_DIR, isCastingStale, isNonHuman, checkCastingUsable } from './src/casting.js'
import { warmupAccounts, shouldWarmup } from './src/warmup.js'
import { readLedger, recordAccounts, estimateQuota, isQuotaExhausted, isAccountLevelFailure, classifyAccountFailure, isRetriableGenerationError, explainTraeVError, LEDGER_FILE } from './src/quota.js'
import { classifyError, backoffFor, sleep, isStillCooling } from './src/errors.js'
import { createLimiter } from './src/limiter.js'
import { createRunCircuit } from './src/circuit.js'
import { rankAccounts, summarizeAccounts } from './src/ranking.js'
import { planRecast } from './src/recast.js'
import { indexCharacters, resolveShotCharacters, renderAnchor, normalizeName } from './src/characters.js'
import { renderStyleSuffix } from './src/style.js'
import { canChain as judgeChain } from './src/frame-chain.js'
import { checkPlatformPacing, getPlatformProfile } from './src/platform.js'
import { checkShotsCompliance } from './src/compliance.js'
import { createProject, validateProjectTitle, PROJECT_DIRS } from './src/project.js'
import { buildLinkGraph } from './src/link.js'
import { loadCreationBundle, saveAsset, mergeAsset, saveScript, readScript, readStoryboardMd, ASSET_KINDS } from './src/creation.js'
import { generateAll, generateStage, regenerateWithHints, probeLlmRoutes, checkPrerequisites, STAGE_DEPS, STAGE_ORDER, CHAIN_ORDER, EPISODE_STAGES, FREE_MODEL_ROUTE, FREE_MODEL_FALLBACK_MODEL, STAGES } from './src/ai-create.js'
import { runGate } from './src/gate.js'
import { MAX_DURATION, MIN_DURATION, DEFAULT_DURATION, AUTOCONCURRENCY_CAP, TRAE, PATHS, VIDEO_MODEL } from './src/constants.js'
import { soloHeaders } from './src/credential.js'
import { createJobStore } from './src/jobs.js'

/** 短剧默认竖屏画幅（独立于 trae 的 adaptive，短剧行业惯例即竖屏）。 */
export const DRAMA_DEFAULT_RATIO = '9:16'

export const name = 'drama-trae'

/** 零硬依赖：凭据走文件读取，commands/webServer 软访问。 */
/**
 * 硬依赖只声明 connection。
 *
 * llm 走 `ctx.get('llm')` 机会性读取——cordis 的 inject 里每一项都是**硬依赖**，
 * 把 llm 写进来会让「宿主没装模型插件」变成插件不加载，出片功能跟着失效。
 * `ctx.get()` 在服务缺失时返回 undefined 而不抛错，正是这里需要的语义。
 */
export const inject = ['connection']

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
    concurrency = 0, // 0 = 自动（min(账号数, 镜头数, AUTO_CONCURRENCY_CAP)）
    styleIncludeDraft = false, // 草稿态风格 DNA 是否也注入
    // 一致性门禁默认「启用但只报告不阻断」：旧项目（分镜无 characters/sceneId、
    // 或有超长镜头）不会因升级而突然跑不了。要阻断请显式传 gateBlockOnFail:true，
    // 或只让硬性结构错（镜号重复/无描述/时长越界）阻断——见 gateStrict。
    force = false,             // 强制重新生成（覆盖已有产物），默认跳过已存在的文件
    gate = true,
    gateBlockOnFail = false,
    gateStrict = null,         // 数组：只阻断这些 code（如 ['CHK-06','CHK-05','CHK-07']）；null=用 gateBlockOnFail
    chainFrames = false,       // 首帧链式传导（同场景连续镜复用上一镜末帧）——已实测可用
    platform = null,           // 投放平台（用于节奏提示与合规词表）
    complianceBlock = false,   // 合规命中 block 级词时是否阻断
    recastCastings = true,     // 定妆图产出账号失效时自动重出（角色一致性优先）
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
  let usable = accounts.filter((a) => !isTraeExpired(a))

  // 配额账本预检：把**仍在冷却期**的账号剔除，避免一开始就撞墙。
  // 账本由每次跑完的真实结果更新（零成本，不主动探测 —— 探测本身也消耗配额）。
  const ledger = await readLedger(projectDir).catch(() => ({ accounts: {} }))
  // 关键：status 只是「上次观测」，配合 at 才有意义。
  // 之前只看 status，一条 11 小时前的 warmup quota 记录会把账号永久封死；
  // 实测 33 个账号里 20 个被这样挡在门外，而配额按周期是会回来的。
  const cooling = Object.entries(ledger.accounts || {})
    .filter(([, r]) => isStillCooling(r))
    .map(([uid]) => String(uid))
  // 兼容旧变量名（下面的错误消息与测试仍引用 knownDead）
  const knownDead = cooling
  const staleCount = Object.entries(ledger.accounts || {})
    .filter(([, r]) => ['quota', 'broken', 'auth'].includes(r?.status) && !isStillCooling(r))
    .length
  if (cooling.length) {
    const before = usable.length
    usable = usable.filter((a) => !cooling.includes(String(a.uid)))
    onProgress({
      type: 'quota-prune',
      pruned: before - usable.length,
      remaining: usable.length,
      stale: staleCount,
      note: `已跳过 ${before - usable.length} 个仍在冷却期的账号`
        + (staleCount ? `（另有 ${staleCount} 个旧记录已过期，重新放回可用池）` : ''),
    })
  } else if (staleCount) {
    onProgress({
      type: 'quota-revive',
      revived: staleCount,
      remaining: usable.length,
      note: `账本里 ${staleCount} 个 quota/broken 记录已超冷却期，重新放回可用池`,
    })
  }
  if (usable.length === 0) {
    throw new Error(
      `drama-trae: 没有可用 TRAE 账号。${knownDead.length
        ? `账本里有 ${knownDead.length} 个账号已确认配额耗尽，需要补充新账号或等配额重置。`
        : '请先登录 TRAE 账号。'}`)
  }

  // 按账本证据强度重排：ok（真出过片）→ unknown（没跑过）→ expired（冷却已过）→ pending（只有 heartbeat）。
  // 旧实现按下标轮转，把「只拿到过 heartbeat」的号当正常号用，实测这些号真实出片时
  // 0.3 秒就被 4040 拒 —— 时间全花在必然秒拒的号上。
  const ranked = rankAccounts(usable, ledger, { isCooling: isStillCooling })
  const rankSummary = summarizeAccounts(usable, ledger, { isCooling: isStillCooling })
  usable = ranked
  onProgress({ type: 'account-rank', ...rankSummary.counts, total: usable.length,
    note: `账号优先级：确定可用 ${rankSummary.counts.ok} / 未跑过 ${rankSummary.counts.unknown} / `
      + `冷却已过 ${rankSummary.counts.expired} / 仅排队过 ${rankSummary.counts.pending}` })

  const results = { generated: [], skipped: [], errors: [] }
  let cancelled = false
  const cancel = () => { cancelled = true }
  if (typeof onCancel === 'function') onCancel(cancel)

  // 加载角色卡（跨镜形象锚点，抑制人物设定漂移）；缺失时降级为不注入
  const charIndex = await loadCharacterIndex(projectDir)

  // 加载角色定妆记录：有则按镜注入首帧，无则纯文生视频（不阻断出片）。
  // 注意 castings 的 key 绑定产出账号，选号时必须锁定（见上方 forcedUid）。
  let castings = await listCastings(projectDir).catch(() => [])

  // 定妆图自动重出：TOS key 嵌了产出账号 uid，签名只能用那个号。
  // 那个号一旦配额空/冷却，这张图就**永久作废** —— 实测一集 24 镜里
  // 每个定妆镜都因此降级纯文生视频，整集人物一致性直接丢失。
  // 但角色形象没变，换个活着的账号重出一张仍是同一张脸，所以自动重出。
  if (castings.length && !dryRun && recastCastings !== false) {
    const plan = planRecast(castings, usable, ledger, { isCooling: isStillCooling })
    if (plan.recast.length) {
      onProgress({
        type: 'recast-plan',
        total: plan.recast.length,
        keep: plan.keep.length,
        names: plan.recast.map((c) => String(c.name)),
        reasons: plan.recast.map((c) => `${c.name}: ${c.recastReason}`),
        note: `${plan.recast.length} 张定妆图的产出账号已失效，正在用可用账号重出（角色一致性优先于省一次出图）`,
      })
      const rebuilt = []
      for (const c of plan.recast) {
        // charIndex.map 的 key 是归一化名（去标点小写），不能直接用原名去 get
        const card = (charIndex.list ?? []).find((x) => String(x?.name ?? '') === String(c.name))
          || (charIndex.list ?? []).find((x) => normalizeName(x?.name) === normalizeName(c.name))
        try {
          const r = await castCharacter({
            character: card ?? { name: c.name, appearancePrompt: c.prompt },
            projectDir,
            credentials: usable,
            force: true,
            onProgress: (stage, payload) => onProgress({ type: 'recast-item', stage, name: c.name, ...payload }),
          })
          rebuilt.push({ name: c.name, uid: r.uid })
        } catch (e) {
          onProgress({ type: 'recast-fail', name: c.name, error: e.message })
        }
      }
      // 重新读取：重出成功的记录已落盘，与保留的记录合并
      castings = await listCastings(projectDir).catch(() => [])
      onProgress({
        type: 'recast-done',
        rebuilt: rebuilt.length,
        failed: plan.recast.length - rebuilt.length,
        usable: castings.length,
      })
    }
  }
  if (charIndex.anchorCount > 0) {
    onProgress({ type: 'characters', count: charIndex.map.size, anchors: charIndex.anchorCount })
  }

  // 加载视觉风格 DNA（跨镜风格约束）；未定向/未冻结的草稿不注入
  const styleDoc = await loadStyleDoc(projectDir)
  const styleRender = renderStyleSuffix(styleDoc, { includeDraft: styleIncludeDraft })

  // 场景卡索引：SceneId → 场景卡（供 prompt 注入空间/光影/氛围）
  const sceneCardsRaw = await loadSceneCards(projectDir)
  const sceneIndex = new Map()
  for (const c of (sceneCardsRaw || [])) {
    const id = String(c?.id ?? c?.sceneId ?? '').trim()
    if (id) sceneIndex.set(id, c)
  }
  if (sceneIndex.size) onProgress({ type: 'scenes', count: sceneIndex.size })

  // 全项目角色卡（剔除 prompt 中姓名并替换为可区分特征词，避免模型绘制文字且同镜不混淆）
  const allCharCards = [...charIndex.map.values()].filter((c) => String(c?.name ?? '').trim())
  if (styleRender.suffix) {
    onProgress({ type: 'style', state: styleRender.state, dimensions: styleRender.used })
  }

  // 预构建每镜的计划（确定性），并幂等跳过已存在
  const planned = []
  let anchorInjected = 0      // 成功注入锚点的镜头数
  let anchorMissed = 0        // 声明了 characters 但查不到卡的镜头数
  for (let i = 0; i < total; i++) {
    const { shot, episodeName, sourceFile } = shots[i]
    const label = `[${i + 1}/${total}]`
    try {
      // 解析本镜涉及的角色卡并渲染锚点
      // scanText=true：描述里出现但 characters[] 未声明的角色也纳入锚点
      const { cards } = resolveShotCharacters(shot, charIndex, { scanText: true })
      const anchor = renderAnchor(cards)
      if (anchor) anchorInjected += 1
      else if (Array.isArray(shot?.characters) && shot.characters.length) anchorMissed += 1

      // 场景卡：分镜用 sceneRef（ai-drama 实际字段），兼容 sceneId
      const sceneRef = String(shot.sceneRef ?? shot.sceneId ?? '').trim()
      const sceneCard = sceneRef ? sceneIndex.get(sceneRef) : null
      // 角色姓名要剔除（模型会把中文姓名画成文字）
      const charNames = cards.map((c) => String(c?.name ?? '').trim()).filter(Boolean)
      const prompt = buildShotVideoPrompt(shot, {
        ratio,
        characterAnchor: anchor ? anchor.replace(/^\[角色锚点\]\s*/, '') : '',
        characterNames: cards,
        allCharCards,
        sceneCard,
        styleDna: styleRender.suffix ? (styleDoc?.style ?? null) : null,
      })
      const durSec = Number(shot.durationSec)
      const rawDur = forceDuration ?? (Number.isFinite(durSec) && durSec > 0 ? durSec : DEFAULT_DURATION)
      // 时长预检：分镜的 durationSec 是剪辑意图，模型只吃 MIN_DURATION~MAX_DURATION。
      // 低于下限（2~3 秒的短切很常见）直接发请求会 InvalidParameter 白跑一轮，
      // 所以统一抬到下限；超上限则截断。两个方向都告警，出片不中断。
      const durFix = clampDurationToModel(rawDur)
      const duration = durFix.duration
      if (durFix.clamped === 'below') {
        onProgress({ type: 'warn', label, shot: shot.shotNumber, code: 'duration-clamped',
          message: `durationSec=${rawDur} 低于模型下限 ${MIN_DURATION}s，已抬到 ${MIN_DURATION}s（剪辑时截短即可）` })
      } else if (durFix.clamped === 'above') {
        onProgress({ type: 'warn', label, shot: shot.shotNumber, code: 'duration-clamped',
          message: `durationSec=${rawDur} 超过上限 ${MAX_DURATION}s，已截断` })
      }
      const safeShot = String(shot.shotNumber || shot.shot || i + 1).replace(/[^0-9A-Za-z_-]/g, '_')
      // 命名规则：无 sceneId 时 <集>-<镜号>.mp4（旧行为）；
      // 有 sceneId 时 <集>-<镜号>-<sceneId>.mp4，便于反查与去重
      const safeScene = String(shot.sceneId ?? '').replace(/[^0-9A-Za-z_-]/g, '_')
      const outName = safeScene
        ? `${episodeName}-${safeShot}-${safeScene}.mp4`
        : `${episodeName}-${safeShot}.mp4`
      const outPath = path.join(outDir, outName)

      // 已有产物默认跳过（省钱）；要重跑就传 force=true
      const exists = await fileExists(outPath)
      if (exists && !force) {
        results.skipped.push({ shot: shot.shotNumber, reason: 'already-exists', file: outPath })
        onProgress({ type: 'skip', label, shot: shot.shotNumber, file: outName, reason: 'already-exists' })
        continue
      }
      if (exists && force) {
        onProgress({ type: 'overwrite', label, shot: shot.shotNumber, file: outName })
      }

      const params = normalizeParams({ prompt, ratio, resolution, duration })
      onProgress({ type: 'plan', label, shot: shot.shotNumber, episode: episodeName, prompt })

      if (dryRun) {
        results.skipped.push({ shot: shot.shotNumber, reason: 'dry-run', planned: outPath, prompt })
        continue
      }

      planned.push({ i, shot, episodeName, sourceFile, params, outPath, label, anchor, styleUsed: styleRender.used, sceneId: String(shot.sceneRef ?? shot.sceneId ?? '').trim() })
    } catch (e) {
      results.errors.push({ shot: shot.shotNumber, error: e.message })
      onProgress({ type: 'error', label, shot: shot.shotNumber, error: e.message })
    }
  }

  // 出片前一致性门禁：命中 FAIL 则阻断（可用 gate:false 关闭）
  // 注意：门禁检查**全部分镜**（含 dry-run 与幂等跳过的镜），
  // 因为 dry-run 的核心用途就是预检，且跳过的镜下次仍会出片。
  let gateReport = null
  if (gate) {
    const sceneCards = await loadSceneCards(projectDir)
    const assetCards = await loadAssetCards(projectDir)
    gateReport = runGate({
      shots: shots.map((s) => s.shot),
      charIndex,
      styleDoc,
      sceneCards,
      assetCards,
      maxDuration: MAX_DURATION,
    })
    onProgress({ type: 'gate', ...gateReport.summary })
    for (const f of gateReport.fails) onProgress({ type: 'gate-fail', ...f })
    for (const w of gateReport.warns.slice(0, 20)) onProgress({ type: 'gate-warn', ...w })
    const blockedCodes = Array.isArray(gateStrict)
      ? gateReport.fails.filter((f) => gateStrict.includes(f.code))
      : gateBlockOnFail ? gateReport.fails : []
    if (blockedCodes.length > 0) {
      onProgress({ type: 'summary', generated: 0, total, skipped: results.skipped.length,
        errors: blockedCodes.length, concurrency: 0, outDir, blocked: true })
      return {
        project,
        total,
        generated: 0,
        skipped: results.skipped.length,
        errors: blockedCodes.length,
        outDir,
        concurrency: 0,
        gate: gateReport.summary,
        blocked: true,
        blockedCodes: blockedCodes.map((f) => f.code),
        anchor: { characters: charIndex.map.size, anchorsAvailable: charIndex.anchorCount, injected: anchorInjected, missed: anchorMissed },
        style: { state: styleRender.state, used: styleRender.used },
        results: { ...results, gate: gateReport },
        message: `一致性门禁阻断：${blockedCodes.length} 项 FAIL（${blockedCodes.map((f) => f.code).join('/')}）；用 gate:false 或 gateBlockOnFail:false 可跳过`,
      }
    }
  }

  // 平台节奏提示 + 合规检查（不改门禁判定，单独报告）
  let platformReport = null
  let complianceReport = null
  if (platform || true) {
    const pl = platform ?? '其他'
    platformReport = checkPlatformPacing(shots.map((s) => s.shot), pl)
    complianceReport = checkShotsCompliance(shots.map((s) => s.shot), pl)
    if (platformReport.issues.length) {
      onProgress({ type: 'platform', platform: pl, stats: platformReport.stats })
      for (const it of platformReport.issues.slice(0, 10)) onProgress({ type: 'platform-issue', ...it })
    }
    onProgress({ type: 'compliance', ...complianceReport.summary })
    for (const h of complianceReport.blocks.slice(0, 10)) {
      onProgress({ type: 'compliance-block', ...h })
    }
    for (const h of complianceReport.warns.slice(0, 10)) {
      onProgress({ type: 'compliance-warn', ...h })
    }
    if (complianceBlock && complianceReport.blocks.length > 0) {
      onProgress({ type: 'summary', generated: 0, total, skipped: results.skipped.length,
        errors: complianceReport.blocks.length, concurrency: 0, outDir, blocked: true })
      return {
        project, total, generated: 0, skipped: results.skipped.length,
        errors: complianceReport.blocks.length, outDir, concurrency: 0,
        gate: gateReport ? gateReport.summary : null,
        platform: { stats: platformReport.stats, issues: platformReport.issues.length },
        compliance: complianceReport.summary,
        blocked: true, blockedBy: 'compliance',
        anchor: { characters: charIndex.map.size, anchorsAvailable: charIndex.anchorCount, injected: anchorInjected, missed: anchorMissed },
        style: { state: styleRender.state, used: styleRender.used },
        results: { ...results },
        message: `合规阻断：命中 ${complianceReport.blocks.length} 个 block 级词`,
      }
    }
  }

  // 首帧链式传导：需要「上一镜出片完成后」才知道末帧，故链式开启时强制串行。
  // lastFrames 在出片成功时填充；传导判定在 runPlannedItem 内按**运行期**前驱末帧动态计算。
  const lastFrames = new Map()        // Map<镜号, 末帧 key>
  const shotOrder = planned.map((p) => p.shot)  // 按出片顺序
  const effectiveConcurrency = chainFrames ? 1 : (concurrency > 0 ? concurrency : 0)

  // 并发 worker 池：每镜从账号池轮转取独立账号，真正并行出片。
  //
  // 自动并发必须封顶：实测 18 并发跑 24 镜时服务端开始整片返回
  // `4010 access denied`（452 次），并发越高拒绝越多，且这是**全局**拒绝 ——
  // 换账号没用。默认按 min(账号数, 镜头数, 6) 起步，再由 limiter 动态收紧。
  const autoCap = Number(process.env.DSH_TRAE_AUTO_CONCURRENCY || AUTOCONCURRENCY_CAP)
  const workerCount = effectiveConcurrency > 0
    ? Math.min(effectiveConcurrency, planned.length)
    : Math.min(usable.length, planned.length, autoCap)
  const n = Math.max(1, workerCount)
  // 自适应闸门：遇到全局限流就乘性减半，连续成功再加性探回。
  const limiter = createLimiter({ target: n, successStreak: 6 })
  // 跑批熔断：整池账号在亚秒内被一起拒时立刻停手，不空转几十次请求（见 src/circuit.js）
  const circuit = createRunCircuit({
    threshold: Number(process.env.DSH_TRAE_TRIP_THRESHOLD || 8),
    fastFailMs: Number(process.env.DSH_TRAE_FAST_FAIL_MS || 1500),
  })
  let accountIndex = 0
  let nextIndex = 0
  // 配额记账缓冲：跑完一次性写盘（避免每镜一次 IO）
  const quotaEntries = []
  // 本轮内已撞配额的账号：立刻排除，避免同一个账号被反复重试 10 次
  const deadThisRun = new Set()
  // 本轮已「被某个 worker 占住在试」的账号：并发时多个 worker 会同时按下标轮转到
  // 同一个号（实测两个 worker 都挑中 2609607782493708，同一个死号被撞两次），
  // 所以取号要带租约，试完（成功/失败判定后）再释放。
  const busyUids = new Set()
  // 统计：有多少镜用上了定妆图（首帧参考），用于 summary 与前端提示
  let castingUsed = 0

  async function runPlannedItem(item) {
    if (cancelled) { results.errors.push({ shot: item.shot.shotNumber, error: '已取消' }); return }
    const maxTries = Math.max(1, usable.length) // 每个镜头最多试遍所有账号
    // 平台级故障（4010 access denied / 2001 lock busy / 429）与「换号」是两回事：
    // 换号对它无效，只有退避重试有效。所以单独给一份重试预算，
    // 不挤占账号轮转的次数 —— 否则 24 镜里有 21 镜只撞一次 4010 就被判死。
    const maxGlobalRetries = Number(process.env.DSH_TRAE_GLOBAL_RETRIES || 3)
    let lastError = null
    let accountTries = 0
    let globalRetries = 0
    let preferSameUid = null    // 平台级故障退避后优先用同一个账号
    while (accountTries < maxTries) {
      if (cancelled) { results.errors.push({ shot: item.shot.shotNumber, error: '已取消' }); return }
      // 熔断期间不再发任何请求：排队中的镜头直接收尾，避免几十次必然失败的调用
      if (!circuit.canAttempt()) {
        lastError = lastError || new Error('服务端持续快速拒绝，本轮已熔断')
        break
      }
      // 轮转取账号：失败自动换下一个（每账号独立配额）
      // 链式传导时锁定**上一镜产出账号**（末帧 key 与账号绑定，换账号会 invalid userid）
      let forcedUid = null
      if (chainFrames) {
        const idx = shotOrder.indexOf(item.shot)
        if (idx > 0) {
          const prevNo = String(shotOrder[idx - 1]?.shotNumber ?? shotOrder[idx - 1]?.shot ?? '').trim()
          forcedUid = lastFrames.get(prevNo)?.uid ?? null
        }
      }
      // 本镜若会用角色定妆图作首帧，账号必须锁定为该图的产出账号
      // （提前算一次，避免在选号之后才发现）
      if (!forcedUid) {
        const pre = pickCastingEntry(item.shot, castings, allCharCards.map(c => c.name))
        if (pre?.uid) forcedUid = String(pre.uid)
      }
      // 定妆图产出账号若已在本次撞配额，也没法换号（key 绑定账号）→ 直接放弃该镜
      if (forcedUid && deadThisRun.has(String(forcedUid))) {
        lastError = new Error(
          `定妆图产出账号 ${forcedUid} 已配额耗尽，且该图只能用它签名，无法改用其他账号`)
        break
      }
      // 选号：先排除本轮已撞配额的账号，再按序轮转。
      // 否则「账号 A 配额耗尽」会被重试 10 次（每次必然失败，白等 10 轮）。
      const alive = usable.filter((a) => !deadThisRun.has(String(a.uid)))
      if (alive.length === 0) {
        lastError = new Error(
          `本轮所有 ${usable.length} 个账号都已配额耗尽，跳过该镜。请补充新账号或等配额重置。`)
        break
      }
      // 取号：先锁定（链式传导 / 定妆图绑定），再优先沿用上轮退避的号，
      // 最后才按下标轮转；三种路径都要避开「本轮已被别的 worker 占住」的号。
      const pickFrom = (list) => {
        const free = list.filter((a) => !busyUids.has(String(a.uid)))
        return free.length ? free : null
      }
      let credential = null
      if (forcedUid) {
        const hit = alive.find((a) => String(a.uid) === String(forcedUid))
        if (hit) credential = hit
      }
      if (!credential && preferSameUid) {
        const free = pickFrom(alive.filter((a) => String(a.uid) === String(preferSameUid)))
        if (free?.length) credential = free[0]
      }
      if (!credential) {
        const free = pickFrom(alive)
        if (!free) {
          // 所有存活号都在被别的 worker 使用：并发已经把池子用满。
          // 这不是错误，等一轮（其它 worker 释放后会继续），最多等 maxTries 轮。
          accountTries += 1
          await sleep(500 + Math.floor(Math.random() * 500), () => cancelled)
          continue
        }
        credential = free[(accountIndex + accountTries) % free.length]
      }
      busyUids.add(String(credential.uid))
      try {
        onProgress({ type: 'start', label: item.label, shot: item.shot.shotNumber, episode: item.episodeName, prompt: item.params.prompt, attempt: accountTries + globalRetries })

        // 图生视频：分镜若带参考图（shot.image 本地路径 / shot.image_key 已有 TOS key），先取 key
        let genParams = item.params
        let usingCasting = false
        const refImage = item.shot?.image ?? item.shot?.referenceImage ?? item.shot?.imagePath
        const refKey = item.shot?.image_key ?? item.shot?.imageKey
        // 首帧链式传导：同场景且非硬切时，用**上一镜已产出的末帧**作本镜首帧
        let chainKey = null
        let chainFrom = null
        let chainUid = null
        if (chainFrames) {
          const idx = shotOrder.indexOf(item.shot)
          if (idx > 0) {
            const prevShot = shotOrder[idx - 1]
            const prevNo = String(prevShot?.shotNumber ?? prevShot?.shot ?? '').trim()
            const prevEntry = lastFrames.get(prevNo)
            // 复用 frame-chain 的判定规则（同场景 + 非硬切）
            const judged = judgeChain(prevShot, item.shot, prevEntry?.key)
            // 关键：末帧 key 绑定产出账号，链式时必须沿用该账号，否则 invalid userid
            if (judged.chain) { chainKey = prevEntry.key; chainFrom = prevNo; chainUid = prevEntry.uid }
          }
        }
        // 角色定妆图：本镜主体的定妆照作为 i2v 首帧，跨镜保脸。
        // 优先级低于首帧链式（链式保证同场景空间连续），高于无锚点的纯文生视频。
        // 定妆图 key 同样绑定产出账号：必须锁定产出它的那个账号，
        // 否则会报 failed to sign image url: invalid userid（实测）。
        const castingHit = (!chainKey && castings.length)
          ? pickCastingEntry(item.shot, castings, allCharCards.map(c => c.name))
          : null
        const castingKey = castingHit?.uri ?? null
        const castingUid = castingHit?.uid ?? null
        if (chainKey) {
          onProgress({ type: 'chain', label: item.label, shot: item.shot.shotNumber, fromShot: chainFrom })
          genParams = { ...item.params, image_paths: [chainKey] }
        } else if (castingKey) {
          // 定妆图只能用产出它的账号签名，账号不符会 invalid userid。
          // 这里做一次硬校验：拿到图却拿不到产出账号，宁可跳过也不浪费一次请求。
          // 前置已按 castingUid 锁号；这里只做防御式断言，账号不符就直接记录错误、
          // 不发请求（发了必然 invalid userid，白白消耗一次配额与时间）。
          if (castingUid && String(credential?.uid) !== String(castingUid)) {
            const msg = `定妆图产出账号 ${castingUid} 与当前账号 ${credential?.uid} 不符`
            if (usable.some((a) => String(a.uid) === String(castingUid) && !deadThisRun.has(String(castingUid)))) {
              lastError = new Error(msg)
              // 下一轮 forcedUid 会选中产出账号；无论如何都要推进计数，
              // 否则 while 循环没有步进 → 死循环。
              accountTries += 1
              continue
            }
            // 产出账号已不可用 → 这张图永远用不了（key 绑死账号）。
            // 定妆图是「锦上添花」，不该让整条镜头失败：
            // 降级为纯文生视频（角色一致性会差一些，但片子出得来）。
            // 注意：这里必须 return 出这条分支，否则后面又会把 image_paths 加回来。
            onProgress({
              type: 'casting-drop',
              label: item.label,
              shot: item.shot.shotNumber,
              reason: `${msg}，该账号不在可用池 → 改用纯文生视频`,
            })
            genParams = { ...item.params }
            usingCasting = false
          } else {
            onProgress({ type: 'casting', label: item.label, shot: item.shot.shotNumber })
            genParams = { ...item.params, image_paths: [castingKey] }
            usingCasting = true
          }
          if (usingCasting) castingUsed += 1
        } else if (refKey) {
          genParams = { ...item.params, image_paths: [refKey] }
        } else if (refImage) {
          onProgress({ type: 'upload', label: item.label, shot: item.shot.shotNumber })
          const up = await uploadLocalFile(credential, refImage, { biz_type: 'image' })
          genParams = { ...item.params, image_paths: [up.uri] }
        }

        // 只有真正发请求的这一段才占并发许可：换号判断、定妆图校验都不占，
        // 否则被 4010 打回时许可空转，整条流水线跟着排队。
        const release = await limiter.acquire()
        const reqStartedAt = Date.now()
        let video
        try {
          video = await generateVideo({
            credential,
            params: genParams,
            localPath: item.outPath,
            onProgress: (stage, payload) => {
              if (stage === 'result' || stage === 'done' || stage === 'failed') {
                onProgress({ type: 'video', label: item.label, shot: item.shot.shotNumber, stage, payload })
              }
            },
          })
        } finally {
          release()
        }
        // 一次成功 = 通道健康：连续若干次后允许把并发探回目标值
        limiter.reward()
        circuit.record({ ok: true, ms: Date.now() - reqStartedAt })
        accountIndex += 1
        busyUids.delete(String(credential.uid))
        // 出片真成功 → 这才是「确定可用」，覆盖预热时的 pending
        quotaEntries.push({ uid: credential.uid, status: 'ok', note: `镜 ${item.shot.shotNumber} 出片成功` })
        if (video.last_frame_uri) lastFrames.set(String(item.shot.shotNumber ?? '').trim(), { key: video.last_frame_uri, uid: credential.uid })
        results.generated.push({
          shot: item.shot.shotNumber,
          episode: item.episodeName,
          source: item.sourceFile,
          file: video.path,
          video_duration: video.video_duration,
          attempts: accountTries,
          account: credential.uid,     // 出片账号（便于配额归因）
          prompt: item.params.prompt,  // 实际发送的完整 prompt（可回溯性）
          anchor: item.anchor || '',   // 注入的角色锚点（空串=未注入）
          image_ref: genParams.image_paths?.[0] ?? null,
          chained_from: chainFrom,
          last_frame_uri: video.last_frame_uri ?? null,
          scene_id: item.sceneId || null,
        })
        onProgress({ type: 'done', label: item.label, shot: item.shot.shotNumber, file: video.path, attempt: accountTries })
        return
      } catch (e) {
        lastError = e
        busyUids.delete(String(credential.uid))
        const msg = String(e.message || '')
        const reqMs = Date.now() - (typeof reqStartedAt === 'number' ? reqStartedAt : Date.now())
        // 统一分类（src/errors.js）：scope 决定「换号还是退避」，retriable 决定「还试不试」。
        // 旧写法把 4010（平台侧 access denied）当未知错，换一次号就 break ——
        // 实测 452 次 4010 让 21/24 镜直接判死，服务端 message 里明写着 wait and retry。
        const cls = classifyError(msg)
        if (cls.markAccount) {
          // 账号级故障（4008 额度空 / 4040 账号异常 / 1001 鉴权被拒）→ 立刻拉黑换号。
          // 实测（dsh-trae-video）：这几类换号即可出片，不该让镜头失败。
          quotaEntries.push({
            uid: credential.uid,
            status: cls.kind === 'quota' ? 'quota' : cls.kind === 'auth' ? 'auth' : 'broken',
            note: `${cls.kind}: ${msg.slice(0, 110)}`,
          })
          deadThisRun.add(String(credential.uid))
          preferSameUid = null
          accountTries += 1
          onProgress({
            type: 'quota-dead',
            label: item.label,
            shot: item.shot.shotNumber,
            uid: credential.uid,
            kind: cls.kind,
            remaining: usable.length - deadThisRun.size,
          })
        }
        if (!cls.retriable) {
          // 参数/内容被拒：换号、重试都不会好，直接判该镜失败，省下配额。
          // 这类不计入熔断（它与通道健康无关，再慢也是内容问题）。
          break
        }
        // 熔断记账：只有「能被服务端接受的请求」才代表通道状态。
        // 亚秒级连续失败 = 通道根本进不去 → 立刻停手（见 src/circuit.js）。
        const cb = circuit.record({ ok: false, ms: reqMs, kind: cls.kind })
        if (cb.justTripped) {
          onProgress({ type: 'circuit-open', ...cb, ...circuit.snapshot() })
        }
        if (cb.tripped && !circuit.canAttempt()) {
          lastError = new Error(cb.reason || '服务端持续快速拒绝，已熔断本轮出片')
          break
        }
        if (cls.scope === 'global') {
          // 平台侧瞬时拒绝：换号无效（全池一起被拒），只有退避重试有效。
          // 这类重试不吃账号轮转预算，单独计数，否则「试遍账号」=「试一次就放弃」。
          // 撞上全局限流就立刻收紧并发：拒绝是并发打满导致的，
          // 只退避不降并发，醒来还是以同样的并发撞同一堵墙。
          const newLimit = limiter.penalize()
          onProgress({ type: 'throttle', limit: newLimit, kind: cls.kind, ...limiter.snapshot() })
          if (globalRetries >= maxGlobalRetries) break
          const waitMs = backoffFor(cls.backoffMs, globalRetries, 60_000)
          globalRetries += 1
          preferSameUid = String(credential.uid) // 账号没坏，退避后继续用它
          onProgress({
            type: 'retry', label: item.label, shot: item.shot.shotNumber,
            attempt: accountTries + globalRetries, error: msg.slice(0, 120),
            waitMs, kind: cls.kind,
          })
          const woke = await sleep(waitMs, () => cancelled)
          if (!woke) { results.errors.push({ shot: item.shot.shotNumber, error: '已取消' }); return }
          continue
        }
        // 账号级：换下一个账号继续（预算按账号数计）
        onProgress({
          type: 'retry', label: item.label, shot: item.shot.shotNumber,
          attempt: accountTries, error: msg.slice(0, 120), kind: cls.kind,
        })
      }
    }
    const rawErr = lastError?.message || '生成失败'
    // 把服务端嵌套错误翻成人话，界面直接能看懂
    const humanErr = lastError ? explainTraeVError(rawErr) : '生成失败'
    results.errors.push({ shot: item.shot.shotNumber, error: humanErr, rawError: rawErr.slice(0, 600), kind: lastError ? classifyError(rawErr).kind : null })
    onProgress({ type: 'error', label: item.label, shot: item.shot.shotNumber, error: humanErr, rawError: rawErr.slice(0, 300), kind: lastError ? classifyError(rawErr).kind : null })
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

  // 配额记账：把本轮的账号结果写进账本，下次预检就能跳过耗尽的账号
  if (quotaEntries.length) {
    try { await recordAccounts(projectDir, quotaEntries) } catch { /* 记账失败不影响出片结果 */ }
  }

  const summary = {
    project,
    total,
    generated: results.generated.length,
    skipped: results.skipped.length,
    errors: results.errors.length,
    // 首条错误摘要：前端据此显示「为什么失败」，不用去翻日志
    firstError: results.errors[0]?.error ? String(results.errors[0].error).slice(0, 160) : null,
    skipNote: results.skipped.length && !results.generated.length
      ? '所选镜头均已有产物，无需重新生成'
      : null,
    perShot: results.errors.slice(0, 20).map((e) => ({ shot: e.shot, error: String(e.error).slice(0, 120) })),
    outDir,
    concurrency: n,
    limiter: limiter.snapshot(),
    circuit: circuit.snapshot(),
    // 一致性与可观测性指标
    gate: gateReport ? gateReport.summary : null,
    platform: platformReport ? { platform: platformReport.profile, stats: platformReport.stats, issues: platformReport.issues.length } : null,
    compliance: complianceReport ? complianceReport.summary : null,
    style: { state: styleRender.state, used: styleRender.used },
    anchor: {
      characters: charIndex.map.size,     // 角色卡数
      anchorsAvailable: charIndex.anchorCount, // 有 appearancePrompt 的卡数
      injected: anchorInjected,           // 成功注入锚点的镜头数
      missed: anchorMissed,               // 声明了 characters 但查不到卡的镜头数
    },
  }
  onProgress({ type: 'summary', ...summary })
  return { ...summary, results }
}

/* ---------------------------------------------------------------- 定位与读取 */

/** 读取 .aidrama 下的 JSON，失败返回 null。 */
async function readAidramaJson(projectDir, name) {
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir, '.aidrama', name), 'utf8'))
  } catch {
    return null
  }
}

/** 加载视觉风格 DNA（.aidrama/style.json）。 */
export async function loadStyleDoc(projectDir) {
  return readAidramaJson(projectDir, 'style.json')
}

/** 加载场景卡数组（.aidrama/scenes/cards.json）。 */
export async function loadSceneCards(projectDir) {
  const doc = await readAidramaJson(projectDir, path.join('scenes', 'cards.json'))
  if (Array.isArray(doc)) return doc
  if (Array.isArray(doc?.cards)) return doc.cards
  if (Array.isArray(doc?.scenes)) return doc.scenes
  return null
}

/** 取风格 DNA 纯对象（供 prompt 构建直接用）。 */
export async function loadStyleDna(projectDir, { includeDraft = false } = {}) {
  const doc = await loadStyleDoc(projectDir)
  const r = renderStyleSuffix(doc, { includeDraft })
  if (!r.suffix) return null
  return doc?.style ?? null
}

/** 加载资产卡数组（.aidrama/assets/cards.json）。 */
export async function loadAssetCards(projectDir) {
  const doc = await readAidramaJson(projectDir, path.join('assets', 'cards.json'))
  return Array.isArray(doc?.cards) ? doc.cards : Array.isArray(doc) ? doc : null
}

/**
 * 加载项目的人物设定卡索引（.aidrama/characters.json）。
 * 缺失或解析失败时返回空索引——出片照常进行，只是不注入角色锚点。
 * @param {string} projectDir 项目根目录
 * @returns {Promise<ReturnType<typeof indexCharacters>>}
 */
export async function loadCharacterIndex(projectDir) {
  const file = path.join(projectDir, '.aidrama', 'characters.json')
  try {
    const raw = await fs.readFile(file, 'utf8')
    return indexCharacters(JSON.parse(raw))
  } catch {
    return indexCharacters(null) // { map: empty, list: [], anchorCount: 0 }
  }
}

/** 默认 ai-drama 根目录。 */
/**
 * 发现本机所有含**真实项目**的 AI短剧 根目录。
 *
 * 之前只检查 ~/Documents/ShiPin 与 ~/Documents 两个固定位置，
 * 导致项目放在其它路径（如 ~/Documents/dsh-plugin-ai-drama2/AI短剧）时
 * 前端「出片」页签里看不到任何项目、无法初始化。
 *
 * 现改为：环境变量 > 固定候选 > 一级目录扫描，且只保留确实含项目的根。
 */
export async function discoverDramaRoots() {
  const home = process.env.HOME || '~'
  const roots = []
  const push = async (p) => {
    if (!p) return
    const full = path.resolve(p)
    if (path.basename(full) === 'AI短剧') {
      if (await fileExists(full)) roots.push(full)
    } else {
      const maybe = path.join(full, 'AI短剧')
      if (await fileExists(maybe)) roots.push(maybe)
    }
  }

  // ① 显式环境变量优先
  if (process.env.DSH_DRAMA_ROOT) await push(process.env.DSH_DRAMA_ROOT)

  // ② 固定候选
  await push(path.join(home, 'Documents', 'ShiPin'))
  await push(home)

  // ③ 一级目录扫描（~/* 与 ~/Documents/*），兜住任意自定义路径
  for (const base of [home, path.join(home, 'Documents')]) {
    let entries = []
    try { entries = await fs.readdir(base, { withFileTypes: true }) } catch { entries = [] }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const maybe = path.join(base, e.name, 'AI短剧')
      if (await fileExists(maybe)) roots.push(maybe)
    }
  }

  // 去重 + 只保留含真实项目（至少一个子目录带 .aidrama）的根
  const seen = new Set()
  const out = []
  for (const r of roots) {
    if (seen.has(r)) continue
    seen.add(r)
    let dirs = []
    try { dirs = await fs.readdir(r, { withFileTypes: true }) } catch { dirs = [] }
    const hasProject = dirs.some((d) =>
      d.isDirectory() && !d.name.startsWith('.') && d.name !== '共享资料')
    const realProject = hasProject || await (async () => {
      for (const d of dirs) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue
        if (await fileExists(path.join(r, d.name, '.aidrama'))) return true
      }
      return false
    })()
    if (realProject) out.push(r)
  }
  return out
}

/** 兼容旧调用：返回第一个含项目的根；都没有则返回最可能的默认路径。 */
export async function defaultDramaRoot() {
  const roots = await discoverDramaRoots()
  if (roots.length) return roots[0]
  return path.join(process.env.HOME || '~', 'Documents', 'ShiPin', 'AI短剧')
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
  // 宿主 llm 服务（可选）：AI 创作走 ctx.get('llm')，与 ai-drama 同源
  /**
   * 解析本次调用要用的 model id。
   *
   * 顺序：调用方显式传入 → 实时探测目录里的第一个 → 已知兜底（deepseek-v4.1-flash-free）。
   * 宿主适配器的 resolveModel 要求 model 必须是**具体字符串**；传 undefined 会让它
   * 返回 id === undefined，宿主随即抛 INVALID_MODEL_INFO。所以这里必须给出真值。
   */
  async function resolveModel(llm, requested) {
    const want = typeof requested === 'string' ? requested.trim() : ''
    if (want) return want
    try {
      const probe = await probeLlmRoutes(llm)
      const first = probe.models?.find((m) => m.id)
      if (first) return first.id
    } catch { /* 探测失败就用兜底 */ }
    return FREE_MODEL_FALLBACK_MODEL
  }

  // 宿主 llm 服务（可选）：AI 创作走 ctx.get('llm')，与 ai-drama 同源
  const getLlm = () => {
    try {
      const v = ctx.get?.('llm')
      return v && typeof v.stream === 'function' ? v : null
    } catch { return null }
  }

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
          // 有显式 root 时只扫那一个；否则自动发现本机所有含项目的根并聚合
          if (dramaRoot) {
            const projects = await listProjectSummaries(dramaRoot)
            return Response.json({ ok: true, projects, roots: [path.resolve(dramaRoot)] })
          }
          const roots = await discoverDramaRoots()
          const projects = []
          for (const root of roots) {
            const list = await listProjectSummaries(root)
            for (const p of list) projects.push({ ...p, root })
          }
          // 空根也返回，便于前端提示「这个目录没有项目」
          const allRoots = roots.length ? roots : [await defaultDramaRoot()]
          return Response.json({ ok: true, projects, roots: allRoots })
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
          force: Boolean(input.force),
          onProgress: (evt) => {
            job.progress.current = evt
            if (evt.type === 'start') job.progress.total = Math.max(job.progress.total, 0) + 1
            if (evt.type === 'done') { job.progress.done += 1; job.results.push(evt) }
            if (evt.type === 'error') { job.errors.push(evt) }
            if (evt.type === 'summary') { job.progress.total = evt.total; job.progress.done = evt.generated }
            jobs.update(job.id, { progress: job.progress, results: job.results, errors: job.errors }).catch(() => {})
          },
        }).then((result) => {
          job.finishedAt = Date.now()
          job.result = result
          // 关键：不能只看「跑完了」就报成功。
          // 0 镜生成成功 + 24 镜失败也是「跑完了」，但必须报失败。
          const generated = Number(result?.generated ?? 0)
          const errors = Number(result?.errors ?? 0)
          const skipped = Number(result?.skipped ?? 0)
          const total = Number(result?.total ?? 0)
          let status = 'done'
          let failReason = null
          if (generated === 0 && errors === 0 && skipped > 0) {
            // 全部跳过 ≠ 失败：镜头的文件已存在，本来就不该重新生成。
            // 之前这里误判成「生成失败」，用户看到红灯但其实一切正常。
            status = 'done'
          } else if (generated === 0) {
            status = 'failed'
            failReason = errors
              ? `全部 ${errors} 镜生成失败（${result?.firstError || '配额或服务端错误'}）`
              : `没有任何镜头生成成功（共 ${total} 镜）`
          } else if (errors > 0) {
            status = 'partial'
            failReason = `${generated} 镜成功 / ${errors} 镜失败`
          }
          job.status = status
          job.error = failReason
          jobs.update(job.id, {
            status, finishedAt: job.finishedAt, result,
            ...(failReason ? { error: failReason } : {}),
          }).catch(() => {})
        }).catch((e) => {
          job.status = 'failed'
          job.finishedAt = Date.now()
          job.error = e.message
          jobs.update(job.id, { status: 'failed', finishedAt: job.finishedAt, error: e.message }).catch(() => {})
        })
        return Response.json({ ok: true, taskId: job.id })
      },
    })
    // 一致性预检：不出片，只返回门禁/平台/合规/注入统计，供前端面板展示
    scoped.connection.fetch.register({
      path: `${apiBase}/preflight`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          if (!input.project) return Response.json({ ok: false, error: '缺少 project' }, { status: 400 })
          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)
          const storyboardDir = path.join(projectDir, '.aidrama', 'storyboard')
          const shots = await collectShots(storyboardDir, { episode: input.episode, onlyShots: input.shots })
          if (!shots.length) return Response.json({ ok: false, error: '未找到分镜' }, { status: 400 })

          const charIndex = await loadCharacterIndex(projectDir)
          const styleDoc = await loadStyleDoc(projectDir)
          const sceneCards = await loadSceneCards(projectDir)
          const assetCards = await loadAssetCards(projectDir)
          const styleRender = renderStyleSuffix(styleDoc, { includeDraft: Boolean(input.styleIncludeDraft) })

          const pl = String(input.platform ?? '其他')
          const gate = runGate({
            shots: shots.map((s) => s.shot),
            charIndex, styleDoc, sceneCards, assetCards,
            maxDuration: MAX_DURATION,
          })
          const pacing = checkPlatformPacing(shots.map((s) => s.shot), pl)
          const compliance = checkShotsCompliance(shots.map((s) => s.shot), pl)

          const perShot = shots.map(({ shot, episodeName }) => {
            // scanText=true：描述里出现但 characters[] 未声明的角色也纳入锚点
      const { cards } = resolveShotCharacters(shot, charIndex, { scanText: true })
            return {
              shot: String(shot.shotNumber ?? shot.shot ?? ''),
              episode: episodeName,
              sceneId: String(shot.sceneId ?? '').trim() || null,
              anchorPreview: renderAnchor(cards) || null,
              hasEmotion: Boolean(shot.emotion),
              durationSec: Number(shot.durationSec) || null,
            }
          })

          return Response.json({
            ok: true,
            gate,
            platform: { profile: pacing.profile, stats: pacing.stats, issues: pacing.issues },
            compliance: compliance.summary,
            complianceHits: { blocks: compliance.blocks.slice(0, 50), warns: compliance.warns.slice(0, 50) },
            style: { state: styleRender.state, used: styleRender.used, suffix: styleRender.suffix || null },
            characters: { total: charIndex.map.size, anchors: charIndex.anchorCount },
            perShot,
          })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 本地文件上传：base64 → TOS key（供 i2v 素材；biz_type=image 落图像桶）
    scoped.connection.fetch.register({
      path: `${apiBase}/upload`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const { name, data: b64, biz_type } = await readJson(request)
        try {
          if (!name || !b64) return Response.json({ ok: false, error: '缺少 name/data' }, { status: 400 })
          const fs2 = await import('node:fs/promises')
          const os2 = await import('node:os')
          const tmp = path.join(os2.tmpdir(), `drama-upload-${Date.now()}-${name}`)
          await fs2.writeFile(tmp, Buffer.from(b64, 'base64'))
          const usable = (await loadAccounts()).filter((a) => !isTraeExpired(a))
          if (!usable.length) throw new Error('所有 Trae 账号已过期')
          const credential = usable[0]
          const up = await uploadLocalFile(credential, tmp, { biz_type: biz_type ?? 'image' })
          await fs2.unlink(tmp).catch(() => {})
          return Response.json({ ok: true, uri: up.uri, uid: credential.uid })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 新建短剧项目：只建空骨架（13 内容目录 + .aidrama 元数据），不写剧本内容
    scoped.connection.fetch.register({
      path: `${apiBase}/create-project`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          // 未指定 root 时用自动发现的第一个根；都没有则用默认路径（会自建 AI短剧 目录）
          let root = input.dramaRoot
          if (!root) {
            const roots = await discoverDramaRoots()
            root = roots[0] || await defaultDramaRoot()
          }
          const result = await createProject({
            dramaRoot: root,
            title: input.title,
            contract: input.contract,
          })
          return Response.json({ ok: true, ...result, root })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 剧名校验（前端输入时即时校验，不写盘）
    scoped.connection.fetch.register({
      path: `${apiBase}/validate-title`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const { title } = await readJson(request)
          const normalized = validateProjectTitle(title)
          return Response.json({ ok: true, title: normalized })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 创作资产总览：一次返回契约/大纲/人物/世界观/记忆/风格 + 进度
    scoped.connection.fetch.register({
      path: `${apiBase}/creation`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          if (!input.project) return Response.json({ ok: false, error: '缺少 project' }, { status: 400 })
          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)
          const bundle = await loadCreationBundle(projectDir)
          // 关联图：六个阶段产出的交叉引用（纯读计算，不改资产）
          const links = buildLinkGraph(bundle)
          return Response.json({ ok: true, ...bundle, links, projectDir, kinds: Object.entries(ASSET_KINDS).map(([k, v]) => ({ kind: k, label: v.label, type: v.type })) })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 保存单个创作资产（原子写 + 备份）
    scoped.connection.fetch.register({
      path: `${apiBase}/save-asset`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          if (!input.project) return Response.json({ ok: false, error: '缺少 project' }, { status: 400 })
          if (!input.kind) return Response.json({ ok: false, error: '缺少 kind' }, { status: 400 })
          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)
          // 修复场景用合并写：模型通常只返回被改动的条目，直接覆盖会抹掉其余数据
          const result = input.mode === 'merge'
            ? await mergeAsset(projectDir, input.kind, input.data)
            : await saveAsset(projectDir, input.kind, input.data)
          return Response.json({ ok: true, ...result })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 读取/保存剧本正文
    scoped.connection.fetch.register({
      path: `${apiBase}/script`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          if (!input.project) return Response.json({ ok: false, error: '缺少 project' }, { status: 400 })
          if (!input.episode) return Response.json({ ok: false, error: '缺少 episode' }, { status: 400 })
          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)
          if (input.action === 'save') {
            const r = await saveScript(projectDir, input.episode, input.content)
            return Response.json({ ok: true, ...r, consistency: r.consistency })
          }
          const content = await readScript(projectDir, input.episode)
          return Response.json({ ok: true, episode: input.episode, content: content ?? '' })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 读取分镜 Markdown 表格
    scoped.connection.fetch.register({
      path: `${apiBase}/storyboard-md`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          if (!input.project || !input.episode) return Response.json({ ok: false, error: '缺少 project / episode' }, { status: 400 })
          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)
          const content = await readStoryboardMd(projectDir, input.episode)
          return Response.json({ ok: true, episode: input.episode, content: content ?? '' })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // AI 创作：从想法一路生成到风格 DNA（六阶段链式，逐阶段回调进度）
    scoped.connection.fetch.register({
      path: `${apiBase}/ai-create`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          if (!input.project) return Response.json({ ok: false, error: '缺少 project' }, { status: 400 })
          // 只有「立项契约」必须给想法；只跑后续单阶段时 idea 可空
          const onlyStages = Array.isArray(input.only) && input.only.length ? input.only : null
          const needIdea = onlyStages ? onlyStages.includes('contract') : true
          if (needIdea && (!input.idea || !String(input.idea).trim())) {
            return Response.json({ ok: false, error: '生成立项契约需要先填写想法（idea）' }, { status: 400 })
          }

          const llm = getLlm()
          if (!llm) return Response.json({ ok: false, error: '宿主未提供 llm 服务，无法 AI 生成' }, { status: 400 })

          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)

          // 已有资产作为可选基线（重跑某阶段时可喂进去）
          const bundle = await loadCreationBundle(projectDir)
          const baseline = {}
          for (const k of STAGE_ORDER) {
            const v = bundle[k]
            if (v && (Array.isArray(v) ? v.length : true)) baseline[k] = v
          }

          const modelId = await resolveModel(llm, input.model)
          const only = Array.isArray(input.only) && input.only.length ? input.only : null
          const job = await jobs.createJob({ project: input.project, episode: input.episode })
          job.status = 'running'
          await jobs.update(job.id, { status: 'running' })

          // 异步执行，前端轮询 /status
          generateAll({
            llm,
            idea: String(input.idea).trim(),
            only,
            // provider 缺省走 our-free-model（免费通道）；model 必须解析成具体 id
            provider: input.provider || FREE_MODEL_ROUTE,
            model: modelId,
            onStage: (evt) => {
              job.progress.current = evt
              if (evt.type === 'stage-done') job.progress.done += 1
              if (evt.type === 'stage-error') job.errors.push(evt)
              jobs.update(job.id, { progress: { ...job.progress }, errors: job.errors }).catch(() => {})
            },
          }).then(async (result) => {
            // 生成结果**不自动落盘**：只返回预览，等前端确认后再 save-asset
            job.status = 'done'
            job.finishedAt = Date.now()
            job.result = result
            await jobs.update(job.id, { status: 'done', finishedAt: job.finishedAt, result }).catch(() => {})
          }).catch((e) => {
            job.status = 'failed'
            job.finishedAt = Date.now()
            job.error = e.message
            jobs.update(job.id, { status: 'failed', finishedAt: job.finishedAt, error: e.message }).catch(() => {})
          })

          job.progress.total = (only || STAGE_ORDER).length
          return Response.json({ ok: true, taskId: job.id, stages: STAGES, order: STAGE_ORDER })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 带缺口重跑：把关联图检测到的缺口作为约束喂给模型，逐条修正
    scoped.connection.fetch.register({
      path: `${apiBase}/ai-repair`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          const llm = getLlm()
          if (!llm) return Response.json({ ok: false, error: '宿主未提供 llm 服务' }, { status: 400 })
          if (!input.stage || !STAGES[input.stage]) {
            return Response.json({ ok: false, error: `未知阶段：${input.stage}` }, { status: 400 })
          }
          if (!Array.isArray(input.hints) || !input.hints.length) {
            return Response.json({ ok: false, error: '缺少缺口清单（hints）' }, { status: 400 })
          }
          const context = input.context || {}
          const r = await regenerateWithHints({
            llm,
            stage: input.stage,
            context,
            hints: input.hints.map(String).slice(0, 20),
            provider: input.provider || FREE_MODEL_ROUTE,
            model: await resolveModel(llm, input.model),
          })
          return Response.json({ ok: true, ...r })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 按集生成并落盘：剧本 → 分集剧本/NNN集.md；分镜 → .aidrama/storyboard/NNN集.md.json
    scoped.connection.fetch.register({
      path: `${apiBase}/ai-episode`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          if (!input.project) return Response.json({ ok: false, error: '缺少 project' }, { status: 400 })
          const stage = String(input.stage || '')
          if (!EPISODE_STAGES.includes(stage)) {
            return Response.json({ ok: false, error: `该接口只处理按集阶段（${EPISODE_STAGES.join(' / ')}）` }, { status: 400 })
          }
          const ep = Number(input.episode)
          if (!Number.isFinite(ep) || ep < 1) {
            return Response.json({ ok: false, error: '缺少有效集号（episode）' }, { status: 400 })
          }
          const llm = getLlm()
          if (!llm) return Response.json({ ok: false, error: '宿主未提供 llm 服务' }, { status: 400 })

          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)
          const bundle = await loadCreationBundle(projectDir)
          const context = {
            ...(bundle.contract ? { contract: bundle.contract } : {}),
            ...(bundle.outline?.length ? { outline: bundle.outline } : {}),
            ...(bundle.characters?.length ? { characters: bundle.characters } : {}),
            ...(bundle.world?.length ? { world: bundle.world } : {}),
            ...(bundle.memory?.length ? { memory: bundle.memory } : {}),
          }

          // 分镜必须先有该集剧本，并把正文注入上下文（否则模型只能凭空编分镜）
          if (stage === 'storyboard') {
            const fileName = `第${String(ep).padStart(3, '0')}集.md`
            const existing = await readScript(projectDir, fileName)
            if (!existing || !existing.trim()) {
              return Response.json({
                ok: false,
                error: `第 ${ep} 集还没有剧本，请先生成剧本再拆分镜`,
                code: 'NEED_SCRIPT',
              }, { status: 409 })
            }
            context.script = existing
          }

          const r = await generateStage({
            llm, stage, context, episode: ep,
            provider: input.provider || FREE_MODEL_ROUTE,
            model: await resolveModel(llm, input.model),
          })

          // 落盘
          const pad = String(ep).padStart(3, '0')
          let saved
          if (stage === 'script') {
            saved = await saveScript(projectDir, `第${pad}集.md`, r.data.text)
          } else {
            const sbDir = path.join(projectDir, '.aidrama', 'storyboard')
            await fs.mkdir(sbDir, { recursive: true })
            const target = path.join(sbDir, `第${pad}集.md.json`)
            const tmp = `${target}.tmp-${Date.now()}`
            await fs.writeFile(tmp, JSON.stringify(r.data, null, 2) + '\n', 'utf8')
            await fs.rename(tmp, target)
            saved = { episode: `第${pad}集.md.json`, bytes: Buffer.byteLength(JSON.stringify(r.data)) }
          }

          return Response.json({ ok: true, stage, episode: ep, saved, data: r.data, elapsedMs: r.elapsedMs, contextSaved: r.contextSaved })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })
    // 分镜 prompt 预览：逐镜展示「出片时真正会发给模型的 prompt」
    scoped.connection.fetch.register({
      path: `${apiBase}/shot-prompts`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          if (!input.project || !input.episode) {
            return Response.json({ ok: false, error: '缺少 project / episode' }, { status: 400 })
          }
          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)
          // collectShots 要「不带扩展名」的集名：第001集.md.json → 第001集.md
          const epName = String(input.episode).replace(/\.md\.json$/, '.md').replace(/\.json$/, '.md')
          const shots = await collectShots(path.join(projectDir, '.aidrama', 'storyboard'), { episode: epName })
          const bundle = await loadCreationBundle(projectDir)
          const charCards = (bundle.characters || []).filter(c => String(c?.name ?? '').trim())
          const styleDna = bundle.style?.style ?? null
          const ratio = String(input.ratio || '9:16')
          const castings = await listCastings(projectDir)

          const charIndex = indexCharacters(charCards)
          // 场景索引与出片端同一来源：.aidrama/assets/cards.json
          const sceneCardsRaw = await loadSceneCards(projectDir)
          const sceneIndex = new Map()
          for (const c of (sceneCardsRaw || [])) {
            const id = String(c?.id ?? c?.sceneId ?? '').trim()
            if (id) sceneIndex.set(id, c)
          }

          const out = []
          for (const s of shots) {
            const shot = s.shot
            const { cards } = resolveShotCharacters(shot, charIndex, { scanText: true })
            const anchor = renderAnchor(cards)
            const sceneRef = String(shot.sceneRef ?? shot.sceneId ?? '').trim()
            const sceneCard = sceneRef ? sceneIndex.get(sceneRef) : null

            // 与出片端完全同一套构建逻辑，预览＝实际
            const prompt = buildShotVideoPrompt(shot, {
              ratio,
              characterAnchor: anchor ? anchor.replace(/^[\[］]?角色锚点[\]］]?\s*/, '') : '',
              characterNames: cards,
              allCharCards: charCards,
              sceneCard,
              styleDna,
            })

            // 出片会用的首帧参考
            const castingKey = pickCastingKey(shot, castings, charCards.map(c => c.name))
            out.push({
              shotNumber: String(shot.shotNumber ?? ''),
              durationSec: Number(shot.durationSec) || null,
              prompt,
              length: prompt.length,
              characters: cards.map(c => String(c.name ?? '')),
              sceneRef: sceneRef || null,
              imageRef: castingKey ? 'casting' : null,
              raw: {
                description: shot.description ?? '',
                videoPrompt: shot.videoPrompt ?? '',
                imagePrompt: shot.imagePrompt ?? '',
                shotSize: shot.shotSize ?? '',
                cameraMove: shot.cameraMove ?? '',
                dialogue: shot.dialogue ?? '',
                sfx: shot.sfx ?? '',
              },
            })
          }
          return Response.json({ ok: true, episode: input.episode, shots: out })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })

    // 配额预估：出片前看「还有几个账号能用、够不够跑 N 镜」
    scoped.connection.fetch.register({
      path: `${apiBase}/quota-estimate`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          const projectDir = input.project
            ? await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)
            : null
          const accts = (await loadAccounts()).filter((a) => !isTraeExpired(a))
          const ledger = projectDir ? await readLedger(projectDir).catch(() => ({ accounts: {} })) : { accounts: {} }
          const est = estimateQuota(accts, ledger, Number(input.shotsNeeded || 0))
          return Response.json({
            ok: true,
            ...est,
            ledgerPath: projectDir ? LEDGER_FILE : null,
            // 账本时间戳便于判断信息是否新鲜
            lastAt: est.detail
              .map((d) => d.at).filter(Boolean).sort().pop() ?? null,
          })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })

    // 账号预热：探测全部账号的额度状态并写账本（480p/2s 最省探针）
    scoped.connection.fetch.register({
      path: `${apiBase}/warmup`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)
          const accts = (await loadAccounts()).filter((a) => !isTraeExpired(a))
          const ledger = await readLedger(projectDir).catch(() => ({ accounts: {} }))
          const plan = shouldWarmup(accts, ledger, Number(input.shotsNeeded || 0))
          // concurrency 默认 4：TRAE 各账号独立，多账号并发不互相限流
          const result = await warmupAccounts({
            accounts: accts,
            projectDir,
            // 探针只读到 heartbeat 就断：不产视频、不耗积分，单账号约 3 秒
            probeDeps: {
              host: TRAE.agentHost,
              path: PATHS.textToVideoStream,
              model: VIDEO_MODEL,
              headers: soloHeaders,
              fetchImpl: fetch,
              waitMs: 12000,
            },
            skipUids: [],
            concurrency: Math.min(8, Math.max(1, Number(input.concurrency || 4))),
          })
          return Response.json({
            ok: true,
            plan,
            summary: {
              ok: result.ok.length,
              quota: result.quota.length,
              broken: result.broken.length,
              unknown: result.unknown.length,
              elapsedMs: result.elapsedMs,
            },
            usableUids: result.ok,
            detail: result.entries.map((e) => ({ uid: e.uid, status: e.status, ms: e.ms, note: e.note })),
          })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })

    // 角色定妆：读现有定妆 / 生成定妆（文生图）
    scoped.connection.fetch.register({
      path: `${apiBase}/casting`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          if (!input.project) return Response.json({ ok: false, error: '缺少 project' }, { status: 400 })
          const projectDir = await locateProjectDir(input.dramaRoot || await defaultDramaRoot(), input.project)

          // action=list：只读已有定妆
          if ((input.action || 'list') === 'list') {
            const castings = await listCastings(projectDir)
            const bundle = await loadCreationBundle(projectDir)

            // 给每张定妆图生成可访问的签名 URL，前端才能显示。
            // TOS key 绑定产出账号，所以要用记录里的 uid 去解析；解析失败不影响列表。
            const withUrls = await Promise.all(castings.map(async (c) => {
              if (!c?.uri) return { ...c, url: null }
              try {
                const accts = (await loadAccounts()).filter((a) => !isTraeExpired(a))
                const cred = (c.uid ? accts.find((a) => String(a.uid) === String(c.uid)) : null) || accts[0]
                if (!cred) return { ...c, url: null }
                const map = await resolveResourceUrls(cred, [c.uri])
                return { ...c, url: map[c.uri] || null }
              } catch (e) {
                return { ...c, url: null, urlError: e.message }
              }
            }))
            const urlByKey = new Map(withUrls.filter(x => x.url).map(x => [String(x.name), x.url]))
            // 可用性检查：出片时这张图能不能真的用（key 格式 / 账号是否在用）
            const acctsForCheck = (await loadAccounts()).filter((a) => !isTraeExpired(a))
            const usableByKey = new Map(
              withUrls.map((c) => [String(c.name), checkCastingUsable(c, acctsForCheck)]))
            return Response.json({
              ok: true,
              castings: withUrls,
              characters: (bundle.characters || []).map(c => {
                const hit = castings.find(x => x.name === c.name)
                return {
                  name: c.name, role: c.role, appearancePrompt: c.appearancePrompt,
                  casted: Boolean(hit?.uri),
                  // 形象描述改过 → 旧定妆图已过期，需要重出
                  stale: Boolean(hit) && isCastingStale(hit, c),
                  nonHuman: isNonHuman(c),
                  // 定妆图的可访问地址（前端直接当 <img src> 用）
                  imageUrl: urlByKey.get(String(c.name)) || null,
                  // 能否用于出片（key 格式 + 产出账号是否在用）
                  usable: usableByKey.get(String(c.name)) || null,
                }
              }),
            })
          }

          // action=cast：给指定角色（或全部缺定妆的角色）出图
          if (input.action === 'cast') {
            // 与 upload 路由同一套取号逻辑：筛选未过期账号
            const usableAccts = (await loadAccounts()).filter((a) => !isTraeExpired(a))
            const forced = String(input.uid ?? '').trim()
            const cred = forced
              ? usableAccts.find((a) => String(a.uid) === forced)
              : usableAccts[0]
            if (!cred) {
              return Response.json({
                ok: false,
                error: usableAccts.length
                  ? `指定账号 ${forced} 不可用`
                  : '没有可用的 TRAE 账号（全部过期或未登录）',
              }, { status: 400 })
            }
            const bundle = await loadCreationBundle(projectDir)
            let targets = bundle.characters || []
            if (Array.isArray(input.names) && input.names.length) {
              const want = new Set(input.names.map(String))
              targets = targets.filter(c => want.has(String(c.name)))
            } else if (input.onlyMissing) {
              const existing = new Set((await listCastings(projectDir)).map(x => x.name))
              targets = targets.filter(c => !existing.has(String(c.name)))
            }
            if (!targets.length) return Response.json({ ok: false, error: '没有需要定妆的角色' }, { status: 400 })

            // 把整个可用账号列表交给定妆逻辑：配额耗尽的账号自动跳过
            const r = await castAll({
              credential: cred, credentials: usableAccts, characters: targets, projectDir,
              uid: cred?.uid ?? null, force: Boolean(input.force),
            })
            return Response.json({ ok: r.ok, ...r, casted: r.done.length })
          }

          return Response.json({ ok: false, error: `未知 action：${input.action}` }, { status: 400 })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
      },
    })

    // AI 状态：探测宿主 llm 路由与模型（前端用于显示可用性与选择）
    scoped.connection.fetch.register({
      path: `${apiBase}/llm-status`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch() {
        const llm = getLlm()
        if (!llm) {
          return Response.json({
            ok: true, available: false, reason: '宿主未提供 llm 服务',
            providers: [], models: [], freeModelRoute: FREE_MODEL_ROUTE, fallbackModel: FREE_MODEL_FALLBACK_MODEL,
          })
        }
        const probe = await probeLlmRoutes(llm).catch(() => ({ providers: [], models: [], hasFreeModel: false }))
        return Response.json({
          ok: true, available: true, ...probe,
          freeModelRoute: FREE_MODEL_ROUTE,
          fallbackModel: probe.models?.find((m) => m.id)?.id || FREE_MODEL_FALLBACK_MODEL,
          stageDeps: STAGE_DEPS,
        })
      },
    })
    // AI 创作：只跑单个阶段（用于单阶段重跑/微调）
    scoped.connection.fetch.register({
      path: `${apiBase}/ai-create-stage`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const input = await readJson(request)
        try {
          const llm = getLlm()
          if (!llm) return Response.json({ ok: false, error: '宿主未提供 llm 服务' }, { status: 400 })
          if (!input.stage || !STAGES[input.stage]) {
            return Response.json({ ok: false, error: `未知阶段：${input.stage}` }, { status: 400 })
          }
          const context = input.context || {}
          // 前置校验：不让用户跳过顺序生成（否则产出与后续接不上）
          const prereq = checkPrerequisites(input.stage, context)
          if (!prereq.ok && !input.force) {
            return Response.json({
              ok: false,
              error: `「${STAGES[input.stage].label}」还缺前序资产：${prereq.missingLabels.join('、')}`,
              code: 'PREREQ_MISSING',
              missing: prereq.missing,
              missingLabels: prereq.missingLabels,
            }, { status: 409 })
          }
          const r = await generateStage({
            llm,
            stage: input.stage,
            idea: input.idea,
            context,
            episode: input.episode,
            provider: input.provider || FREE_MODEL_ROUTE,
            model: await resolveModel(llm, input.model),
            allowMissingPrereq: Boolean(input.force),
          })
          return Response.json({ ok: true, ...r, consistency: r.consistency })
        } catch (e) {
          return Response.json({ ok: false, error: e.message }, { status: 400 })
        }
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
          const vids = files.filter((f) => f.endsWith('.mp4') || f.endsWith('.mov'))
          const videos = []
          for (const f of vids) {
            const full = path.join(genDir, f)
            const st = await fs.stat(full).catch(() => null)
            videos.push({
              name: f,
              path: full,
              size: st?.size ?? 0,
              mtime: st?.mtimeMs ?? 0,
            })
          }
          // 默认按 mtime 倒序（最新的在前），前端可再排序
          videos.sort((a, b) => b.mtime - a.mtime)
          const totalBytes = videos.reduce((n, v) => n + v.size, 0)
          return Response.json({ ok: true, artifacts: videos, dir: genDir, totalBytes })
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