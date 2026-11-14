/** 面板、策略与 background 共用的类型定义。 */

export type ImageMode = 'ocr' | 'direct'

export interface Settings {
  baseUrl: string
  apiKey: string
  model: string
  autoSubmit: boolean
  /** 是否识别题目图片 */
  enableImages: boolean
  /** ocr：先转文字再答题；direct：视觉模型直接作答 */
  imageMode: ImageMode
  /** 视觉服务地址，留空复用 baseUrl */
  visionBaseUrl: string
  /** 视觉服务 Key，留空复用 apiKey */
  visionApiKey: string
  /** 视觉模型，留空复用 model */
  visionModel: string
}

export type QuestionType =
  | 'single'
  | 'multiple'
  | 'judge'
  | 'blank'
  | 'short'
  | 'unknown'

export interface QuestionOption {
  /** A / B / C ... 或判断题的对错标记 */
  label: string
  text: string
  /** 用于点击的节点（label / 选项容器），部分平台没有原生 input */
  element?: HTMLElement
  /** 原生 radio / checkbox，便于设置状态与校验 */
  input?: HTMLInputElement
}

/** 题目中的图片，src 为页面原始地址，dataUrl 为压缩后的可发送数据 */
export interface QuestionImage {
  src: string
  kind: 'stem' | 'option'
  optionLabel?: string
  alt?: string
  /** 形如「题目2 图片1（题干配图）」，用于 Prompt 与图片顺序对应 */
  label?: string
  dataUrl?: string
  element?: HTMLImageElement
}

/** 策略解析出的题目结构。DOM 字段仅在当前 frame 内有效，跨 frame 传输前会剥离。 */
export interface Question {
  /** 解析顺序索引（字符串），不依赖页面上可能重复的题号 */
  id: string
  /** 页面展示的题号，仅用于日志与 Prompt */
  number: string
  type: QuestionType
  stem: string
  options: QuestionOption[]
  /** 填空/简答的空位数量 */
  blanks: number
  /** 题干 / 选项中的图片 */
  images: QuestionImage[]
  /** 题目容器 */
  element?: HTMLElement
  /** 填空/简答的输入控件 */
  blankElements?: Array<HTMLInputElement | HTMLTextAreaElement>
}

/** 模型返回的答案，answer 为单选 "A"、多选 "A,B" 或 ["A","B"]、填空按空位拆分 */
export interface Answer {
  id: string
  type?: QuestionType
  answer: string | string[]
}

export type FillStatus = 'filled' | 'skipped' | 'failed'

export interface FillResult {
  id: string
  status: FillStatus
  message?: string
}

export type ErrorCode =
  | 'NO_CONFIG'
  | 'HTTP'
  | 'TIMEOUT'
  | 'PARSE'
  | 'RATE_LIMIT'
  | 'UNKNOWN'

export interface LlmPayload {
  prompt: string
  system?: string
  temperature?: number
  /** data:image/...;base64,... 形式的图片，按 Prompt 中标注的顺序排列 */
  images?: string[]
}

export type Req =
  | { type: 'PING' }
  | { type: 'LLM_CHAT'; payload: LlmPayload }
  | { type: 'FETCH_IMAGE'; payload: { url: string } }

export type Res =
  | { ok: true; data: { content: string; model?: string; mimeType?: string } }
  | { ok: false; error: { code: ErrorCode; message: string } }
