/**
 * dsh-drama-trae —— AI 创作引擎（创作环节全部由宿主 LLM 生成）。
 *
 * 通道与 dsh-plugin-ai-drama 完全同源：`ctx.get('llm')` → `llm.stream(...)`。
 * 这样模型选择、配额、重试、可观测性全部继承宿主设置，不另开一套。
 *
 * 六阶段生成链（严格顺序，后一阶段吃前一阶段产出）：
 *   ① 立项契约 contract   ← 用户一句话想法
 *   ② 分集大纲 outline    ← contract
 *   ③ 人物设定 characters ← contract + outline
 *   ④ 世界观   world      ← contract + outline + characters
 *   ⑤ 本剧记忆 memory     ← contract + outline + characters + world
 *   ⑥ 视觉风格 style      ← contract + 全部前序
 *
 * 设计约束（对齐 ai-drama 的 prompt 纪律）：
 *   - 每阶段**只输出 JSON**，用工具函数从响应里剥离 ```json 围栏与前后赘述
 *   - 强 schema 校验：字段名、类型、数组/对象形状、条数下限
 *   - 校验不过 → 明确报错并回传原始片段（**不静默降级成空数据**）
 *   - 单次超时 + token 预算，防止长任务挂死
 *   - 生成结果**不自动落盘**：返回给前端预览，用户确认后再调 saveAsset 写入
 *
 * @module src/ai-create
 */

/** 每阶段超时（毫秒）。DeepSeek 长文生成实测 30–90s，留足余量。 */
const STAGE_TIMEOUT_MS = 150_000

/** 每阶段输出 token 上限。 */
/**
 * 各阶段输出 token 预算。
 *
 * 中文 JSON 很吃 token：一个字段值常在 30–60 字（≈30–60 token），
 * 契约有 11 个字段、大纲每集 6 个字段 × 10–16 集。
 * 早期把 contract 设成 1200 时，模型写到 hookDensity 就被截断，
 * 拿到半个 JSON → 报「输出不是合法 JSON」。这里按实测留足余量。
 */
export const STAGE_MAX_TOKENS = {
  contract: 3000,
  outline: 8000,
  characters: 6000,
  world: 5000,
  memory: 5000,
  style: 2500,
  script: 6000,      // 单集剧本 2–4 场景，含对白与动作
  // 分镜单镜约 300 字符（10 字段），20 镜 ≈ 6000 字符 ≈ 4800 tokens。
  // 但模型会写长描述，实测 16290 字符仍被 7000 截断 —— 直接给到 16000，
  // 足够容纳 30+ 镜；若模型上限更低，适配器会自行截到它的 maxOutput。
  storyboard: 16000,
}

/** 阶段元信息：中文名 + 输出形状 + 条数下限。 */
/**
 * 各阶段的形状与**全量生成时的最小条目数**。
 *
 * min 只用于「从零生成」：从零时必须够量（大纲至少 3 集、人物至少 3 人）。
 * 但**修缺口时不该套用全量下限**——修 3 条伏笔的回收点，模型只回 3 条改动是
 * 正确行为，此时用 min=3 校验会通过，但若只回 2 条就直接判失败，把正确的
 * 修正结果误判为错误。修复路径改用 minRepair（见 validateStage 的 opts）。
 */
export const STAGES = Object.freeze({
  contract: { label: '立项契约', type: 'object', min: 0, minRepair: 0 },
  outline: { label: '分集大纲', type: 'array', min: 3, minRepair: 1 },
  characters: { label: '人物设定', type: 'array', min: 3, minRepair: 1 },
  world: { label: '世界观', type: 'array', min: 4, minRepair: 1 },
  memory: { label: '本剧记忆', type: 'array', min: 3, minRepair: 1 },
  style: { label: '视觉风格 DNA', type: 'object', min: 0, minRepair: 0 },
  // 分集剧本：对象（不是数组），必须带 text 与 episode
  script: { label: '分集剧本正文', type: 'script', min: 0, minRepair: 0 },
  // 分镜表：数组。最少 3 镜（60 秒一集至少 3 个镜头），上限由 prompt 约束到 12
  storyboard: { label: '分镜表', type: 'array', min: 3, minRepair: 1 },
})

/** 执行顺序（严格链式）。 */
export const STAGE_ORDER = [
  'contract', 'outline', 'characters', 'world', 'memory', 'style',
  // 后两阶段是「按集生成」，需要显式指定 episode，不参与全链默认跑
  'script', 'storyboard',
]

/** 全链默认只跑前六阶段（后两阶段按集，需显式触发）。 */
export const CHAIN_ORDER = ['contract', 'outline', 'characters', 'world', 'memory', 'style']

/** 需要按集生成的阶段。 */
export const EPISODE_STAGES = ['script', 'storyboard']

/**
 * 每个阶段**必须**已有的前序资产。
 *
 * 这不是「建议顺序」，是硬前置：缺了它，本阶段产出的内容没有依据，
 * 只会变成另一套平行设定（实测：跳过契约直接跑人物，姓名与世界观全对不上）。
 * style 依赖 world 而非 memory —— 视觉风格要承接环境光，与伏笔清单无关。
 */
export const STAGE_DEPS = Object.freeze({
  contract: [],
  outline: ['contract'],
  characters: ['contract', 'outline'],
  world: ['contract', 'outline', 'characters'],
  memory: ['contract', 'outline', 'characters', 'world'],
  style: ['contract', 'outline', 'characters', 'world'],
  // 写剧本：要大纲（本集节拍）+人物（谁在场）+世界（在哪拍）
  script: ['contract', 'outline', 'characters', 'world'],
  // 分镜：核心输入是**该集剧本正文**（逐场拆镜）+ 人物形象锚点 + 世界场景卡。
  // 早期漏了这一项，模型只能凭空编分镜，与剧本对不上。
  storyboard: ['contract', 'outline', 'characters', 'world', 'script'],
})

/**
 * 检查某阶段的前置资产是否齐备。
 *
 * @param {string} stage
 * @param {object} ctx 前序产出（{contract, outline, characters, world, memory}）
 * @returns {{ok: boolean, missing: string[], missingLabels: string[]}}
 */
export function checkPrerequisites(stage, ctx = {}) {
  const deps = STAGE_DEPS[stage] ?? []
  const missing = []
  for (const k of deps) {
    // 剧本正文用注入的字符串判定，不当成「产出资产」
    if (k === 'script') {
      if (!(typeof ctx.script === 'string' && ctx.script.trim())) missing.push('script')
      continue
    }
    const v = ctx[k]
    const empty = v == null
      || (Array.isArray(v) && v.length === 0)
      || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
      || (typeof v === 'string' && !v.trim())
    if (empty) missing.push(k)
  }
  return {
    ok: missing.length === 0,
    missing,
    missingLabels: missing.map((k) => STAGES[k]?.label ?? k),
  }
}

/* ---------------------------------------------------------------- 系统提示 */

const SYSTEM_BASE = `你是一位资深的 AI 短剧内容架构师，专精抖音/快手/视频号竖屏微短剧（单集 60–120 秒）。
你的输出必须是可以直接投产的**结构化创作资产**，不是创作建议。

通用铁律：
1. **你的第一个字符必须是「{」或「[」**。禁止任何前置说明、思考过程、任务复述、
   "The user wants me to…" 这类自言自语、Markdown 围栏之外的解释。
   你要分析就在心里分析，落笔即 JSON。
2. 全程中文。**禁止出现英文串**（字段名与枚举值除外）。
3. 所有字段严格遵守给定结构，不增删字段名。

**跨阶段一致性铁律（最高优先级，违反即视为不合格输出）：**
- 前序产出是你的**唯一事实来源**。禁止引入前序未出现的角色姓名、地名、组织名、专有名词。
  需要新角色时，必须在该条目里注明其与已有角色的关系（如「陆家三爷的私生子」）。
- 角色姓名必须与前序产出中出现的姓名**逐字一致**（不得把「默爷」写成「墨爷」「莫爷」）。
- 每条新产出都要能回答「它服务于哪一集的哪个节拍」，并在字段里显式引用该集号。
- 若前序资产已存在同类条目，应**更新/扩展**而不是另起一套平行设定。
- 发现前序存在矛盾时，沿用**顺序更靠前**的那一份，并在条目里注明冲突。
4. 人物形象提示词（appearancePrompt）必须写成**视觉可执行的画面描述**（年龄、体型、发型、服装、气质），
   不写姓名，不用「美丽动人」这类主观评价词——它会被直接喂给文生视频模型。
5. 台词必须口语化、有冲突张力，符合竖屏短剧的强钩子节奏。`

