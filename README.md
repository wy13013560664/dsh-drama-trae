# dsh-drama-trae —— AI 短剧一键出片

> 连接两个已有插件，把「写短剧」和「出视频」无缝打通：
> - **dsh-plugin-ai-drama**：立项 → 总纲 → 人物 → 剧本 → **分镜表**（无内建出片能力，原依赖 LibTV/NeoWoW 付费 CLI）
> - **dsh-trae-video**：免费 Trae 账号直接出视频（Seedance 2.0，竖屏/横屏/续写）
>
> 本插件读 ai-drama 写盘的分镜 JSON，逐镜生成视频，写回短剧项目的「素材/生成/」目录。
> **无需订阅、无需 LibTV/NeoWoW、无需 API Key** —— 只要 our-free-model 里登录了 Trae 账号。
>
> **完整双半身**：宿主半（生成引擎 + REST API）+ 客户端半（DSH 侧栏「AI 短剧出片」面板），
> 与 dsh-plugin-ai-drama 同款 slots 界面协议。

---

## 一、它能做什么

| 输入 | 输出 |
|---|---|
| ai-drama 短剧项目的分镜表（`.aidrama/storyboard/*.json`） | 每个镜头一段视频（`素材/生成/<集>-<镜号>.mp4`） |

- 自动读分镜的 `videoPrompt` / `imagePrompt` / `description` + 景别 + 运镜，拼成视频 prompt
- 自动竖屏 9:16（短剧行业惯例），可改画幅/分辨率/时长
- 幂等：已生成过的镜头自动跳过，断点续跑
- 支持只生成某集、只生成某几个镜号
- 多 Trae 账号轮换，一个排队可换下一个（复用 our-free-model 账号池）

---

## 二、操作指南（最快上手）

### 前置条件

1. **已安装** `dsh-plugin-ai-drama`（短剧工作区）——用于立项+写分镜
2. **已安装** `dsh-our-free-model` 并**登录了 Trae 账号**——免费出片凭据
3. 本插件 `dsh-drama-trae`

检查 Trae 账号：

```bash
cd ~/Documents/deepseek-harness/default-workspace/dsh-trae-video
node cli.mjs --list-accounts   # 有 TRAE_ACCOUNT_* 且未过期即可
```

### 方式 A：图形界面（DSH 内，推荐）

> ⚠️ 需重启 DSH 后生效（bundles 启动时扫描）。

1. 重启 DSH，侧栏会出现「**AI 短剧出片**」图标
2. 点在图标 → 中央打开出片面板，含**三个页签**：

| 页签 | 功能 |
|---|---|
| **出片** | 选项目 → 选集 → 勾选镜头 → 设画幅/分辨率/时长 → 一键出片；每镜一张任务卡（待生成/生成中 ⏳/完成 ✅/失败 ❌），底部进度条实时刷新 |
| **产物** | 列出已生成的视频，一件「打开」（系统播放器），一键定位到素材目录 |
| **账号** | Trae 账号池状态（可用/已过期计数），免费出片凭据一目了然 |

界面与 dsh-plugin-ai-drama 同款（sidebar.panellist + main 槽位）。

### 方式 B：命令行（无需重启 DSH）

> 写好分镜后（见「方式 A」的 ai-drama 工作区，或直接手写 `.aidrama/storyboard/<集>.json`），
> 数据落在：`<工作区>/AI短剧/<剧名>/.aidrama/storyboard/<集名>.json`

先看有哪些项目/分镜：

```bash
cd ~/Documents/deepseek-harness/default-workspace/dsh-drama-trae
node cli.mjs --list --drama-root ~/Documents/ShiPin/AI短剧
```

输出类似：

```
《都市夜雨》: 2 集, 24 镜
  - 第01集: 12 镜
  - 第02集: 12 镜
```

**生成第 1 集全部镜头**：

```bash
node cli.mjs --project 都市夜雨 --episode 第01集 \
  --drama-root ~/Documents/ShiPin/AI短剧
```

**先 dry-run 看计划（不真出片，验证 prompt 对不对）**：

```bash
node cli.mjs --project 都市夜雨 --episode 第01集 \
  --drama-root ~/Documents/ShiPin/AI短剧 --dry-run
```

**只生成某几个镜头（调试/补漏）**：

```bash
node cli.mjs --project 都市夜雨 --episode 第01集 --shots 3,7,12 \
  --drama-root ~/Documents/ShiPin/AI短剧
```

