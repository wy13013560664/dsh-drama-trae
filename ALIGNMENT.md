# dsh-drama-trae 界面对齐 dsh-plugin-ai-drama 基准文档

> 资深前端对齐重构 · 结论先行 · 改动可追溯
> 基准版本：dsh-plugin-ai-drama v0.16.10 · 目标：dsh-drama-trae v0.1.0

## 一、结论先行

dsh-drama-trae 与 dsh-plugin-ai-drama 的**功能职责完全不同**，对齐的仅是「界面骨架 / 视觉规范 / 交互契约」，不复制其剧本/人物/分镜编辑业务。对齐后：

- **视觉**：100% 复用 `--ad-*` 主题变量 + `ad-*` 类名 + 官方 alias token，浅/深色自动翻转。
- **结构**：`ad-shell > ad-head > ad-body` 三段、页签分组条、数据源选择器、加载骨架、错误框、空态。
- **交互**：页签 roving tabindex + ←→/Home/End、`aria-selected`/`data-on`、脏标记、键盘焦点环。
- **功能**：drama-trae 独特功能（并发出片/失败重试/账号池/产物预览/统计/媒体流）**全部保留、不弱化**。

## 二、ai-drama 视觉规范解析（唯一基准）

### 2.1 主题变量体系（17 个 `--ad-*`，挂在 body 块）

```
--ad-bg-base         = --dsw-alias-bg-base
--ad-label-primary   = --dsw-alias-label-primary
--ad-label-secondary = --dsw-alias-label-secondary
--ad-brand           = --dsw-alias-brand-primary
--ad-on-brand        = --dsw-alias-bg-base
--ad-primary-hover-bg= color-mix(brand 88%, bg-base)
--ad-error   = color-mix(state-error 75%, label-primary)
--ad-warn    = color-mix(state-warn 55%, label-primary)
--ad-success = color-mix(state-success 60%, label-primary)
--ad-error-bg / --ad-warning-bg / --ad-error-border / --ad-warning-border
--ad-subtle-bg = color-mix(label-primary 4%, transparent)
--ad-hover-bg  = color-mix(label-primary 6%, transparent)
--ad-border  = --dsw-alias-border-l2
--ad-divider = --dsw-alias-border-l1
```

关键约束：业务 CSS **只引用 `--ad-*`**，不直连 `--dsw-*`；定义块挂在 `body`（非 `:root`）。

### 2.2 类名规范（核心子集）

| 类 | 用途 |
|---|---|
| `.ad-shell` | 根 flex column，height:100% |
| `.ad-head` | 顶栏（图标+标题+副标题+右侧操作），border-bottom |
| `.ad-title` | 标题 16px/600 |
| `.ad-sub` | 副标题 12px/secondary |
| `.ad-body` | 内容区 flex:1 overflow:auto padding:16px 18px |
| `.ad-btn / .ad-primary / .ad-sm / .ad-btn-danger` | 按钮族 |
| `.ad-tabs / .ad-tab / .ad-tab-groups / .ad-tab-group / .ad-tab-group-label` | 页签分组条 |
| `.ad-tab[data-on="1"]` | 选中态（opacity:1 + brand 下边线） |
| `.ad-tab-dirty` | 未保存脏标记（●） |
| `.ad-tabs-more / .ad-tabs-more-panel` | 窄窗页签收纳 |
| `.ad-input / .ad-select / .ad-area / .ad-field` | 表单 |
| `.ad-card / .ad-card-main / .ad-card-title / .ad-card-meta` | 卡片 |
| `.ad-empty / .ad-empty-state / .ad-empty-title / .ad-hint-next` | 空态 |
| `.ad-err / .ad-err-box / .ad-err-head / .ad-err-next / .ad-err-actions` | 错误框 |
| `.ad-skeleton / .ad-skeleton-line.w40/w60/w80/w90` | 加载骨架 |
| `.ad-sec / .ad-count / .ad-dirty / .ad-ok / .ad-warn` | 辅助文本 |
| `.ad-check` | 复选框 accent-color |
| `.ad-table / .ad-table-empty` | 表格 |
| `.ad-modal-backdrop / .ad-modal` | 模态 |

### 2.3 交互状态契约

- **选中态**：`.ad-tab[data-on="1"]`，同时挂 `aria-selected`。
- **键盘 roving**：页签 `tabIndex 0/-1` + `←→/Home/End` 移动焦点（manual activation）。
- **焦点环**：`.ad-shell :focus-visible` = 2px brand outline。
- **脏标记**：`.ad-tab-dirty` 的 `●`，`aria-label="未保存修改"`。
- **空态**：`.ad-empty-state`（标题/描述/下一步/动作）。
- **错误**：`.ad-err-box`（失败码·可读文案 + 下一步 + 恢复按钮）。
- **按钮禁用**：`disabled` → opacity .5 + cursor default。

