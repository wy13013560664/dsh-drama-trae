/**
 * dsh-drama-trae —— 客户端半（Web Client half）
 *
 * 界面与流程基准：dsh-plugin-ai-drama（唯一基准）。
 * 本文件只负责「出片」这件事的界面，视觉/结构/交互契约与 ai-drama 完全一致：
 *   - 主题：17 个 --ad-* 变量（复用宿主 dsw-alias token，浅/深自动翻转）
 *   - 结构：ad-shell > ad-head > ad-body；页签分组条 ad-tab-groups
 *   - 交互：页签 data-on/aria-selected/roving tabindex；脏标记；骨架；错误框；空态
 *
 * 功能（不可变更清单，见 ALIGNMENT.md 第三节）：
 *   并发出片 / 失败重试 / 账号池 / 产物预览+打开 / 生成历史统计 / 媒体流
 *
 * 数据源：宿主半 REST 路由 /api/drama-trae/*。React 由浏览器模块表提供。
 */
window.__ModuleLoader__.load({
  id: 'dsh-drama-trae',
  factory(require) {
    const { createElement: h, Fragment, useState, useEffect, useRef } = require('react')

    const PANEL_ID = 'drama-trae'

    /**
     * 面板选择项的持久化（localStorage）。
     *
     * 项目/集数/根目录原本是组件内 useState，切到「会话」再回来（组件卸载重挂）
     * 就全部清零，每次都得重选。存到 localStorage 后跨会话、跨刷新都能恢复。
     * 读取全部包 try/catch：隐私模式或存储被禁用时退化为不持久化，不影响功能。
     */
    /** 任务终态：三个都要停轮询（partial 曾被漏掉，导致按钮永久禁用）。 */
    const TERMINAL_JOB_STATUS = new Set(['done', 'failed', 'partial', 'cancelled'])

    /**
     * 把「任务当前在干什么」翻成一句人话。
     *
     * 出片慢的原因九成是这三类，但旧界面只显示 X/Y 镜，用户看不出是卡住还是在换号：
     *   · 换号（quota-dead）—— 某个账号额度空了，换下一个
     *   · 退避重试（retry + waitMs）—— 平台限流，正在等
     *   · 降并发（throttle）—— 并发被打满，自动收紧
     */
    function describeJobEvent(cur) {
      if (!cur || typeof cur !== 'object') return ''
      switch (cur.type) {
        case 'start': return `镜 ${cur.shot ?? ''} 出片中${cur.attempt ? `（第 ${cur.attempt + 1} 次）` : ''}`
        case 'quota-dead': return `镜 ${cur.shot ?? ''} 账号额度空，换号（余 ${cur.remaining ?? '?'}）`
        case 'retry': return cur.waitMs
          ? `镜 ${cur.shot ?? ''} ${cur.kind || '限流'}，退避 ${Math.round(cur.waitMs / 1000)}s 后重试`
          : `镜 ${cur.shot ?? ''} 换号重试（${cur.kind || ''}）`
        case 'throttle': return `并发自动降到 ${cur.limit}（${cur.kind || '限流'}）`
        case 'account-rank': return `账号排序：可用 ${cur.ok ?? 0} / 未跑 ${cur.unknown ?? 0} / 复用 ${cur.expired ?? 0} / 待验 ${cur.pending ?? 0}`
        case 'circuit-open': return '服务端持续秒拒，已停止本轮（见日志原因）'
        case 'casting-drop': return `镜 ${cur.shot ?? ''} 定妆图不可用，降级纯文生视频`
        case 'chain': return `镜 ${cur.shot ?? ''} 承接镜 ${cur.fromShot ?? ''} 末帧`
        case 'gate-fail': return `门禁未过：${cur.code || ''}`
        case 'compliance-block': return `合规阻断：${cur.word || ''}`
        case 'warn': return cur.message || ''
        case 'skip': return `镜 ${cur.shot ?? ''} 已有产物，跳过`
        case 'summary': return `完成 ${cur.generated ?? 0}/${cur.total ?? 0} 镜`
        default: return ''
      }
    }

    const STORE_KEY = `dsh-drama-trae:selection:v1`
    function loadSelection() {
      try {
        const raw = globalThis.localStorage?.getItem(STORE_KEY)
        if (!raw) return {}
        const o = JSON.parse(raw)
        return (o && typeof o === 'object') ? o : {}
      } catch { return {} }
    }
    function saveSelection(patch) {
      try {
        const cur = loadSelection()
        const next = { ...cur, ...patch }
        globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(next))
      } catch { /* 隐私模式/配额满：静默降级为不持久化 */ }
    }
    const API_BASE = '/api/drama-trae/'

    async function api(method, payload) {
      const response = await fetch(API_BASE + method, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      let data
      try { data = await response.json() } catch { throw new Error('短剧出片服务尚未就绪，请刷新后重试') }
      if (!response.ok || data.ok === false) throw new Error(data.error || '短剧出片操作失败')
      return data
    }

    /* ---------------------------------------------------------------- 样式（对齐 ai-drama） */
    const CSS = `
body{
--ad-bg-base:var(--dsw-alias-bg-base);
--ad-label-primary:var(--dsw-alias-label-primary);
--ad-label-secondary:var(--dsw-alias-label-secondary);
--ad-brand:var(--dsw-alias-brand-primary);
--ad-on-brand:var(--dsw-alias-bg-base);
--ad-primary-hover-bg:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,var(--dsw-alias-bg-base));
--ad-error:color-mix(in srgb,var(--dsw-alias-state-error-primary) 75%,var(--dsw-alias-label-primary));
--ad-warn:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-label-primary));
--ad-success:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,var(--dsw-alias-label-primary));
--ad-error-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);
--ad-warning-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);
--ad-error-border:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);
--ad-warning-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);
--ad-subtle-bg:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);
--ad-hover-bg:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);
--ad-border:var(--dsw-alias-border-l2);
--ad-divider:var(--dsw-alias-border-l1);
}
.ad-shell{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--ad-label-primary);background:var(--ad-bg-base)}
.ad-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.ad-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--ad-divider);flex:none;background:var(--ad-bg-base)}
.ad-title{font-size:16px;font-weight:600}
.ad-sub{font-size:12px;color:var(--ad-label-secondary)}
.ad-hint-box{background:var(--ad-subtle-bg);border:1px solid var(--ad-divider);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.7;color:var(--ad-label-secondary);word-break:break-all}
.ad-body{flex:1;min-height:0;overflow:auto;padding:16px 18px}
.ad-btn{border:1px solid var(--ad-border);background:transparent;color:inherit;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;white-space:nowrap}
.ad-btn:not(.ad-primary):hover{background:var(--ad-hover-bg)}
.ad-btn[disabled]{opacity:.5;cursor:default}
.ad-primary{border-color:transparent;background:var(--ad-brand);color:var(--ad-on-brand)}
.ad-primary:hover{background:var(--ad-primary-hover-bg)}
.ad-sm{padding:4px 10px;font-size:12px}
.ad-cta{padding:7px 18px;font-weight:600}
.ad-btn-danger{border-color:var(--ad-error-border);color:var(--ad-error)}
.ad-btn-danger:hover{background:var(--ad-error-bg)}
.ad-card{border:1px solid var(--ad-border);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:12px;background:var(--ad-subtle-bg);box-shadow:0 1px 2px var(--ad-border)}
.ad-card-main{flex:1;min-width:0}
.ad-card-title{font-size:14px;font-weight:600;margin-bottom:2px}
.ad-card-meta{font-size:12px;color:var(--ad-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ad-empty{color:var(--ad-label-secondary);font-size:13px;line-height:1.9}
.ad-err{color:var(--ad-error);font-size:13px;line-height:1.8}
.ad-warn{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.8;background:var(--ad-warning-bg);color:var(--ad-warn);border:1px solid var(--ad-warning-border)}
.ad-row{display:flex;align-items:center;gap:8px}
.ad-input,.ad-select,.ad-area{padding:6px 10px;font-size:13px;border-radius:8px;border:1px solid var(--ad-border);background:var(--ad-bg-base);color:inherit;font-family:inherit;box-sizing:border-box}
.ad-script-editor{width:100%;tab-size:2;white-space:pre-wrap}
.ad-script-editor:focus{outline:2px solid var(--ad-brand);outline-offset:1px}
.ad-input{flex:1;min-width:0}
.ad-select{max-width:220px}
.ad-input:focus,.ad-select:focus,.ad-area:focus{outline:2px solid var(--ad-brand);outline-offset:1px;border-color:var(--ad-brand)}
.ad-field{display:flex;gap:10px;align-items:flex-start;margin-bottom:8px}
.ad-field > label{width:110px;flex:none;font-size:13px;padding-top:7px;color:var(--ad-label-secondary)}
.ad-tabs{display:flex;align-items:flex-start;gap:8px;border-bottom:1px solid var(--ad-divider);margin:2px 0 12px;flex:none}
.ad-tab{border:0;background:transparent;color:inherit;padding:8px 12px;border-radius:8px 8px 0 0;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;opacity:.72;transition:background 160ms ease,opacity 160ms ease}
.ad-tab:hover{background:var(--ad-hover-bg);opacity:1}
.ad-tab[data-on="1"]{opacity:1;font-weight:600;color:var(--ad-label-primary);border-bottom-color:var(--ad-brand)}
.ad-tab-dirty{font-size:12px;margin-left:4px;color:var(--ad-warn)}
.ad-tab-groups{display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;flex:1;min-width:0}
.ad-tab-group{display:flex;align-items:center;gap:4px;padding-right:12px;border-right:1px solid var(--ad-divider)}
.ad-tab-group:last-child{border-right:0;padding-right:0}
.ad-tab-group-label{font-size:12px;color:var(--ad-label-secondary);padding-right:4px;white-space:nowrap}
.ad-tabs-more{display:none;position:relative;flex:none}
.ad-tabs-more-panel{position:absolute;z-index:50;top:calc(100% + 4px);right:0;min-width:240px;max-width:min(560px,90vw);padding:8px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-bg-base);box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-wrap:wrap;gap:6px}
.ad-tabpanel{min-width:0}
.ad-sec{font-size:14px;font-weight:600;margin:14px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--ad-divider)}
.ad-sec:first-child{margin-top:0}
.ad-count{font-size:12px;color:var(--ad-label-secondary)}
.ad-dirty{font-size:12px;color:var(--ad-warn)}
.ad-ok{font-size:12px;color:var(--ad-success)}
.ad-check{width:14px;height:14px;cursor:pointer;accent-color:var(--ad-brand);flex:none}
.ad-box{border:1px solid var(--ad-border);border-radius:10px;padding:12px}
.ad-empty-state{padding:14px 16px;border:1px dashed var(--ad-border);border-radius:10px;line-height:1.9;font-size:13px;color:var(--ad-label-secondary)}
.ad-empty-title{font-size:13px;font-weight:600;color:var(--ad-label-primary);margin-bottom:4px}
.ad-hint-next{font-size:12px;line-height:1.8;color:var(--ad-label-secondary);margin-top:4px}
.ad-err-box{margin:0 0 12px;padding:10px 12px;border-radius:10px;border:1px solid var(--ad-error-border);background:var(--ad-error-bg);display:flex;flex-direction:column;gap:4px}
.ad-err-head{font-size:12px;font-weight:600;color:var(--ad-error)}
.ad-err-next{font-size:12px;line-height:1.8;color:var(--ad-warn)}
.ad-err-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.ad-skeleton{display:flex;flex-direction:column;gap:10px;padding:6px 2px}
.ad-skeleton-line{height:14px;border-radius:6px;background:var(--ad-subtle-bg);animation:ad-skeleton-pulse 1.2s ease-in-out infinite}
.ad-skeleton-line.w40{width:40%}.ad-skeleton-line.w60{width:60%}.ad-skeleton-line.w80{width:80%}.ad-skeleton-line.w90{width:90%}
@keyframes ad-skeleton-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.ad-content{width:100%;max-width:1200px;margin:0 auto}
/* ---------- 布局栅格（8px 基准）---------- */
.ad-grid{display:grid;gap:8px}
.ad-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.ad-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.ad-grid-4{grid-template-columns:repeat(4,minmax(0,1fr))}
@media (max-width:900px){.ad-grid-3,.ad-grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.ad-grid-2,.ad-grid-3,.ad-grid-4{grid-template-columns:minmax(0,1fr)}}
.ad-stack{display:flex;flex-direction:column;gap:8px}
.ad-stack-16{display:flex;flex-direction:column;gap:16px}

/* ---------- 上下文栏 / 面包屑 ---------- */
.ad-contextbar{display:flex;align-items:center;gap:8px;padding:6px 18px;border-bottom:1px solid var(--ad-divider);background:var(--ad-subtle-bg);font-size:12px;color:var(--ad-label-secondary);flex-wrap:wrap;flex:none}
.ad-crumb{display:inline-flex;align-items:center;gap:6px}
.ad-crumb-sep{opacity:.45}
.ad-crumb-link{border:0;background:transparent;color:var(--ad-brand);cursor:pointer;padding:0 2px;border-radius:4px;font-size:12px}
.ad-crumb-link:hover{background:var(--ad-hover-bg)}
.ad-crumb-chip{padding:1px 8px;border-radius:999px;background:var(--ad-bg-base);border:1px solid var(--ad-border);color:var(--ad-label-primary);font-size:11px}

/* ---------- 禁用 / 激活 / 悬停 状态 ---------- */
.ad-btn[disabled],.ad-btn:disabled{opacity:.45;cursor:not-allowed;pointer-events:none}
.ad-btn:active{transform:translateY(1px)}
.ad-btn.ad-primary:active{background:var(--ad-primary-hover-bg)}
.ad-input[disabled],.ad-select[disabled],.ad-area[disabled]{opacity:.5;cursor:not-allowed;background:var(--ad-subtle-bg)}
.ad-input[aria-invalid="true"]{border-color:var(--ad-error-border);background:var(--ad-error-bg)}
.ad-input::placeholder,.ad-area::placeholder{color:var(--ad-label-secondary);opacity:.7}
.ad-tab[disabled]{opacity:.4;cursor:not-allowed}

/* ---------- 长文本与截断 ---------- */
.ad-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ad-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ad-break{word-break:break-all;overflow-wrap:anywhere}
.ad-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}

/* ---------- 状态反馈：成功 / 警告 / 信息 ---------- */
.ad-ok-box{padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--ad-success) 35%,transparent);background:color-mix(in srgb,var(--ad-success) 8%,transparent);font-size:13px;line-height:1.7}
.ad-warn-box{padding:10px 12px;border-radius:10px;border:1px solid var(--ad-warning-border);background:var(--ad-warning-bg);font-size:13px;line-height:1.7}
.ad-info-box{padding:10px 12px;border-radius:10px;border:1px solid var(--ad-divider);background:var(--ad-subtle-bg);font-size:12px;line-height:1.7;color:var(--ad-label-secondary)}
.ad-toast{margin:0 0 12px;padding:8px 12px;border-radius:8px;font-size:13px;display:flex;align-items:center;gap:8px}
.ad-toast-ok{background:color-mix(in srgb,var(--ad-success) 10%,transparent);border:1px solid color-mix(in srgb,var(--ad-success) 35%,transparent);color:var(--ad-success)}
.ad-toast-err{background:var(--ad-error-bg);border:1px solid var(--ad-error-border);color:var(--ad-err)}

/* ---------- 搜索与筛选 ---------- */
.ad-filterbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.ad-search{flex:1;min-width:140px;max-width:320px}
.ad-chip-group{display:inline-flex;gap:4px}
.ad-chip{border:1px solid var(--ad-border);background:transparent;color:inherit;border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer}
.ad-chip:hover{background:var(--ad-hover-bg)}
.ad-chip[data-on="1"]{border-color:var(--ad-brand);color:var(--ad-brand);background:color-mix(in srgb,var(--ad-brand) 10%,transparent)}

/* ---------- 数据展示 ---------- */
.ad-stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-subtle-bg)}
.ad-stat-value{font-size:20px;font-weight:600;line-height:1.2}
.ad-stat-label{font-size:11px;color:var(--ad-label-secondary)}
.ad-table{width:100%;border-collapse:collapse;font-size:12px}
.ad-table th{text-align:left;font-weight:600;color:var(--ad-label-secondary);padding:6px 8px;border-bottom:1px solid var(--ad-divider);white-space:nowrap}
.ad-table td{padding:6px 8px;border-bottom:1px solid var(--ad-divider)}
.ad-table tr:last-child td{border-bottom:0}
.ad-table tbody tr:hover{background:var(--ad-hover-bg)}

/* ---------- 帮助与说明 ---------- */
.ad-help{font-size:12px;color:var(--ad-label-secondary);line-height:1.7;margin-top:4px}
.ad-label-req::after{content:" *";color:var(--ad-err)}
.ad-counter{font-size:11px;color:var(--ad-label-secondary);margin-left:auto}
.ad-counter[data-over="1"]{color:var(--ad-err)}

/* ---------- 危险 / 次要按钮 ---------- */
.ad-btn-ghost{border-color:transparent;background:transparent}
.ad-btn-ghost:hover{background:var(--ad-hover-bg)}
.ad-btn-icon{padding:4px 8px;font-size:13px;line-height:1}

.ad-list-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.ad-shell :focus-visible,.ad-btn:focus-visible,.ad-tab:focus-visible,.ad-input:focus-visible,.ad-select:focus-visible,.ad-area:focus-visible,.ad-check:focus-visible{outline:2px solid var(--ad-brand);outline-offset:2px}
.ad-tab:focus-visible{outline-offset:-2px}
/* drama-trae 特有：任务卡 / 产物行 / 进度条（命名仍走 ad-*、用 --ad-* 变量） */
.ad-shot-list{display:flex;flex-direction:column;gap:0;border:1px solid var(--ad-border);border-radius:10px;overflow:hidden;max-height:360px;overflow-y:auto}
.ad-shot-row{display:flex;align-items:center;padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--ad-divider);font-size:12px;background:var(--ad-bg-base)}
.ad-shot-row:last-child{border-bottom:0}
.ad-shot-row:hover{background:var(--ad-hover-bg)}
.ad-shot-no{font-weight:600;min-width:48px;white-space:nowrap}
.ad-shot-meta{min-width:74px;color:var(--ad-label-secondary);white-space:nowrap}
.ad-shot-desc{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ad-label-secondary)}
.ad-progress-box{margin-top:10px;padding:12px 14px;border-radius:10px;background:var(--ad-subtle-bg)}
.ad-progress-bar{height:6px;border-radius:3px;background:var(--ad-border);overflow:hidden}
.ad-progress-fill{height:100%;background:var(--ad-brand);border-radius:3px;transition:width 0.4s}
.ad-video-shell{margin-top:10px;border-radius:10px;overflow:hidden;border:1px solid var(--ad-border)}
.ad-video-shell video{width:100%;max-height:320px;display:block;background:#000}
.ad-stat-chip{font-size:12px;padding:4px 12px;border-radius:999px;background:var(--ad-subtle-bg);border:1px solid var(--ad-border)}
@media (max-width:900px){
.ad-tab-groups{display:none}
.ad-tabs-more{display:block}
.ad-content{max-width:none}
}
`

    /* ---------------------------------------------------------------- 图标 */
    function PanelIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 2, y: 4, width: 20, height: 16, rx: 2 }),
        h('path', { d: 'M2 8h20M7 4v4M17 4v4M7 12l3 2 3-2 4 3' }),
      )
    }

    /* ---------------------------------------------------------------- 出片页签 */
    function GenerateTab(props) {
      const {
        projects, project, setProject, episode, setEpisode, shots,
        checked, setChecked, ratio, setRatio, resolution, setResolution,
        duration, setDuration, dramaRoot, setDramaRoot, listError, shotsError, roots,
        lot, busy, startGenerate, onRefreshProjects, jobProgress,
        creating, setCreating, newTitle, setNewTitle, createError, createProject,
        quotaEst, quotaLoading, onLoadQuotaEstimate,
        warmupRun, warmupResult, onRunWarmup,
        forceGen, setForceGen,
      } = props

      // 分镜搜索与状态筛选
      const [q, setQ] = useState('')
      const [statusFilter, setStatusFilter] = useState('all')

      function toggleShot(key) {
        setChecked(prev => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key); else next.add(key)
          return next
        })
      }

      const allChecked = shots.length > 0 && shots.every(s => checked.has(String(s.shotNumber || s.shot)))

      // 过滤：搜索正则 + 状态筛选
      const qn = String(q || '').trim().toLowerCase()
      const visibleShots = shots.filter(s => {
        const key = String(s.shotNumber || s.shot)
        const st = lot.get(key)?.status || 'idle'
        if (statusFilter === 'done' && st !== 'done') return false
        if (statusFilter === 'todo' && st === 'done') return false
        if (statusFilter === 'failed' && st !== 'failed') return false
        if (!qn) return true
        const hay = [key, s.shotSize, s.cameraMove, s.description, s.videoPrompt, s.dialogue, s.sceneRef]
          .filter(Boolean).join(' ').toLowerCase()
        return hay.includes(qn)
      })

      const shotRows = visibleShots.map(s => {
        const key = String(s.shotNumber || s.shot)
        const sel = checked.has(key)
        const st = lot.get(key)
        const status = st?.status || 'idle'
        const badge = status === 'done' ? '✅' : status === 'running' ? '⏳' : status === 'failed' ? '❌' : ''
        return h('div', {
          key: `${s.episodeName || ''}-${key}`,
          className: 'ad-shot-row',
          style: { background: sel ? 'color-mix(in srgb,var(--ad-brand) 8%,var(--ad-bg-base))' : undefined },
          onClick: () => toggleShot(key),
        },
          h('input', { type: 'checkbox', className: 'ad-check', checked: sel, readOnly: true, style: { marginRight: 8 } }),
          h('span', { className: 'ad-shot-no' }, `镜${key}`),
          h('span', { className: 'ad-shot-meta' }, `${s.shotSize || ''} ${s.cameraMove || ''}`.trim()),
          h('span', { className: 'ad-shot-desc' }, (s.videoPrompt || s.imagePrompt || s.description || '').slice(0, 44)),
          status !== 'idle' ? h('span', { style: { marginLeft: 'auto', fontSize: 13 } }, badge) : null,
        )
      })

      // 分镜列表的空态（三种原因分别提示）
      const shotsEmptyNode = shots.length === 0
        ? h('div', { className: 'ad-empty-state' },
            h('div', { className: 'ad-empty-title' },
              shotsError ? '分镜加载失败' : project ? '本项目还没有分镜' : '尚未选择项目'),
            h('div', null,
              shotsError ? shotsError
                : project ? '在 AI 短剧工作区生成该集分镜后点「刷新」，或换个集数。'
                : '先在上方选择短剧项目。'),
          )
        : visibleShots.length === 0
          ? h('div', { className: 'ad-empty-state' },
              h('div', { className: 'ad-empty-title' }, '没有匹配的分镜'),
              h('div', null, `当前条件：${qn ? `关键词「${q}」` : ''}${qn && statusFilter !== 'all' ? ' + ' : ''}${statusFilter !== 'all' ? `状态「${statusFilter === 'done' ? '已完成' : statusFilter === 'failed' ? '失败' : '未出片'}」` : ''}`),
              h('div', { className: 'ad-row', style: { marginTop: 8 } },
                h('button', { className: 'ad-btn ad-sm', onClick: () => { setQ(''); setStatusFilter('all') } }, '清除筛选'),
              ),
            )
          : null

      // 进度条标题必须反映**真实成败**，不能只看「任务跑完」。
      // 状态：pending/polling=生成中 · done=全部成功 · partial=部分成功 · failed=一镜没出
      const jobState = jobProgress
        ? (jobProgress.status === 'done' ? { icon: '✅', label: '生成完成', color: 'var(--ad-success)' }
          : jobProgress.status === 'failed' ? { icon: '❌', label: '生成失败', color: 'var(--ad-err)' }
          : jobProgress.status === 'partial' ? { icon: '⚠', label: '部分完成', color: 'var(--ad-warn)' }
          : { icon: '⏳', label: '生成中…', color: undefined })
        : null
      const jobFails = (jobProgress?.error && jobProgress.status !== 'done') ? jobProgress.error : ''

      const progressNode = jobProgress ? h('div', { className: 'ad-progress-box' },
        h('div', { style: { fontWeight: 600, marginBottom: 6, color: jobState.color } },
          `${jobState.icon} ${jobState.label}`),
        h('div', { className: 'ad-progress-bar' }, h('div', { className: 'ad-progress-fill', style: { width: `${jobProgress.pct}%` } })),
        h('div', { className: 'ad-count', style: { marginTop: 4 } },
          `${jobProgress.done}/${jobProgress.total} 镜`,
          jobProgress.currentText ? `　·　${jobProgress.currentText}` : ''),
        jobFails ? h('div', { className: 'ad-err', style: { marginTop: 6, fontSize: 11, lineHeight: 1.6 } },
          String(jobFails).slice(0, 200)) : null,
      ) : null

      return h(Fragment, null,
        h('div', { className: 'ad-list-toolbar' },
          h('input', { className: 'ad-input', value: dramaRoot, onChange: e => setDramaRoot(e.target.value), placeholder: '工作区根目录（留空自动探测）', style: { maxWidth: 520 } }),
          h('button', { className: 'ad-btn ad-sm', onClick: onRefreshProjects }, '刷新项目'),
          h('button', { className: 'ad-btn ad-primary ad-sm', onClick: () => setCreating(v => !v) },
            creating ? '取消新建' : '＋ 新建项目'),
        ),

        // ---- 新建项目表单 ----
        creating ? h('div', { className: 'ad-card', style: { marginBottom: 10 } },
          h('div', { className: 'ad-card-title' }, '新建短剧项目'),
          h('div', { className: 'ad-hint-box', style: { marginBottom: 8 } },
            '只创建**空骨架**（13 个内容目录 + .aidrama 元数据），不写剧本内容。',
            '建好后回到 AI 短剧工作区写大纲/人物/剧本/分镜，本插件负责出片。'),
          h('div', { className: 'ad-row', style: { marginBottom: 8 } },
            h('span', { style: { fontSize: 12, minWidth: 44 } }, '剧名'),
            h('input', {
              className: 'ad-input', value: newTitle, placeholder: '例如：白月光替身',
              style: { maxWidth: 320 },
              onChange: e => setNewTitle(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter' && newTitle.trim()) createProject() },
            }),
            h('span', { className: 'ad-count' }, `${newTitle.length}/40`),
          ),
          h('div', { className: 'ad-row', style: { marginBottom: 8 } },
            h('span', { style: { fontSize: 12, minWidth: 44 } }, '根目录'),
            h('span', { className: 'ad-sub', style: { fontSize: 12, wordBreak: 'break-all' } },
              dramaRoot || (roots && roots[0]) || '（自动探测）'),
          ),
          createError ? h('div', { className: 'ad-err', style: { marginBottom: 6 } }, createError) : null,
          h('div', { className: 'ad-row' },
            h('button', {
              className: 'ad-btn ad-primary',
              disabled: !newTitle.trim() || newTitle.length > 40,
              onClick: createProject,
            }, '创建项目'),
            h('span', { className: 'ad-count' }, '创建后自动刷新项目列表'),
          ),
        ) : null, 
        listError ? h('div', { className: 'ad-err' }, listError) : null,
        projects.length === 0 && !listError ? h('div', { className: 'ad-empty-state', style: { marginBottom: 8 } },
          h('div', { className: 'ad-empty-title' }, '未找到短剧项目'),
          h('div', null, '已扫描以下目录：'),
          (roots || []).length
            ? (roots || []).map(r => h('div', { key: r, className: 'ad-sub', style: { marginTop: 4, wordBreak: 'break-all' } }, '· ' + r))
            : h('div', { className: 'ad-sub' }, '（未发现任何含项目的 AI短剧 目录）'),
          h('div', { className: 'ad-hint-box', style: { marginTop: 8 } },
            '点上方「＋ 新建项目」可直接创建空项目骨架；',
            '建好后回到 AI 短剧工作区写分镜，或在「项目根目录」填自定义路径后点「刷新」。'),
        ) : null,

        // 分镜工具栏：搜索 / 状态筛选 / 全选
        shots.length ? h('div', { className: 'ad-filterbar' },
          h('input', {
            className: 'ad-input ad-search', value: q, placeholder: '搜索镜号 / 描述 / 台词 / 场景',
            onChange: e => setQ(e.target.value),
            'aria-label': '搜索分镜',
          }),
          h('div', { className: 'ad-chip-group', role: 'group', 'aria-label': '按状态筛选' },
            [['all', '全部'], ['todo', '未出片'], ['done', '已完成'], ['failed', '失败']].map(([k, l]) =>
              h('button', {
                key: k, className: 'ad-chip', 'data-on': statusFilter === k ? '1' : '0',
                onClick: () => setStatusFilter(k),
              }, l)),
          ),
          h('button', {
            className: 'ad-btn ad-sm ad-btn-ghost',
            onClick: () => {
              if (allChecked) setChecked(new Set())
              else setChecked(new Set(visibleShots.map(s => String(s.shotNumber || s.shot))))
            },
          }, allChecked ? '取消全选' : `全选${qn || statusFilter !== 'all' ? '（筛后）' : ''}`),
          h('span', { className: 'ad-counter', 'data-over': visibleShots.length === 0 ? '1' : '0' },
            `${visibleShots.length}/${shots.length} 镜`),
        ) : null,

        h('div', { className: 'ad-row', style: { marginBottom: 8, flexWrap: 'wrap' } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, '项目'),
          h('select', { className: 'ad-select', style: { flex: '0 1 260px', minWidth: 180 }, value: project, onChange: e => { setProject(e.target.value); setEpisode('') } },
            h('option', { value: '' }, '— 选择短剧项目 —'),
            ...projects.map(p => h('option', { value: p.name, key: p.name }, `${p.name}（${p.episodes.length} 集）`)),
          ),
          project ? h('select', { className: 'ad-select', style: { maxWidth: 180 }, value: episode, onChange: e => setEpisode(e.target.value) },
            h('option', { value: '' }, '全部集'),
            ...(projects.find(p => p.name === project)?.episodes || []).map(x => h('option', { value: x, key: x }, x)),
          ) : null,
        ),

        h('div', { className: 'ad-row', style: { marginBottom: 8, flexWrap: 'wrap' } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, '参数'),
          h('select', { className: 'ad-select', style: { maxWidth: 130 }, value: ratio, onChange: e => setRatio(e.target.value), 'aria-label': '画幅', title: '画幅' },
            ['9:16', '16:9', '1:1', '3:4', '4:3'].map(r => h('option', { value: r, key: r }, r === '9:16' ? '9:16 竖屏' : r)),
          ),
          h('select', { className: 'ad-select', style: { maxWidth: 110 }, value: resolution, onChange: e => setResolution(e.target.value), 'aria-label': '分辨率', title: '分辨率' },
            ['720p', '1080p', '480p'].map(r => h('option', { value: r, key: r }, r)),
          ),
          h('input', { className: 'ad-input', style: { maxWidth: 90 }, value: duration, onChange: e => setDuration(e.target.value), placeholder: '时长秒', 'aria-label': '单镜时长（秒）', title: '单镜时长（秒，留空取分镜时长）' }),
        ),

        shotsError ? h('div', { className: 'ad-err' }, shotsError) : null,

        h('div', { className: 'ad-row', style: { justifyContent: 'space-between', marginBottom: 6 } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, project ? `分镜列表 · ${shots.length} 镜` : '选择项目后显示分镜'),
          shots.length > 0 ? h('button', { className: 'ad-btn ad-sm', onClick: () => setChecked(allChecked ? new Set() : new Set(shots.map(s => String(s.shotNumber || s.shot)))) }, allChecked ? '清除全选' : '全选') : null,
        ),

        shotsEmptyNode || h('div', { className: 'ad-shot-list' }, ...shotRows),

        h('div', { className: 'ad-row', style: { marginTop: 12 } },
          h('button', {
            className: 'ad-btn ad-primary ad-cta',
            onClick: startGenerate,
            disabled: busy || shots.length === 0 || checked.size === 0 || (quotaEst && !quotaEst.enough),
          }, busy ? '生成中…' : `🚀 一键出片（已选 ${checked.size} 镜）`),
          // 配额预估：读账本，不探测、不耗配额
          h('button', {
            className: 'ad-btn ad-sm',
            disabled: quotaLoading,
            onClick: () => onLoadQuotaEstimate(checked.size || shots.length || 0),
            title: '根据历史结果估算还能跑几镜（不发请求、不消耗配额）',
          }, quotaLoading ? '⏳ 估算中…' : '配额预估'),
          h('button', {
            className: 'ad-btn ad-sm',
            disabled: warmupRun || !project,
            onClick: () => onRunWarmup(),
            title: '用最省的探针（480p/2s）把每个账号探一遍，成功即记入账本，之后出片不再撞死号',
          }, warmupRun ? '⏳ 预热中…' : '账号预热'),
          h('label', {
            className: 'ad-hint',
            style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' },
            title: '默认跳过已有产物（省钱）。勾选后可覆盖重跑。',
          },
            h('input', {
              type: 'checkbox',
              checked: !!forceGen,
              onChange: (e) => setForceGen(e.target.checked),
            }),
            '强制重新生成'),
          quotaEst
            ? h('span', {
                className: 'ad-hint',
                style: {
                  fontSize: 11,
                  color: quotaEst.enough ? 'var(--ad-success)' : 'var(--ad-err)',
                },
                title: `账本记录于 ${quotaEst.lastAt || '尚未记录'}`,
              }, quotaEst.enough
                ? `✅ 可用 ${quotaEst.usable} 个账号，约够 ${quotaEst.capacity} 镜（需 ${quotaEst.shotsNeeded}）`
                : `❌ 仅 ${quotaEst.usable} 个可用账号（约 ${quotaEst.capacity} 镜），不够 ${quotaEst.shotsNeeded} 镜。${quotaEst.quotaDead} 个已耗尽，请补账号`)
            : null,
          warmupResult
            ? h('span', {
                className: 'ad-hint',
                style: {
                  fontSize: 11,
                  color: warmupResult.ok ? 'var(--ad-success)' : 'var(--ad-err)',
                },
              }, warmupResult.ok
                ? `预热完成：可用 ${warmupResult.summary.ok} / 耗尽 ${warmupResult.summary.quota} / 异常 ${warmupResult.summary.broken}（${(warmupResult.summary.elapsedMs / 1000).toFixed(0)}s）`
                : `预热失败：${warmupResult.error}`)
            : null,
        ),
        progressNode,
      )
    }

    /* ---------------------------------------------------------------- 产物页签 */
    /* ------------------------------------------------------------ 一致性页签 */
    /** AI 创作六阶段的中文名（与 host src/ai-create.js 的 STAGES 对齐）。 */
    const STAGES_CLIENT = {
      contract: '立项契约', outline: '分集大纲', characters: '人物设定',
      world: '世界观', memory: '本剧记忆', style: '视觉风格',
      script: '分集剧本', storyboard: '分镜表',
    }

    /** 按集生成的阶段（需要集号）。 */
    const EPISODE_STAGES_CLIENT = ['script', 'storyboard']

    /* ------------------------------------------------------------ 总览页签 */
    /** 全剧总览：把六个阶段的产出按「集」串起来看，而不是分六个独立文件看。 */
    function OverviewTab({ project, links, linksError, onLoad, onRepair, repairState, onApplyRepair, onDiscardRepair, projects, setProject, episode, setEpisode, episodes }) {
      if (!project) {
        return h('div', { className: 'ad-empty-state' },
          h('div', { className: 'ad-empty-title' }, '选择一个项目'),
          h('div', null, '本项目全剧的跨阶段关联会显示在这里。'),
          (projects || []).length
            ? h('div', { className: 'ad-row', style: { marginTop: 10, justifyContent: 'center' } },
                h('select', {
                  className: 'ad-select', style: { maxWidth: 280 }, defaultValue: '',
                  onChange: e => { if (e.target.value) setProject(e.target.value) },
                },
                  h('option', { value: '' }, '选择项目…'),
                  (projects || []).map(pj => h('option', { value: pj.name, key: pj.name }, pj.name))))
            : h('div', { className: 'ad-hint', style: { marginTop: 8 } }, '还没有项目，先去「出片」页签新建。'))
      }
      if (linksError) {
        return h('div', { className: 'ad-err-box' },
          h('div', { className: 'ad-err-head' }, '关联图加载失败'),
          h('div', { className: 'ad-err' }, linksError))
      }
      if (!links) {
        return h('div', { className: 'ad-empty-state' },
          h('div', { className: 'ad-empty-title' }, '还没有关联数据'),
          h('div', null, '先生成契约与大纲，这里会自动算出角色/场景/伏笔的交叉引用。'),
          h('div', { className: 'ad-row', style: { marginTop: 8 } },
            h('button', { className: 'ad-btn ad-sm ad-primary', onClick: onLoad }, '加载')))
      }

      const t = links.totals || {}

      // ① 指标卡
      const statRow = h('div', { className: 'ad-grid ad-grid-4', style: { marginBottom: 12 } },
        h('div', { className: 'ad-stat' },
          h('div', { className: 'ad-stat-value' }, String(t.episodes ?? 0)),
          h('div', { className: 'ad-stat-label' }, '集数')),
        h('div', { className: 'ad-stat' },
          h('div', { className: 'ad-stat-value' }, String(t.characters ?? 0)),
          h('div', { className: 'ad-stat-label' }, '角色')),
        h('div', { className: 'ad-stat' },
          h('div', { className: 'ad-stat-value' }, String(t.avgCharsPerEpisode ?? 0)),
          h('div', { className: 'ad-stat-label' }, '平均每集登场角色')),
        h('div', { className: 'ad-stat' },
          h('div', { className: 'ad-stat-value', style: { color: (t.foreshadowCoverage ?? 0) >= 80 ? 'var(--ad-success)' : 'var(--ad-warn)' } },
            `${t.foreshadowCoverage ?? 0}%`),
          h('div', { className: 'ad-stat-label' }, '伏笔标注回收率')),
      )

      // ② 逐集关联表
      const epRows = (links.episodeMap || []).map(e => h('tr', { key: e.order },
        h('td', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, `第${e.order}集`),
        h('td', { style: { maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.title || '—'),
        h('td', null,
          (e.characters || []).length
            ? (e.characters || []).map(n => h('span', { key: n, className: 'ad-crumb-chip', style: { marginRight: 4 } }, n))
            : h('span', { className: 'ad-hint' }, '—')),
        h('td', null,
          (e.places || []).length
            ? (e.places || []).map(n => h('span', { key: n, className: 'ad-crumb-chip', style: { marginRight: 4, opacity: .8 } }, n))
            : h('span', { className: 'ad-hint' }, '—')),
        h('td', null,
          (e.foreshadows || []).length
            ? h('span', { style: { fontSize: 11, color: 'var(--ad-brand)' } }, `${e.foreshadows.length} 条伏笔埋入`)
            : h('span', { className: 'ad-hint' }, '—')),
      ))

      const epTable = (links.episodeMap || []).length ? h('div', { style: { maxHeight: 320, overflow: 'auto', marginBottom: 12 } },
        h('table', { className: 'ad-table' },
          h('thead', null, h('tr', null,
            h('th', null, '集'), h('th', null, '标题'), h('th', null, '登场角色'), h('th', null, '场景'), h('th', null, '伏笔'))),
          h('tbody', null, epRows))
      ) : null

      // ③ 角色出场弧线
      const arcRows = (links.characterArcs || []).map(c => h('div', { key: c.name, className: 'ad-shot-row', style: { cursor: 'default' } },
        h('span', { style: { minWidth: 64, fontWeight: 600, fontSize: 12 } }, c.name),
        h('span', { className: 'ad-shot-meta', style: { minWidth: 40 } }, c.role),
        h('span', { style: { flex: 1, fontSize: 12 } },
          c.episodeCount
            ? c.episodes.map(n => h('span', { key: n, className: 'ad-crumb-chip', style: { marginRight: 3, padding: '1px 5px', fontSize: 10 } }, n))
            : h('span', { style: { color: 'var(--ad-err)' } }, '未在大纲中登场')),
        h('span', { className: 'ad-counter', style: { minWidth: 48 } }, `${c.episodeCount} 集`),
      ))

      // ④ 伏笔链
      const fsRows = (links.foreshadowChains || []).map((f, i) => h('div', { key: f.id || i, className: 'ad-shot-row', style: { cursor: 'default', alignItems: 'flex-start' } },
        h('span', { style: { minWidth: 92, fontSize: 11, color: 'var(--ad-label-secondary)' } },
          `第${f.plantedAt ?? '?'}集 → ${f.payoffAt ? `第${f.payoffAt}集` : '未定'}`),
        h('span', { style: { flex: 1, fontSize: 12, lineHeight: 1.6 } }, f.content),
        h('span', { className: 'ad-crumb-chip', style: {
          minWidth: 40, textAlign: 'center',
          color: f.payoffAt ? 'var(--ad-success)' : 'var(--ad-warn)',
        } }, f.payoffAt ? '已定' : '缺回收'),
      ))

      // ⑤ 缺口 → 该由哪个阶段来修
      const orph = links.orphans || {}
      const orphanIssues = []
      const gapActions = []
      if ((orph.characters || []).length) {
        const txt = `角色未登场：${orph.characters.join('、')}`
        orphanIssues.push(txt)
        // 角色没登场 → 要么人物卡删掉它，要么大纲补戏份；优先修人物卡
        gapActions.push({ text: txt, stage: 'characters' })
      }
      if ((orph.places || []).length) {
        const txt = `场景未使用：${(orph.places || []).slice(0, 6).join('、')}`
        orphanIssues.push(txt)
        // 场景没用上 → 世界观收窄（只保留剧情真用得上的）
        gapActions.push({ text: txt, stage: 'world' })
      }
      if ((orph.foreshadowsWithoutPayoff || []).length) {
        const txt = `${orph.foreshadowsWithoutPayoff.length} 条伏笔缺回收点`
        orphanIssues.push(txt)
        gapActions.push({ text: txt, stage: 'memory' })
      }

      return h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 8, flexWrap: 'wrap' } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, '全剧关联'),
          // 直接在本页切项目，不用回「创作」页
          (projects || []).length
            ? h('select', {
                className: 'ad-select', style: { maxWidth: 200, fontSize: 12 }, value: project,
                onChange: e => { const v = e.target.value; setProject(v); setEpisode('') },
              }, (projects || []).map(pj => h('option', { value: pj.name, key: pj.name }, pj.name)))
            : h('span', { className: 'ad-sub' }, `《${project}》`),
          h('button', { className: 'ad-btn ad-sm', onClick: onLoad }, '重新计算'),
          h('span', { className: 'ad-hint', style: { marginLeft: 'auto' } }, '由六份资产交叉计算得出，不改动任何文件'),
        ),
        statRow,
        orphanIssues.length ? h('div', { className: 'ad-warn-box', style: { marginBottom: 12 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '⚠ 关联缺口'),
          gapActions.map((g, i) => h('div', { key: i, className: 'ad-row', style: { fontSize: 12, lineHeight: 1.7, gap: 8, marginBottom: 4 } },
            h('span', { style: { flex: 1 } }, `· ${g.text}`),
            h('button', {
              className: 'ad-btn ad-sm',
              disabled: !!repairState?.running,
              onClick: () => onRepair(g.stage, [g.text]),
              title: `带着这条缺口重跑「${STAGES_CLIENT[g.stage]}」`,
            }, repairState?.running && repairState.stage === g.stage ? '⏳ 修正中' : '让 AI 补'),
          )),
          h('div', { className: 'ad-row', style: { marginTop: 8 } },
            h('button', {
              className: 'ad-btn ad-sm ad-primary',
              disabled: !!repairState?.running,
              onClick: () => onRepair(gapActions[0]?.stage || 'world', gapActions.map(g => g.text)),
            }, '全部交给 AI 修'),
          ),
        ) : null,

        // 修正结果预览
        repairState?.error ? h('div', { className: 'ad-err-box', style: { marginBottom: 12 } },
          h('div', { className: 'ad-err-head' }, '修正失败'),
          h('div', { className: 'ad-err' }, repairState.error)) : null,
        repairState?.result ? h('div', { className: 'ad-ok-box', style: { marginBottom: 12 } },
          h('div', { className: 'ad-row' },
            h('span', { style: { fontWeight: 600 } }, `✅ 修正版已生成（${STAGES_CLIENT[repairState.stage]}，` +
              `${Array.isArray(repairState.result.data) ? repairState.result.data.length + ' 条' : '对象'}）`),
            h('span', { className: 'ad-hint', style: { marginRight: 4 } },
              Array.isArray(repairState.result.data) ? '合并写入（保留原有条目）' : ''),
            h('button', { className: 'ad-btn ad-sm ad-primary', style: { marginLeft: 'auto' }, onClick: onApplyRepair }, '写入项目'),
            h('button', { className: 'ad-btn ad-sm ad-btn-ghost', onClick: onDiscardRepair }, '丢弃'),
          ),
          h('pre', { className: 'ad-hint-box ad-mono', style: {
            height: 360, minHeight: 360, overflow: 'auto', marginTop: 6, fontSize: 12, lineHeight: 1.6, resize: 'vertical',
          } }, JSON.stringify(repairState.result.data, null, 2)),
        ) : null,

        epTable,
        h('div', { className: 'ad-sec' }, `角色出场弧线（${(links.characterArcs || []).length}）`),
        h('div', { className: 'ad-shot-list' }, ...arcRows),
        h('div', { className: 'ad-sec', style: { marginTop: 12 } }, `伏笔链（${(links.foreshadowChains || []).length}）`),
        (links.foreshadowChains || []).length
          ? h('div', { className: 'ad-shot-list' }, ...fsRows)
          : h('div', { className: 'ad-empty-state' }, h('div', null, '还没有伏笔条目')),
      )
    }

    /* ------------------------------------------------------------ 创作页签 */
    function CreationTab({
      project, dramaRoot, bundle, bundleError, bundleLoading,
      onLoad, onSave, onSaveScript, onLoadScript, onLoadStoryboard,
      // AI 一键生成相关（缺一个都会导致渲染抛 ReferenceError → 整页空白）
      ai, setAi, aiRun, aiTaskId, aiProgress, onAiGenerate, onApplyAi,
      llmStatus, onRefreshLlm, onAiStage, onAiEpisode,
      // 角色定妆（缺了会 ReferenceError → 整页白屏）
      casting, castingRun, castingMsg, onCast, castingPreview, setCastingPreview,
      shotPrompts, promptRun, onLoadShotPrompts,
    }) {
      const [sub, setSub] = useState('contract')
      const [editing, setEditing] = useState(null)   // 正在编辑的文本
      const [scriptEp, setScriptEp] = useState('')
      const [scriptText, setScriptText] = useState('')
      const [sbEp, setSbEp] = useState('')
      const [sbText, setSbText] = useState('')
      const [saveMsg, setSaveMsg] = useState(null)
      const [scriptFull, setScriptFull] = useState(false)
      const [saveErr, setSaveErr] = useState(null)

      if (!project) {
        return h('div', { className: 'ad-empty-state' },
          h('div', { className: 'ad-empty-title' }, '尚未选择项目'),
          h('div', null, '在「出片」页签选择项目后，这里可查看与编辑该项目的大纲、人物、剧本与记忆。'))
      }

      const SUB_TABS = [
        ['contract', '立项'], ['outline', '大纲'], ['characters', '人物'],
        ['world', '世界观'], ['memory', '记忆'], ['style', '风格'], ['script', '剧本'],
        ['storyboard', '分镜'],
      ]

      const p = bundle?.progress

      // ---- 概览：七步进度 ----
      const stepLabels = [
        ['contract', '立项契约'], ['outline', '分集大纲'], ['characters', '人物设定'],
        ['world', '世界观'], ['script', '分集剧本'], ['storyboard', '分镜表'], ['generated', '已出片'],
      ]
      const progressNode = p ? h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 6 } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, `创作进度 ${p.done}/${p.total}`),
          h('span', { className: 'ad-counter', style: { marginLeft: 'auto' } }, `${p.pct}%`),
        ),
        h('div', { className: 'ad-progress-bar', style: { marginBottom: 8 } },
          h('div', { className: 'ad-progress-fill', style: { width: `${p.pct}%` } })),
        h('div', { className: 'ad-grid ad-grid-4', style: { marginBottom: 12 } },
          stepLabels.map(([k, l]) => h('div', {
            key: k, className: 'ad-stat',
            style: { borderColor: p.steps[k] ? 'color-mix(in srgb,var(--ad-success) 40%,transparent)' : undefined },
          },
            h('div', { className: 'ad-stat-value', style: { fontSize: 15, color: p.steps[k] ? 'var(--ad-success)' : 'var(--ad-label-secondary)' } },
              p.steps[k] ? '✓' : '—'),
            h('div', { className: 'ad-stat-label' }, l))),
        ),
      ) : null

      // 阶段就绪判定：前置资产是否齐备（与后端 STAGE_DEPS 保持一致）
      const stageReady = (name, b) => {
        if (!b) return false
        if (name === 'contract') return Boolean(b.contract?.title)
        if (name === 'outline') return Array.isArray(b.outline) && b.outline.length > 0
        if (name === 'characters') return Array.isArray(b.characters) && b.characters.length > 0
        if (name === 'world') return Array.isArray(b.world) && b.world.length > 0
        if (name === 'memory') return Array.isArray(b.memory) && b.memory.length > 0
        if (name === 'style') return Boolean(b.style?.style && Object.values(b.style.style).some(v => v))
        // script 不是「资产」而是「该集剧本正文」：看 scripts 清单里有没有这一集
        if (name === 'script') {
          const epNo = Number(ai?.episodeNo || 1)
          const prefix = `第${String(epNo).padStart(3, '0')}集`
          return Array.isArray(b.scripts) && b.scripts.some(x => String(x).startsWith(prefix))
        }
        // storyboard 同理：看 storyboards 清单里有没有这一集
        if (name === 'storyboard') {
          const epNo = Number(ai?.episodeNo || 1)
          const prefix = `第${String(epNo).padStart(3, '0')}集`
          return Array.isArray(b.storyboards) && b.storyboards.some(x => String(x).startsWith(prefix))
        }
        return false
      }
      const curStage = ai?.stage || 'contract'
      const isEpisodeStage = EPISODE_STAGES_CLIENT.includes(curStage)

      const curDeps = (llmStatus?.stageDeps || {})[curStage] || []
      const missingLabels = curDeps.filter(x => !stageReady(x, bundle)).map(x => STAGES_CLIENT[x] || x)
      const stageReady2 = missingLabels.length === 0
      // 分镜必须先有该集剧本（后端也会拦，这里提前禁用按钮避免白等）
      const hasScriptForCurEp = stageReady('script', bundle)

      // 跨阶段一致性告警（模型另起一套设定时暴露出来）
      const linkIssues = (aiProgress?.stages || []).flatMap(st =>
        (st.consistency?.issues || []).map(i => ({ ...i, stage: st.label })))
      const linksNode = linkIssues.length ? h('div', { className: 'ad-warn-box', style: { marginTop: 8 } },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, `⚠ 与前序资产有 ${linkIssues.length} 处不一致`),
        linkIssues.slice(0, 8).map((i, idx) => h('div', { key: idx, style: { fontSize: 12, lineHeight: 1.7 } },
          `· [${i.stage}] ${i.message}`)),
      ) : null

      // ---- AI 一键生成面板 ----
      const ideaVal = ai?.idea ?? ''
      // ===== 角色定妆面板 =====
      const castingChars = casting?.characters || []
      const castedCount = castingChars.filter(c => c.casted && !c.stale).length
      const staleCount = castingChars.filter(c => c.stale).length
      const castingRows = castingChars.map(c => {
        // 三种状态：已定妆 / 已过期（形象描述改过）/ 未定妆
        const icon = c.stale ? '⚠' : (c.casted ? '✓' : '○')
        const iconColor = c.stale ? 'var(--ad-warn)'
          : (c.casted ? 'var(--ad-success)' : 'var(--ad-label-secondary)')
        return h('div', {
          key: c.name, className: 'ad-row', style: { padding: '3px 0', gap: 6, fontSize: 12 },
        },
          h('span', { style: { width: 12, color: iconColor } }, icon),
          h('span', { style: { minWidth: 64, fontWeight: 500 } }, c.name),
          // 形态标签：每个角色都显示（人形/异兽），保证列对齐且一眼能看出定妆构图差异
          h('span', {
            className: 'ad-hint',
            style: {
              fontSize: 10, minWidth: 26, flex: '0 0 auto', textAlign: 'center',
              color: c.nonHuman ? 'var(--ad-brand)' : 'var(--ad-label-secondary)',
              border: c.nonHuman ? '1px solid var(--ad-brand)' : '1px solid transparent',
              borderRadius: 3, padding: '0 3px', lineHeight: '14px',
            },
            title: c.nonHuman
              ? '非人形角色：定妆用全身形态，主体完整入画不裁头'
              : '人形角色：定妆用单人正面胸像',
          }, c.nonHuman ? '异兽' : '人形'),
          c.stale ? h('span', {
            className: 'ad-hint', style: { fontSize: 10, color: 'var(--ad-warn)' },
            title: '人物设定的形象描述已改，旧定妆图与新设定不一致',
          }, '形象已变') : null,
          // 定妆图缩略图：点一下放大查看
          c.imageUrl
            ? h('img', {
                src: c.imageUrl, alt: c.name,
                style: {
                  width: 32, height: 32, objectFit: 'cover', borderRadius: 4,
                  border: '1px solid var(--ad-border)', cursor: 'zoom-in', flex: '0 0 auto',
                },
                title: '点击查看定妆图',
                onClick: () => setCastingPreview(c.name),
              })
            : h('span', {
                style: {
                  width: 32, height: 32, borderRadius: 4, flex: '0 0 auto',
                  border: '1px dashed var(--ad-border)', display: 'inline-block',
                },
                title: c.casted ? '有定妆记录但图片地址解析失败' : '还未定妆',
              }),
          h('span', { className: 'ad-hint', style: { flex: 1, fontSize: 11, color: 'var(--ad-label-secondary)' } },
            String(c.appearancePrompt || '（缺形象描述）').slice(0, 60)),
          c.imageUrl ? h('button', {
            className: 'ad-btn ad-sm',
            onClick: () => window.open(c.imageUrl, '_blank', 'noopener'),
            title: '在新标签打开原图',
          }, '看大图') : null,
          h('button', {
            className: c.stale ? 'ad-btn ad-sm ad-primary' : 'ad-btn ad-sm',
            disabled: castingRun || !c.appearancePrompt,
            onClick: () => onCast([c.name], c.casted),
            title: c.stale ? '形象描述已变，建议重出' : (c.casted ? '重新出这张定妆图' : '为这个角色出定妆图'),
          }, c.stale ? '重出' : (c.casted ? '重出' : '定妆')),
        )
      })

      // 放大预览：点缩略图后浮层显示原图
      const previewChar = castingPreview ? castingChars.find(x => x.name === castingPreview) : null
      const previewNode = previewChar?.imageUrl ? h('div', {
        style: {
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', zIndex: 100,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 10, padding: 24,
        },
        onClick: () => setCastingPreview(null),
      },
        h('img', {
          src: previewChar.imageUrl, alt: previewChar.name,
          style: { maxWidth: '88vw', maxHeight: '78vh', objectFit: 'contain', borderRadius: 8 },
          onClick: e => e.stopPropagation(),
        }),
        h('div', { style: { color: '#fff', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', null, `${previewChar.name} 定妆图`),
          h('button', {
            className: 'ad-btn ad-sm',
            onClick: e => { e.stopPropagation(); window.open(previewChar.imageUrl, '_blank', 'noopener') },
          }, '打开原图'),
          h('button', {
            className: 'ad-btn ad-sm ad-btn-ghost',
            style: { color: '#fff', borderColor: 'rgba(255,255,255,.4)' },
            onClick: e => { e.stopPropagation(); setCastingPreview(null) },
          }, '关闭'),
        ),
        h('div', { style: { color: 'rgba(255,255,255,.6)', fontSize: 11 } }, '点击空白处也可关闭'),
      ) : null

      const castingPanel = h('div', {
        className: 'ad-card', style: { flexDirection: 'column', alignItems: 'stretch', gap: 8, marginBottom: 12 },
      },
        h('div', { className: 'ad-row' },
          h('span', { className: 'ad-card-title', style: { margin: 0 } }, '角色定妆'),
          h('span', { className: 'ad-hint' }, `${castedCount}/${castingChars.length} 已定妆`),
          staleCount ? h('span', {
            className: 'ad-hint', style: { color: 'var(--ad-warn)' },
            title: '这些角色的形象描述改过，旧定妆图与新设定不一致',
          }, `${staleCount} 个已过期`) : null,
          h('button', {
            className: 'ad-btn ad-sm ad-primary', style: { marginLeft: 'auto' },
            disabled: castingRun || !castingChars.length,
            onClick: () => onCast([], false),
            title: '给所有还没定妆的角色出图（已定妆的跳过）',
          }, castingRun ? '⏳ 出图中…' : `全部定妆（缺 ${castingChars.length - castedCount}）`),
        ),
        h('div', { className: 'ad-hint', style: { fontSize: 11, lineHeight: 1.6 } },
          '定妆 = 用文生图给每个角色出一张标准形象照；出片时作为参考首帧传入，' +
          '同一角色跨镜不会换脸。每张约 10–20 秒，结果缓存在 .aidrama/casting/，重复使用不重复出图。'),
        castingRows.length ? h(Fragment, null, castingRows) : h('div', { className: 'ad-hint' }, '还没有人物设定，先在阶段里生成「人物设定」'),
        castingMsg ? h('div', {
          className: castingMsg.kind === 'err' ? 'ad-err' : 'ad-hint',
          style: { fontSize: 11, color: castingMsg.kind === 'ok' ? 'var(--ad-success)' : undefined },
        }, castingMsg.text) : null,
      )

      const aiPanel = h('div', { className: 'ad-card', style: { flexDirection: 'column', alignItems: 'stretch', gap: 8, marginBottom: 12 } },
        h('div', { className: 'ad-row' },
          h('span', { className: 'ad-card-title', style: { margin: 0 } }, '🤖 AI 一键生成创作资产'),
          h('span', { className: 'ad-hint', style: { marginLeft: 'auto' } }, '六阶段链式：立项→大纲→人物→世界→记忆→风格'),
        ),
        h('div', { style: { fontSize: 12, color: 'var(--ad-label-secondary)', lineHeight: 1.7 } },
          '一句话想法只用于「立项契约」。其余阶段吃已有资产（契约/大纲/人物…），想法可留空。',
          '生成结果先预览，确认后再写入项目，不会覆盖现有内容。'),
        h('textarea', {
          className: 'ad-area', value: ideaVal, placeholder: '例：重生复仇女主被豪门当替身十年，重生后反杀',
          style: { minHeight: 60, fontSize: 13 },
          onChange: e => setAi(a => ({ ...a, idea: e.target.value })),
          disabled: aiRun,
        }),
        // 模型可用性 + 选择
        h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8 } },
          h('span', { className: 'ad-count' }, '模型'),
          llmStatus === null
            ? h('span', { className: 'ad-hint' }, '检测中…')
            : llmStatus.available === false
              ? h('span', { className: 'ad-hint', style: { color: 'var(--ad-err)' } }, `⚠ ${llmStatus.reason || 'llm 不可用'}`)
              : h(Fragment, null,
                  h('span', { className: 'ad-crumb-chip', style: { color: 'var(--ad-success)', borderColor: 'color-mix(in srgb,var(--ad-success) 40%,transparent)' } },
                    `✓ ${llmStatus.hasFreeModel ? 'our-free-model 已就绪' : ((llmStatus.providers || [])[0] || '默认通道')}`),
                  h('select', {
                    className: 'ad-select', style: { maxWidth: 220, fontSize: 12 }, value: ai?.model || '',
                    onChange: e => setAi(a => ({ ...a, model: e.target.value }),
                    ),
                    title: '留空则自动选用该通道第一个可用模型',
                  },
                    h('option', { value: '' }, `默认（${llmStatus.fallbackModel || '自动'}）`),
                    (llmStatus.models || []).slice(0, 30).map(m => h('option', { value: m.id, key: m.id }, m.name || m.id))),
                  (llmStatus.models || []).length
                    ? h('span', { className: 'ad-hint' }, `${llmStatus.models.length} 个可选`)
                    : h('span', { className: 'ad-hint' }, '目录未返回，将用兜底模型'),
                ),
          h('button', { className: 'ad-btn ad-sm ad-btn-ghost', onClick: onRefreshLlm }, '重新检测'),
        ),
        // 按集阶段（剧本/分镜）需要选集号
        isEpisodeStage ? h('div', { className: 'ad-filterbar', style: { marginBottom: 8 } },
          h('span', { className: 'ad-count' }, '集号'),
          h('select', {
            className: 'ad-select', style: { maxWidth: 180, fontSize: 12 },
            value: String(ai?.episodeNo || 1),
            onChange: e => setAi(a => ({ ...a, episodeNo: Number(e.target.value) })),
            disabled: aiRun,
          },
            Array.from({ length: Math.max(1, (bundle?.outline || []).length) }, (_, i) => {
              const ep = (bundle?.outline || [])[i]
              return h('option', { value: String(i + 1), key: i + 1 },
                `第${i + 1}集${ep?.title ? ' ' + ep.title : ''}`)
            })),
          h('span', { className: 'ad-hint' }, '只生成选中的这一集'),
          // 已有剧本/分镜的标记
          (bundle?.scripts || []).some(x => x.startsWith(`第${String(ai?.episodeNo || 1).padStart(3,'0')}集`))
            ? h('span', { className: 'ad-crumb-chip', style: { color: 'var(--ad-success)' } }, '✓ 已有剧本') : null,
          (bundle?.storyboards || []).some(x => x.startsWith(`第${String(ai?.episodeNo || 1).padStart(3,'0')}集`))
            ? h('span', { className: 'ad-crumb-chip', style: { color: 'var(--ad-success)' } }, '✓ 已有分镜') : null,
        ) : null,
        h('div', { className: 'ad-row', style: { flexWrap: 'wrap' } },
          h('button', {
            className: 'ad-btn ad-primary', disabled: aiRun || (llmStatus && llmStatus.available === false),
            onClick: onAiGenerate,
          }, aiRun ? `⏳ 生成中 ${aiProgress?.done ?? 0}/${aiProgress?.total ?? 6}` : '开始生成（六阶段全链）'),
          // 单阶段试跑：先用最短的一步验证链路是否真的通，避免白等几分钟
          h('select', {
            className: 'ad-select', style: { maxWidth: 120, fontSize: 12 }, value: ai?.stage || 'contract',
            onChange: e => setAi(a => ({ ...a, stage: e.target.value })),
            disabled: aiRun,
            title: '只生成单个阶段，用于快速验证链路',
          },
            ['contract', 'outline', 'characters', 'world', 'memory', 'style', 'script', 'storyboard'].map(k =>
              h('option', { value: k, key: k }, STAGES_CLIENT[k]))),
          h('button', {
            className: 'ad-btn ad-sm',
            disabled: aiRun || (llmStatus && llmStatus.available === false) || !stageReady2 || (curStage === 'storyboard' && !hasScriptForCurEp),
            onClick: () => {
              // 按集阶段走专用接口（会直接落盘）
              if (isEpisodeStage) onAiEpisode(curStage, Number(ai?.episodeNo || 1))
              else onAiStage(curStage)
            },
            title: stageReady2 ? (isEpisodeStage ? '生成并写入项目文件' : '只跑选中的阶段（约 20–40 秒）') : `缺前序资产：${missingLabels.join('、')}`,
          }, isEpisodeStage ? '生成并写入' : '只跑该阶段'),
          missingLabels.length
            ? h('span', { className: 'ad-hint', style: { color: 'var(--ad-warn)' } },
                `⚠ 需先生成：${missingLabels.join('、')}`)
            : null,
          aiProgress?.current?.stage ? h('span', { className: 'ad-hint' },
            `当前：${aiProgress.current.label || aiProgress.current.stage}`) : null,
          h('span', { className: 'ad-hint', style: { marginLeft: 'auto' } }, '约 2–5 分钟，取决于模型速度'),
        ),
        // 阶段进度
        aiProgress?.stages?.length ? h('div', { className: 'ad-stack', style: { gap: 4 } },
          aiProgress.stages.map(st => h('div', { key: st.stage, className: 'ad-row', style: { gap: 6, fontSize: 12 } },
            h('span', { style: { minWidth: 16 } }, st.ok ? '✅' : '❌'),
            h('span', { style: { minWidth: 90, fontWeight: 500 } }, st.label),
            h('span', { className: 'ad-hint', style: { flex: 1 } }, st.ok ? `${(st.bytes || 0).toString()} 字节 · ${Math.round((st.elapsedMs || 0) / 1000)}s` : (st.error || '')),
            st.ok && st.warn ? h('span', { className: 'ad-hint', style: { color: 'var(--ad-warn)', fontSize: 11 } }, `⚠ ${st.warn}`) : null,
          ))) : null,
        linksNode,
      )

      // ---- 生成结果预览 + 写入 ----
      const aiResultNode = (() => {
        const res = aiProgress?.result
        if (!res || !res.stages?.length) return null
        const okStages = res.stages.filter(x => x.ok)
        if (!okStages.length) return null
        const previewKeys = ['contract', 'outline', 'characters', 'world', 'memory', 'style', 'script', 'storyboard'].filter(k => res.assets?.[k])
        return h('div', { className: 'ad-card', style: { flexDirection: 'column', alignItems: 'stretch', gap: 8, marginBottom: 12 } },
          h('div', { className: 'ad-row' },
            h('span', { className: 'ad-card-title', style: { margin: 0 } }, `✅ 已生成 ${okStages.length} 个阶段`),
            h('button', {
              className: 'ad-btn ad-primary ad-sm',
              onClick: () => onApplyAi(res.assets, previewKeys),
            }, '全部写入项目'),
          ),
          h('div', { className: 'ad-stack', style: { gap: 6 } },
            previewKeys.map(k => {
              const v = res.assets[k]
              const n = Array.isArray(v) ? v.length : 1
              const isStyle = k === 'style'
              return h('div', { key: k, className: 'ad-row', style: { fontSize: 12, gap: 8 } },
                h('span', { style: { minWidth: 90, fontWeight: 500 } }, STAGES_CLIENT[k] || k),
                h('span', { className: 'ad-hint', style: { flex: 1 } }, isStyle ? '五维 DNA' : (Array.isArray(v) ? `${n} 条` : '对象')),
                h('button', { className: 'ad-btn ad-sm ad-btn-ghost', onClick: () => setSub(k) }, '预览'),
              )
            })),
          // 内联预览选中阶段
          h('pre', { className: 'ad-hint-box ad-mono', style: {
            height: 400, minHeight: 400, overflow: 'auto', fontSize: 12, lineHeight: 1.6, resize: 'vertical',
          } }, JSON.stringify(res.assets[sub] || res.assets[previewKeys[0]], null, 2)),
        )
      })()

      // ---- 各子页签内容 ----
      function renderContract() {
        const c = bundle?.contract
        if (!c) return h('div', { className: 'ad-empty-state' }, h('div', { className: 'ad-empty-title' }, '还没有立项契约'),
          h('div', null, '点「新建项目」创建骨架后会生成 contract.json；或在此手动编辑保存。'))
        const rows = [
          ['剧名', c.title], ['投放平台', c.platform], ['目标受众', c.audience],
          ['单集时长', Array.isArray(c.episodeDurationSec) ? `${c.episodeDurationSec[0]}–${c.episodeDurationSec[1]} 秒` : c.episodeDurationSec],
          ['目标集数', c.targetEpisodes], ['画幅', c.orientation],
          ['钩子密度', c.hookDensity], ['内容红线', c.redlines],
          ['世界空间', c.worldSpace], ['世界时间', c.worldTime], ['力量体系', c.powerSystem],
        ].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
        return h(Fragment, null,
          h('table', { className: 'ad-table' }, h('tbody', null,
            rows.map(([k, v]) => h('tr', { key: k },
              h('th', { style: { width: 110 } }, k),
              h('td', null, String(v))))))
        )
      }

      function renderList(kind, fields, emptyHint) {
        const arr = bundle?.[kind] || []
        if (!arr.length) return h('div', { className: 'ad-empty-state' }, h('div', { className: 'ad-empty-title' }, `还没有${emptyHint}`),
          h('div', null, '在 AI 短剧工作区生成后点「重新加载」。'))
        return h('div', { className: 'ad-stack' },
          arr.map((it, i) => h('div', { key: it.id || i, className: 'ad-card', style: { alignItems: 'flex-start', flexDirection: 'column', gap: 6 } },
            h('div', { className: 'ad-row', style: { gap: 8 } },
              h('span', { className: 'ad-card-title', style: { margin: 0 } },
                kind === 'outline' ? `第${it.order}集 ${it.title || ''}` : (it.name || '(未命名)')),
              it.role ? h('span', { className: 'ad-crumb-chip' }, it.role) : null,
              it.kind ? h('span', { className: 'ad-crumb-chip' }, it.kind) : null,
              it.status ? h('span', { className: 'ad-crumb-chip' }, it.status === 'open' ? '未回收' : it.status) : null,
              it.episode ? h('span', { className: 'ad-counter' }, `第${it.episode}集`) : null,
            ),
            fields.map(([k, label]) => {
              const v = it[k]
              if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return null
              return h('div', { key: k, style: { fontSize: 12, lineHeight: 1.7 } },
                h('span', { style: { color: 'var(--ad-label-secondary)' } }, `${label}：`),
                h('span', null, Array.isArray(v) ? v.join('、') : String(v)))
            }))))
      }

      function renderStyle() {
        const st = bundle?.style
        if (!st?.style) return h('div', { className: 'ad-empty-state' }, h('div', { className: 'ad-empty-title' }, '还没有风格 DNA'))
        const labels = { palette: '色板', lighting: '光感', texture: '质感', composition: '构图偏好', motion: '运镜节奏' }
        return h('div', { className: 'ad-stack' },
          Object.entries(labels).map(([k, l]) => h('div', { key: k, className: 'ad-card', style: { flexDirection: 'column', alignItems: 'flex-start', gap: 4 } },
            h('div', { className: 'ad-card-title', style: { margin: 0, fontSize: 13 } }, l),
            h('div', { style: { fontSize: 12, lineHeight: 1.7, color: st.style[k] ? undefined : 'var(--ad-label-secondary)' } },
              st.style[k] || '（空）'))))
      }

      function renderScript() {
        const eps = bundle?.scripts || []
        return h(Fragment, null,
          h('div', { className: 'ad-filterbar' },
            h('span', { className: 'ad-count' }, '集'),
            h('select', { className: 'ad-select', style: { maxWidth: 200, fontSize: 12 }, value: scriptEp, onChange: async e => {
              const ep = e.target.value
              setScriptEp(ep); setSaveMsg(null); setSaveErr(null)
              if (ep) { const r = await onLoadScript(ep); setScriptText(r ?? '') } else setScriptText('')
            }},
              h('option', { value: '' }, eps.length ? '选择集…' : '（无剧本文件）'),
              eps.map(f => h('option', { value: f, key: f }, f))),
            scriptEp ? h('button', { className: 'ad-btn ad-sm', onClick: async () => {
              setSaveErr(null); setSaveMsg(null)
              try { const r = await onSaveScript(scriptEp, scriptText); setSaveMsg(`已保存 ${r.bytes} 字节${r.backup ? '（已备份）' : ''}`) }
              catch (err) { setSaveErr(err.message) }
            }}, '保存剧本') : null,
            h('span', { className: 'ad-hint', style: { marginLeft: 'auto' } }, `${eps.length} 集`),
          ),
          saveMsg ? h('div', { className: 'ad-toast ad-toast-ok' }, '✅ ', saveMsg) : null,
          saveErr ? h('div', { className: 'ad-err-box' }, h('div', { className: 'ad-err-head' }, '保存失败'), h('div', { className: 'ad-err' }, saveErr)) : null,
          scriptEp
            ? h(Fragment, null,
                // 编辑区工具条：字数、行数、全屏切换
                h('div', { className: 'ad-row', style: { marginBottom: 6, fontSize: 12 } },
                  h('span', { className: 'ad-counter' },
                    `${scriptText.length} 字 · ${scriptText.split('\n').length} 行`),
                  h('button', {
                    className: 'ad-btn ad-sm ad-btn-ghost', style: { marginLeft: 'auto' },
                    onClick: () => setScriptFull(v => !v),
                    title: scriptFull ? '退出全屏编辑' : '展开到整屏编辑',
                  }, scriptFull ? '⤡ 退出全屏' : '⤢ 全屏编辑'),
                ),
                h('textarea', {
                  className: 'ad-area ad-script-editor',
                  style: scriptFull
                    ? { height: 'calc(100vh - 220px)', minHeight: 480, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, lineHeight: 1.75, resize: 'vertical' }
                    : { height: 460, minHeight: 460, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, lineHeight: 1.75, resize: 'vertical' },
                  value: scriptText,
                  onChange: e => setScriptText(e.target.value),
                  placeholder: 'Markdown 正文…（可直接编辑，保存后自动备份）',
                  spellCheck: false,
                }),
              )
            : h('div', { className: 'ad-empty-state' },
                h('div', { className: 'ad-empty-title' }, eps.length ? '选择一集查看剧本' : '还没有分集剧本'),
                h('div', null, eps.length ? '剧本来自 分集剧本/ 目录，可直接编辑并保存。' : '在 AI 短剧工作区生成剧本后点「重新加载」。')),
        )
      }

      /** 逐镜真实 prompt（出片时实际发给模型的那段话） */
      function renderShotPrompts() {
        const r = shotPrompts
        const rows = (r?.ok && Array.isArray(r.shots)) ? r.shots : []
        const total = rows.reduce((n, x) => n + (x.durationSec || 0), 0)
        return h('div', { className: 'ad-card', style: { flexDirection: 'column', alignItems: 'stretch', gap: 8, marginBottom: 12 } },
          h('div', { className: 'ad-row' },
            h('span', { className: 'ad-card-title', style: { margin: 0 } }, '逐镜出片 Prompt'),
            h('span', { className: 'ad-hint' }, rows.length ? `${rows.length} 镜 · ${total}s` : ''),
            h('button', {
              className: 'ad-btn ad-sm ad-primary', style: { marginLeft: 'auto' },
              disabled: promptRun || !sbEp,
              onClick: () => onLoadShotPrompts(sbEp),
            }, promptRun ? '⏳ 生成中…' : '生成预览'),
          ),
          h('div', { className: 'ad-hint', style: { fontSize: 11, lineHeight: 1.6 } },
            '这里显示的是出片时**真正发给视频模型的提示词**（角色锚点 + 画面 + 景别运镜 + 光影 + 画幅），' +
            '与「出片」页签实际使用的完全同一套构建逻辑。选好分镜表后点「生成预览」。'),
          r?.ok === false ? h('div', { className: 'ad-err' }, r.error) : null,
          rows.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            rows.map((x, i) => h('div', {
              key: i, style: {
                border: '1px solid var(--ad-border)', borderRadius: 6, padding: '6px 8px',
                background: 'var(--ad-subtle-bg)', display: 'flex', flexDirection: 'column', gap: 4,
              },
            },
              h('div', { className: 'ad-row', style: { fontSize: 11, gap: 8 } },
                h('span', { style: { fontWeight: 600, minWidth: 34 } }, `镜${x.shotNumber}`),
                h('span', { className: 'ad-hint' }, `${x.durationSec || '?'}s`),
                x.shotSizeTag ? h('span', { className: 'ad-hint' }, x.shotSizeTag) : null,
                x.characters?.length
                  ? h('span', { className: 'ad-hint', style: { color: 'var(--ad-brand)' } },
                      `角色 ${x.characters.join('/')}`)
                  : h('span', { className: 'ad-hint' }, '无角色'),
                x.sceneRef ? h('span', { className: 'ad-hint' }, `场景 ${x.sceneRef}`) : null,
                x.imageRef ? h('span', {
                  className: 'ad-hint', style: { color: 'var(--ad-success)' },
                  title: '出片时会把该角色定妆图作为首帧参考（i2v）',
                }, '首帧=定妆图') : null,
                h('span', { className: 'ad-hint', style: { marginLeft: 'auto' } }, `${x.length} 字`),
                h('button', {
                  className: 'ad-btn ad-sm',
                  onClick: () => {
                    navigator.clipboard?.writeText(x.prompt).catch(() => {})
                    setSaveMsg({ kind: 'ok', text: `已复制镜 ${x.shotNumber} 的 prompt` })
                  },
                  title: '复制这段 prompt',
                }, '复制'),
              ),
              h('div', { style: { fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, x.prompt),
              x.raw?.videoPrompt && x.raw.videoPrompt !== x.prompt
                ? h('div', { className: 'ad-hint', style: { fontSize: 10, opacity: .75 } },
                    `分镜原写：${x.raw.videoPrompt}`)
                : null,
            )),
          ) : null,
        )
      }

      function renderStoryboardMd() {
        const sbs = (bundle?.storyboards || []).map(f => f)
        return h(Fragment, null,
          h('div', { className: 'ad-filterbar' },
            h('span', { className: 'ad-count' }, '分镜表'),
            h('select', { className: 'ad-select', style: { maxWidth: 220, fontSize: 12 }, value: sbEp, onChange: async e => {
              const ep = e.target.value; setSbEp(ep)
              if (ep) { const r = await onLoadStoryboard(ep); setSbText(r ?? '') } else setSbText('')
            }},
              h('option', { value: '' }, sbs.length ? '选择分镜表…' : '（无分镜表）'),
              sbs.map(f => h('option', { value: f, key: f }, f))),
            h('span', { className: 'ad-hint', style: { marginLeft: 'auto' } }, `${sbs.length} 份`),
          ),
          sbText
            ? h('pre', { className: 'ad-hint-box ad-mono', style: {
                height: 360, minHeight: 360, overflow: 'auto', whiteSpace: 'pre',
                fontSize: 12, lineHeight: 1.7, resize: 'vertical',
              } }, sbText)
            : h('div', { className: 'ad-empty-state' },
                h('div', { className: 'ad-empty-title' }, sbs.length ? '选择一份分镜表' : '还没有分镜表 md'),
                h('div', null, '分镜表 md 由 .aidrama/storyboard/*.json 渲染，只读预览。')),
        )
      }

      let bodyNode
      if (bundleLoading) bodyNode = h('div', { className: 'ad-skeleton' }, h('div', { className: 'ad-skeleton-line w60' }), h('div', { className: 'ad-skeleton-line w90' }))
      else if (bundleError) bodyNode = h('div', { className: 'ad-err-box' }, h('div', { className: 'ad-err-head' }, '加载失败'), h('div', { className: 'ad-err' }, bundleError),
        h('div', { className: 'ad-err-actions' }, h('button', { className: 'ad-btn ad-sm', onClick: onLoad }, '重试')))
      else if (!bundle) bodyNode = h('div', { className: 'ad-empty-state' }, h('div', { className: 'ad-empty-title' }, '还没有数据'),
        h('div', null, '点「重新加载」读取该项目的创作资产。'),
        h('div', { className: 'ad-row', style: { marginTop: 8 } }, h('button', { className: 'ad-btn ad-sm ad-primary', onClick: onLoad }, '重新加载')))
      else {
        const contentMap = {
          contract: renderContract,
          outline: () => renderList('outline', [['logline', '一句话'], ['hook', '钩子'], ['twist', '反转'], ['cliffhanger', '悬念']], '分集大纲'),
          characters: () => renderList('characters', [['bio', '小传'], ['appearancePrompt', '形象提示词'], ['voiceHint', '音色'], ['personality', '性格']], '人物设定'),
          world: () => renderList('world', [['detail', '设定']], '世界观'),
          memory: () => renderList('memory', [['content', '内容']], '本剧记忆'),
          style: renderStyle,
          script: renderScript,
          // 分镜子页：上半是只读表格，下半是逐镜真实出片 prompt
          storyboard: () => h(Fragment, null, renderStoryboardMd(), renderShotPrompts()),
        }
        const subTabsNode = h('div', { className: 'ad-tabs', role: 'tablist', style: { marginBottom: 10 } },
          h('div', { className: 'ad-tab-groups' },
            SUB_TABS.map(([k, l]) => h('button', {
              key: k, className: 'ad-tab', role: 'tab', 'data-on': sub === k ? '1' : '0',
              onClick: () => { setSub(k); setSaveMsg(null); setSaveErr(null) },
            }, l))))
        bodyNode = h(Fragment, null, subTabsNode, (contentMap[sub] || renderContract)())
      }

      return h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 8 } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, `《${project}》创作资产`),
          h('button', { className: 'ad-btn ad-sm', onClick: onLoad }, '重新加载'),
          h('span', { className: 'ad-hint', style: { marginLeft: 'auto' } }, '数据源 .aidrama/*.json'),
        ),
        progressNode,
        castingPanel,
        previewNode,
        aiPanel,
        aiResultNode,
        bodyNode,
      )
    }

    function ConsistencyTab({ project, preflight, pfError, pfLoading, onRun, opts, setOpts }) {
      const gate = preflight?.gate
      const plat = preflight?.platform
      const comp = preflight?.compliance
      const style = preflight?.style
      const chars = preflight?.characters

      // 合规命中 → 统一行结构（先算后渲染，避免深层嵌套括号出错）
      const complianceRows = []
      for (const it of (preflight?.complianceHits?.blocks || [])) {
        complianceRows.push({ code: 'CP-BLOCK', severity: 'fail', shot: it.shot,
          message: `命中「${it.term}」${it.field ? '（' + it.field + '）' : ''}` })
      }
      for (const it of (preflight?.complianceHits?.warns || [])) {
        complianceRows.push({ code: 'CP-WARN', severity: 'warn', shot: it.shot,
          message: `命中「${it.term}」${it.field ? '（' + it.field + '）' : ''}` })
      }

      function SevRow(it, icon) {
        const color = it.severity === 'fail' ? 'var(--ad-err)' : it.severity === 'warn' ? 'var(--ad-warn)' : 'var(--ad-label-secondary)'
        return h('div', { key: `${it.code}-${it.shot || ''}`, className: 'ad-shot-row', style: { cursor: 'default', gap: 8 } },
          h('span', { style: { color, fontWeight: 600, minWidth: 62, fontSize: 12 } }, `${icon} ${it.code}`),
          h('span', { style: { flex: 1, fontSize: 12 } }, it.message),
          it.shot ? h('span', { className: 'ad-shot-no' }, `镜${it.shot}`) : null,
        )
      }

      if (!project) {
        return h('div', { className: 'ad-empty-state' },
          h('div', { className: 'ad-empty-title' }, '尚未选择项目'),
          h('div', null, '在「出片」页签选择短剧项目后回到这里。'))
      }

      const body = pfLoading
        ? h('div', { className: 'ad-skeleton' },
            h('div', { className: 'ad-skeleton-line w60' }),
            h('div', { className: 'ad-skeleton-line w90' }))
        : !preflight
          ? h('div', { className: 'ad-empty-state' },
              h('div', { className: 'ad-empty-title' }, '还没有预检结果'),
              h('div', null, '点「运行预检」检查本集一致性、平台节奏与合规风险。'),
              h('div', { className: 'ad-sub', style: { marginTop: 6 } }, '预检不消耗生成配额。'))
          : h(Fragment, null,
              // —— 概览
              h('div', { className: 'ad-sec' }, '概览'),
              h('div', { className: 'ad-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 10 } },
                h('span', { style: {
                  padding: '2px 10px', borderRadius: 999, fontSize: 12,
                  background: gate?.blocked ? 'var(--ad-error-bg)' : 'var(--ad-subtle-bg)',
                  color: gate?.blocked ? 'var(--ad-err)' : 'var(--ad-success)',
                } }, gate?.blocked ? `❌ ${gate.fails} 项 FAIL` : '✅ 门禁通过'),
                h('span', { className: 'ad-count' }, `检查 ${gate?.checked ?? 0} 镜 · WARN ${gate?.warns ?? 0} · INFO ${gate?.infos ?? 0}`),
                chars ? h('span', { className: 'ad-count' }, `人物卡 ${chars.total} 张 / 锚点 ${chars.anchors} 张`) : null,
                style ? h('span', { className: 'ad-count' }, `风格 ${style.state === 'frozen' ? '已冻结' : style.state === 'directed' ? '已定向' : '草稿'} · ${style.used?.length ?? 0} 维`) : null,
                plat ? h('span', { className: 'ad-count' }, `${plat.profile?.ratio || ''} · 共 ${plat.stats?.totalSec ?? 0}s · 均 ${plat.stats?.avgSec ?? 0}s`) : null,
                comp ? h('span', { className: 'ad-count' }, `合规 block ${comp.blocks ?? 0} / warn ${comp.warns ?? 0}`) : null,
              ),

              // —— 门禁 FAIL
              gate?.fails?.length ? h(Fragment, null,
                h('div', { className: 'ad-sec', style: { color: 'var(--ad-err)' } }, `门禁阻断项（${gate.fails.length}）`),
                h('div', { className: 'ad-shot-list' }, gate.fails.map(it => SevRow(it, '⛔'))) ) : null,

              // —— 门禁 WARN
              gate?.warns?.length ? h(Fragment, null,
                h('div', { className: 'ad-sec' }, `门禁提示（${gate.warns.length}）`),
                h('div', { className: 'ad-shot-list' }, gate.warns.slice(0, 30).map(it => SevRow(it, '⚠️'))) ) : null,

              // —— 平台节奏
              plat?.issues?.length ? h(Fragment, null,
                h('div', { className: 'ad-sec' }, `平台节奏（${plat.profile?.note || ''}）`),
                h('div', { className: 'ad-shot-list' }, plat.issues.map(it => SevRow({ ...it, severity: 'warn' }, '📱'))) ) : null,

              // —— 合规（先算成数组再渲染，避免深层嵌套）
              complianceRows.length ? h(Fragment, null,
                h('div', { className: 'ad-sec', style: { color: comp?.blocks ? 'var(--ad-err)' : undefined } }, '合规风险'),
                h('div', { className: 'ad-shot-list' }, complianceRows.map(it => SevRow(it, it.severity === 'fail' ? '⛔' : '⚠️'))
                ) ) : null,

              // —— 每镜注入预览
              preflight.perShot?.length ? h(Fragment, null,
                h('div', { className: 'ad-sec' }, `逐镜注入预览（${preflight.perShot.length} 镜）`),
                h('div', { className: 'ad-shot-list' },
                  preflight.perShot.map(p => h('div', { key: p.shot, className: 'ad-shot-row', style: { cursor: 'default' } },
                    h('span', { className: 'ad-shot-no' }, `镜${p.shot}`),
                    p.sceneId ? h('span', { className: 'ad-shot-meta' }, p.sceneId) : null,
                    p.anchorPreview
                      ? h('span', { className: 'ad-shot-desc', style: { color: 'var(--ad-success)' } }, '✅ ' + p.anchorPreview.slice(0, 60))
                      : h('span', { className: 'ad-shot-desc', style: { color: 'var(--ad-label-secondary)' } }, '— 无角色锚点'),
                    p.hasEmotion ? h('span', { className: 'ad-shot-meta' }, '情绪') : null,
                    p.durationSec ? h('span', { className: 'ad-shot-meta', style: { marginLeft: 'auto' } }, `${p.durationSec}s`) : null,
                  ))) ) : null,

              // —— 风格 DNA 预览
              style?.suffix ? h(Fragment, null,
                h('div', { className: 'ad-sec' }, '视觉风格注入'),
                h('div', { className: 'ad-hint-box', style: {
                  padding: '8px 10px', borderRadius: 8, background: 'var(--ad-subtle-bg)',
                  fontSize: 12, lineHeight: 1.7, wordBreak: 'break-all',
                } }, style.suffix) ) : null,
            )

      return h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, '一致性预检'),
          h('button', { className: 'ad-btn ad-primary ad-sm', onClick: onRun, disabled: pfLoading || !project },
            pfLoading ? '检查中…' : '运行预检'),
          h('span', { className: 'ad-count', style: { marginLeft: 'auto' } }, '预检不消耗配额'),
        ),
        // —— 开关
        h('div', { className: 'ad-row', style: { marginBottom: 12, flexWrap: 'wrap', gap: 12 } },
          h('label', { className: 'ad-row', style: { gap: 4, fontSize: 12, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: opts.gate, onChange: e => setOpts(o => ({ ...o, gate: e.target.checked })) }),
            '一致性门禁'),
          h('label', { className: 'ad-row', style: { gap: 4, fontSize: 12, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: opts.gateBlock, onChange: e => setOpts(o => ({ ...o, gateBlock: e.target.checked })) }),
            '违规阻断'),
          h('label', { className: 'ad-row', style: { gap: 4, fontSize: 12, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: opts.chain, onChange: e => setOpts(o => ({ ...o, chain: e.target.checked })) }),
            '首帧链式传导'),
          h('label', { className: 'ad-row', style: { gap: 4, fontSize: 12, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: opts.complianceBlock, onChange: e => setOpts(o => ({ ...o, complianceBlock: e.target.checked })) }),
            '合规阻断'),
          h('span', { className: 'ad-count' }, '平台'),
          h('select', { className: 'ad-select', style: { maxWidth: 110, fontSize: 12 }, value: opts.platform, onChange: e => setOpts(o => ({ ...o, platform: e.target.value })),
            title: '投放平台（影响节奏检查与合规词表）' },
            ['其他', '抖音', '快手', '视频号', 'B站', '小红书'].map(x => h('option', { value: x, key: x }, x))),
        ),
        pfError ? h('div', { className: 'ad-err-box' },
          h('div', { className: 'ad-err-head' }, '预检失败'),
          h('div', { className: 'ad-err' }, pfError)) : null,
        body,
      )
    }

    function ArtifactsTab({ project, artifacts, artError, onRefresh, onOpen }) {
      const [previewPath, setPreviewPath] = useState(null)
      const [q, setQ] = useState('')
      const [sortBy, setSortBy] = useState('name')

      const qn = String(q || '').trim().toLowerCase()
      let visible = artifacts.filter(a => !qn || String(a.name).toLowerCase().includes(qn))
      if (sortBy === 'size') visible = [...visible].sort((a, b) => (b.size || 0) - (a.size || 0))
      else if (sortBy === 'mtime') visible = [...visible].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
      else visible = [...visible].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))

      const totalBytes = artifacts.reduce((n, a) => n + (a.size || 0), 0)
      const fmtSize = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`
      const fmtTime = (t) => t ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

      const list = visible.map(a =>
        h('div', { key: a.path, className: 'ad-shot-row', style: { cursor: 'default' } },
          h('span', { style: { flex: 1, fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.name),
          h('span', { className: 'ad-shot-meta', style: { minWidth: 64, textAlign: 'right' } }, fmtSize(a.size)),
          h('span', { className: 'ad-shot-meta', style: { minWidth: 76 } }, fmtTime(a.mtime)),
          h('button', { className: 'ad-btn ad-sm', onClick: () => setPreviewPath(previewPath === a.path ? null : a.path) }, previewPath === a.path ? '收起' : '预览'),
          h('button', { className: 'ad-btn ad-sm ad-btn-ghost', onClick: () => onOpen(a.path) }, '打开'),
        ),
      )

      return h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 8 } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, project ? `《${project}》产物` : '选择项目后查看产物'),
          h('button', { className: 'ad-btn ad-sm', onClick: onRefresh }, '刷新'),
        ),
        // 产物概览指标
        artifacts.length ? h('div', { className: 'ad-grid ad-grid-3', style: { marginBottom: 10 } },
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value' }, String(artifacts.length)), h('div', { className: 'ad-stat-label' }, '切片总数')),
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value' }, fmtSize(totalBytes)), h('div', { className: 'ad-stat-label' }, '占用空间')),
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value' }, fmtTime(artifacts[0]?.mtime)), h('div', { className: 'ad-stat-label' }, '最近生成')),
        ) : null,
        // 搜索与排序
        artifacts.length ? h('div', { className: 'ad-filterbar' },
          h('input', { className: 'ad-input ad-search', value: q, placeholder: '搜索文件名', onChange: e => setQ(e.target.value), 'aria-label': '搜索产物' }),
          h('span', { className: 'ad-count' }, '排序'),
          h('select', { className: 'ad-select', style: { maxWidth: 120, fontSize: 12 }, value: sortBy, onChange: e => setSortBy(e.target.value) },
            [['name', '按名称'], ['mtime', '按时间'], ['size', '按大小']].map(([k, l]) => h('option', { value: k, key: k }, l))),
          h('span', { className: 'ad-counter', 'data-over': visible.length === 0 ? '1' : '0' }, `${visible.length}/${artifacts.length}`),
        ) : null,
        artError ? h('div', { className: 'ad-err-box' }, h('div', { className: 'ad-err-head' }, '加载失败'), h('div', { className: 'ad-err' }, artError)) : null,
        artifacts.length === 0
          ? h('div', { className: 'ad-empty-state' },
              h('div', { className: 'ad-empty-title' }, artError ? '产物加载失败' : '暂无产物'),
              h('div', null, artError ? '检查项目是否有「素材/生成」目录。' : '去「出片」页签生成视频后，这里会列出成品。'),
              h('div', { className: 'ad-hint' }, '生成完成后可内联预览或系统打开。'))
          : visible.length === 0
            ? h('div', { className: 'ad-empty-state' },
                h('div', { className: 'ad-empty-title' }, '没有匹配的产物'),
                h('div', null, `关键词「${q}」`),
                h('div', { className: 'ad-row', style: { marginTop: 8 } },
                  h('button', { className: 'ad-btn ad-sm', onClick: () => setQ('') }, '清除搜索')))
            : h('div', { className: 'ad-shot-list' }, ...list),
        previewPath
          ? h('div', { className: 'ad-video-shell' },
              h('video', { src: `${API_BASE}media?file=${encodeURIComponent(previewPath)}`, controls: true, autoPlay: false }))
          : null,
      )
    }

    /* ---------------------------------------------------------------- 账号页签 */
        function AccountsTab({ accounts, accError, onRefresh }) {
      const [q, setQ] = useState('')
      const expiredCount = accounts.filter(a => a.expired).length
      const usable = accounts.length - expiredCount
      const qn = String(q || '').trim().toLowerCase()
      const visible = accounts.filter(a => {
        if (!qn) return true
        const hay = [a.name, a.nickname, a.phone, a.uid, a.email, a.ref].filter(Boolean).join(' ').toLowerCase()
        return hay.includes(qn)
      })
      const list = visible.map(a =>
        h('div', { key: a.ref, className: 'ad-shot-row', style: { cursor: 'default' } },
          h('span', { className: 'ad-shot-meta ad-mono' }, a.ref),
          h('span', { style: { flex: 1, fontSize: 12, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            a.name || a.nickname || a.phone || a.uid || '—'),
          a.email ? h('span', { className: 'ad-shot-meta ad-ellipsis' }, a.email) : null,
          h('span', { className: 'ad-shot-meta', style: { color: a.expired ? 'var(--ad-err)' : 'var(--ad-success)', minWidth: 44 } },
            a.expired ? '已过期' : '可用'),
        ),
      )
      return h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 8 } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, 'Trae 账号池'),
          h('button', { className: 'ad-btn ad-sm', onClick: onRefresh }, '刷新'),
          h('span', { className: 'ad-hint', style: { marginLeft: 'auto' } }, '账号来自 ~/.dsh/.credentials.yaml'),
        ),
        // 汇总指标
        accounts.length ? h('div', { className: 'ad-grid ad-grid-3', style: { marginBottom: 10 } },
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value' }, String(accounts.length)), h('div', { className: 'ad-stat-label' }, '账号总数')),
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value', style: { color: 'var(--ad-success)' } }, String(usable)), h('div', { className: 'ad-stat-label' }, '当前可用')),
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value', style: { color: expiredCount ? 'var(--ad-err)' : 'var(--ad-label-secondary)' } }, String(expiredCount)), h('div', { className: 'ad-stat-label' }, '已过期')),
        ) : null,
        accounts.length ? h('div', { className: 'ad-filterbar' },
          h('input', { className: 'ad-input ad-search', value: q, placeholder: '搜索账号 / 手机号 / uid', onChange: e => setQ(e.target.value), 'aria-label': '搜索账号' }),
          h('span', { className: 'ad-counter', 'data-over': visible.length === 0 ? '1' : '0' }, `${visible.length}/${accounts.length}`),
        ) : null,
        accError ? h('div', { className: 'ad-err-box' }, h('div', { className: 'ad-err-head' }, '账号加载失败'), h('div', { className: 'ad-err' }, accError)) : null,
        accounts.length === 0
          ? h('div', { className: 'ad-empty-state' },
              h('div', { className: 'ad-empty-title' }, accError ? '账号加载失败' : '未检测到 Trae 账号'),
              h('div', null, accError ? '检查 ~/.dsh/.credentials.yaml 是否可读。' : '先在 our-free-model 里登录 TRAE 账号。'),
              h('div', { className: 'ad-hint' }, '账号会自动续期；过期账号会在出片时被跳过。'))
          : visible.length === 0
            ? h('div', { className: 'ad-empty-state' },
                h('div', { className: 'ad-empty-title' }, '没有匹配的账号'),
                h('div', null, `关键词「${q}」`),
                h('div', { className: 'ad-row', style: { marginTop: 8 } },
                  h('button', { className: 'ad-btn ad-sm', onClick: () => setQ('') }, '清除搜索')))
            : h('div', { className: 'ad-shot-list' }, ...list),
      )
    }

    /* ---------------------------------------------------------------- 统计页签 */
    function StatsTab({ history, stats, histError, onRefresh }) {
      const [q, setQ] = useState('')
      const [statusFilter, setStatusFilter] = useState('all')

      const doneCount = history.filter(j => j.status === 'done').length
      const failedCount = history.filter(j => j.status === 'failed').length
      const runningCount = history.filter(j => j.status === 'running' || j.status === 'queued').length
      const totalShots = history.reduce((n, j) => n + (j.progress?.total || 0), 0)
      const okRate = history.length ? Math.round(doneCount / history.length * 100) : 0

      const qn = String(q || '').trim().toLowerCase()
      const visible = history.slice().reverse().filter(j => {
        if (statusFilter !== 'all' && j.status !== statusFilter) return false
        if (!qn) return true
        return [j.project, j.episode, j.id, j.error].filter(Boolean).join(' ').toLowerCase().includes(qn)
      })

      const fmtDur = (j) => {
        if (!j.startedAt) return '—'
        const end = j.finishedAt || Date.now()
        const s2 = Math.round((end - j.startedAt) / 1000)
        return s2 >= 60 ? `${Math.floor(s2 / 60)}m${s2 % 60}s` : `${s2}s`
      }

      const rows = visible.map(j => {
        const statusTxt = j.status === 'done' ? '✅ 完成' : j.status === 'failed' ? '❌ 失败' : j.status === 'running' ? '⏳ 进行中' : '排队'
        const color = j.status === 'failed' ? 'var(--ad-err)' : j.status === 'done' ? 'var(--ad-success)' : 'var(--ad-label-secondary)'
        const total = j.progress?.total || 0
        const done = j.progress?.done || 0
        const pct = total ? Math.round(done / total * 100) : 0
        return h('div', { key: j.id, className: 'ad-shot-row', style: { cursor: 'default' } },
          h('span', { style: { fontSize: 12, fontWeight: 500, minWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, j.project || '(未命名)'),
          h('span', { className: 'ad-shot-meta', style: { minWidth: 70 } }, j.episode || '—'),
          h('span', { className: 'ad-shot-meta', style: { minWidth: 56, textAlign: 'right' } }, `${done}/${total}`),
          total ? h('div', { style: { width: 60, height: 4, borderRadius: 2, background: 'var(--ad-border)', marginLeft: 6, overflow: 'hidden' } },
            h('div', { style: { width: `${pct}%`, height: '100%', background: j.status === 'failed' ? 'var(--ad-err)' : 'var(--ad-brand)' } })) : null,
          h('span', { style: { minWidth: 66, fontSize: 12, marginLeft: 'auto', textAlign: 'right', color } }, statusTxt),
          h('span', { className: 'ad-shot-meta', style: { minWidth: 52, textAlign: 'right' } }, fmtDur(j)),
          h('span', { className: 'ad-shot-meta ad-mono', style: { minWidth: 60, opacity: .6 } }, (j.id || '').slice(0, 8)),
        )
      })

      return h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 8 } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, '生成历史与统计'),
          h('button', { className: 'ad-btn ad-sm', onClick: onRefresh }, '刷新'),
          h('span', { className: 'ad-hint', style: { marginLeft: 'auto' } }, '持久化于 ~/.dsh/drama-trae/jobs.jsonl'),
        ),
        // 汇总指标
        history.length ? h('div', { className: 'ad-grid ad-grid-4', style: { marginBottom: 10 } },
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value' }, String(history.length)), h('div', { className: 'ad-stat-label' }, '任务总数')),
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value', style: { color: 'var(--ad-success)' } }, `${okRate}%`), h('div', { className: 'ad-stat-label' }, '成功率')),
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value' }, String(totalShots)), h('div', { className: 'ad-stat-label' }, '累计镜数')),
          h('div', { className: 'ad-stat' }, h('div', { className: 'ad-stat-value', style: { color: runningCount ? 'var(--ad-brand)' : 'var(--ad-label-secondary)' } }, String(runningCount)), h('div', { className: 'ad-stat-label' }, '进行中')),
        ) : null,
        history.length ? h('div', { className: 'ad-filterbar' },
          h('input', { className: 'ad-input ad-search', value: q, placeholder: '搜索项目 / 集 / 任务号', onChange: e => setQ(e.target.value), 'aria-label': '搜索历史' }),
          h('div', { className: 'ad-chip-group', role: 'group', 'aria-label': '按状态筛选' },
            [['all', '全部'], ['done', '完成'], ['failed', '失败'], ['running', '进行中']].map(([k, l]) =>
              h('button', { key: k, className: 'ad-chip', 'data-on': statusFilter === k ? '1' : '0', onClick: () => setStatusFilter(k) }, l))),
          h('span', { className: 'ad-counter', 'data-over': visible.length === 0 ? '1' : '0' }, `${visible.length}/${history.length}`),
        ) : null,
        histError ? h('div', { className: 'ad-err-box' }, h('div', { className: 'ad-err-head' }, '历史加载失败'), h('div', { className: 'ad-err' }, histError)) : null,
        history.length === 0
          ? h('div', { className: 'ad-empty-state' },
              h('div', { className: 'ad-empty-title' }, histError ? '历史加载失败' : '还没有生成记录'),
              h('div', null, histError ? '检查 ~/.dsh/drama-trae/jobs.jsonl 是否可读。' : '去「出片」页签跑一次出片，这里会记录每次任务。'),
              h('div', { className: 'ad-hint' }, '每个任务记录耗时、镜数、成功率与失败原因。'))
          : visible.length === 0
            ? h('div', { className: 'ad-empty-state' },
                h('div', { className: 'ad-empty-title' }, '没有匹配的记录'),
                h('div', { className: 'ad-row', style: { marginTop: 8 } },
                  h('button', { className: 'ad-btn ad-sm', onClick: () => { setQ(''); setStatusFilter('all') } }, '清除筛选')))
            : h('div', { className: 'ad-shot-list' }, ...rows),
      )
    }

    /* ---------------------------------------------------------------- 主面板 */
    function DramaPanel() {
      const [phase, setPhase] = useState('loading') // loading | ready | error
      const [tab, setTab] = useState('generate')
      const [projects, setProjects] = useState([])
      // 首屏直接从持久化恢复，避免「切回来要重选」
      const [project, setProject] = useState(() => String(loadSelection().project || ''))
      const [episode, setEpisode] = useState(() => String(loadSelection().episode || ''))
      const [shots, setShots] = useState([])
      const [checked, setChecked] = useState(new Set())
      const [ratio, setRatio] = useState('9:16')
      const [resolution, setResolution] = useState('720p')
      const [duration, setDuration] = useState('')
      const [dramaRoot, setDramaRoot] = useState(() => String(loadSelection().dramaRoot || ''))

      // 选择项一变更就落盘，切走/刷新/换会话都能恢复
      const setProjectPersist = (v) => { const val = String(v ?? ''); setProject(val); saveSelection({ project: val }) }
      const setEpisodePersist = (v) => { const val = String(v ?? ''); setEpisode(val); saveSelection({ episode: val }) }
      const setDramaRootPersist = (v) => { const val = String(v ?? ''); setDramaRoot(val); saveSelection({ dramaRoot: val }) }
      const [listError, setListError] = useState('')
      const [roots, setRoots] = useState([])
      // 创作资产（ai-drama 流程集成）
      const [bundle, setBundle] = useState(null)
      const [bundleError, setBundleError] = useState(null)
      const [bundleLoading, setBundleLoading] = useState(false)
      const [links, setLinks] = useState(null)
      const [linksError, setLinksError] = useState(null)
      // 缺口修正（让 AI 带着具体缺口重跑某阶段）
      const [repairState, setRepairState] = useState(null)
      // AI 创作
      const [ai, setAi] = useState({ idea: '' })
      const [aiTaskId, setAiTaskId] = useState(null)
      const [aiRun, setAiRun] = useState(false)

      // 角色定妆：文生图出角色标准照，出片时作为 i2v 首帧，跨镜保脸
      const [casting, setCasting] = useState(null)   // {castings, characters}
      const [castingRun, setCastingRun] = useState(false)
      const [castingMsg, setCastingMsg] = useState(null)
      const [castingPreview, setCastingPreview] = useState(null)   // 放大预览的角色
      const [shotPrompts, setShotPrompts] = useState(null)         // 逐镜真实 prompt
      const [promptRun, setPromptRun] = useState(false)
      const [quotaEst, setQuotaEst] = useState(null)
      const [quotaLoading, setQuotaLoading] = useState(false)
      const [forceGen, setForceGen] = useState(false)
      const [warmupRun, setWarmupRun] = useState(false)
      const [warmupResult, setWarmupResult] = useState(null)

      /** 账号预热：探一遍全部账号写账本（成功后出片直接按账本选号） */
      async function runWarmup() {
        if (!project || warmupRun) return
        setWarmupRun(true)
        setWarmupResult(null)
        try {
          const r = await api('warmup', {
            project, shotsNeeded: shots?.length || 0, concurrency: 4,
            ...(dramaRoot ? { dramaRoot } : {}),
          })
          if (r?.ok) {
            setWarmupResult(r)
            // 预热会改写账本，顺手刷新预估
            loadQuotaEstimate(shots?.length || 0)
          } else {
            setWarmupResult({ ok: false, error: r?.error || '预热失败' })
          }
        } catch (e) {
          setWarmupResult({ ok: false, error: e.message })
        } finally { setWarmupRun(false) }
      }

      /** 出片前配额预估（读账本，不探测、不耗配额） */
      async function loadQuotaEstimate(shotsNeeded) {
        if (!project) return
        setQuotaLoading(true)
        try {
          const r = await api('quota-estimate', {
            project, shotsNeeded: Number(shotsNeeded || 0), ...(dramaRoot ? { dramaRoot } : {}),
          })
          if (r?.ok) setQuotaEst(r)
        } catch (e) { /* 预估失败不影响出片 */ } finally { setQuotaLoading(false) }
      }

      async function loadCasting() {
        if (!project) return
        try {
          const r = await api('casting', { action: 'list', project, ...(dramaRoot ? { dramaRoot } : {}) })
          if (r?.ok) setCasting({ castings: r.castings || [], characters: r.characters || [] })
        } catch (e) { setCastingMsg({ kind: 'err', text: e.message }) }
      }

      /** 拉取逐镜「出片时真正会发的 prompt」 */
      async function loadShotPrompts(episode) {
        if (!project || !episode) return
        setPromptRun(true)
        try {
          const r = await api('shot-prompts', {
            project, episode, ...(dramaRoot ? { dramaRoot } : {}),
            ratio: (ai?.ratio || '9:16'),
          })
          if (r?.ok) setShotPrompts(r)
          else setShotPrompts({ ok: false, error: r?.error || '未知错误' })
        } catch (e) {
          setShotPrompts({ ok: false, error: e.message })
        } finally { setPromptRun(false) }
      }

      async function onCast(names, force) {
        if (!project) return
        setCastingRun(true)
        setCastingMsg({ kind: 'info', text: '正在出定妆图…（每个角色一张，约 10–20 秒）' })
        try {
          const r = await api('casting', {
            action: 'cast', project, names, force: Boolean(force),
            ...(dramaRoot ? { dramaRoot } : {}),
          })
          if (r?.ok) {
            setCastingMsg({ kind: 'ok', text: `已定妆 ${r.casted ?? 0} 个角色` })
          } else {
            const f = r?.failed?.[0]
            setCastingMsg({ kind: 'err', text: `定妆失败：${f ? `${f.name} ${f.error}` : (r?.error || '未知错误')}` })
          }
          await loadCasting()
        } catch (e) {
          setCastingMsg({ kind: 'err', text: e.message })
        } finally { setCastingRun(false) }
      }
      const [aiProgress, setAiProgress] = useState(null)
      const [llmStatus, setLlmStatus] = useState(null)
      // 新建项目
      const [creating, setCreating] = useState(false)
      const [newTitle, setNewTitle] = useState('')
      const [createError, setCreateError] = useState(null)
      const [shotsError, setShotsError] = useState('')
      const [busy, setBusy] = useState(false)
      // 一致性预检与出片选项（P0-P2 改造的前端暴露）
      const [preflight, setPreflight] = useState(null)
      const [pfError, setPfError] = useState(null)
      const [pfLoading, setPfLoading] = useState(false)
      const [genOpts, setGenOpts] = useState({
        gate: true, gateBlock: false, chain: false, complianceBlock: false, platform: '其他',
      })
      const [taskId, setTaskId] = useState(null)
      const [jobProgress, setJobProgress] = useState(null)
      const [lot, setLot] = useState(new Map())
      const [artifacts, setArtifacts] = useState([])
      const [artError, setArtError] = useState('')
      const [accounts, setAccounts] = useState([])
      const [accError, setAccError] = useState('')
      const [history, setHistory] = useState([])
      const [stats, setStats] = useState(null)
      const [histError, setHistError] = useState('')
      const pollTimer = useRef(null)

      async function refreshProjects() {
        setListError('')
        try {
          const r = await api('list', dramaRoot ? { dramaRoot } : {})
          setProjects(r.projects || [])
          setRoots(r.roots || [])
        }
        catch (e) { setListError(e.message); setPhase('error') }
        setPhase('ready')
      }
      async function refreshShots() {
        if (!project) { setShots([]); setChecked(new Set()); return }
        setShotsError('')
        try {
          const r = await api('shots', { dramaRoot: dramaRoot || undefined, project, episode: episode || undefined })
          const list = r.shots || []
          setShots(list)
          setChecked(new Set(list.map(s => String(s.shotNumber || s.shot)).filter(Boolean)))
        } catch (e) { setShotsError(e.message) }
      }
      async function refreshArtifacts() {
        if (!project) { setArtifacts([]); return }
        setArtError('')
        try { const r = await api('artifacts', { dramaRoot: dramaRoot || undefined, project }); setArtifacts(r.artifacts || []) }
        catch (e) { setArtError(e.message) }
      }
      async function refreshAccounts() {
        setAccError('')
        try { const r = await api('accounts', {}); setAccounts(r.accounts || []) }
        catch (e) { setAccError(e.message) }
      }
      async function refreshHistory() {
        setHistError('')
        try { const r = await api('history', {}); setHistory(r.history || []); setStats(r.stats || null) }
        catch (e) { setHistError(e.message) }
      }
      async function openFile(filePath) {
        try { await api('open', { filePath }) } catch (e) { window.alert(e.message) }
      }

      useEffect(() => { refreshProjects(); refreshAccounts() }, [])
      useEffect(() => { refreshShots() }, [project, episode, dramaRoot])
      async function onRefreshLlm() {
        setLlmStatus(null)
        try {
          const r = await api('llm-status', {})
          setLlmStatus(r)
        } catch (e) {
          setLlmStatus({ available: false, reason: e.message, providers: [], models: [] })
        }
      }

      /** 按集生成剧本/分镜：调用 /ai-episode，直接落盘。 */
      async function onAiEpisode(stage, episodeNo) {
        const ep = Number(episodeNo)
        if (!Number.isFinite(ep) || ep < 1) return
        const label = STAGES_CLIENT[stage] || stage
        setAiRun(true)
        setAiProgress({ done: 0, total: 1, stages: [], current: { stage, label }, result: null })
        try {
          const r = await api('ai-episode', {
            project, stage, episode: ep,
            ...(dramaRoot ? { dramaRoot } : {}),
            ...(ai?.model ? { model: ai.model } : {}),
          })
          setAiProgress({
            done: 1, total: 1,
            stages: [{ stage, label: `${label} 第${ep}集`, ok: true, bytes: r.saved?.bytes || 0, elapsedMs: r.elapsedMs, warn: r.durationWarn || null }],
            result: { stages: [{ stage, ok: true }], assets: { [stage]: r.data }, applied: [stage], episode: ep },
            appliedMsg: `已写入 ${r.saved?.episode || ''}`,
          })
          // 刷新资产（剧本/分镜清单会变）
          await loadCreation()
        } catch (e) {
          setAiProgress({
            done: 0, total: 1,
            stages: [{ stage, label: `${label} 第${ep}集`, ok: false, error: e.message }],
            result: null, error: e.message,
          })
        } finally {
          setAiRun(false)
        }
      }

      async function onAiStage(stage) {
        const idea = String(ai?.idea || '').trim()
        // 只有「立项契约」由想法驱动；其余阶段吃已有资产，不该被想法卡住
        if (stage === 'contract' && !idea) { setAiProgress({ error: '生成立项契约需要先填写想法' }); return }
        setAiRun(true)
        setAiProgress({ done: 0, total: 1, stages: [], current: { stage, label: STAGES_CLIENT[stage] }, result: null })
        try {
          const r = await api('ai-create-stage', {
            stage, idea,
            ...(ai?.model ? { model: ai.model } : {}),
            // 单阶段重跑时把已有资产作为上下文，保证输出与前序一致
            context: {
              ...(bundle?.contract ? { contract: bundle.contract } : {}),
              ...(bundle?.outline?.length ? { outline: bundle.outline } : {}),
              ...(bundle?.characters?.length ? { characters: bundle.characters } : {}),
              ...(bundle?.world?.length ? { world: bundle.world } : {}),
            },
          })
          setAiProgress({
            done: 1, total: 1,
            stages: [{ stage, label: STAGES_CLIENT[stage] || stage, ok: true, bytes: JSON.stringify(r.data).length, elapsedMs: r.elapsedMs }],
            result: { stages: [{ stage, ok: true }], assets: { [stage]: r.data } },
          })
        } catch (e) {
          setAiProgress({
            done: 0, total: 1,
            stages: [{ stage, label: STAGES_CLIENT[stage] || stage, ok: false, error: e.message }],
            result: null, error: e.message,
          })
        } finally {
          setAiRun(false)
        }
      }

      async function onAiGenerate() {
        const idea = String(ai?.idea || '').trim()
        // 全链从想法开始；若已有契约，可以不填想法直接续跑后续阶段
        if (!idea && !bundle?.contract) {
          setAiProgress({ error: '生成全链需要想法，或项目已有立项契约' })
          return
        }
        setAiRun(true); setAiProgress({ done: 0, total: 6, stages: [], current: null, result: null })
        try {
          const r = await api('ai-create', {
            project, idea,
            ...(dramaRoot ? { dramaRoot } : {}),
            ...(ai?.model ? { model: ai.model } : {}),
          })
          setAiTaskId(r.taskId)
        } catch (e) {
          setAiRun(false)
          setAiProgress(p => ({ ...(p || {}), error: e.message }))
        }
      }

      // 轮询 AI 任务进度
      useEffect(() => {
        if (!aiTaskId) return
        let cancelled = false
        const tick = async () => {
          try {
            const st = await api('status', { taskId: aiTaskId })
            if (cancelled) return
            const stages = (st.result?.stages || []).filter(x => x.ok || x.error)
            setAiProgress({
              done: stages.filter(x => x.ok).length,
              total: st.progress?.total || 6,
              stages,
              current: st.progress?.current || null,
              result: st.result || null,
              status: st.status,
              error: st.error,
            })
            if (st.status === 'done' || st.status === 'failed') {
              setAiRun(false); setAiTaskId(null)
              if (st.status === 'done' && st.result?.assets) await loadCreation()
            } else {
              setTimeout(tick, 1500)
            }
          } catch (e) {
            if (!cancelled) { setAiRun(false); setAiTaskId(null) }
          }
        }
        tick()
        return () => { cancelled = true }
      }, [aiTaskId])

      async function onApplyAi(assets, keys) {
        const saved = []
        try {
          for (const k of keys) {
            if (!assets[k]) continue
            await api('save-asset', { project, kind: k, data: assets[k], ...(dramaRoot ? { dramaRoot } : {}) })
            saved.push(k)
          }
          await loadCreation()
          setAiProgress(p => ({ ...(p || {}), applied: saved }))
        } catch (e) {
          setAiProgress(p => ({ ...(p || {}), error: `写入失败（已写入 ${saved.length} 项）：${e.message}` }))
        }
      }

      async function onRepair(stage, hints) {
        if (!project || !hints?.length) return
        setRepairState({ running: true, stage, hints })
        try {
          const r = await api('ai-repair', {
            stage,
            hints,
            context: {
              ...(bundle?.contract ? { contract: bundle.contract } : {}),
              ...(bundle?.outline?.length ? { outline: bundle.outline } : {}),
              ...(bundle?.characters?.length ? { characters: bundle.characters } : {}),
              ...(bundle?.world?.length ? { world: bundle.world } : {}),
              ...(bundle?.memory?.length ? { memory: bundle.memory } : {}),
            },
            ...(ai?.model ? { model: ai.model } : {}),
          })
          setRepairState({ stage, hints, result: r, running: false })
        } catch (e) {
          setRepairState({ stage, hints, error: e.message, running: false })
        }
      }

      async function onApplyRepair() {
        const st = repairState
        if (!st?.result?.data) return
        try {
          // 修复是「补/改」不是「替换」：用 merge 保住原有条目
          await api('save-asset', {
            project, kind: st.stage, data: st.result.data, mode: 'merge',
            ...(dramaRoot ? { dramaRoot } : {}),
          })
          setRepairState(null)
          await loadCreation()
        } catch (e) {
          setRepairState({ ...st, error: `写入失败：${e.message}` })
        }
      }

      async function loadCreation() {
        if (!project) return
        setBundleLoading(true); setBundleError(null)
        try {
          const r = await api('creation', { project, ...(dramaRoot ? { dramaRoot } : {}) })
          setBundle(r)
          setLinks(r.links || null)
          setLinksError(null)
        } catch (e) {
          setBundleError(e.message); setBundle(null); setLinksError(e.message); setLinks(null)
        } finally {
          setBundleLoading(false)
        }
      }
      async function saveAsset(kind, data) {
        return api('save-asset', { project, kind, data, ...(dramaRoot ? { dramaRoot } : {}) })
      }
      async function loadScriptText(episode) {
        const r = await api('script', { project, episode, ...(dramaRoot ? { dramaRoot } : {}) })
        return r.content || ''
      }
      async function saveScriptText(episode, content) {
        return api('script', { project, episode, content, action: 'save', ...(dramaRoot ? { dramaRoot } : {}) })
      }
      async function loadStoryboardText(episode) {
        const r = await api('storyboard-md', { project, episode, ...(dramaRoot ? { dramaRoot } : {}) })
        return r.content || ''
      }

      async function createProject() {
        const title = String(newTitle || '').trim()
        if (!title) { setCreateError('剧名不能为空'); return }
        setCreateError(null)
        try {
          const r = await api('create-project', {
            title,
            ...(dramaRoot ? { dramaRoot } : {}),
            ...(episode ? {} : {}),
          })
          setNewTitle('')
          setCreating(false)
          await refreshProjects()
          if (r.title) setProjectPersist(r.title)
        } catch (e) {
          setCreateError(e.message)
        }
      }

      async function runPreflight() {
        if (!project) { setPfError('请先选择项目'); return }
        setPfLoading(true); setPfError(null)
        try {
          const r = await api('preflight', {
            project, dramaRoot,
            ...(episode ? { episode } : {}),
            platform: genOpts.platform,
          })
          setPreflight(r)
        } catch (e) {
          setPfError(e.message); setPreflight(null)
        } finally {
          setPfLoading(false)
        }
      }

      useEffect(() => { if (tab === 'artifacts') refreshArtifacts() }, [tab, project])
      useEffect(() => { if (tab === 'stats') refreshHistory() }, [tab])
      useEffect(() => { if (tab === 'consistency' && project && !preflight && !pfLoading) runPreflight() }, [tab, project])
      // 创作与总览都依赖同一份资产与关联图，任一页签进入都要加载
      useEffect(() => {
        if ((tab === 'creation' || tab === 'overview') && project && !bundleLoading && (!bundle || !links)) {
          loadCreation()
        }
      }, [tab, project])
      useEffect(() => { if (tab === 'creation' && llmStatus === null) onRefreshLlm() }, [tab])
      // 进创作页或换项目时加载定妆状态（否则面板永远是 0/0）
      useEffect(() => {
        if ((tab === 'creation' || tab === 'overview') && project) loadCasting()
      }, [tab, project, dramaRoot])
      // 已有 bundle 但缺 links（老版本缓存）时，进总览页补算
      useEffect(() => {
        if (tab === 'overview' && bundle && !links && !bundleLoading) loadCreation()
      }, [tab, bundle, links])

      useEffect(() => {
        if (!taskId) return
        const poll = async () => {
          try {
            const res = await api('status', { taskId })
            const j = res.job
            const total = j.progress?.total || 0
            const done = j.progress?.done || 0
            setJobProgress({
              status: j.status, done, total,
              pct: total ? Math.round(done / total * 100) : 0,
              error: j.error,
              currentText: describeJobEvent(j.progress?.current),
            })
            const m = new Map()
            for (const r of j.results || []) if (r.shot) m.set(String(r.shot), { status: 'done' })
            for (const r of j.errors || []) if (r.shot) m.set(String(r.shot), { status: 'failed' })
            const cur = j.progress?.current
            if (cur?.type === 'start' && cur.shot) m.set(String(cur.shot), { status: 'running' })
            setLot(m)
            // 三个终态都要停轮询。旧写法只认 done/failed，partial（部分成功）
            // 会让轮询永远跑下去、busy 永远为 true、出片按钮永久禁用。
            if (TERMINAL_JOB_STATUS.has(j.status)) {
              clearInterval(pollTimer.current); setBusy(false)
              if (j.status === 'done' || j.status === 'partial') refreshArtifacts()
            }
          } catch { /* 忽略 */ }
        }
        poll()
        pollTimer.current = setInterval(poll, 2500)
        return () => clearInterval(pollTimer.current)
      }, [taskId])

      async function startGenerate() {
        const selected = shots.filter(s => checked.has(String(s.shotNumber || s.shot)))
        if (selected.length === 0) { window.alert('请先勾选要生成的镜头'); return }
        setBusy(true); setJobProgress(null)
        setLot(new Map(selected.map(s => [String(s.shotNumber || s.shot), { status: 'idle' }])))
        try {
          const res = await api('generate', {
            dramaRoot: dramaRoot || undefined,
            project,
            episode: episode || undefined,
            shots: selected.map(s => String(s.shotNumber || s.shot)),
            ratio, resolution,
            ...(duration ? { duration: Number(duration) } : {}),
            // P0-P2 改造的开关，直通 host 的 runOneShotDrama
            gate: genOpts.gate,
            gateBlockOnFail: genOpts.gateBlock,
            chainFrames: genOpts.chain,
            complianceBlock: genOpts.complianceBlock,
            platform: genOpts.platform,
            force: forceGen,
          })
          setTaskId(res.taskId)
        } catch (e) { setBusy(false); window.alert(e.message) }
      }

      const TAB_GROUPS = [
        { id: 'core', label: '创作', tabs: [['creation', '创作'], ['overview', '总览'], ['generate', '出片'], ['consistency', '一致性']] },
        { id: 'deliver', label: '交付', tabs: [['artifacts', '产物']] },
        { id: 'ops', label: '运维', tabs: [['accounts', '账号'], ['stats', '统计']] },
      ]
      const tabLabelOf = new Map(TAB_GROUPS.flatMap(g => g.tabs))
      const groupedTabs = TAB_GROUPS.map(g => ({ ...g, items: g.tabs }))
      const visibleTabKeys = groupedTabs.flatMap(g => g.tabs.map(([key]) => key))

      function renderMainTab(key, label) {
        return h('button', {
          key, id: 'ad-tab-' + key, className: 'ad-tab', role: 'tab',
          'aria-selected': tab === key ? 'true' : 'false',
          'aria-controls': 'ad-tabpanel',
          'data-on': tab === key ? '1' : '0',
          tabIndex: tab === key ? 0 : -1,
          onClick: () => setTab(key),
        }, label)
      }
      const tabsNode = h('div', { className: 'ad-tabs', key: 'tabs' },
        h('div', { className: 'ad-tab-groups', role: 'tablist', 'aria-label': '短剧出片页签' },
          groupedTabs.map(group => h('div', { className: 'ad-tab-group', key: group.id, role: 'presentation' },
            h('span', { className: 'ad-tab-group-label' }, group.label),
            group.items.map(([key, label]) => renderMainTab(key, label))))),
      )

      let panel = null
      if (phase === 'loading') {
        panel = h('div', { className: 'ad-skeleton', role: 'status', 'aria-label': '加载中骨架' },
          h('div', { className: 'ad-skeleton-line w60' }),
          h('div', { className: 'ad-skeleton-line w90' }),
          h('div', { className: 'ad-skeleton-line w80' }),
          h('div', { className: 'ad-skeleton-line w40' }))
      } else if (phase === 'error') {
        panel = h('div', { className: 'ad-err-box', role: 'alert' },
          h('div', { className: 'ad-err-head' }, '加载失败'),
          h('div', { className: 'ad-err' }, listError || '无法加载短剧项目列表'),
          h('div', { className: 'ad-err-actions' },
            h('button', { className: 'ad-btn ad-sm ad-primary', onClick: refreshProjects }, '重试')))
      } else {
        // 六个页签**始终挂载**，只用 display 控制可见性。
        // 条件渲染会在切走时卸载组件，组件内部 useState（搜索词、选中集、
        // 编辑中的剧本、预览开关等 14 个状态）随之清零，切回来就空了。
        // 常驻挂载的代价是隐藏页签仍占 DOM，换来切换不丢状态。
        const pane = (id, node) => h('div', {
          key: `pane-${id}`,
          className: 'ad-pane',
          'data-on': tab === id ? '1' : '0',
          style: tab === id ? undefined : { display: 'none' },
        }, node)

        panel = h(Fragment, null, tabsNode,
          h('div', { className: 'ad-tabpanel', id: 'ad-tabpanel', role: 'tabpanel' },
            pane('creation', h(CreationTab, {
              project, dramaRoot, bundle, bundleError, bundleLoading,
              onLoad: loadCreation, onSave: saveAsset,
              onSaveScript: saveScriptText, onLoadScript: loadScriptText, onLoadStoryboard: loadStoryboardText,
              ai, setAi, aiRun, aiTaskId, aiProgress, onAiGenerate, onApplyAi,
              llmStatus, onRefreshLlm, onAiStage, onAiEpisode,
              casting, castingRun, castingMsg, onCast,
              castingPreview, setCastingPreview,
              shotPrompts, promptRun, onLoadShotPrompts: loadShotPrompts,
              quotaEst, quotaLoading, onLoadQuotaEstimate: loadQuotaEstimate,
              warmupRun, warmupResult, onRunWarmup: runWarmup,
              forceGen, setForceGen,
            })),
            pane('overview', h(OverviewTab, {
              project, links, linksError, onLoad: loadCreation,
              onRepair, repairState,
              onApplyRepair, onDiscardRepair: () => setRepairState(null),
              projects, setProject: setProjectPersist, episode, setEpisode: setEpisodePersist,
              episodes: (projects || []).find(x => x.name === project)?.episodes || [],
            })),
            pane('generate', h(GenerateTab, {
              projects, project, setProject: setProjectPersist, episode, setEpisode: setEpisodePersist, shots,
              checked, setChecked, ratio, setRatio, resolution, setResolution,
              duration, setDuration, dramaRoot, setDramaRoot: setDramaRootPersist, listError, shotsError, roots,
              lot, busy, startGenerate, onRefreshProjects: refreshProjects,
              jobProgress,
              creating, setCreating, newTitle, setNewTitle, createError, createProject,
              quotaEst, quotaLoading, onLoadQuotaEstimate: loadQuotaEstimate,
              warmupRun, warmupResult, onRunWarmup: runWarmup,
              forceGen, setForceGen,
            })),
            pane('consistency', h(ConsistencyTab, {
              project, preflight, pfError, pfLoading, onRun: runPreflight, opts: genOpts, setOpts: setGenOpts,
            })),
            pane('artifacts', h(ArtifactsTab, {
              project, artifacts, artError, onRefresh: refreshArtifacts, onOpen: openFile,
            })),
            pane('accounts', h(AccountsTab, { accounts, accError, onRefresh: refreshAccounts })),
            pane('stats', h(StatsTab, { history, stats, histError, onRefresh: refreshHistory })),
          ))
      }

      return h(Fragment, null,
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'ad-shell', role: 'region', 'aria-label': 'AI 短剧出片' },
          h('div', { className: 'ad-head', key: 'head' },
            h(PanelIcon),
            h('div', null,
              h('div', { className: 'ad-title' }, 'AI 短剧出片'),
              h('div', { className: 'ad-sub' }, '把 ai-drama 分镜免费生成视频（Trae Seedance）')),
            h('div', { style: { flex: 1 } }),
          ),
          h('div', { className: 'ad-contextbar', key: 'ctx', role: 'navigation', 'aria-label': '当前位置' },
            h('span', { className: 'ad-crumb' },
              h('button', { className: 'ad-crumb-link', onClick: () => setTab('generate') }, 'AI 短剧'),
              h('span', { className: 'ad-crumb-sep' }, '›'),
              h('span', { className: 'ad-crumb-chip' }, project || '未选项目'),
              episode ? h(Fragment, null,
                h('span', { className: 'ad-crumb-sep' }, '›'),
                h('span', { className: 'ad-crumb-chip' }, episode)) : null,
              h('span', { className: 'ad-crumb-sep' }, '›'),
              h('span', { style: { fontWeight: 600, color: 'var(--ad-label-primary)' } }, tabLabelOf.get(tab) || tab),
            ),
            h('div', { style: { flex: 1 } }),
            shots.length ? h('span', { className: 'ad-crumb' }, `${shots.length} 镜`) : null,
            checked.size ? h('span', { className: 'ad-crumb' }, `已选 ${checked.size}`) : null,
            busy ? h('span', { className: 'ad-crumb', style: { color: 'var(--ad-brand)' } }, '⏳ 出片中') : null,
            h('button', {
              className: 'ad-crumb-link', title: '刷新项目与分镜',
              onClick: () => { refreshProjects(); if (project) refreshShots() },
            }, '刷新'),
          ),
          h('div', { className: 'ad-body', key: 'body' },
            h('div', { className: 'ad-content' }, panel)),
        ),
      )
    }

    /* ---------------------------------------------------------------- 注册 */
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 61, label: 'AI 短剧出片' },
            PanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, DramaPanel),
        )
      },
    }
  },
})