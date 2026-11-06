/**
 * dsh-drama-trae —— 分镜 → Trae Seedance 视频 prompt 构建（v2 结构化版）。
 *
 * 设计依据（Trae Seedance 实测行为，2026-11-04）：
 *   · 模型对「自然语言连贯描述」敏感，对「字段罗列」几乎不响应
 *   · 画面里出现中文字（如「沈知意」）会被当成要求绘制文字 → 必须避免
 *   · 光影/情绪/运镜要写成画面内可见现象，不能写抽象词
 *   · 总长 2000 字符上限，超出截断会丢失最重要的开头部分
 *
 * v2 六段式结构（顺序固定，各段用句号分隔而非逗号串）：
 *   ① 主体+场景（谁在哪、画面占比）
 *   ② 动作过程（起点→过程→终点，写方向与幅度）
 *   ③ 镜头语言（景别+运镜+焦段，自然语句）
 *   ④ 光影质感（光源/方向/强弱 + 色调/材质）
 *   ⑤ 风格基调（全局 DNA，只取非空维度）
 *   ⑥ 画幅（固定收尾）
 *
 * 关键约束：
 *   - 禁止在 prompt 里出现角色姓名（避免模型绘制文字）
 *   - 禁令以「不得出现」否定句形式放末尾且不超过 3 条
 *   - 内容时长（时长/帧率）不进 prompt，由请求参数承载
 *
 * @module src/prompt
 */

/** 整镜 prompt 上限（Trae 侧实测 2000 字符以上会被截断）。 */
const PROMPT_MAX_CHARS = 2000

/** 各段拼接上限，保证核心信息不被截断。 */
const SECTION_LIMITS = { subject: 160, action: 200, camera: 120, light: 160, style: 220 }