### 2.4 页面结构（phase 状态机）

```
phase: 'loading' | 'ready'(列表) | 'project'(项目内) | 'error'
ad-shell
└ ad-head（标题/数据源/图标/右侧操作）
└ ad-body
   ├ loading → ad-skeleton（4 行 + 项目卡骨架）
   ├ error   → ad-err-box（可读化 + 恢复按钮）
   ├ ready   → 数据源选择器 + 新建 hero + 搜索 + 项目 grid + 共享资料
   └ project → ad-tabs（分组页签）+ ad-tabpanel（当前页内容）
```

## 三、drama-trae 不可变更功能清单（对齐不改动）

| # | 功能 | 承载 | 对齐后保持 |
|---|---|---|---|
| 1 | 读取 ai-drama 分镜 JSON | host `/list`+`/shots` | ✅ |
| 2 | 分镜→视频 prompt 确定性转换 | src/prompt.js | ✅ |
| 3 | 免费 Trae 账号出片（t2v/i2v/v2v） | src/video.js | ✅ |
| 4 | **并发出片** worker 池 + 账号轮转 | index.js | ✅ |
| 5 | **失败自动换账号重试** | index.js | ✅ |
| 6 | 幂等跳过 / dry-run | index.js | ✅ |
| 7 | 任务状态（jobs 持久化） | src/jobs.js | ✅ |
| 8 | 生成历史 / 统计 | `/history` + StatsTab | ✅ 对齐为页签 |
| 9 | 产物列表 + 系统打开 | `/artifacts`+`/open` | ✅ |
| 10 | 产物内联预览（media 流） | `/media` + `<video>` | ✅ |
| 11 | 账号池状态 | `/accounts` | ✅ |
| 12 | 参数校验（枚举/范围/refs） | src/validate.js | ✅ |
| 13 | 多账号轮换 + 冷却 | src/accounts.js | ✅ |
| CLI 独立出片 | cli.mjs | ✅ 不变 |

## 四、对齐改造点（drama-trae client.js）

| 维度 | 改造前（现状） | 改造后（对齐 ai-drama） |
|---|---|---|
| 主题 | 内联 style，`var(--text)` | `--ad-*` 变量 + `ad-*` 类名 |
| 根容器 | 内联 SHELL style | `.ad-shell` |
| 标题 | h(div,{style:TITLE}) | `.ad-head` > `.ad-title` + `.ad-sub` |
| 页签 | 内联 TABS_ROW/TAB | `.ad-tabs` > `.ad-tab` + `data-on`/aria |
| 页签分组 | 无 | `.ad-tab-groups`（四组：出片/产物/账号/统计） |
| 数据源 | 内联 input | `.ad-select` + 数据源选择器行 |
| 加载 | 无 | `.ad-skeleton` |
| 错误 | 内联 ERR | `.ad-err-box`（可读化 + 恢复） |
| 空态 | 内联文字 | `.ad-empty-state` |
| 按钮 | 内联 BTN_* | `.ad-btn`/`.ad-primary`/`.ad-sm` |
| 复选框 | 原生 | `.ad-check` |
| 键盘焦点 | 无 | `:focus-visible` + roving tabindex |
| 脏标记 | 无 | `.ad-tab-dirty` ● |

## 五、关键交互流程

1. **打开面板** → `phase=loading`（骨架）→ `/list` 完成 → `ready`（出片页签 + 数据源/项目下拉）。
2. **选择项目** → `/shots` → 镜头列表刷新 → 勾选 → **一键出片**。
3. **出片** → `/generate`（异步返回 taskId）→ 轮询 `/status` → 任务卡逐镜更新状态。
4. **查看产物** → 切「产物」页签 → `/artifacts` → 点预览（`/media` 流）或打开（`/open`）。
5. **看统计** → 切「统计」页签 → `/history`（持久化）。
6. **看账号** → 切「账号」页签 → `/accounts`。

## 六、回归测试清单

- [ ] 面板挂载：slots 注册 sidebar.panellist + main 各 1 次
- [ ] 主题变量：无残留 `var(--text)`/`var(--bg-input)`，全用 `--ad-*`
- [ ] 页签：data-on / aria-selected / 键盘 roving / 脏标记
- [ ] 出片流程：并发出片 + retry 事件 + 任务卡状态
- [ ] 产物：列表 / 预览 / 打开
- [ ] 统计：历史持久化 / 成功率
- [ ] 账号池：可用/过期计数
- [ ] 空态 / 加载骨架 / 错误框
- [ ] 语法：index.js / client.js / cli.mjs node --check 通过