/** 各阶段专属提示。 */
const STAGE_PROMPTS = {
  contract: `请基于用户的「一句话想法」，产出**剧集立项契约**。

输出 JSON 对象，字段：
{
  "title": "剧名（8 字内，有钩子感）",
  "platform": "推荐投放平台（抖音/快手/视频号之一）",
  "audience": "目标受众画像（题材+年龄+性别+痛点，40 字内）",
  "episodeDurationSec": [最小秒, 最大秒],
  "targetEpisodes": 建议集数（整数，通常 8–20）,
  "orientation": "portrait 或 landscape",
  "hookDensity": "钩子密度策略（前几秒做什么、中段几次反转、结尾怎么留悬念）",
  "redlines": "内容红线（禁什么，平台合规视角）",
  "worldSpace": "世界空间（故事发生在哪，要有阶层/环境对比）",
  "worldTime": "世界时间（年代+关键时间设定）",
  "powerSystem": "核心竞争力/力量体系（无超自然就写信息差、资源、人脉等）"
}`,

  outline: `请基于立项契约产出**分集大纲**。

输出 JSON 数组，每集一个对象，字段：
{
  "order": 集号（从 1 开始）,
  "title": "集标题（6 字内）",
  "logline": "一句话剧情（谁做了什么、结果如何，40 字内）",
  "hook": "开场钩子（前 3 秒观众看到什么）",
  "twist": "中段反转（颠覆观众预期的那一下）",
  "cliffhanger": "结尾悬念（下一集的引子）",
  "estDurationSec": 预估时长秒数
}

要求：
- 集数严格等于契约的 targetEpisodes；每集 hook/twist/cliffhanger 互不重复；
- 整体要有**递进**：第 1 集建立冲突，中段升级对抗，最后 2 集收束并留续作空间；
- **【硬约束】每集必须明确落到契约定义的世界层级上**：
  看契约的 worldSpace，它列出的每一层（例如「地面旧货市场 / 地下市集 / 顶层高塔」）
  都必须在大纲里被实际使用至少一次，且 logline / hook 里要写明**发生在哪一层**；
- **【硬约束】契约的 powerSystem 是核心机制**：每集的 twist 必须依赖该机制推进
  （例如「以命饲妖」→ 每次用力量都要付出寿数代价），不许写成与机制无关的常规反转；
- **【硬约束】每个契约层面的地点/空间，在 12 集内至少出现 2 次**，
  否则说明该层级对剧情无用，应在 worldSpace 里删掉而不是留空。`,

  characters: `请基于立项契约与分集大纲产出**人物设定**。

**第一步（必做）**：先通读分集大纲，提取其中**已经出现过的所有角色姓名**（主角、对手、配角都算）。
你产出的 name 字段必须与这些姓名**逐字一致**——大纲里叫「默爷」就写「默爷」，
不许改名、不许加姓氏、不许写成同音字。大纲中**没出现**但剧情需要的角色可以新增，
但必须在 bio 开头标注「与 <已有角色> 的关系：…」。

输出 JSON 数组，字段：
{
  "id": "ch-序号",
  "name": "角色姓名（2–3 字，与大纲逐字一致）",
  "role": "主角/反派/配角/龙套",
  "personality": ["性格标签1", "性格标签2", "性格标签3"],
  "bio": "人物小传（与已有角色的关系+出身+处境+动机+转变弧线，80 字内）",
  "appearancePrompt": "形象提示词（年龄+体型+发型+服装+气质，视觉可执行，不提姓名，50 字内）",
  "voiceHint": "音色提示（清冷/温润/沙哑…+情绪表现特点，20 字内）",
  "arcEpisodes": [首次登场集号, 关键转折集号, 结局集号]
}

要求：
- 必须覆盖大纲里出现过的**每一个有名字的角色**，一个都不能漏；
- arcEpisodes 必须与大纲实际集号对得上，不能凭空编造；
- appearancePrompt 彼此区分度高（年龄/服装/气质明确不同），因为它们会被逐镜注入视频生成 prompt，雷同会导致角色串脸。`,

  world: `请基于立项契约、分集大纲与人物设定产出**世界观设定条目**。

**第一步（必做）**：契约的 worldSpace / worldTime / powerSystem 已经定义了世界骨架，
大纲与人物已经提到过若干地点与组织。你必须：
- 使用契约里出现的空间层级名称（例如契约写「城中村旧货市场 / 山海市集 / 昆仑墟高塔」，就沿用这三个名字）；
- 沿用大纲与人物中已出现的地名、组织名、专有名词，**不得另造同义名称**；
- 只补契约没写细、但剧情需要落地的那部分。

输出 JSON 数组，字段：
{
  "id": "w-序号",
  "kind": "地点/组织/规则/习俗/物品 之一",
  "name": "名称（优先复用前序已出现的名字）",
  "detail": "设定细节（80 字内，有画面感+剧情功能，不写百科式说明）",
  "usedInEpisodes": [使用该设定的集号数组]
}

要求：
- 至少含 3 个地点（须呈现契约要求的阶层或环境对比）、1 个组织、1 条规则；
- usedInEpisodes 必须指向大纲里真实存在的集，且该集确实用得上这条设定；
- 每条设定都要能**支撑某个具体剧情节拍**，不写与剧情无关的设定。`,

  memory: `请基于前序全部资产产出**本剧记忆条目**（用于后续创作时防 OOC、防设定冲突、防桥段重复）。

**第一步（必做）**：逐集扫描分集大纲的 hook / twist / cliffhanger，找出其中
**已经埋下但尚未回收**的线索（大纲里的 cliffhanger 往往就是下一集要回收的伏笔）。

输出 JSON 数组，字段：
{
  "id": "m-序号",
  "kind": "伏笔/已用桥段/时间线/人物状态 之一",
  "content": "记忆内容（要能被后续检索复用，100 字内）",
  "episode": 埋下该线索的集号,
  "payoffEpisode": 预期回收的集号（伏笔必填，非伏笔可为 null）,
  "status": "open（未回收）或 closed（已回收）",
  "relatedCharacters": ["涉及的已有角色姓名"]
}

要求：
- 至少 3 条**伏笔**，且 payoffEpisode 必须落在大纲实际集数范围内；
- 伏笔必须具体到「哪一集的哪个细节暗示了什么、将在哪一集如何回收」，
  禁止写「为后续埋下伏笔」这种空话；
- relatedCharacters 必须与人物设定里的姓名逐字一致；
- 再加 2 条已用桥段（防重复）、1 条时间线锚点。`,

  style: `请基于前序全部资产产出**视觉风格 DNA**（五维，每维不超过 300 字但要有画面可执行性）。

输出 JSON 对象：
{
  "schemaVersion": 1,
  "style": {
    "palette": "色调（主色+辅色+点缀光，含冷暖倾向）",
    "lighting": "光感（主光源方向、明暗对比、轮廓处理）",
    "texture": "质感（胶片/数码、颗粒、锐度、景深倾向）",
    "composition": "构图偏好（画幅、常用景别、对称/三分、视觉重心）",
    "motion": "运镜节奏（推拉摇移的偏好、速度快慢、留白处理）"
  }
}

要求：
- 五维必须与契约的题材与平台匹配（悬疑冷调 / 甜宠暖调 / 复仇高对比…）；
- 必须与**世界观设定里已描述的环境光**一致（若 world 写了「地下市集靠妖火照明」，
  lighting 就要承接这一点，不能另写「阳光明媚」）；
- 每维写成**具体参数级描述**，不写「电影感」这类模糊词。`,

  script: `请把**指定这一集**的大纲扩写成可拍摄的分集剧本。

输出 JSON 对象：
{
  "episode": 集号（整数）,
  "title": "集标题（沿用大纲）",
  "text": "剧本正文（Markdown 字符串，见下方格式）"
}

正文格式（严格遵守）：
# 第NNN集 集标题

## 场景 1：内景/外景 - 地点 - 时间
动作：只写镜头能拍到的画面，不写心理活动。
角色名：台词（口语化，单行不超过 20 字）

## 场景 2：…

要求：
- **场景数 2–4 个**，场景地点必须来自世界观里已登记的地点名；
- 对白角色必须在人物设定里存在，台词用**全角冒号**「角色名：台词」；
- 开场第一个场景必须兑现大纲本集的 hook，结尾必须落在 cliffhanger；
- 动作只写可拍摄内容（不大场面、不复杂特效）；
- 全集合计时长要贴近契约的 episodeDurationSec 区间；
- text 里用 \n 换行转义，不要嵌套对象。`,

  storyboard: `请把**指定这一集**的剧本拆成分镜表。

输出 JSON 数组，每个镜头一个对象，字段与顺序严格如下：
{
  "shotNumber": "镜号（本集内从 1 开始递增，字符串）",
  "shotSize": "景别：远景/全景/中景/近景/特写/大特写 之一",
  "cameraMove": "运镜：推/拉/摇/移/跟/固定 之一（一镜一动，不堆砌）",
  "description": "画面描述（**≤25 字**，只写镜头里看得见的）",
  "dialogue": "该镜内的对白或旁白（≤20 字，可留空字符串）",
  "sfx": "音效（≤12 字：BGM/环境音/拟音）",
  "durationSec": 时长秒数（整数，一镜 2–5 秒）,
  "imagePrompt": "生图提示词（**≤40 字**：形象锚点+本镜画面+景别+光线）",
  "videoPrompt": "生视频提示词（**≤40 字**：同上但补运镜与情绪）",
  "sceneRef": "本镜所在地点名称（与世界观里的地点名一致）"
}

节奏纪律（竖屏短剧，必须遵守）：
- **第一镜必须 shotSize 为「特写」或「大特写」**，且 durationSec ≤ 3 —— 硬要求，算法会校验；
- 其余镜头按剧本节奏推进，不要全是特写；
- 一镜 2–5 秒，不要有超过 8 秒的长镜；
- **【最关键】全集合计 durationSec 必须落在契约的单集时长区间内**（见上方契约的
  episodeDurationSec），算法会按 ±15% 校验，偏离会被直接拒绝；
- **镜头数要按时长反推**：镜头数 ≈ 单集目标秒数 ÷ 平均4秒。
  举例：契约 60–120 秒 → 需要 **15–30 个镜头**（不是 6–12 个！）。
  取中间值 90 秒，就是约 22 镜。宁可多拆，不要少拆。
- imagePrompt / videoPrompt 里**必须带上该镜人物的形象描述**（年龄体型发型服装），
  但**不写角色姓名**——姓名会被模型画成文字。`,
}

