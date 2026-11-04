# dsh-drama-trae 界面对齐改造 · 功能对照表 + 回归测试清单

> 基线：改造前 v0.1.0（四页签内联样式）→ 改造后（ad-* 类名 + --ad-* 变量 + 页签分组，对齐 dsh-plugin-ai-drama v0.16.10）

## 一、修改前后功能对照表

| # | 功能 | 改造前 | 改造后 | 状态 |
|---|---|---|---|---|
| 1 | 读 ai-drama 分镜 JSON（`/list` `/shots`） | ✅ | ✅ 不变 | 保持 |
| 2 | 分镜→视频 prompt 确定性转换 | ✅ | ✅ 不变 | 保持 |
| 3 | 免费 Trae 出片 t2v/i2v/v2v | ✅ | ✅ 不变 | 保持 |
| 4 | 并发出片（worker 池 + 账号轮转） | ✅ | ✅ 不变 | 保持 |
| 5 | 失败自动换账号重试 | ✅ | ✅ 不变 | 保持 |
| 6 | 幂等跳过 / dry-run | ✅ | ✅ 不变 | 保持 |
| 7 | 任务状态 jobs 持久化 | ✅ | ✅ 不变 | 保持 |
| 8 | 生成历史统计（`/history`） | ✅ 内联统计页 | ✅ 对齐 `.ad-shot-list`+`.ad-stat-chip` | 保持+对齐 |
| 9 | 产物列表 + 系统打开（`/artifacts` `/open`） | ✅ | ✅ 对齐 `.ad-btn` | 保持+对齐 |
| 10 | 产物内联预览（`/media` + `<video>`） | ✅ 内联风格 | ✅ 对齐 `.ad-video-shell` | 保持+对齐 |
| 11 | 账号池状态（`/accounts`） | ✅ | ✅ 对齐 `.ad-shot-row` | 保持+对齐 |
| 12 | 参数校验 | ✅ | ✅ 不变 | 保持 |
| 13 | 多账号轮换 + 冷却 | ✅ | ✅ 不变 | 保持 |
| 14 | CLI 独立出片 | ✅ | ✅ 不变 | 保持 |

**结论：14 项功能全部保持，0 丢失、0 弱化。**

## 二、界面/交互对齐对照表

| 维度 | 改造前（drama-trae） | 改造后（对齐 ai-drama） |
|---|---|---|
| 主题变量 | 内联 `var(--text)` / `var(--bg-input)` | `--ad-*` 17 变量（复用 dsw-alias token） |
| 根容器 | 内联 SHELL style | `.ad-shell` |
| 顶栏 | 内联 HEADER | `.ad-head` > `.ad-title` + `.ad-sub` |
| 内容区 | 内联 | `.ad-body` > `.ad-content` |
| 页签 | 内联 TABS_ROW | `.ad-tabs` > `.ad-tab`（data-on/aria-selected） |
| 页签分组 | 无 | `.ad-tab-groups` 三组（出片/交付/运维） |
| 选中态 | 内联 | `.ad-tab[data-on="1"]`（opacity+brand 下边线） |
| 按钮 | 内联 BTN_* | `.ad-btn` `.ad-primary` `.ad-sm` `.ad-cta` `.ad-btn-danger` |
| 表单 | 内联 INPUT | `.ad-input` `.ad-select` `.ad-check` |
| 卡片 | 内联 SHOT_ROW | `.ad-card` `.ad-card-main` `.ad-card-title` |
| 空态 | 内联文字 | `.ad-empty-state`（标题/描述/下一步） |
| 错误 | 内联 ERR | `.ad-err-box`（可读化+恢复） |
| 加载 | 无 | `.ad-skeleton`（4 行骨架） |
| 焦点环 | 无 | `:focus-visible` 2px brand |
| 键盘 roving | 无 | tabIndex 0/-1 + aria-selected |
| 脏标记 | 无 | `.ad-tab-dirty` ● |
| 进度条 | 内联 PROGRESS_BAR | `.ad-progress-bar` `.ad-progress-fill` |

## 三、关键交互流程（改造后）

1. **打开面板** → `phase=loading` 骨架 → `/list` 完成 → `ready`（出片页签 + 数据源/项目下拉）。
2. **选项目** → `/shots` → 镜头列表（`.ad-shot-row`）→ 勾选 → 一键出片（`.ad-primary.ad-cta`）。
3. **出片** → `/generate`（异步 taskId）→ 轮询 `/status` → 任务卡逐镜更新（✅/⏳/❌）。
4. **产物** → 切页签 → `/artifacts` → 预览（`.ad-video-shell` `<video>`）/ 打开（`/open`）。
5. **统计** → 切页签 → `/history`（持久化）→ `.ad-stat-chip` 计数。
6. **账号** → 切页签 → `/accounts` → 可用/过期。
7. **错误恢复** → `.ad-err-box`「重试」按钮。
8. **窄窗** → `.ad-tabs-more` 收纳（`@media max-width:900px` 触发）。

## 四、回归测试清单

### 结构
- [ ] slots 注册：sidebar.panellist + main 各 1 次
- [ ] 根 `ad-shell` 唯一
- [ ] `ad-head`（图标+标题+副标题）、`ad-body`、`ad-content` 存在
- [ ] `ad-tabs` + `ad-tab-groups`（3 组）+ `ad-tab`（data-on/aria-selected）

### 视觉
- [ ] `<style>` 注入含 `--ad-*` 17 变量定义
- [ ] 无残留 `var(--text)` / `var(--bg-input)`
- [ ] 类名前缀 `ad-`（业务 CSS 不直连 `--dsw-*`）

### 交互
- [ ] 页签 data-on 切换、aria-selected、tabIndex roving
- [ ] 按钮 disabled 态、`ad-primary` 主按钮
- [ ] `:focus-visible` 焦点环
- [ ] 空态 `.ad-empty-state`、错误 `.ad-err-box`、骨架 `.ad-skeleton`

### 功能保持（关键）
- [ ] 并发出片 worker 池正常（3 镜同时起跑）
- [ ] 失败重试：配额错误 → 自动换账号 → 成功
- [ ] 幂等跳过、dry-run
- [ ] 产物列表 + 预览（media 流）+ 打开
- [ ] 统计历史持久化 + 成功率
- [ ] 账号池可用/过期计数
- [ ] 参数校验（枚举/范围/refs）

### 语法
- [ ] index.js / client.js / cli.mjs / src/*.js 全部 `node --check` 通过

## 五、改动文件清单

| 文件 | 改动 |
|---|---|
| `client.js` | 全量重写（视觉/结构/交互对齐，功能逻辑保留） |
| `ALIGNMENT.md` | 新增（基准解析 + 功能清单 + 改造点 + 测试） |
| `FUNCTION-MAP.md` | 本文件（对照表 + 测试清单） |
| `index.js` / `cli.mjs` / `src/*` | 未改动（功能保持） |