function clip(text, max = PROMPT_MAX_CHARS) {
  const s = String(text == null ? '' : text).trim()
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

function pick(shot, ...keys) {
  for (const k of keys) {
    const v = shot?.[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** 去掉 prompt 里的中文引号书名号内容（「沈知意」这类会被模型画成字）。 */
function stripQuotedText(s) {
  return String(s ?? '')
    .replace(/「[^」]*」/g, '')
    .replace(/『[^』]*』/g, '')
    .replace(/《[^》]*》/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/“([^”]*)”/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 把角色姓名替换为**可区分的特征词**（不能统一换成「女子」，否则同镜多角色会混）。
 * 特征词由角色卡的 role/appearancePrompt 推出：主角→年轻女子/年轻男子，
 * 反派→贵妇/中年男子，其余按年龄线索推断。多角色时保证互不相同。
 *
 * @param {string} text
 * @param {object[]|string[]} chars 角色卡数组或姓名数组
 * @returns {string}
 */
function stripCharacterNames(text, chars) {
  let s = String(text ?? '')
  const list = (Array.isArray(chars) ? chars : []).map((c) =>
    typeof c === 'string' ? { name: c } : c
  ).filter((c) => String(c?.name ?? '').trim())

  // 先按名字长度降序替换，避免「顾夫人」被「顾」这种短名先吃掉
  const sorted = [...list].sort((a, b) => String(b.name).length - String(a.name).length)
  const used = new Map() // 特征词 → 已用次数

  for (const c of sorted) {
    const name = String(c.name)
    const label = inferLabel(c, used)
    s = s.split(name).join(label)
  }
  return s.replace(/\s{2,}/g, ' ').replace(/(女子|男子){2,}/g, '$1')
    .replace(/。，/g, '。').replace(/，{2,}/g, '，').trim()
}

/** 从角色卡推出一个可与其它角色区分的特征词。 */
function inferLabel(card, used) {
  const name = String(card?.name ?? '')
  const role = String(card?.role ?? '')
  const ap = String(card?.appearancePrompt ?? '')

  // ---- ① 先判性别（男性线索优先，避免「陆沉」被当女性）----
  const maleHints = /先生|少爷|总裁|董事长|公子|老爷|老爷子|哥|叔|伯|父|男/
  // 男性线索要覆盖「壮汉/板寸/胡茬/背头」这类不含「男」字但明确指向男性的描写，
  // 否则「38岁黝黑壮汉，板寸油汗，破旧迷彩外套」会被判成女性。
  const MALE_AP = /男性|男子|壮汉|大汉|汉子|板寸|寸头|胡茬|胡渣|络腮|背头|油头|西装|中山装|唐装|长袍|夹克|工装|警服|军装|迷彩|领带|扳指|喉结|魁梧|英俊|清朗男子|少年|青年男|老爷子|老头|大叔/
  const isMale = maleHints.test(name) || MALE_AP.test(ap)

  // ---- ② 判年龄档 ----
  const ageMatch = ap.match(/(\d+)\s*岁/)
  const age = ageMatch ? Number(ageMatch[1]) : null
  const isOld = /老夫人|太太|贵妇|夫人|老爷子|老爷|长辈|盘发|翡翠|旗袍/.test(name + ap) ||
    (age !== null && age >= 45)

  // ---- ③ 组合成可区分特征词 ----
  let label = ''
  if (isMale) {
    if (/助理|秘书|特助/.test(name)) label = '职场男性'
    else if (isOld) label = '年长男子'
    else label = '年轻男子'
  } else {
    if (/助理|秘书|特助/.test(name)) label = '职场女性'
    else if (/贵妇|夫人|太太|老爷子的妻子|盘发|翡翠|旗袍/.test(name + ap)) label = '贵妇'
    else if (isOld) label = '年长女性'
    else label = '年轻女子'
  }

  // 去重：同镜若已有同标签角色，加序号区分（如「年轻女子二」）
  const n = (used.get(label) ?? 0) + 1
  used.set(label, n)
  if (n === 1) return label
  // 不能用数组下标兜底：n=4 会越界成 undefined，写成「年轻女子undefined」。
  const ord = ['', '', '二', '三', '四', '五', '六', '七', '八', '九']
  return label + (ord[n] ?? `第${n}`)
}

/**
 * 清理形象锚点：去掉「姓名：」前缀，只留形象描述。
 * 锚点原文形如「沈知意：25岁都市女性，清瘦…」→「25岁都市女性，清瘦…」
 */
/** 清理形象锚点：多角色 '；' 分段，逐段剥离「姓名：」前缀与残留姓名。 */
function stripAnchorName(anchor, names) {
  const raw = String(anchor ?? '').trim().replace(/^\[角色锚点\]\s*/, '')
  if (!raw) return ''
  const nameList = (Array.isArray(names) ? names : []).map((x) =>
    typeof x === 'string' ? x : String(x?.name ?? '')).filter(Boolean)

  // 按 '；' 拆成多角色段，逐段处理
  const segs = raw.split(/[;；]/).map((seg) => {
    let a = seg.trim()
    for (const n of nameList) {
      // 剥掉「名字：」（允许中文冒号、英文冒号）
      a = a.replace(new RegExp('^' + escapeRe(n) + '\s*[：:]\s*'), '')
      // 其余位置的姓名一律移除
      a = a.split(n).join('')
    }
    return a.replace(/^[：:，,、\s]+/, '').trim()
  }).filter(Boolean)

  return segs.join('；').replace(/\s{2,}/g, ' ').trim()
}

/** 正则转义。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 情绪 → 可观测画面描述（内联精简表，避免跨模块依赖）。
 * 只保留短剧最常用的 16 种，其余走「内在状态」兜底。
 */
const EMOTION_VISUAL = {
  压抑: '肩膀下沉，呼吸浅而慢，视线始终低垂',
  警觉: '瞳孔收缩，视线快速扫向画面边缘',
  紧张: '手指收紧，喉结轻滚，呼吸变浅',
  恐惧: '瞳孔放大，身体后倾，手掌撑在身后',
  愤怒: '咬紧下颌，鼻翼张开，颈侧血管微凸',
  悲伤: '眼睑下垂，视线落在下方，嘴角松弛下滑',
  绝望: '双肩塌陷，头部低垂，重心不稳前倾',
  平静: '呼吸均匀，肩膀松弛，视线平稳',
  冷静: '面部肌肉放松，下颌线平直',
  坚定: '下颌绷紧，视线直刺前方，重心前移',
  震惊: '瞳孔骤缩，身体僵直，手中物体开始滑落',
  疑惑: '单侧眉上扬，头部微侧，视线聚焦一点',
  轻蔑: '嘴角单侧上扬，眼睑半垂，头部后仰',
  委屈: '下唇前突，眼眶盈满，视线向下躲闪',
  释然: '长呼一口气，肩头落下，嘴角缓慢松开',
  决绝: '下颌绷紧，视线直刺前方，身体重心前移',
}

function intensityWord(level) {
  const n = Number(level)
  if (!Number.isFinite(n)) return ''
  if (n >= 85) return '幅度极大'
  if (n >= 65) return '幅度明显'
  if (n >= 45) return '幅度适中'
  if (n >= 25) return '幅度轻微'
  return '几乎不可察'
}

/** 情绪渲染为可观测句。 */
function renderEmotion(emotion) {
  if (!emotion) return ''
  const label = typeof emotion === 'string' ? emotion.trim() : String(emotion.label ?? emotion.name ?? '').trim()
  if (!label) return ''
  const amp = typeof emotion === 'object' ? intensityWord(emotion.intensity) : ''
  const mapped = EMOTION_VISUAL[label]
  if (mapped) return amp ? `${mapped}，变化${amp}` : mapped
  return amp ? `（内心${label}，幅度${amp}，仅以体态体现）` : `（内心${label}，仅以体态体现）`
}

/** 剔除给人类看的元叙述（「是全剧……核心场景」「本剧伏笔」等对模型无意义）。 */
function stripMetaNarration(text) {
  return String(text ?? '')
    .replace(/[，,；;]?\s*[，,]*\s*(是全剧[^。，,；;]*|本剧[^。，,；;]*|全剧[^。，,；;]*|贯穿全剧[^。，,；;]*|为后续[^。，,；;]*|伏笔[^。，,；;]*)/g, '')
    .replace(/[，,]{2,}/g, '，')
    .replace(/^[，,。；;]+|[，,。；;]+$/g, '')
    .trim()
}

/** 把长描述压缩成「关键词短语」：取前若干字并去掉尾部未完结的分句。 */
function shortenDna(text, max, prefix) {
  let t = String(text ?? '').trim()
  if (t.length > max) {
    const cut = t.slice(0, max)
    const lastSep = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf(','), cut.lastIndexOf('。'))
    t = lastSep > max * 0.5 ? cut.slice(0, lastSep) : cut
  }
  t = t.replace(/^[，,。、\s]+/, '')
  return prefix === '色调' ? `色调偏${t}` : `质感${t}`
}

/** 景别中文→模型更易理解的补充说明。 */
const SHOT_SIZE_HINT = {
  远景: '人物在画面中占比很小，环境为主',
  全景: '完整呈现人物全身与所处空间',
  中景: '取人物腰部以上，兼顾动作与神态',
  近景: '取人物胸部以上，聚焦面部表情',
  特写: '只取面部或手部局部，占满画面',
  大特写: '極近距离，单一细节占满画面',
}

/** 运镜中文→自然语句。 */
const CAMERA_HINT = {
  固定: '机位不动',
  推: '镜头向前推进',
  缓慢推进: '镜头缓慢向前推进',
  拉: '镜头向后拉远',
  摇: '镜头水平摇转',
  移: '镜头横向平移',
  跟随: '镜头跟随人物移动',
  跟: '镜头跟随人物移动',
}

/**
 * 构建单镜视频 prompt（v2 结构化版）。
 *
 * @param {object} shot 分镜行
 * @param {object} [opts]
 * @param {string} [opts.ratio]           画幅（默认 9:16）
 * @param {string} [opts.characterAnchor] 角色形象锚点（已渲染，如「25岁清瘦，乌黑长发…」）
 * @param {string[]} [opts.characterNames] 需从正文剔除的角色姓名
 * @param {object} [opts.sceneCard]       本镜场景卡（含 description/space/lighting）
 * @param {object} [opts.styleDna]        风格 DNA（palette/lighting/texture/composition/motion）
 * @returns {string}
 */
export function buildShotVideoPrompt(shot, opts = {}) {
  const s = shot || {}
  // 剔除姓名：优先用全项目角色卡（避免「本镜没挂号但不该出现名字」的漏网）
  const names = Array.isArray(opts.allCharCards) && opts.allCharCards.length
    ? opts.allCharCards
    : (Array.isArray(opts.characterNames) ? opts.characterNames : [])

  // ---------- ① 主体 + 场景 ----------
  const anchor = String(opts.characterAnchor ?? '').trim()
  const sceneCard = opts.sceneCard || null
  const sceneDesc = sceneCard?.description
    ? stripMetaNarration(stripQuotedText(sceneCard.description))
    : ''
  const scenePlace = sceneCard?.name ? String(sceneCard.name).trim() : ''
  // 分镜自带的 videoPrompt 是「按剧本写好的镜头描述」，必须优先采纳：
  // 早期只用它当 description 为空时的补充，等于把模型写好的镜头描述全丢了。
  const videoP = stripQuotedText(pick(s, 'videoPrompt'))
  const explicit = videoP || pick(s, 'imagePrompt', 'prompt', '提示词')

  const subjectParts = []
  const anchorClean = stripAnchorName(anchor, names)
  if (anchorClean) subjectParts.push(anchorClean)
  // 场景：场景卡描述优先（更完整），分镜描述只补「本镜新增信息」
  const desc = stripMetaNarration(stripCharacterNames(stripQuotedText(pick(s, 'description', '画面')), names))
  if (scenePlace) subjectParts.push(`场景为${scenePlace}`)
  if (sceneDesc) subjectParts.push(sceneDesc)
  if (desc) {
    // 若分镜描述已经被场景描述/场景名覆盖过半，则只保留差异部分
    const overlap = sceneDesc && desc.includes(sceneDesc.slice(0, 8))
    const placeOverlap = scenePlace && desc.startsWith(scenePlace + '，')
    if (overlap || placeOverlap) {
      const stripped = placeOverlap ? desc.slice(scenePlace.length + 1) : desc
      const tail = stripCharacterNames(stripped, names).trim()
      if (tail && !sceneDesc?.includes(tail)) subjectParts.push(tail)
    } else {
      subjectParts.push(desc)
    }
  }
  // 显式提示词（分镜自带的 videoPrompt）必须参与主体描述：
  // 早期只在「description 为空」时才用它，等于把模型按剧本写好的镜头描述整段丢弃。
  // 现在的策略是「取并集但去重」：若 videoPrompt 里的关键信息 description 没有，就补进来。
  if (explicit) {
    const explicitClean = stripCharacterNames(stripQuotedText(explicit), names).trim()
    if (explicitClean) {
      const alreadyThere = desc && explicitClean.split('，').filter(seg => seg.trim() && desc.includes(seg.trim())).length >= 2
      if (!alreadyThere) {
        subjectParts.length = 0
        if (anchorClean) subjectParts.push(anchorClean)
        if (scenePlace) subjectParts.push(`场景为${scenePlace}`)
        if (desc) subjectParts.push(desc)
        subjectParts.push(explicitClean)
      }
    }
  }

  // 主体描述里单独的运镜词（「固定」「快推」「拉镜」）与镜头段重复，删掉以免模型混淆。
  // 必须放在 explicit 处理之后：运镜词常常来自分镜自带的 videoPrompt。
  // 覆盖分镜里常见的运镜词写法（含「摇跟」「拉镜」「快推」这类组合词）
  const CAM_WORDS = /(?:^|，)(?:固定|机位不动|快推|缓推|慢推|推近|推进|推远|拉远|拉镜|拉背|摇镜|摇跟|移镜|横移|跟拍|手持|甩镜|升降)(?=，|。|$)/g
  for (let i = 0; i < subjectParts.length; i++) {
    subjectParts[i] = String(subjectParts[i])
      .replace(CAM_WORDS, '')
      .replace(/，{2,}/g, '，')
      .replace(/^，|，$/g, '')
      .trim()
  }

  // ---------- ② 动作过程 ----------
  const actionParts = []
  const natural = stripCharacterNames(stripQuotedText(pick(s, 'naturalLanguagePrompt')), names)
  if (natural) actionParts.push(natural)
  const emo = renderEmotion(s.emotion ?? (sceneCard?.emotionBaseline ?? null))
  if (emo) actionParts.push(emo)

  // ---------- ③ 镜头语言 ----------
  const size = pick(s, 'shotSize', '景别')
  const cam = pick(s, 'cameraMove', 'camera', '运镜')
  const lens = pick(s, 'lens', '焦段')
  const camParts = []
  if (size) {
    const hint = SHOT_SIZE_HINT[size]
    camParts.push(hint ? `${size}，${hint}` : size)
  }
  if (cam) camParts.push(CAMERA_HINT[cam] || cam)
  if (lens) camParts.push(`焦距${lens}`)

  // ---------- ④ 光影质感 ----------
  const lightParts = []
  const shotLight = stripQuotedText(pick(s, 'light', '光影'))
  const sceneLight = String(sceneCard?.lighting ?? '').trim()
  if (shotLight) lightParts.push(shotLight)
  else if (sceneLight) lightParts.push(sceneLight)
  const dna = opts.styleDna || {}
  // 只取「色板」与「质感」的关键词（长描述对单镜是噪音，且会挤占主体描述）
  // 调色板去掉十六进制色值：模型读不懂 #0E1116，还会把它当文字画进画面
  // 调色板处理：只留主色。
  // 反例：'主色墨青黑 #0E1116 占画面 55%，辅色锈红…，点缀光…，整体冷调偏青；城中村色温 3200K…'
  // 这种长描述对单镜是噪音：模型要的是「这镜什么调子」，不是整套色彩管理学。
  const paletteClean = (() => {
    let p = String(dna.palette ?? '')
    // 截到第一个句号/分号之前（后面都是从属细节）
    p = p.split(/[；;。]/)[0]
    // 只取第一段（主色）
    p = p.split(/[，,]/)[0]
    p = p
      .replace(/#[0-9A-Fa-f]{3,8}/g, '')
      .replace(/\d+\s*%|\d{2,}/g, '')
      .replace(/主色|色调偏|占画面|合计|约占/g, '')
      .replace(/[a-zA-Z]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[，、\s]+|[，、\s]+$/g, '')
      .trim()
    return p.length >= 2 ? p : ''
  })()
  if (paletteClean) lightParts.push(shortenDna(paletteClean, 16, '色调'))
  if (String(dna.texture ?? '').trim()) lightParts.push(shortenDna(dna.texture, 26, '质感'))

  // ---------- ⑤ 风格基调（构图与运镜偏好）----------
  // 只在「本镜没写运镜」时补风格里的运镜偏好，避免与镜头段重复
  const styleParts = []
  // 构图偏好：只保留「对称/居中/留白」这类可执行词，去掉画幅与冗余修辞
  const comp = String(dna.composition ?? '').trim()
    .replace(/竖屏\s*9:16[，,、]?/g, '').replace(/横屏\s*16:9[，,、]?/g, '')
  for (const kw of ['对称构图', '居中构图', '三分构图', '留白', '低机位', '高机位', '俯拍', '仰拍']) {
    if (comp.includes(kw)) styleParts.push(kw)
  }
  // 运镜偏好只在分镜未指定运镜时补，避免一句里两种运镜打架
  if (!cam) {
    const motion = String(dna.motion ?? '').trim()
    for (const kw of ['缓慢推进', '固定机位', '轻微手持', '缓慢拉远']) {
      if (motion.includes(kw)) styleParts.push(kw)
    }
  }
  const styleMentionsRatio = false  // 已剥离画幅，末尾统一声明

  // ---------- ⑥ 禁令（最多 3 条）----------
  const constraints = Array.isArray(s.constraints)
    ? s.constraints.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 3)
    : typeof s.constraints === 'string' && s.constraints.trim()
      ? [s.constraints.trim()]
      : []

  const ratio = opts.ratio || '9:16'
  const ratioText = ratio === '9:16' ? '竖屏构图 9:16' : ratio === '16:9' ? '横屏构图 16:9' : `画幅 ${ratio}`

  // 正字法：视频模型对繁体/异体字识别率低，统一成简体常用字
  const NORMALIZE = {
    極: '极', 檔: '档', 積: '积', 體: '体', 現: '现', 麼: '么', 畫: '画', 聲: '声',
    燈: '灯', 霧: '雾', 襯: '衬', 靜: '静', 開: '开', 關: '关', 長: '长', 間: '间',
    頭: '头', 臉: '脸', 髮: '发', 眼: '眼', 藍: '蓝', 綠: '绿', 紅: '红', 黃: '黄',
    塵: '尘', 煙: '烟', 鐵: '铁', 銅: '铜', 門: '门', 牆: '墙', 劍: '剑', 獸: '兽',
  }
  const normalizeChars = (t) => String(t ?? '').replace(
    new RegExp('[' + Object.keys(NORMALIZE).join('') + ']', 'g'), (m) => NORMALIZE[m] || m)

  // ---------- 组装：按 Seedance 2.0 配方重排 ----------
  // 官方配方：「一句镜头动作 + 画面要素 + 统一风格后缀」
  //   · 镜头动作放最前，模型才会把它当成运镜指令
  //   · 画面主体次之
  //   · 光影/风格压到最后，避免挤掉主体
  const sections = []
  if (camParts.length) sections.push(clip(camParts.join('，'), SECTION_LIMITS.camera))
  if (subjectParts.length) sections.push(clip(subjectParts.join('，'), SECTION_LIMITS.subject))
  if (actionParts.length) sections.push(clip(actionParts.join('。'), SECTION_LIMITS.action))
  if (lightParts.length) sections.push(clip(lightParts.join('，'), SECTION_LIMITS.light))
  if (styleParts.length) sections.push(clip(styleParts.join('，'), SECTION_LIMITS.style))

  if (!sections.length) {
    throw new Error(`镜 ${s.shotNumber || s.shot || '?'} 既没有提示词也没有画面描述，无法生成`)
  }

  let body = sections.map((x) => x.replace(/。$/, '')).join('。') + '。'
  if (constraints.length) body += `画面中不得出现${constraints.join('、')}。`
  if (!styleMentionsRatio) body += ratioText
  // 句号句读统一：锚点/描述常以「。」结尾，与后续「，」拼出「。，」，模型会读成断句
  let cleaned = body
    .replace(/。\s*，/g, '。')
    .replace(/，\s*。/g, '。')
    .replace(/，{2,}/g, '，')
    .replace(/。{2,}/g, '。')
    .replace(/\s{2,}/g, ' ')
  cleaned = normalizeChars(cleaned)

  // 兜底：句中孤立的运镜词（与开头的镜头段重复，纯噪音）
  // 只删「被逗号夹在中间」的，避免误删「机位不动」这种有效描述开头的
  const sizeWords = ['大特写','特写','中景','近景','全景','远景']
  // 分镜原写常把景别与运镜粘在一起（「大特写固定」「中景快推」），
  // 开头镜头段已经说过景别+运镜，句中这份是重复噪音 → 拆开只留画面描述。
  const gluedSizeCam = /(大特写|特写|中景|近景|全景|远景)(固定|快推|缓推|慢推|推近|推进|推远|拉远|拉镜|拉背|摇镜|摇跟|移镜|横移|跟拍|手持|甩镜|升降)/g
  cleaned = cleaned.replace(gluedSizeCam, '')
  // 句中孤立的运镜词（前后都被逗号夹住）
  const isolatedCam = /，(?:固定|机位不动|快推|缓推|慢推|推近|推进|推远|拉远|拉镜|拉背|摇镜|摇跟|移镜|横移|跟拍|手持|甩镜|升降)(?=，|。)/g
  cleaned = cleaned
    .replace(isolatedCam, '')
    .replace(/，{2,}/g, '，')
    .replace(/^[，。]+/, '')
    .replace(/，\s*。/g, '。')

  // 景别只保留最前一次（重复的「大特写…大特写」是噪音，还浪费 token）
  const sizeWord = String(size ?? '').trim()
  if (sizeWord) {
    const first = cleaned.indexOf(sizeWord)
    if (first >= 0) {
      const tail = cleaned.slice(first + sizeWord.length)
      // 尾巴里再出现同名景别就删掉那一处（连同其后的短修饰）
      cleaned = cleaned.slice(0, first + sizeWord.length)
        + tail.replace(new RegExp(`${sizeWord}(，|\\s)?`, 'g'), '')
    }
    cleaned = cleaned.replace(/，{2,}/g, '，').replace(/，\s*。/g, '。')
  }
  return clip(stripQuotedText(cleaned))
}