/* ---------------------------------------------------------------- 路由探测 */

/**
 * 高频非人名词组（避免把「的名字」「瞳睁开」这类当成角色名）。
 * 只用于**降低误报**，不会漏掉真实姓名。
 */
const STOP_WORDS = new Set([
  '的名字', '瞳睁开', '抢图鉴', '假妖骨', '二颗头', '条手臂', '只妖瞳', '教他',
  '他们', '我们', '自己', '此时', '随后', '当场', '众人', '全场', '对方', '两人',
  '三人', '一人', '所有', '这个', '那个', '一个', '没有', '不是', '已经', '正在',
  '忽然', '突然', '反而', '便', '就', '父亲', '母亲', '女儿', '儿子', '主角',
  '反派', '配角', '龙套', '异兽', '图鉴', '图卷', '封印', '血脉', '寿数', '气血',
])

/** free-model 的默认路由名（与 dsh-our-free-model 的 ROUTE_MAIN 对齐）。 */
export const FREE_MODEL_ROUTE = 'our-free-model'

/**
 * dsh-our-free-model 目录里已知的 model id（摘自其 src/catalog.js 的名字表）。
 *
 * 用途仅作**兜底默认**：llm 的 provider 路由要求 `model` 必须是具体 id，
 * 传 undefined/空串会让适配器返回 `id === undefined`，宿主随即抛
 * INVALID_MODEL_INFO（"invalid exact model metadata ... model \"undefined\""）。
 * 正常路径优先用 probeLlmRoutes 探到的实时目录。
 */
export const FREE_MODEL_FALLBACK_MODEL = 'deepseek-v4.1-flash-free'

/**
 * 探测宿主可用的 llm 路由与模型，用于前端选择。
 * 依次尝试 adapter 接口：listRouteAdapters / providers / routes / listModels。
 * 任一接口不可用都返回空数组，不抛错（探测是尽力而为）。
 *
 * @param {object} llm 宿主 llm 服务
 * @returns {Promise<{providers: string[], models: {id, name, provider}[], hasFreeModel: boolean}>}
 */
export async function probeLlmRoutes(llm) {
  const out = { providers: [], models: [], hasFreeModel: false }
  if (!llm || typeof llm !== 'object') return out

  // ① provider 列表：不同版本暴露不同名字，逐个尝试
  for (const key of ['listRouteAdapters', 'listProviders', 'providers', 'routes', 'catalog']) {
    try {
      const v = llm[key]
      const val = typeof v === 'function' ? await v.call(llm) : v
      if (!val) continue
      const arr = Array.isArray(val) ? val : Object.keys(val)
      const names = arr.map((x) => (typeof x === 'string' ? x : x?.provider ?? x?.id ?? '')).filter(Boolean)
      if (names.length) { out.providers = [...new Set([...out.providers, ...names])]; break }
    } catch { /* 换下一个接口 */ }
  }

  // ② 模型目录：listModels(provider) 可选参数
  for (const key of ['listModels', 'models', 'catalog']) {
    try {
      const v = llm[key]
      if (typeof v !== 'function') continue
      const list = await v.call(llm, out.providers[0] || undefined)
      if (Array.isArray(list) && list.length) {
        out.models = list.map((m) => ({
          id: String(m?.id ?? m ?? ''),
          name: String(m?.name ?? m?.id ?? m ?? ''),
          provider: String(m?.provider ?? out.providers[0] ?? ''),
        })).filter((m) => m.id)
        break
      }
    } catch { /* 换下一个 */ }
  }

  out.hasFreeModel = out.providers.includes(FREE_MODEL_ROUTE) || out.models.some((m) => m.provider === FREE_MODEL_ROUTE)
  return out
}

/* ---------------------------------------------------------------- 调用 */

/**
 * 从模型输出里抽取 JSON（剥离 ```json 围栏与前后赘述）。
 * @param {string} text
 * @returns {any}
 */
/**
 * 从被截断的 JSON 数组文本里抢救出所有**已完整闭合**的对象。
 *
 * 分镜这类长数组经常在预算边缘被截断：第 1–20 镜完整，第 21 镜写到一半。
 * 这时整份 JSON.parse 会失败，但前 20 镜是完全可用的产出，扔掉可惜。
 *
 * 做法：按 `{` `}` 配对扫描（跳过字符串内的花括号），每遇到一个深度归零的
 * 片段就尝试 JSON.parse，成功就收下。最后按需补齐数组闭合。
 *
 * @param {string} raw
 * @returns {any[]} 抢救出的对象数组（无内容时为空数组）
 */
export function salvageJsonArray(raw) {
  const text = String(raw ?? '')
  const first = text.indexOf('[')
  if (first < 0) return []
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = first; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const frag = text.slice(start, i + 1)
        try {
          const obj = JSON.parse(frag)
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj)
        } catch { /* 这个对象本身坏了，跳过 */ }
        start = -1
      }
      continue
    }
  }
  return out
}

