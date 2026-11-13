import type {
  Answer,
  FillResult,
  Question,
  QuestionImage,
  QuestionOption,
  QuestionType,
} from '../types'
import { prepareQuestionImages } from '../utils/image'
import { createStrategy } from './strategies'

const CHANNEL = 'auto-answer-ai-bridge'
const DEFAULT_TIMEOUT = 1500

export type SerializableImage = Omit<QuestionImage, 'element'>

export interface SerializableQuestion {
  id: string
  number: string
  type: QuestionType
  stem: string
  options: Array<Pick<QuestionOption, 'label' | 'text'>>
  blanks: number
  images: SerializableImage[]
}

export interface FrameParseResult {
  frame: Window
  platform: string
  questions: SerializableQuestion[]
  warnings: string[]
}

type ParseRequest = {
  channel: typeof CHANNEL
  type: 'parse'
  requestId: string
  withImages: boolean
}

type ParseResponse = {
  channel: typeof CHANNEL
  type: 'parse-result'
  requestId: string
  platform: string
  questions: SerializableQuestion[]
  warnings?: string[]
}

type FillRequest = {
  channel: typeof CHANNEL
  type: 'fill'
  requestId: string
  answers: Answer[]
}

type FillResponse = {
  channel: typeof CHANNEL
  type: 'fill-result'
  requestId: string
  results: FillResult[]
}

type SubmitRequest = {
  channel: typeof CHANNEL
  type: 'submit'
  requestId: string
}

type SubmitResponse = {
  channel: typeof CHANNEL
  type: 'submit-result'
  requestId: string
  submitted: boolean
}

type BridgeMessage = ParseRequest | ParseResponse | FillRequest | FillResponse | SubmitRequest | SubmitResponse

function isBridgeMessage(value: unknown): value is BridgeMessage {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { channel?: unknown }).channel === CHANNEL
  )
}

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function childWindows(): Window[] {
  return [...document.querySelectorAll<HTMLIFrameElement>('iframe, frame')]
    .map((frame) => frame.contentWindow)
    .filter((frame): frame is Window => frame !== null)
}

/** 剥离 DOM 引用，避免跨 frame postMessage 结构化克隆失败。 */
export function serializeQuestion(question: Question): SerializableQuestion {
  return {
    id: question.id,
    number: question.number,
    type: question.type,
    stem: question.stem,
    options: question.options.map((option) => ({
      label: option.label,
      text: option.text,
    })),
    blanks: question.blanks,
    images: (question.images ?? []).map(({ element: _element, ...image }) => ({ ...image })),
  }
}

export function deserializeQuestion(question: SerializableQuestion): Question {
  return {
    ...question,
    options: question.options.map((option) => ({ ...option })),
    blanks: question.blanks ?? 0,
    images: (question.images ?? []).map((image) => ({ ...image })),
  }
}

/** 向所有直接子 iframe 请求解析结果，超时未响应的 frame 会被忽略。 */
export function requestQuestionsFromFrames(
  withImages = false,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<FrameParseResult[]> {
  const frames = childWindows()
  if (frames.length === 0) return Promise.resolve([])

  const id = requestId()
  return new Promise((resolve) => {
    const collected = new Map<Window, FrameParseResult>()

    const finish = (): void => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve([...collected.values()])
    }

    const onMessage = (event: MessageEvent): void => {
      const data = event.data
      if (
        !isBridgeMessage(data) ||
        data.type !== 'parse-result' ||
        data.requestId !== id
      ) {
        return
      }

      const source = event.source as Window | null
      if (!source || !frames.includes(source)) return

      collected.set(source, {
        frame: source,
        platform: data.platform,
        questions: data.questions,
        warnings: data.warnings ?? [],
      })
      if (collected.size === frames.length) finish()
    }

    const timer = setTimeout(finish, timeoutMs)
    window.addEventListener('message', onMessage)

    const message: ParseRequest = {
      channel: CHANNEL,
      type: 'parse',
      requestId: id,
      withImages,
    }
    for (const frame of frames) {
      try {
        frame.postMessage(message, '*')
      } catch {
        // 已卸载的 frame 直接跳过
      }
    }
  })
}

