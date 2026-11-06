# dsh-drama-trae 安装指南（跨设备）

打包产物：**`dsh-drama-trae-0.1.0.tgz`**（35.9 KB，15 文件，SHA256 `41c62fd6...0af660b3`）

## 前置依赖（目标设备需先装）

1. **DeepSeek Harness ≥ 0.2.0-rc.2**（含 `dsh plugin` 命令 / 桌面端）
2. **dsh-plugin-ai-drama** —— 提供短剧立项/分镜（本插件读它的分镜 JSON）
3. **dsh-our-free-model** —— 提供免费 Trae 账号（本插件出片的凭据）
4. Node.js `^22.19.0 || >=24.0.0`

## 从 GitHub 拉取源码继续开发（推荐开发用）

仓库：<https://github.com/wy13013560664/dsh-drama-trae>

```bash
git clone https://github.com/wy13013560664/dsh-drama-trae.git
cd dsh-drama-trae
ls test/                        # 14 个测试文件，直接 node test/pN-*.mjs 跑
node cli.mjs --list --drama-root ~/Documents/ShiPin/AI短剧
```

挂进 DSH profile（软链，改源码即时生效）：

```bash
ln -sfn "$PWD" ~/.dsh/profiles/desktop/node_modules/dsh-drama-trae
# 重启 DSH，侧栏出现「AI 短剧出片」
```

> 本仓库与 `dsh-trae-video`（出片引擎）配套使用；两者可分别 clone，
> 也可在同一目录下并列，`dsh-drama-trae` 会按 `TRAE_ACCOUNT_*` 凭据走。

## 方式 A：`dsh plugin add`（推荐）

```bash
# 把 tgz 拷到目标设备后
dsh plugin --profile <profile> add ./dsh-drama-trae-0.1.0.tgz
```

`<profile>` 换成你的 profile 名（桌面端通常是 `desktop`）。重启 DSH 后侧栏出现「AI 短剧出片」。

## 方式 B：手动 link（不依赖 dsh plugin 命令）

```bash
# 解包到 workspace
tar -xzf dsh-drama-trae-0.1.0.tgz -C ~/Documents/deepseek-harness/default-workspace/
mv ~/Documents/deepseek-harness/default-workspace/package ~/Documents/deepseek-harness/default-workspace/dsh-drama-trae

# 在 profile 的 package.json 里加两处：
#   1) dependencies:  "dsh-drama-trae": "link:<绝对路径>"
#   2) dsh.profile.bundles 数组加 "dsh-drama-trae"

# 重装依赖 + 重启
cd ~/.dsh/profiles/desktop && pnpm install
```

## 方式 C：npm 全局安装（仅 CLI 出片，无 DSH 界面）

```bash
npm install -g ./dsh-drama-trae-0.1.0.tgz
drama-trae --list --drama-root <AI短剧目录>
drama-trae --project <剧名> --episode <集> ...
```

> 注：方式 C 只装宿主半（并发出片引擎 + CLI），客户端半（DSH 界面）需方式 A/B。CLI 无需 DSH 即可出片。

## 验证安装

```bash
# 1. 列出分镜（数据源就绪）
node cli.mjs --list --drama-root ~/Documents/ShiPin/AI短剧

# 2. dry-run 预演
node cli.mjs --project <剧名> --episode <集> --drama-root <AI短剧目录> --dry-run

# 3. 真出片（并发出片 + 自动换账号重试）
node cli.mjs --project <剧名> --episode <集> --drama-root <AI短剧目录> --concurrency 5
```

## 功能速览

- **并发出片**：多 Trae 账号并行（默认自动 = 账号数）
- **失败重试**：配额耗尽自动换账号（最多轮遍全池）
- **产物预览**：内联 `<video>` 播放 + 系统打开
- **生成历史**：持久化 + 统计页签
- **账号池**：可用/过期可视化
- **界面基准**：与 dsh-plugin-ai-drama 完全一致（`--ad-*` 主题 + `ad-*` 类）

## 完整文档（包内已含）

- `README.md` —— 用户操作指南
- `ALIGNMENT.md` —— 界面基准解析 + 功能清单 + 改造点
- `FUNCTION-MAP.md` —— 功能对照表 + 回归测试清单
---

## 图生视频（i2v）分镜支持（v0.2.0 新增）

分镜 JSON 中给镜头加参考图，即可让该镜走图生视频而非纯文生视频：

```json
{
  "shotNumber": 1,
  "image": "/Users/you/frames/shot1.png",     // 本地参考图，插件自动上传
  "prompt": "镜头缓慢推进，人物回头",
  "durationSec": 5
}
```

