/**
 * TRAE CN 视频生成复刻 —— 常量与端盘点定义（自 libai_agent.dylib + channel-pack 逆向）。
 * @module src/constants
 */

// 二进制 strings 连排路由表（证据见 recon/trae-video-gen-analysis.md §2.3）
export const TRAE = {
  // our-free-model 与 TRAE 二进制里硬编码的同一套客户端静态凭据
  clientId: 'en1oxy7wnw8j9n',
  appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  ideVersion: '0.1.52',
  ideVersionCode: '20260811',
  deviceBrand: 'Apple',
  osVersion: 'macOS 15.7.4',
  pluginVersion: '2.3.62834',
  userAgent: 'Trae/0.1.52',

  // 主机（our-free-model 镜像代理优先，直连 ugHost 亦可）
  agentHost: process.env.DSH_TRAE_VIDEO_HOST || 'https://trae-api-cn.mchost.guru',
  ugHost: 'https://api.trae.cn',

  // 默认凭据引用名（与 our-free-model 一致）
  defaultCredentialRef: 'TRAE_ACCESS_TOKEN',
}

// 视频生成专用端点（自二进制 api/ide/v1 路由表）
export const PATHS = {
  // 生成前额度预检（soft-fail，拿不到额度不阻断）
  checkEstimatedBalance: '/api/v1/commercial/check_estimated_balance',
  // t2v 主力端点（SSE 流式）
  textToVideoStream: '/api/ide/v1/tool_text_to_video_stream',
  // 非流式变体（极可能是轮询式提交）
  textToVideo: '/api/ide/v1/tool_text_to_video',
  // 结果拉取 / 下载地址解析（TOS key → 签名 URL）
  getResourceUrl: '/api/ide/v1/get_resource_url',
  getMultimodal: '/api/ide/v1/get/multimodal',
  reportMultimodal: '/api/ide/v1/report/multimodal',
  // 素材上传（图生视频 / 视频续写）
  getResourceUploadToken: '/api/ide/v1/get_resource_upload_token',
  getResourceUploadUrl: '/api/ide/v1/get_resource_upload_url',
  commitResourceUploadResult: '/api/ide/v1/commit_resource_upload_result',
  // 图片生成（同一条流水线，供对照 / 首帧）
  textToImageStream: '/api/ide/v1/tool_text_to_image_stream',
}

// OAuth 换票/刷新（与 our-free-model 一致）
export const OAUTH_PATHS = {
  exchangeToken: '/cloudide/api/v3/trae/oauth/ExchangeToken',
  getUserInfo: '/cloudide/api/v3/trae/GetUserInfo',
}

// 视频模型（二进制 strings：`seedance2-fast` / `seedance_2_0`）
export const VIDEO_MODEL = 'seedance2-fast'
export const IMAGE_MODEL = 'seedream_5'

// GenerateVideoParams 枚举（自二进制 JSON Schema + strings 连排）
export const RESOLUTIONS = ['480p', '720p', '1080p', '4k']
export const RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']
export const DEFAULT_RESOLUTION = '720p'
export const DEFAULT_RATIO = 'adaptive'
export const DEFAULT_DURATION = 5
export const MAX_DURATION = 15
/**
 * 时长下限 4 秒 —— 来自服务端实测拒绝，不是保守估计。
 *
 * 传 2 或 3 时服务端返回：
 *   `InvalidParameter: the parameter duration specified in the request is not
 *    valid for model doubao-seedance-2-0-mini in t2v; received: "2"`
 * 即模型侧只接受 4~15。二进制 tool Schema 写的 2~15 与真实模型下限不一致，
 * 按二进制写就会让每个 2s/3s 分镜必然失败一次（实测一集 24 镜里有 8 镜如此）。
 */
export const MIN_DURATION = 4
export const MAX_IMAGE_REFS = 9
export const MAX_VIDEO_REFS = 3
/**
 * 自动并发天花板。
 *
 * 实测：18 并发跑 24 镜时服务端整片 4010（452 次全局拒绝），
 * 降到 2~6 后同样的账号池能出片。所以自动模式默认不超过 6；
 * 想开更高用 DSH_TRAE_AUTO_CONCURRENCY 环境变量显式覆盖。
 */
export const AUTOCONCURRENCY_CAP = 6

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024 // 100 MiB 上限（原串 "100 MiB limit"）

// 生成编排阶段（对齐 GenerateVideo 工具实现状态机）
export const STAGES = {
  PREFLIGHT: 'preflight', // check_estimated_balance
  SUBMIT: 'submit', // tool_text_to_video_stream
  POLL: 'poll', // SSE 进度
  DOWNLOAD: 'download', // 下载产物
  WRITE: 'write', // 落盘 mp4
  DONE: 'done',
  FAILED: 'failed',
}