/** 让指定 iframe 按本地题目 id 填涂。 */
export function fillInFrame(
  frame: Window,
  answers: Answer[],
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<FillResult[]> {
  if (answers.length === 0) return Promise.resolve([])

  const id = requestId()
  return new Promise((resolve) => {
    const finish = (results: FillResult[]): void => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(results)
    }

    const onMessage = (event: MessageEvent): void => {
      const data = event.data
      if (
        !isBridgeMessage(data) ||
        data.type !== 'fill-result' ||
        data.requestId !== id
      ) {
        return
      }
      if (event.source !== frame) return
      finish(data.results)
    }

    const timer = setTimeout(() => finish([]), timeoutMs)
    window.addEventListener('message', onMessage)

    const message: FillRequest = {
      channel: CHANNEL,
      type: 'fill',
      requestId: id,
      answers,
    }
    try {
      frame.postMessage(message, '*')
    } catch {
      finish([])
    }
  })
}

/** 向所有有题目的 iframe 广播交卷指令，任意一个成功即视为已触发。 */
export function submitFrames(frames: Window[], timeoutMs = 800): Promise<boolean> {
  const targets = [...new Set(frames)]
  if (targets.length === 0) return Promise.resolve(false)

  const id = requestId()
  return new Promise((resolve) => {
    let submitted = false

    const finish = (): void => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(submitted)
    }

    const onMessage = (event: MessageEvent): void => {
      const data = event.data
      if (
        !isBridgeMessage(data) ||
        data.type !== 'submit-result' ||
        data.requestId !== id
      ) {
        return
      }
      const source = event.source as Window | null
      if (!source || !targets.includes(source)) return
      if (data.submitted) submitted = true
    }

    const timer = setTimeout(finish, timeoutMs)
    window.addEventListener('message', onMessage)

    const message: SubmitRequest = { channel: CHANNEL, type: 'submit', requestId: id }
    for (const frame of targets) {
      try {
        frame.postMessage(message, '*')
      } catch {
        // ignore
      }
    }
  })
}

/**
 * 在每个 frame 内启动消息代理：负责本地解析、填涂、交卷。
 * 返回清理函数，便于开发期 HMR 重复注入时移除旧监听。
 */
export function startFrameAgent(): () => void {
  const handleMessage = async (event: MessageEvent): Promise<void> => {
    const data = event.data
    if (!isBridgeMessage(data)) return

    const source = event.source as Window | null
    if (!source) return
    // 只接受父级/顶层页面的指令，避免页面脚本随意触发
    if (source !== window.parent && source !== window.top) return

    if (data.type === 'parse') {
      let platform = 'unknown'
      let questions: SerializableQuestion[] = []
      const warnings: string[] = []
      try {
        const strategy = createStrategy(location.host)
        if (strategy) {
          platform = strategy.platform
          const parsed = strategy.parseQuestions()

          if (data.withImages) {
            for (const question of parsed) {
              await prepareQuestionImages(question, {
                onWarning: (message) => warnings.push(message),
              })
            }
          }

          questions = parsed.map(serializeQuestion)
        }
      } catch {
        questions = []
      }
      const response: ParseResponse = {
        channel: CHANNEL,
        type: 'parse-result',
        requestId: data.requestId,
        platform,
        questions,
        warnings,
      }
      source.postMessage(response, '*')
      return
    }

    if (data.type === 'fill') {
      const results: FillResult[] = []
      try {
        const strategy = createStrategy(location.host)
        const questionMap = new Map(
          strategy ? strategy.parseQuestions().map((question) => [question.id, question]) : [],
        )
        for (const answer of data.answers) {
          const question = questionMap.get(answer.id)
          if (!strategy || !question) {
            results.push({ id: answer.id, status: 'failed', message: '题目已变化，未找到对应元素' })
            continue
          }
          results.push(strategy.fillAnswer(question, answer))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        for (const answer of data.answers) {
          if (!results.some((result) => result.id === answer.id)) {
            results.push({ id: answer.id, status: 'failed', message })
          }
        }
      }
      const response: FillResponse = {
        channel: CHANNEL,
        type: 'fill-result',
        requestId: data.requestId,
        results,
      }
      source.postMessage(response, '*')
      return
    }

    if (data.type === 'submit') {
      let submitted = false
      try {
        submitted = createStrategy(location.host)?.submit() ?? false
      } catch {
        submitted = false
      }
      const response: SubmitResponse = {
        channel: CHANNEL,
        type: 'submit-result',
        requestId: data.requestId,
        submitted,
      }
      source.postMessage(response, '*')
    }
  }

  const onMessage = (event: MessageEvent): void => {
    void handleMessage(event)
  }

  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}
