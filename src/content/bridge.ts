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
const PARSE_TIMEOUT = 5000
const FILL_TIMEOUT = 5000
// 学习通提交前会先做 validate 请求再弹确认框，留足等待时间
const SUBMIT_TIMEOUT = 10000

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
  /** 在 childWindows() 中的稳定下标，用于填涂时按 cN: 前缀回路由 */
  index: number
  platform: string
  questions: SerializableQuestion[]
  warnings: string[]
}

type ParseRequest = {
  channel: typeof CHANNEL
  type: 'parse'
  requestId: string
  withImages: boolean
  deadline?: number
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
  deadline?: number
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
  deadline?: number
}

type SubmitResponse = {
  channel: typeof CHANNEL
  type: 'submit-result'
  requestId: string
  submitted: boolean
  notices?: string[]
}

export interface SubmitOutcome {
  submitted: boolean
  notices: string[]
}

type BridgeMessage =
  | ParseRequest
  | ParseResponse
  | FillRequest
  | FillResponse
  | SubmitRequest
  | SubmitResponse

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
    .filter((frame) => {
      const src = (frame.getAttribute('src') ?? '').trim()
      // UEditor / 编辑器内部的 javascript: iframe 没有内容脚本，不能等待
      if (/^(javascript:|about:blank|blob:)/i.test(src)) return false
      if (frame.closest('.edui-editor, .blankItemDiv')) return false
      return true
    })
    .map((frame) => frame.contentWindow)
    .filter((frame): frame is Window => frame !== null)
}

function remaining(deadline: number): number {
  return Math.max(800, deadline - Date.now())
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

/**
 * 向所有直接子 iframe 请求解析结果，超时未响应的 frame 会被忽略。
 * 子 frame 内部会继续向自己的子 frame 转发，因此支持多层嵌套。
 */
export function requestQuestionsFromFrames(
  withImages = false,
  timeoutMs = PARSE_TIMEOUT,
  deadline = Date.now() + timeoutMs,
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
      if (!source) return
      const index = frames.indexOf(source)
      if (index < 0) return

      collected.set(source, {
        frame: source,
        index,
        platform: data.platform,
        questions: data.questions,
        warnings: data.warnings ?? [],
      })
      if (collected.size === frames.length) finish()
    }

    const timer = setTimeout(finish, Math.max(500, timeoutMs))
    window.addEventListener('message', onMessage)

    const message: ParseRequest = {
      channel: CHANNEL,
      type: 'parse',
      requestId: id,
      withImages,
      deadline,
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

/** 让指定 iframe 按本地题目 id 填涂；该 iframe 的 agent 会继续向下转发。 */
export function fillInFrame(
  frame: Window,
  answers: Answer[],
  timeoutMs = FILL_TIMEOUT,
  deadline = Date.now() + timeoutMs,
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

    const timer = setTimeout(() => finish([]), Math.max(500, timeoutMs))
    window.addEventListener('message', onMessage)

    const message: FillRequest = {
      channel: CHANNEL,
      type: 'fill',
      requestId: id,
      answers,
      deadline,
    }
    try {
      frame.postMessage(message, '*')
    } catch {
      finish([])
    }
  })
}

/** 向指定 iframe 广播交卷指令，支持子 frame 继续向下递归。 */
export function submitFrames(
  frames: Window[],
  timeoutMs = SUBMIT_TIMEOUT,
  deadline = Date.now() + timeoutMs,
): Promise<SubmitOutcome> {
  const targets = [...new Set(frames)]
  if (targets.length === 0) return Promise.resolve({ submitted: false, notices: [] })

  const id = requestId()
  return new Promise((resolve) => {
    let submitted = false
    const notices = new Set<string>()
    const responded = new Set<Window>()

    const finish = (): void => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve({ submitted, notices: [...notices] })
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
      for (const notice of data.notices ?? []) notices.add(notice)
      responded.add(source)
      if (responded.size === targets.length) finish()
    }

    const timer = setTimeout(finish, Math.max(500, timeoutMs))
    window.addEventListener('message', onMessage)

    const message: SubmitRequest = {
      channel: CHANNEL,
      type: 'submit',
      requestId: id,
      deadline,
    }
    for (const frame of targets) {
      try {
        frame.postMessage(message, '*')
      } catch {
        // ignore
      }
    }
  })
}

function failedResults(answers: Answer[], message: string): FillResult[] {
  return answers.map((answer) => ({
    id: answer.id,
    status: 'failed',
    message,
  }))
}