export function extractJson(text, opts = {}) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('模型返回为空')

  // 若给了 reasoning（模型思考通道），正文解析失败时去那里再找一次
  const fallbacks = []
  if (opts.reasoning && String(opts.reasoning).trim()) fallbacks.push(String(opts.reasoning).trim())

  // ① 直接解析
  try { return JSON.parse(raw) } catch { /* 继续尝试 */ }

  // ② 剥离 Markdown 围栏
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try { return JSON.parse(fence[1].trim()) } catch { /* 继续 */ }
  }

  // ③ 截取第一个 { 或 [ 到最后一个 } 或 ]
  const firstObj = raw.indexOf('{')
  const firstArr = raw.indexOf('[')
  const start = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr)
  if (start !== -1) {
    const isArr = raw[start] === '['
    const end = raw.lastIndexOf(isArr ? ']' : '}')
    if (end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)) } catch { /* 继续 */ }
    }
  }
  // 区分「被截断」与「格式错误」：截断时给出可操作的建议
  const looksTruncated = (() => {
    const opens = (raw.match(/[{[]/g) || []).length
    const closes = (raw.match(/[}\]]/g) || []).length
    if (opens > closes) return true
    // 结尾停在字符串中间 / 逗号 / 冒号也视为截断
    return /[",:]\s*$/.test(raw)
  })()
  if (looksTruncated) {
    // 先抢救：数组里已完整闭合的对象其实可用（分镜前 20 镜写完了，第 21 镜断了）
    const rescued = opts.salvage === false ? [] : salvageJsonArray(raw)
    if (rescued.length) {
      // 标记源信息，让上层知道这是「部分结果」
      Object.defineProperty(rescued, 'salvaged', { value: true, enumerable: false })
      Object.defineProperty(rescued, 'partialFrom', { value: raw.length, enumerable: false })
      return rescued
    }
    throw new Error(
      `模型输出被截断（JSON 未闭合，已收到 ${raw.length} 字符），且无法抢救出完整片段。` +
      `通常是输出 token 预算不足：请在「模型」下拉换一个长输出能力更强的模型，或减少本阶段内容量后重试。` +
      `片段尾部：${raw.slice(-120)}`
    )
  }
  // 正文没有 JSON：再试 reasoning 通道（模型常把结构化结果写在思考里）
  for (const fb of fallbacks) {
    try { return extractJson(fb) } catch { /* 继续 */ }
  }

  // 识别「模型在自言自语」这种最常见的失败形态，给出针对性建议
  const looksLikeNarration = /^(The user|I need|Let me|I will|First,|Okay|Sure|Here)/i.test(raw)
  if (looksLikeNarration) {
    const e = new Error(
      `模型用自然语言复述任务，未输出 JSON（开头：${raw.slice(0, 80)}）。` +
      `这在长上下文时偶发；可重试一次，或换个模型。`
    )
    e.narrationLeak = true   // 标记：可重试
    throw e
  }
  throw new Error(`模型输出不是合法 JSON（前 200 字：${raw.slice(0, 200)}）`)
}

/**
 * 校验阶段产出的形状与条数下限。
 * @param {string} stage
 * @param {any} data
 */
export function validateStage(stage, data, opts = {}) {
  const meta = STAGES[stage]
  if (!meta) throw new Error(`未知阶段：${stage}`)

  // 修缺口模式下用 minRepair（只要求「至少改了一条」），不再套用全量下限
  const minRequired = opts.repair ? (meta.minRepair ?? 1) : meta.min

  if (meta.type === 'array') {
    if (!Array.isArray(data)) throw new Error(`${meta.label} 应为数组，实际为 ${typeof data}`)
    if (data.length < minRequired) {
      throw new Error(`${meta.label} 条目过少（${data.length} < ${minRequired}${opts.repair ? '，修正模式' : ''}）`)
    }
    data.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error(`${meta.label} 第 ${i + 1} 项不是对象`)
    })
  } else if (meta.type === 'script') {
    // 剧本是对象：必须有 text 与 episode，text 要是能落盘的 Markdown
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${meta.label} 应为对象`)
    if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('剧本缺少正文（text）')
    if (!Number.isFinite(Number(data.episode))) throw new Error('剧本缺少集号（episode）')
    // 至少要有一个场景标题，否则不是可拍摄的剧本
    if (!/##\s*场景/.test(data.text)) throw new Error('剧本正文缺少「## 场景 N：…」结构')
  } else {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${meta.label} 应为对象`)
  }

  // 阶段专属必填字段
  const REQUIRED = {
    contract: ['title', 'platform', 'audience', 'episodeDurationSec', 'targetEpisodes'],
    outline: ['order', 'title', 'logline', 'hook', 'twist', 'cliffhanger'],
    characters: ['name', 'role', 'appearancePrompt'],
    world: ['kind', 'name', 'detail'],
    memory: ['kind', 'content'],
  }
  const req = REQUIRED[stage]
  // 修复模式下必填字段降级为「至少有一项带该字段」，因为模型可能只返回要修改的条目
  if (req && Array.isArray(data)) {
    data.forEach((it, i) => {
      for (const k of req) {
        const v = it[k]
        const missing = v === undefined || v === null || (typeof v === 'string' && !v.trim())
        if (!missing) continue
        if (opts.repair) {
          // 修复模式：只在「整个数组没有任何一项含该字段」时才报错
          const anyHas = data.some(x => {
            const vv = x?.[k]
            return !(vv === undefined || vv === null || (typeof vv === 'string' && !vv.trim()))
          })
          if (!anyHas) throw new Error(`${meta.label} 全部条目都缺少必填字段 ${k}`)
          continue
        }
        throw new Error(`${meta.label} 第 ${i + 1} 项缺少必填字段 ${k}`)
      }
    })
  } else if (req) {
    for (const k of req) {
      const v = data[k]
      if (v === undefined || v === null) throw new Error(`${meta.label} 缺少必填字段 ${k}`)
    }
  }

  if (stage === 'style') {
    if (!data.style || typeof data.style !== 'object') throw new Error('风格 DNA 缺少 style 对象')
    const five = ['palette', 'lighting', 'texture', 'composition', 'motion']
    const filled = five.filter((k) => typeof data.style[k] === 'string' && data.style[k].trim())
    if (filled.length < 3) throw new Error(`风格 DNA 有效维度不足（${filled.length} < 3）`)
  }

  // 分镜专属：出片直接读这些字段，缺一个就出不了片
  if (stage === 'storyboard' && Array.isArray(data)) {
    opts.durationWarn = null   // 每次校验重置，避免复用 opts 时残留上一次的提示
    const REQUIRED_SHOT = ['shotNumber', 'shotSize', 'cameraMove', 'description', 'durationSec']
    data.forEach((sh, i) => {
      for (const k of REQUIRED_SHOT) {
        const v = sh?.[k]
        const missing = v === undefined || v === null || (typeof v === 'string' && !v.trim())
        if (missing) throw new Error(`分镜第 ${i + 1} 镜缺少必填字段 ${k}`)
      }
      const dur = Number(sh.durationSec)
      if (!Number.isFinite(dur) || dur < 1 || dur > 15) {
        throw new Error(`分镜第 ${i + 1} 镜时长非法（${sh.durationSec}），应为 1–15 秒`)
      }
    })
    // 镜号必须唯一（重号会让产物文件名冲突）
    const nums = data.map((sh) => String(sh.shotNumber))
    const dup = nums.filter((n, i) => nums.indexOf(n) !== i)
    if (dup.length) throw new Error(`分镜镜号重复：${[...new Set(dup)].slice(0, 5).join('、')}`)

    // 总时长与契约区间核对：**只记录不阻断**。
    // 早期这里 throw，导致模型给出 6 镜 24 秒就被整份拒绝，用户只看到「生成失败」。
    // 时长偏差应由「出片前的门禁/平台检查」提示，不该让整次生成作废。
    const total = data.reduce((n, sh) => n + (Number(sh.durationSec) || 0), 0)
    const range = opts.contract?.episodeDurationSec
    if (Array.isArray(range) && range.length === 2) {
      const [lo, hi] = [Number(range[0]), Number(range[1])]
      const outOfRange = Number.isFinite(lo) && Number.isFinite(hi)
        && (total < lo * 0.85 || total > hi * 1.15)
      // 通过 validateStage 的返回值带出来，由调用方决定是否提示
      if (outOfRange) {
        // eslint-disable-next-line no-param-reassign
        opts.durationWarn = `分镜总时长 ${total}s 与契约 ${lo}–${hi}s 偏离较大（建议 ${Math.round(lo / 4)}–${Math.round(hi / 4)} 镜）`
      }
    }
  }

  return { ok: true, durationWarn: opts.durationWarn || null }
}