**改画幅/分辨率/时长**：

```bash
node cli.mjs --project 都市夜雨 --episode 第01集 \
  --drama-root ~/Documents/ShiPin/AI短剧 \
  --ratio 16:9 --resolution 1080p --duration 8
```

### 结果

生成的视频在：

```
<工作区>/AI短剧/<剧名>/素材/生成/<集名>-<镜号>.mp4
```

在 DSH 的 ai-drama 工作区「素材」页签里就能看到、预览。

---

## 三、命令参数速查

| 参数 | 默认 | 说明 |
|---|---|---|
| `--project <名>` | 必填 | 短剧项目名（AI短剧下的子目录名） |
| `--episode <集名>` | 全部集 | 只生成某集（如 `第01集`，不带 .json） |
| `--shots 1,2,3` | 全部 | 只生成指定镜号 |
| `--ratio 9:16` | 9:16 | 画幅：9:16 / 16:9 / 1:1 等 |
| `--resolution 720p` | 720p | 480p/720p/1080p |
| `--duration 5` | 分镜时长 | 单镜秒数（2~15） |
| `--drama-root <目录>` | 自动探测 | ai-drama 根目录（默认 `~/Documents/ShiPin/AI短剧`） |
| `--dry-run` | 关 | 只计划不出片，验证 prompt 与路径 |
| `--list` | - | 列出所有项目与分镜 |

---

## 四、在 DSH 里用（插件 API）

作为插件加载后（需重启 DSH），在命令面板或其它插件里：

```js
// 通过 cordis 能力面调用
await runOneShotDrama({
  project: '都市夜雨',
  episode: '第01集',
  dramaRoot: '/Users/wangyuan/Documents/ShiPin/AI短剧',
  ratio: '9:16',
  resolution: '720p',
  onProgress: (evt) => console.log(evt.type, evt.shot),
})
```

---

## 五、设计说明（为什么这样做）

- **职责分离**：ai-drama 管内容一致性（人物/伏笔/分镜），dsh-trae-video 管出片，本插件只做「读分镜 → 出片 → 回写」的胶水。
- **零硬依赖**：直接读 ai-drama 的分镜 JSON + 复用 trae-video 的生成引擎，不绑定任何 cordis 服务，保证能挂载。
- **确定性 prompt**：分镜 → prompt 是纯函数，可 dry-run 预演，不靠模型临时发挥。
- **幂等 + 断点续跑**：产物文件名稳定（`<集>-<镜>.mp4`），重复执行自动跳过已完成镜头。

---

## 六、成本说明

- 视频生成走 Trae 的 Seedance 2.0（`seedance2-fast`），**免费账号可用**，但免费额度有队列，生成一个 5 秒镜头约 5~10 分钟（排队 + 生成）。
- 多账号轮换可缓解排队：our-free-model 里登录多个 Trae 账号即可。
- 一个短剧若 12 镜 × 5 分钟 ≈ 1 小时出片，建议分批跑（`--shots` 分段），避免长时间占用。

---

## 七、目录结构

```
dsh-drama-trae/
├── index.js          # 宿主半：runOneShotDrama + REST API + jobs
├── client.js         # 客户端半：侧栏入口 + 出片面板（slots）
├── cli.mjs           # 一键出片命令行
├── src/
│   ├── prompt.js     # 分镜 → 视频 prompt（确定性）
│   ├── video.js      # 生成引擎（复用 trae-video）
│   ├── accounts.js   # Trae 账号池
│   ├── credential.js # 凭据解析 + 鉴权
│   ├── validate.js   # 参数校验
│   ├── jobs.js       # 任务状态管理（前端轮询）
│   └── constants.js  # TRAE 端点/枚举常量
├── package.json
├── cordis.patch.yml
└── test-fixture/     # 测试用样例分镜（可删）
```

---

## 八、常见问题

**Q: `--list` 显示「无项目」？**
A: 确认 `--drama-root` 指向 `AI短剧` 目录（或它的父目录），且已在 ai-drama 里建过项目、写过分镜。

**Q: 报「未找到 TRAE_ACCOUNT_* 凭据」？**
A: 在 DSH 里打开 our-free-model 插件，登录至少一个 Trae 账号。

**Q: 生成到一半断了？**
A: 直接重跑同一条命令，已完成的镜头会自动跳过（幂等）。

**Q: 想换账号避开排队？**
A: our-free-model 里多登录几个 Trae 账号，本插件会自动轮换。