/**
 * 在每个 frame 内启动消息代理：负责本页解析、子 frame 聚合、填涂路由与交卷。
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
      const deadline = data.deadline ?? Date.now() + PARSE_TIMEOUT
      let platform = 'unknown'
      let localQuestions: SerializableQuestion[] = []
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

          localQuestions = parsed.map(serializeQuestion)
        }
      } catch {
        localQuestions = []
      }

      // 递归向子 frame 收集；cards.html → work.html 这类两层结构也能拿到题目
      const childResults = await requestQuestionsFromFrames(
        data.withImages,
        remaining(deadline),
        deadline,
      )

      const childQuestions: SerializableQuestion[] = []
      // 用 frame 在 childWindows() 中的下标做前缀，确保填涂时能按同样的下标回路由
      childResults.forEach((result) => {
        const index = result.index
        result.questions.forEach((question) => {
          childQuestions.push({ ...question, id: `c${index}:${question.id}` })
        })
        result.warnings.forEach((warning) => {
          warnings.push(`[frame${index}] ${warning}`)
        })
      })

      const response: ParseResponse = {
        channel: CHANNEL,
        type: 'parse-result',
        requestId: data.requestId,
        platform,
        questions: [...localQuestions, ...childQuestions],
        warnings,
      }
      source.postMessage(response, '*')
      return
    }

    if (data.type === 'fill') {
      const deadline = data.deadline ?? Date.now() + FILL_TIMEOUT
      const frames = childWindows()
      const localAnswers: Answer[] = []
      const groups = new Map<number, Answer[]>()

      for (const answer of data.answers) {
        const match = /^c(\d+):(.+)$/.exec(answer.id)
        if (match) {
          const index = Number(match[1])
          const list = groups.get(index) ?? []
          list.push({ ...answer, id: match[2] })
          groups.set(index, list)
        } else {
          localAnswers.push(answer)
        }
      }

      const results: FillResult[] = []

      if (localAnswers.length > 0) {
        try {
          const strategy = createStrategy(location.host)
          const questionMap = new Map(
            strategy
              ? strategy.parseQuestions().map((question) => [question.id, question])
              : [],
          )
          for (const answer of localAnswers) {
            const question = questionMap.get(answer.id)
            if (!strategy || !question) {
              results.push({
                id: answer.id,
                status: 'failed',
                message: '题目已变化，未找到对应元素',
              })
              continue
            }
            results.push(strategy.fillAnswer(question, answer))
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          for (const answer of localAnswers) {
            if (!results.some((result) => result.id === answer.id)) {
              results.push({ id: answer.id, status: 'failed', message })
            }
          }
        }
      }

      // 把带 cN: 前缀的答案转发给对应子 frame
      await Promise.all(
        [...groups.entries()].map(async ([index, answers]) => {
          const frame = frames[index]
          if (!frame) {
            results.push(
              ...failedResults(answers, '对应 iframe 已卸载').map((result) => ({
                ...result,
                id: `c${index}:${result.id}`,
              })),
            )
            return
          }

          const childResults = await fillInFrame(
            frame,
            answers,
            remaining(deadline),
            deadline,
          )

          if (childResults.length === 0) {
            results.push(
              ...failedResults(answers, '子 iframe 未响应填涂指令').map((result) => ({
                ...result,
                id: `c${index}:${result.id}`,
              })),
            )
            return
          }

          for (const result of childResults) {
            results.push({ ...result, id: `c${index}:${result.id}` })
          }
        }),
      )

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
      const deadline = data.deadline ?? Date.now() + SUBMIT_TIMEOUT
      let submitted = false
      let notice = ''
      try {
        const strategy = createStrategy(location.host)
        // 只有本 frame 确实包含题目时才点本页的交卷按钮，
        // 避免中间的 cards 容器页误点无关的「提交」链接。
        if (strategy && strategy.parseQuestions().length > 0) {
          submitted = await strategy.submit()
          notice = strategy.lastNotice
        }
      } catch {
        submitted = false
      }

      const childOutcome = await submitFrames(
        childWindows(),
        remaining(deadline),
        deadline,
      )

      const notices = [
        ...(notice ? [notice] : []),
        ...childOutcome.notices,
      ]
      const response: SubmitResponse = {
        channel: CHANNEL,
        type: 'submit-result',
        requestId: data.requestId,
        submitted: submitted || childOutcome.submitted,
        notices,
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