也支持直接给已上传的 TOS key：

```json
{ "shotNumber": 2, "image_key": "tos-cn-i-zaeny81f73/cn/<uid>/image/xxx_png_1024x576" }
```

**关键约束（抓包实测）**：
- 上传必须 `biz_type='image'`（落图像桶 `zaeny81f73`），否则后端报 `invalid userid`
- key 内含上传账号 uid，**上传与出片由插件自动保证同账号**
- 真实人像图会被 Ark 内容审核拒绝（`InputImageSensitiveContentDetected.PrivacyInformation`），建议用插画 / 风景 / AI 生成图

实测记录（2026-11-04）：本地 PNG 渐变图 → 上传 → i2v 出片成功，1.92 MB / 5s MP4。

---

## 一致性注入体系（v0.4.0 新增）

dsh-drama-trae 现在会**读取 ai-drama 的一致性资产**并注入出片流程。这是 v0.2/v0.3 之前完全没有的能力（此前对 `characters.json` / `style.json` / `scenes` / `assets` 零引用）。

### 注入的三件套

| 来源 | 注入内容 | 生效条件 |
|---|---|---|
| `.aidrama/characters.json` | `[角色锚点] 名字：appearancePrompt` 置于 prompt 最前 | 分镜含 `characters[]` 或 `subject` 命中角色名 |
| `.aidrama/style.json` | `[视觉风格] 色板/光感/质感/构图/运镜` 置于画幅提示之前 | 状态为 `directed` 或 `frozen` |
| 分镜 `emotion` | 情绪→可观测生理描述（33 条映射表） | 有 `{label, intensity}` |

### 一致性门禁（11 项检查）

```
FAIL 级（可阻断）  CHK-05 无画面描述 / CHK-06 镜号重复 / CHK-07 时长越界
                   CHK-01 角色卡不存在 / CHK-02 场景卡不存在（需 requireScene）
WARN 级（只报告）  CHK-08 时长过短 / CHK-09 资产缺失 / PD-08 一镜多事
                   RES-01~03 资源缺失（旧项目零误伤）
INFO 级             CHK-03 风格就绪 / CHK-04 锚点覆盖
```

**默认「启用但只报告」**——旧项目不会因升级突然跑不了。

```bash
--gate-block                     # 门禁违规即阻断
--no-gate                        # 完全关闭门禁
--gate-strict CHK-06,CHK-07      # 只阻断指定检查项
```

### 首帧链式传导（实测可用）

同场景连续镜自动承接上一镜末帧作首帧，形成视觉连续的运动链。

```bash
--chain       # 开启（强制串行，因为需上一镜产出后才知道末帧）
```

**关键约束**：`last_frame_uri` 与产出账号强绑定，链式时插件会**自动锁定同一账号**，否则后端报 `invalid userid`。

判定规则：同 `sceneId` + 上一镜 `transitionToNext` 不是 `hard-cut` / `whip-pan`。

实测（2026-11-04）：4 镜同场景连续出片，1-1 → 1-2 → 1-3 连续承接，全部同账号，0 失败。

### 平台分档与合规检查

```bash
--platform 抖音               # 抖音/快手/视频号/B站/小红书/其他
--compliance-block            # 合规命中阻断词时阻断
```

平台画像给出画幅建议、钩子秒数、单镜上限、单集时长区间（`PLAT-01~04` 提示）。
合规词表分 `block` / `warn` / `context` 三级（`CP` 系列）。**两者均为经验值，非平台官方规范，默认只提示不阻断。**

### 产物命名升级

有 `sceneId` 时：`第001集.md-1-1-SPC-001.mp4`（可反查场景）
无 `sceneId` 时：`第001集.md-1-1.mp4`（旧行为不变）

### 可回溯字段

`results.generated[]` 每条含：`prompt`（实际发送全文）、`anchor`、`account`、`image_ref`、`chained_from`、`last_frame_uri`、`scene_id`。

### brief 结构化输入

```bash
node cli.mjs --brief-init                    # 打印模板
node cli.mjs --brief-check brief.json         # 校验并预览立项输入
```

必填 5 项（题材/核心冲突/单集时长/集数/投放平台）+ 主角 + 可量化视觉基调。
空词黑名单（"高级感""电影感"等）会被识别为笼统并提示。

### 单测

```bash
node test/p0-changes.mjs   # 20 项：锚点/回溯/时长预检
node test/p1-changes.mjs   # 41 项：风格/门禁/brief/情绪
node test/p2-changes.mjs   # 39 项：链式/平台/合规
```