/**
 * 调宿主 LLM 并收流成完整文本。
 *
 * 与 ai-drama 的 collectModelStream 同构：AbortController 超时、逐 chunk 累积、
 * 输出超长保护。区别是失败时**抛错**而不是返回 ok:false——创作链需要明确中断。
 *
 * @param {object} llm 宿主 llm 服务（ctx.get('llm')）
 * @param {object} opts
 * @returns {Promise<{text: string, usage: object|null, elapsedMs: number}>}
 */
async function callModel(llm, { system, user, maxTokens, temperature = 0.7, timeoutMs = STAGE_TIMEOUT_MS, provider, model }) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { controller.abort(new Error('stage-timeout')) } catch { /* ignore */ }
  }, Math.max(500, timeoutMs))

  const startedAt = Date.now()
  let text = ''
  let reasoning = ''
  let usage = null
  const seenTypes = new Map()
  let finishReason = null

  try {
    // provider/model 显式传入时走指定路由（如 our-free-model），否则用宿主默认链
    const opts = {
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens,
      temperature,
      signal: controller.signal,
    }
    if (provider) opts.provider = provider
    // model 只在有实际字符串时才传：宿主适配器要求它是具体 id，
     // 传 undefined 会被当成 "undefined" 字面量并触发 INVALID_MODEL_INFO
    if (typeof model === 'string' && model.trim()) opts.model = model.trim()
    const stream = llm.stream(opts)
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      const t = String(chunk.type || 'unknown')
      seenTypes.set(t, (seenTypes.get(t) ?? 0) + 1)
      if (t === 'reasoning-delta' || t === 'reasoning') {
        // 某些模型把正文全放 reasoning 通道：照样累积，避免「空文本」误判
        reasoning += chunk.text || ''
        continue
      }
      if (chunk.type === 'text-delta') {
        text += chunk.text || ''
        // 输出过长保护：中文 1 字符 ≈ 1 token，留 3 倍余量即可（原先 6 倍过于激进）
        if (text.length > maxTokens * 3) {
          try { controller.abort(new Error('output-too-long')) } catch { /* ignore */ }
          break
        }
      } else if (chunk.type === 'usage') {
        usage = chunk.usage || null
      } else if (chunk.type === 'finish') {
        finishReason = chunk.reason || null
        if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          throw new Error(`模型调用中断：${chunk.reason.failure?.message || chunk.reason.kind}`)
        }
      }
    }
  } catch (error) {
    if (timedOut) throw new Error(`阶段超时（${Math.round(timeoutMs / 1000)}s）`)
    throw new Error(`模型调用失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
    try { if (!controller.signal.aborted) controller.abort(new Error('finished')) } catch { /* ignore */ }
  }

  if (timedOut) throw new Error(`阶段超时（${Math.round(timeoutMs / 1000)}s）`)

  // 正文为空但 reasoning 有内容：说明模型把输出放进了思考通道。
  // 优先用 reasoning 兜底（extractJson 会自己找出 JSON），实在没有才报错。
  if (!text.trim() && reasoning.trim()) {
    text = reasoning
  }
  if (!text.trim()) {
    const dist = [...seenTypes.entries()].map(([k, v]) => `${k}×${v}`).join(', ') || '(无 chunk)'
    const fin = finishReason ? ` finish=${JSON.stringify(finishReason.kind || finishReason)}` : ''
    const err = new Error(
      `模型返回空文本（收到 ${dist}${fin}，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）。` +
      `可能是模型提前停止或只输出了思考内容，请换个模型或减少上下文后重试。`
    )
    err.emptyText = true
    err.elapsedMs = Math.max(0, Date.now() - startedAt)
    throw err
  }
  return { text, usage, elapsedMs: Math.max(0, Date.now() - startedAt), reasoning: reasoning || null }
}

/**
 * 生成单个阶段。
 *
 * @param {object} opts
 * @param {object} opts.llm 宿主 llm 服务
 * @param {string} opts.stage 阶段名
 * @param {string} [opts.idea] 用户一句话想法（仅 contract 阶段使用）
 * @param {object} [opts.context] 前序阶段产出 { contract, outline, characters, world, memory }
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{stage: string, label: string, data: any, usage: object|null, elapsedMs: number}>}
 */
export async function generateStage(optsIn) {
  // storyboard 分批：单次输出装不下 15–30 镜，拆成多批各自生成再拼接。
  if (optsIn?.stage === 'storyboard') return generateStoryboardBatched(optsIn)
  return generateStageOnce(optsIn)
}

/**
 * 分镜分批生成：把「15–30 镜」拆成每批 BATCH 镜，逐批调用后合并。
 *
 * 单次输出上限（模型 maxOutput / 我们给的 maxTokens）装不下整集分镜：
 * 实测 16290 字符仍被截断。分批后每批只有 6 镜（约 1200 字符），
 * 绝不会撞上限，而且某批失败只损失那一批，已出的镜头仍可用。
 */
export async function generateStoryboardBatched({
  llm, context = {}, episode, provider, model,
  timeoutMs = STAGE_TIMEOUT_MS, allowMissingPrereq = false, batches = 4,
}) {
  const meta = STAGES.storyboard
  const ep = Number(episode)
  if (!Number.isFinite(ep) || ep < 1) {
    throw new Error(`「${meta.label}」需要先指定集号（episode，正整数）`)
  }
  const totalBatches = Math.max(1, Math.min(8, Number(batches) || 4))
  const perBatch = 6
  const targetShots = totalBatches * perBatch

  const all = []
  const batchErrors = []
  let usage = null
  let elapsedMs = 0
  let lastWarn = null

  for (let b = 0; b < totalBatches; b++) {
    const from = b * perBatch + 1
    const to = from + perBatch - 1
    let r = null
    try {
      r = await generateStageOnce({
        llm,
        stage: 'storyboard',
        context: {
          ...context,
          // 告知本批要出的镜号区间，避免每批都从 1 开始
          __batch: { index: b + 1, total: totalBatches, from, to, perBatch, targetShots },
        },
        episode: ep,
        provider, model, timeoutMs, allowMissingPrereq,
      })
    } catch (e) {
      // 单批失败不中断整轮：已出的镜头仍然可用，最后统一提示
      batchErrors.push(`第 ${b + 1} 批：${e.message}`)
      continue
    }
    elapsedMs += r.elapsedMs || 0
    if (r.usage) usage = r.usage
    if (r.durationWarn) lastWarn = r.durationWarn
    const got = Array.isArray(r.data) ? r.data : []
    if (!got.length) batchErrors.push(`第 ${b + 1} 批无产出`)
    // 重新编号，避免各批都从 1 开始导致镜号重复
    for (const sh of got) {
      if (all.length >= targetShots) break
      all.push({ ...sh, shotNumber: String(all.length + 1) })
    }
  }

  if (!all.length) {
    throw new Error(
      `分镜分批生成全部失败（${totalBatches} 批）：${batchErrors.slice(0, 2).join('；') || '无产出'}`
    )
  }

  // 合并后再校验一次（镜号、时长、字段）
  const vres = validateStage('storyboard', all, { contract: context.contract })
  const warnParts = []
  if (all.length < targetShots) {
    warnParts.push(`目标 ${targetShots} 镜，实得 ${all.length} 镜（部分批次产出不足）`)
  }
  if (vres?.durationWarn) warnParts.push(vres.durationWarn)

  return {
    stage: 'storyboard', label: meta.label, data: all,
    usage, elapsedMs,
    consistency: checkConsistency('storyboard', all, context),
    contextSaved: 0,
    durationWarn: warnParts.length ? warnParts.join('；') : null,
    salvaged: false,
    batches: totalBatches,
  }
}

async function generateStageOnce({
  llm, stage, idea, context = {}, timeoutMs = STAGE_TIMEOUT_MS, provider, model,
  allowMissingPrereq = false, episode,
}) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主未提供 llm 服务（无法 AI 生成）')
  const meta = STAGES[stage]
  if (!meta) throw new Error(`未知阶段：${stage}`)

  // 前置校验：缺契约就跑人物，产出必然与后续接不上，不如直接拦住
  const prereq = checkPrerequisites(stage, context)
  if (!prereq.ok && !allowMissingPrereq) {
    throw new Error(
      `「${meta.label}」还缺前序资产：${prereq.missingLabels.join('、')}。` +
      `请先生成它们，否则本阶段产出会与后续接不上。` +
      `（如需强行生成，可传 allowMissingPrereq=true）`
    )
  }

  // 按集阶段必须先有集号。
  // 注意：不要用 Number(episode) 判空 —— Number(null) === 0 且 isFinite(0) === true，
  // 会把「没传集号」误判成「第 0 集」。必须显式排除 undefined/null/空串。
  if (EPISODE_STAGES.includes(stage)) {
    const hasEp = episode !== undefined && episode !== null && String(episode).trim() !== ''
    const n = hasEp ? Number(episode) : NaN
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`「${meta.label}」需要先指定集号（episode，正整数）`)
    }
  }

  // 组装上下文：只放与当前阶段相关的前序产出，并按字段白名单瘦身
  const picked = pickContext(stage, context)
  // __batch 是分批控制信息，不参与字段裁剪，单独取出来用
  const batchInfo = context.__batch || null
  const { slimmed: baseSlim, savedChars } = slimContext(stage, picked)
  let slimmed = baseSlim

  // 按集生成时进一步收窄：大纲只要本集，伏笔只要与本集相关的
  if (EPISODE_STAGES.includes(stage)) {
    const ep = Number(episode)
    const narrowed = { ...baseSlim }
    if (Array.isArray(narrowed.outline)) {
      const one = narrowed.outline.filter((e) => Number(e?.order) === ep)
      narrowed.outline = one.length ? one : narrowed.outline.slice(0, 1)
    }
    if (Array.isArray(narrowed.memory)) {
      narrowed.memory = narrowed.memory.filter((m) => {
        const planted = Number(m?.episode)
        const payoff = Number(m?.payoffEpisode)
        return planted === ep || payoff === ep || Number.isNaN(planted)
      })
    }
    slimmed = narrowed
  }
  const ctxParts = []
  for (const [k, v] of Object.entries(slimmed)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && !v.length) continue
    // 剧本正文按原文呈现（Markdown），不要 JSON.stringify
    if (k === 'script' && typeof v === 'string') {
      ctxParts.push(`【本集剧本正文（必须逐场拆镜，不得另编剧情）】\n${v}`)
      continue
    }
    ctxParts.push(`【前序产出：${STAGES[k]?.label || k}】\n${JSON.stringify(v, null, 2)}`)
  }

  const epHead = EPISODE_STAGES.includes(stage)
    ? `【本次只写第 ${Number(episode)} 集】\n只输出这一集的内容；大纲里其它集仅供理解上下文，不要写进输出。`
    : ''

  // 分批：明确告诉本批要出哪几镜，避免重复或从 1 重新开始
  const batch = batchInfo
  const batchHead = batch
    ? `【分批生成：第 ${batch.index}/${batch.total} 批】\n` +
      `本批只输出 **镜号 ${batch.from} 到 ${batch.to}** 的 ${batch.perBatch} 个镜头（shotNumber 用 "1"–"${batch.perBatch}" 也可，系统会自动重编号）。\n` +
      `整集共 ${batch.targetShots} 镜；前后批次会拼接，所以：\n` +
      `- 不要重复剧情：本批从剧本的对应段落继续往后拆；\n` +
      `- 不要输出本批区间之外的镜头；\n` +
      `- 直接输出 JSON 数组，第一个字符是「[」。`
    : ''
  const userMsg = [
    stage === 'contract' ? `【用户想法】\n${String(idea ?? '').trim() || '（未提供，请自行构思一个高钩子短剧题材）'}` : '',
    epHead,
    batchHead,
    ...ctxParts,
    STAGE_PROMPTS[stage],
  ].filter(Boolean).join('\n\n')

  let result
  // 空文本通常是模型提前停止的偶发现象，自动重试一次（多数第二次能出内容）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await callModel(llm, {
        system: SYSTEM_BASE,
        user: userMsg,
        maxTokens: STAGE_MAX_TOKENS[stage] || 2000,
        timeoutMs,
        provider,
        model,
      })
      break
    } catch (e) {
      // 空文本 / 自言自语：都是「模型没按格式输出」的偶发形态，重试一次
      if ((e?.emptyText || e?.narrationLeak) && attempt === 0) continue
      throw e
    }
  }
  const { text, usage, elapsedMs } = result

  const data = extractJson(text, { reasoning: result?.reasoning })
  const wasSalvaged = Boolean(data?.salvaged) && Array.isArray(data)
  const vres = validateStage(stage, data, { contract: context.contract })
  // 抢救可能只拿到部分镜头，把两条提示合并（抢救警告优先）
  const warnParts = []
  if (wasSalvaged) {
    warnParts.push(`原输出被截断，已抢救出前 ${data.length} 个完整镜头（后续可能缺镜，可降低镜数或提高预算后重试）`)
  }
  if (vres?.durationWarn) warnParts.push(vres.durationWarn)
  const durationWarn = warnParts.length ? warnParts.join('；') : null
  // 跨阶段一致性：只告警不阻断，让界面能提示「这里接不上」
  const consistency = checkConsistency(stage, data, context)
  return { stage, label: meta.label, data, usage, elapsedMs, consistency, contextSaved: savedChars, durationWarn, salvaged: wasSalvaged }
}

/**
 * 跨阶段一致性校验：检查本阶段产出是否真的承接了前序资产。
 *
 * schema 校验（validateStage）只保证「形状对不对」，不保证「内容接不接」。
 * 早期实测发现模型会另起一套平行设定：大纲里叫「默爷」，人物卡写成「墨爷」；
 * 契约定了「以命饲妖」，世界观却写「无超自然力量」。
 * 这里做机械比对，把断裂暴露给调用方，而不是靠模型自觉。
 *
 * 只做**告警**不阻断：模型输出仍可用，但会连同 issues 一起返回给界面提示。
 *
 * @param {string} stage
 * @param {any} data 本阶段产出
 * @param {object} ctx 前序产出
 * @returns {{ok: boolean, issues: {level: string, code: string, message: string}[], stats: object}}
 */
export function checkConsistency(stage, data, ctx = {}) {
  const issues = []
  const stats = {}
  const add = (level, code, message) => issues.push({ level, code, message })

  /** 从任意前序资产里抓中文专有名词（姓名/地名，2–4 字）。 */
  const collectNames = (assets, fieldKeys) => {
    const set = new Set()
    for (const arr of Object.values(assets)) {
      if (!Array.isArray(arr)) continue
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue
        for (const k of fieldKeys) {
          const v = item[k]
          if (typeof v === 'string' && v.trim() && v.length <= 12) set.add(v.trim())
        }
      }
    }
    return set
  }

  // ---- characters：姓名必须覆盖大纲里出现过的角色 ----
  if (stage === 'characters' && Array.isArray(data)) {
    // 从大纲里提取「确定是人名」的候选：只认强证据，避免把普通词组当人名。
    //   ① 对话前缀「张三：」   ② 书名号/引号内的 2–3 字
    //   ③ 集标题里作为主体的 2–3 字（标题通常就是主角或核心人物名）
    const strongNames = new Map()
    const bump = (n) => {
      if (!n || n.length < 2 || n.length > 3) return
      if (STOP_WORDS.has(n)) return
      strongNames.set(n, (strongNames.get(n) ?? 0) + 1)
    }
    for (const e of (ctx.outline || [])) {
      const blob = ['title', 'logline', 'hook', 'twist', 'cliffhanger']
        .map((k) => String(e?.[k] ?? '')).join('\n')
      // ① 对话前缀：中文名后紧跟「：」或「：」前的引号
      for (const m of blob.matchAll(/([\u4e00-\u9fa5]{2,3})[：:]\s*(?:[「“"])/g)) bump(m[1])
      // ② 引号/书名号内的 2–3 字（可能是人名或称谓）
      for (const m of blob.matchAll(/[「“"]([\u4e00-\u9fa5]{2,3})[」”"]/g)) bump(m[1])
      // ③ 「XX 在/带/让/被/发现/当众」这类主语句式里靠前的 2–3 字
      for (const m of blob.matchAll(/([\u4e00-\u9fa5]{2,3})(?:在|带|让|被|发现|当众|循|忍|把|站|说|问|夺|拆)/g)) bump(m[1])
      // ④ 称谓形态：X爷 / 老X / 小X / X先生 / X夫人 —— 短剧里这类几乎都是固定角色
      for (const m of blob.matchAll(/([\u4e00-\u9fa5]{1,2}爷|[老小][\u4e00-\u9fa5]{1,2}|[\u4e00-\u9fa5]{1,3}(?:先生|夫人|老板))/g)) bump(m[1])
    }
    const charNames = new Set(data.map((c) => String(c?.name ?? '').trim()).filter(Boolean))
    const candidates = [...strongNames.entries()]
      .filter(([, c]) => c >= 2)      // 至少两处强证据才算稳定人名
      .map(([n]) => n)
    const covered = candidates.filter((n) => charNames.has(n))
    const missing = candidates.filter((n) => !charNames.has(n))
    stats.outlineNames = candidates.length
    stats.characterNames = charNames.size
    stats.covered = covered.length
    stats.missing = missing.slice(0, 10)

    // 漏一个也提醒：短剧角色少一个，后续分镜就会缺锚点
    if (missing.length >= 1) {
      add('warn', 'LINK-01', `大纲中的角色未出现在人物设定：${missing.slice(0, 8).join('、')}`)
    }
    if (candidates.length >= 3 && covered.length === 0) {
      add('fail', 'LINK-02', '人物设定与大纲角色姓名完全对不上（疑似另起一套设定）')
    }
    // 反向：人物卡里出现了大纲完全没有的姓名，说明可能凭空新增
    const extra = [...charNames].filter((n) => !candidates.includes(n))
    stats.extra = extra.slice(0, 10)
    if (candidates.length >= 3 && extra.length > charNames.size / 2) {
      add('warn', 'LINK-08', `${extra.length} 个人物在大纲中找不到对应痕迹（建议在 bio 标注与已有角色的关系）`)
    }
  }

  // ---- world：地名应复用契约里的空间层级 ----
  if (stage === 'world' && Array.isArray(data)) {
    const contractText = [ctx.contract?.worldSpace, ctx.contract?.worldTime, ctx.contract?.powerSystem]
      .filter(Boolean).join(' ')
    const worldNames = data.map((w) => String(w?.name ?? '').trim()).filter(Boolean)
    stats.worldNames = worldNames.length
    if (contractText) {
      // 契约里用「/」「、」「与」分隔的层级名
      const contractPlaces = contractText.split(/[／/、，。；：与和及\s]+/)
        .map((x) => x.trim()).filter((x) => x.length >= 2 && x.length <= 8)
      const reused = contractPlaces.filter((p) => worldNames.some((n) => n.includes(p) || p.includes(n)))
      stats.contractPlaces = contractPlaces.length
      stats.reusedPlaces = reused.length
      if (contractPlaces.length >= 3 && reused.length === 0) {
        add('warn', 'LINK-03', '世界观未复用契约中定义的空间层级名称（可能另造同义名称）')
      }
    }
    // 契约写了力量体系，世界观应有一条规则承接
    if (ctx.contract?.powerSystem) {
      const hasRule = data.some((w) => String(w?.kind ?? '').includes('规则'))
      if (!hasRule) add('warn', 'LINK-04', '契约定义了力量体系，但世界观缺少「规则」类条目来承接')
    }
  }

  // ---- memory：伏笔要指向大纲真实存在的集 ----
  if (stage === 'memory' && Array.isArray(data)) {
    const epCount = (ctx.outline || []).length
    const foreshadows = data.filter((m) => String(m?.kind ?? '').includes('伏笔'))
    stats.foreshadow = foreshadows.length
    stats.episodeCount = epCount
    if (epCount > 0) {
      const outOfRange = foreshadows.filter((m) => {
        const p = Number(m?.payoffEpisode)
        return Number.isFinite(p) && (p < 1 || p > epCount)
      })
      if (outOfRange.length) {
        add('warn', 'LINK-05',
          `${outOfRange.length} 条伏笔的回收集号超出大纲范围（共 ${epCount} 集）`)
      }
      const noPayoff = foreshadows.filter((m) => m?.payoffEpisode == null)
      if (noPayoff.length) {
        add('warn', 'LINK-06', `${noPayoff.length} 条伏笔未标注回收集号（payoffEpisode）`)
      }
    }
    // 涉及角色应与人物设定一致
    const charNames = new Set((ctx.characters || []).map((c) => String(c?.name ?? '').trim()).filter(Boolean))
    if (charNames.size) {
      const bad = []
      for (const m of data) {
        for (const n of (m?.relatedCharacters || [])) {
          if (String(n).trim() && !charNames.has(String(n).trim())) bad.push(String(n).trim())
        }
      }
      if (bad.length) {
        add('warn', 'LINK-07', `记忆条目引用了人物设定中不存在的角色：${[...new Set(bad)].slice(0, 6).join('、')}`)
      }
    }
  }

  return { ok: issues.filter((i) => i.level === 'fail').length === 0, issues, stats }
}

/**
 * 各阶段对前序资产需要的**字段白名单**。
 *
 * 上下文不是越多越好：memory 阶段原来塞了完整的人物卡（personality/bio/
 * appearancePrompt/voiceHint）与完整世界观（detail），但这些字段对「找未回收伏笔」
 * 毫无用处。实测 memory 上下文达 8700 字符时模型频繁提前停止、或先复述任务再输出。
 * 这里按阶段裁剪到真正要用的字段，把上下文压到 1/3 左右。
 *
 * 值含义：`null` = 该阶段要全字段；数组 = 只保留这些字段。
 */
const CONTEXT_FIELDS = {
  // 写剧本：人物要有姓名与定位（谁在场），世界要有地点名（在哪拍）
  script: {
    characters: ['id', 'name', 'role', 'personality'],
    world: ['id', 'kind', 'name'],
  },
  // 分镜：人物**必须带形象锚点**（要写进 imagePrompt），世界要有地点
  storyboard: {
    characters: ['id', 'name', 'role', 'appearancePrompt'],
    world: ['id', 'kind', 'name', 'detail'],
  },
  contract: {
    // 其他阶段对契约只需要骨架，不需要 redlines 之外的长文本
    default: ['title', 'platform', 'audience', 'episodeDurationSec', 'targetEpisodes', 'orientation', 'hookDensity', 'redlines', 'worldSpace', 'worldTime', 'powerSystem'],
  },
  outline: {
    // 建人物：只需要「哪集、什么标题、一句话剧情」——姓名主要出现在 logline/title，
    // hook/twist/cliffhanger 里的姓名会重复出现，删掉不影响抽取，能省 40%
    names: ['order', 'title', 'logline'],
    // 找伏笔/建风格：要看 hook/twist/cliffhanger 里的未回收线索
    default: ['order', 'title', 'logline', 'hook', 'twist', 'cliffhanger'],
  },
  characters: {
    // 建世界观/记忆/风格：只要姓名与定位，不要形象提示词与小传
    lean: ['id', 'name', 'role'],
    default: ['id', 'name', 'role', 'personality', 'bio', 'appearancePrompt', 'voiceHint', 'arcEpisodes'],
  },
  world: {
    // 做记忆/风格：只要名称与类型，不要 detail
    lean: ['id', 'kind', 'name'],
    default: ['id', 'kind', 'name', 'detail', 'usedInEpisodes'],
  },
  memory: {
    // 记忆本身：只要 id/kind/content/episode/payoff/status，不要 relatedCharacters
    lean: ['id', 'kind', 'content', 'episode', 'payoffEpisode', 'status'],
    default: null,
  },
}

/** 按白名单裁剪单条记录。 */
function slimRecord(rec, fields) {
  if (!rec || typeof rec !== 'object' || !Array.isArray(fields)) return rec
  const out = {}
  for (const f of fields) if (rec[f] !== undefined) out[f] = rec[f]
  return out
}

/**
 * 决定某一阶段读取某个前序资产时要用哪些字段。
 *
 * 规则：同阶段同资产，越靠后的阶段越能只用「lean」字段；
 * 目标阶段自己要用的资产（如 characters 建人物）用 default。
 */
function fieldsFor(targetStage, sourceKey) {
  // ① 优先：按「目标阶段 → 源资产」的显式白名单（如 CONTEXT_FIELDS.script.characters）
  //    这是最直接的写法，新增阶段时只需在这里登记，不用改判断分支。
  const byTarget = CONTEXT_FIELDS[targetStage]
  if (byTarget && Array.isArray(byTarget[sourceKey])) return byTarget[sourceKey]

  // ② 兜底：按源资产自己的分档
  const cfg = CONTEXT_FIELDS[sourceKey]
  if (!cfg || Array.isArray(cfg)) return null
  // 建人物阶段对大纲只需要「哪集/标题/一句话」，不需要三个节拍字段
  if (targetStage === 'characters' && sourceKey === 'outline') return cfg.names ?? cfg.default ?? null
  const leanFor = new Set([
    'world:characters', 'memory:characters', 'style:characters',
    'memory:world', 'style:world',
  ])
  const k = `${targetStage}:${sourceKey}`
  return leanFor.has(k) ? (cfg.lean ?? null) : (cfg.default ?? null)
}

/** 只取对当前阶段有用的前序产出，并按白名单裁剪字段。 */
function pickContext(stage, ctx) {
  const order = STAGE_ORDER.indexOf(stage)
  const out = {}
  for (const k of (STAGE_DEPS[stage] ?? [])) {
    // script 不是「产出资产」而是「该集剧本正文」，用注入标记让它进上下文
    if (k === 'script') {
      if (typeof ctx.script === 'string' && ctx.script.trim()) out.script = ctx.script
      continue
    }
    if (STAGE_ORDER.indexOf(k) < order && ctx[k] !== undefined) out[k] = ctx[k]
  }
  return out
}

/**
 * 按阶段裁剪上下文（体积瘦身）。
 *
 * pickContext 决定「拿哪些资产」，这里再决定「每个资产保留哪些字段」。
 * 与 pickContext 分开，便于单独测试与在 prompt 里展示「已裁剪」提示。
 *
 * @param {string} stage
 * @param {object} picked pickContext 的返回
 * @returns {{slimmed: object, savedChars: number, beforeChars: number}}
 */
export function slimContext(stage, picked = {}) {
  const before = Object.values(picked).reduce((n, v) => n + JSON.stringify(v ?? null).length, 0)
  const slimmed = {}
  for (const [k, v] of Object.entries(picked)) {
    if (v === undefined || v === null) continue
    // 剧本正文是纯字符串，没有字段白名单可裁，原样保留
    if (k === 'script' && typeof v === 'string') { slimmed[k] = v; continue }
    const fields = fieldsFor(stage, k)
    if (!fields) { slimmed[k] = v; continue }
    if (Array.isArray(v)) {
      slimmed[k] = v.map((it) => slimRecord(it, fields))
    } else if (typeof v === 'object' && !Array.isArray(v)) {
      // 对象资产（contract/style）：只留白名单里的键
      const out = {}
      for (const f of fields) if (v[f] !== undefined) out[f] = v[f]
      slimmed[k] = out
    } else {
      slimmed[k] = v
    }
  }
  const after = Object.values(slimmed).reduce((n, v) => n + JSON.stringify(v ?? null).length, 0)
  return { slimmed, beforeChars: before, savedChars: Math.max(0, before - after) }
}

/**
 * 带着**具体缺口清单**重跑某个阶段。
 *
 * 与 generateStage 的区别：多传一段 `repairHints`，明确告诉模型「你上一版哪里漏了」。
 * 用于「总览」页签点「让 AI 补」的场景——比笼统重跑有效得多，因为模型知道具体缺什么。
 *
 * @param {object} opts
 * @param {object} opts.llm
 * @param {string} opts.stage
 * @param {object} opts.context 已有全部资产
 * @param {string[]} opts.hints 缺口描述（来自 buildLinkGraph 的 orphans）
 * @returns {Promise<object>}
 */
export async function regenerateWithHints({ llm, stage, context = {}, hints = [], provider, model }) {
  if (!Array.isArray(hints) || !hints.length) {
    // 没有具体缺口就退化成普通重跑
    return generateStage({ llm, stage, context, provider, model })
  }
  const hintBlock = [
    '【上一版的具体缺口，本次必须逐条修正】',
    ...hints.map((h, i) => `${i + 1}. ${h}`),
    '',
    '修正要求：',
    '- 直接输出 JSON，第一个字符必须是「{」或「[」；',
    '- 禁止复述任务、禁止输出思考过程、禁止任何英文说明（不要写 "The user wants…"）；',
    '- 上面每一条都必须在本次输出里有对应处理，不许忽略；',
    '- 若某条缺口指向的对象（角色/场景）确实不该存在，就在输出里**移除它**而不是留着；',
    '- **必须保留原有条目的 `id` 字段**，否则无法合并回原文件；',
    '- 保持与已有资产的其余部分一致，不要推翻已在用的设定。',
  ].join('\n')

  // 把缺口块塞进该阶段的 user 消息（复用 generateStage 的组装逻辑）
  const meta = STAGES[stage]
  if (!meta) throw new Error(`未知阶段：${stage}`)

  const prereq = checkPrerequisites(stage, context)
  if (!prereq.ok) {
    throw new Error(`「${meta.label}」还缺前序资产：${prereq.missingLabels.join('、')}`)
  }

  const picked = pickContext(stage, context)
  const { slimmed, savedChars } = slimContext(stage, picked)
  const ctxParts = []
  for (const [k, v] of Object.entries(slimmed)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && !v.length) continue
    ctxParts.push(`【前序产出：${STAGES[k]?.label || k}】\n${JSON.stringify(v, null, 2)}`)
  }
  const userMsg = [...ctxParts, hintBlock, STAGE_PROMPTS[stage]].filter(Boolean).join('\n\n')

  // 与 generateStage 一致：空文本/自言自语重试一次
  let r
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await callModel(llm, {
        system: SYSTEM_BASE,
        user: userMsg,
        maxTokens: STAGE_MAX_TOKENS[stage] || 2000,
        provider,
        model,
      })
      // 解析也放进重试循环：自言自语属于「模型没按格式输出」，换一次可能就好
      var parsed = extractJson(r.text, { reasoning: r.reasoning })
      break
    } catch (e) {
      lastErr = e
      if ((e?.emptyText || e?.narrationLeak) && attempt === 0) continue
      throw e
    }
  }
  if (!parsed) throw lastErr || new Error('修复重试后仍无有效输出')
  const data = parsed
  // 修复模式：放宽条目下限与必填字段，因为模型只需回「被改动的那几条」
  const vres2 = validateStage(stage, data, { repair: true, contract: context.contract })
  const consistency = checkConsistency(stage, data, context)
  return { stage, label: meta.label, data, usage: r.usage, elapsedMs: r.elapsedMs, consistency, usedHints: hints.length, repairMode: true, contextSaved: savedChars, durationWarn: vres2?.durationWarn || null }
}

/**
 * 全链生成：从想法一路跑到视觉风格 DNA。
 *
 * 逐阶段回调 onStage，让前端能实时显示进度；任一阶段失败立即中断并带上阶段名。
 *
 * @param {object} opts
 * @param {object} opts.llm
 * @param {string} opts.idea
 * @param {string[]} [opts.only] 只跑这些阶段（用于单阶段重跑）
 * @param {(evt: object) => void} [opts.onStage]
 * @returns {Promise<{assets: object, stages: object[], errors: object[]}>}
 */
export async function generateAll({ llm, idea, only, onStage, provider, model }) {
  // 全链默认只跑前六阶段；script/storyboard 按集生成，必须用 only 显式触发
  const targets = Array.isArray(only) && only.length ? only : CHAIN_ORDER
  const assets = {}
  const stages = []
  const errors = []

  for (const stage of targets) {
    const t0 = Date.now()
    try {
      const r = await generateStage({ llm, stage, idea, context: { ...assets }, provider, model })
      assets[stage] = r.data
      stages.push({
        stage, label: r.label, ok: true, elapsedMs: r.elapsedMs, usage: r.usage,
        bytes: JSON.stringify(r.data).length,
        consistency: r.consistency,
      })
      onStage?.({ type: 'stage-done', stage, label: r.label, elapsedMs: r.elapsedMs })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push({ stage, label: STAGES[stage]?.label || stage, error: msg })
      stages.push({ stage, label: STAGES[stage]?.label || stage, ok: false, elapsedMs: Date.now() - t0, error: msg })
      onStage?.({ type: 'stage-error', stage, error: msg })
      break  // 链式依赖：前一阶段失败，后续无意义
    }
  }

  return { assets, stages, errors, ok: errors.length === 0 }
}
