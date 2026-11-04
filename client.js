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
        duration, setDuration, dramaRoot, setDramaRoot, listError, shotsError,
        lot, busy, startGenerate, onRefreshProjects, jobProgress,
      } = props

      function toggleShot(key) {
        setChecked(prev => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key); else next.add(key)
          return next
        })
      }

      const allChecked = shots.length > 0 && shots.every(s => checked.has(String(s.shotNumber || s.shot)))

      const shotRows = shots.map(s => {
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

      const progressNode = jobProgress ? h('div', { className: 'ad-progress-box' },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } },
          jobProgress.status === 'done' ? '✅ 生成完成' : jobProgress.status === 'failed' ? '❌ 生成失败' : '⏳ 生成中…'),
        h('div', { className: 'ad-progress-bar' }, h('div', { className: 'ad-progress-fill', style: { width: `${jobProgress.pct}%` } })),
        h('div', { className: 'ad-count', style: { marginTop: 4 } },
          `${jobProgress.done}/${jobProgress.total} 镜${jobProgress.status === 'failed' ? ` · ${jobProgress.error || ''}` : ''}`),
      ) : null

      return h(Fragment, null,
        h('div', { className: 'ad-list-toolbar' },
          h('input', { className: 'ad-input', value: dramaRoot, onChange: e => setDramaRoot(e.target.value), placeholder: '工作区根目录（留空自动探测）', style: { maxWidth: 520 } }),
          h('button', { className: 'ad-btn ad-sm', onClick: onRefreshProjects }, '刷新项目'),
        ),
        listError ? h('div', { className: 'ad-err' }, listError) : null,

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

        shots.length > 0 ? h('div', { className: 'ad-shot-list' }, ...shotRows) : null,

        h('div', { className: 'ad-row', style: { marginTop: 12 } },
          h('button', {
            className: 'ad-btn ad-primary ad-cta',
            onClick: startGenerate,
            disabled: busy || shots.length === 0 || checked.size === 0,
          }, busy ? '生成中…' : `🚀 一键出片（已选 ${checked.size} 镜）`),
        ),
        progressNode,
      )
    }

    /* ---------------------------------------------------------------- 产物页签 */
    function ArtifactsTab({ project, artifacts, artError, onRefresh, onOpen }) {
      const [previewPath, setPreviewPath] = useState(null)
      const list = artifacts.map(a =>
        h('div', { key: a.path, className: 'ad-shot-row', style: { cursor: 'default' } },
          h('span', { style: { flex: 1, fontSize: 12 } }, a.name),
          h('button', { className: 'ad-btn ad-sm', onClick: () => setPreviewPath(previewPath === a.path ? null : a.path) }, previewPath === a.path ? '收起' : '预览'),
          h('button', { className: 'ad-btn ad-sm', onClick: () => onOpen(a.path) }, '打开'),
        ),
      )
      return h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 8 } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, project ? `《${project}》产物` : '选择项目后查看产物'),
          h('button', { className: 'ad-btn ad-sm', onClick: onRefresh }, '刷新'),
        ),
        artError ? h('div', { className: 'ad-err' }, artError) : null,
        artifacts.length > 0
          ? h('div', { className: 'ad-shot-list' }, ...list)
          : h('div', { className: 'ad-empty-state' },
              h('div', { className: 'ad-empty-title' }, '暂无产物'),
              h('div', null, '去「出片」页签生成视频后，这里会列出成品。'),
              h('div', { className: 'ad-hint-next' }, '生成完成后可内联预览或系统打开。')),
        previewPath
          ? h('div', { className: 'ad-video-shell' },
              h('video', { src: `${API_BASE}media?file=${encodeURIComponent(previewPath)}`, controls: true, autoPlay: false }))
          : null,
      )
    }

    /* ---------------------------------------------------------------- 账号页签 */
    function AccountsTab({ accounts, accError, onRefresh }) {
      const expired = accounts.filter(a => a.expired).length
      const list = accounts.map(a =>
        h('div', { key: a.ref, className: 'ad-shot-row', style: { cursor: 'default' } },
          h('span', { style: { fontSize: 12, fontWeight: 500, minWidth: 150 } }, a.phone || a.uid),
          h('span', { style: { fontSize: 11, color: 'var(--ad-label-secondary)', marginLeft: 8 } }, `uid ${a.uid}`),
          h('span', { style: { marginLeft: 'auto', fontSize: 12, color: a.expired ? 'var(--ad-error)' : 'var(--ad-success)' } }, a.expired ? '已过期' : '可用'),
        ),
      )
      return h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 8 } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, `Trae 账号池 · ${accounts.length} 个（${expired} 个过期）`),
          h('button', { className: 'ad-btn ad-sm', onClick: onRefresh }, '刷新'),
        ),
        accError ? h('div', { className: 'ad-err' }, accError) : null,
        accounts.length > 0
          ? h('div', { className: 'ad-shot-list' }, ...list)
          : h('div', { className: 'ad-empty-state' },
              h('div', { className: 'ad-empty-title' }, '未检测到 Trae 账号'),
              h('div', null, '免费出片依赖 Trae 账号的 Seedance 额度。'),
              h('div', { className: 'ad-hint-next' }, '请在 our-free-model 插件里登录 Trae 账号。')),
      )
    }

    /* ---------------------------------------------------------------- 统计页签 */
    function StatsTab({ history, stats, histError, onRefresh }) {
      const rows = history.slice().reverse().map(j => {
        const statusTxt = j.status === 'done' ? '✅ 完成' : j.status === 'failed' ? '❌ 失败' : j.status === 'running' ? '⏳ 进行中' : '排队'
        const dur = j.finishedAt && j.startedAt ? Math.round((j.finishedAt - j.startedAt) / 1000) + 's' : '-'
        return h('div', { key: j.id, className: 'ad-shot-row', style: { cursor: 'default' } },
          h('span', { style: { fontSize: 12, fontWeight: 500, minWidth: 110 } }, j.project || '(未命名)'),
          h('span', { style: { fontSize: 11, color: 'var(--ad-label-secondary)', marginLeft: 6 } }, j.episode ? j.episode : ''),
          h('span', { style: { marginLeft: 'auto', fontSize: 12 } }, `${j.progress?.done ?? 0}/${j.progress?.total ?? 0}`),
          h('span', { style: { minWidth: 70, fontSize: 12, marginLeft: 8, textAlign: 'right' } }, statusTxt),
          h('span', { style: { minWidth: 60, fontSize: 11, color: 'var(--ad-label-secondary)', marginLeft: 8, textAlign: 'right' } }, dur),
        )
      })
      return h(Fragment, null,
        h('div', { className: 'ad-row', style: { marginBottom: 8 } },
          h('span', { className: 'ad-sec', style: { margin: 0, border: 0, padding: 0 } }, '生成历史（持久化，重启后保留）'),
          h('button', { className: 'ad-btn ad-sm', onClick: onRefresh }, '刷新'),
        ),
        histError ? h('div', { className: 'ad-err' }, histError) : null,
        stats ? h('div', { className: 'ad-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
          h('span', { className: 'ad-stat-chip' }, `总任务 ${stats.total}`),
          h('span', { className: 'ad-stat-chip', style: { color: 'var(--ad-success)' } }, `成功 ${stats.done}`),
          h('span', { className: 'ad-stat-chip', style: { color: 'var(--ad-error)' } }, `失败 ${stats.failed}`),
          h('span', { className: 'ad-stat-chip', style: { color: 'var(--ad-brand)' } }, `进行中 ${stats.running}`),
        ) : null,
        history.length > 0
          ? h('div', { className: 'ad-shot-list' }, ...rows)
          : h('div', { className: 'ad-empty-state' },
              h('div', { className: 'ad-empty-title' }, '暂无历史'),
              h('div', null, '去「出片」页签生成后，这里会累计任务记录。'),
              h('div', { className: 'ad-hint-next' }, '历史含成功率、耗时与每镜进度。')),
      )
    }

    /* ---------------------------------------------------------------- 主面板 */
    function DramaPanel() {
      const [phase, setPhase] = useState('loading') // loading | ready | error
      const [tab, setTab] = useState('generate')
      const [projects, setProjects] = useState([])
      const [project, setProject] = useState('')
      const [episode, setEpisode] = useState('')
      const [shots, setShots] = useState([])
      const [checked, setChecked] = useState(new Set())
      const [ratio, setRatio] = useState('9:16')
      const [resolution, setResolution] = useState('720p')
      const [duration, setDuration] = useState('')
      const [dramaRoot, setDramaRoot] = useState('')
      const [listError, setListError] = useState('')
      const [shotsError, setShotsError] = useState('')
      const [busy, setBusy] = useState(false)
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
        try { const r = await api('list', dramaRoot ? { dramaRoot } : {}); setProjects(r.projects || []) }
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
      useEffect(() => { if (tab === 'artifacts') refreshArtifacts() }, [tab, project])
      useEffect(() => { if (tab === 'stats') refreshHistory() }, [tab])

      useEffect(() => {
        if (!taskId) return
        const poll = async () => {
          try {
            const res = await api('status', { taskId })
            const j = res.job
            const total = j.progress?.total || 0
            const done = j.progress?.done || 0
            setJobProgress({ status: j.status, done, total, pct: total ? Math.round(done / total * 100) : 0, error: j.error })
            const m = new Map()
            for (const r of j.results || []) if (r.shot) m.set(String(r.shot), { status: 'done' })
            for (const r of j.errors || []) if (r.shot) m.set(String(r.shot), { status: 'failed' })
            const cur = j.progress?.current
            if (cur?.type === 'start' && cur.shot) m.set(String(cur.shot), { status: 'running' })
            setLot(m)
            if (j.status === 'done' || j.status === 'failed') {
              clearInterval(pollTimer.current); setBusy(false)
              if (j.status === 'done') refreshArtifacts()
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
          })
          setTaskId(res.taskId)
        } catch (e) { setBusy(false); window.alert(e.message) }
      }

      const TAB_GROUPS = [
        { id: 'core', label: '出片', tabs: [['generate', '出片']] },
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
        panel = h(Fragment, null, tabsNode,
          h('div', { className: 'ad-tabpanel', id: 'ad-tabpanel', role: 'tabpanel' },
            tab === 'generate' ? h(GenerateTab, {
              projects, project, setProject, episode, setEpisode, shots,
              checked, setChecked, ratio, setRatio, resolution, setResolution,
              duration, setDuration, dramaRoot, setDramaRoot, listError, shotsError,
              lot, busy, startGenerate, onRefreshProjects: refreshProjects,
              jobProgress,
            }) :
            tab === 'artifacts' ? h(ArtifactsTab, { project, artifacts, artError, onRefresh: refreshArtifacts, onOpen: openFile }) :
            tab === 'accounts' ? h(AccountsTab, { accounts, accError, onRefresh: refreshAccounts }) :
            h(StatsTab, { history, stats, histError, onRefresh: refreshHistory })))
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