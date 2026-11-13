import type { Answer, QuestionType } from '../types'
import type { Question } from '../types'

export const ANSWER_SYSTEM_PROMPT = `你是在线考试答题助手。你会收到一组题目，必须严格按 JSON 数组输出答案。
要求：
1. 只输出 JSON，不要输出解释、Markdown、代码块或多余文字。
2. 输出格式：[{"id":"题目id","type":"单选","answer":"A"}]
3. id 必须与输入题目完全一致，不得改写、合并或遗漏。
4. 单选 answer 为一个选项字母，如 "A"。
5. 多选 answer 为逗号分隔的选项字母，如 "A,C"。
6. 判断 answer 为 "对" 或 "错"。
7. 填空/简答 answer 为文本，多个空位用 "|" 分隔，例如 "答案1|答案2"。
8. 不确定时给出最可能的答案，不要留空。`

const TYPE_LABELS: Record<QuestionType, string> = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
  blank: '填空',
  short: '简答',
  unknown: '未知',
}

const LABEL_TYPES: Record<string, QuestionType> = {
  单选: 'single',
  单选题: 'single',
  single: 'single',
  多选: 'multiple',
  多选题: 'multiple',
  multiple: 'multiple',
  判断: 'judge',
  判断题: 'judge',
  judge: 'judge',
  填空: 'blank',
  填空题: 'blank',
  blank: 'blank',
  简答: 'short',
  简答题: 'short',
  问答: 'short',
  short: 'short',
}

/** 组装发给模型的题目列表，只保留可序列化字段。 */
export function buildAnswerPrompt(questions: Question[]): string {
  const hasImages = questions.some((question) => (question.images?.length ?? 0) > 0)

  const payload = questions.map((question) => ({
    id: question.id,
    number: question.number,
    type: TYPE_LABELS[question.type] ?? '未知',
    stem: question.stem,
    options: question.options.map((option) => ({
      label: option.label,
      text: option.text,
    })),
    blanks: question.blanks,
    images: (question.images ?? []).map(
      (image) => image.label ?? `题目${question.number} 配图`,
    ),
  }))

  const imageNote = hasImages
    ? '\n题目 JSON 的 images 字段列出了随消息附带的图片标签；图片按题目顺序、题目内按 images 顺序附在本消息中，请结合图片内容作答。'
    : ''

  return `请作答以下题目，并只返回 JSON 数组：${imageNote}\n${JSON.stringify(payload, null, 2)}`
}

function mapType(value: unknown): QuestionType | undefined {
  if (typeof value !== 'string') return undefined
  return LABEL_TYPES[value.trim()] ?? LABEL_TYPES[value.trim().toLowerCase()]
}

function sliceBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

function tryParseJson(text: string): unknown {
  const cleaned = text
    .replace(/```(?:json)?/gi, '')
    .replace(/^\uFEFF/, '')
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    // 继续尝试截取 JSON 片段
  }

  const arrayText = sliceBalanced(cleaned, '[', ']')
  if (arrayText) {
    try {
      return JSON.parse(arrayText)
    } catch {
      // ignore
    }
  }

  const objectText = sliceBalanced(cleaned, '{', '}')
  if (objectText) {
    try {
      return JSON.parse(objectText)
    } catch {
      // ignore
    }
  }

  return null
}

function normalizeAnswerItem(item: unknown): Answer | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null

  const record = item as Record<string, unknown>
  const rawId = record.id ?? record.questionId ?? record.index
  if (rawId === undefined || rawId === null) return null

  const rawAnswer = record.answer ?? record.ans ?? record.value
  if (rawAnswer === undefined || rawAnswer === null) return null

  let answer: string | string[]
  if (Array.isArray(rawAnswer)) {
    answer = rawAnswer.map((value) => String(value).trim()).filter(Boolean)
  } else if (typeof rawAnswer === 'string' || typeof rawAnswer === 'number') {
    answer = String(rawAnswer).trim()
  } else {
    return null
  }

  if (Array.isArray(answer) && answer.length === 0) return null
  if (typeof answer === 'string' && !answer) return null

  return {
    id: String(rawId),
    type: mapType(record.type),
    answer,
  }
}

/**
 * 从模型输出中提取答案数组，容忍代码块、前后废话、对象包裹与 id→answer 映射。
 * 无法解析时返回空数组，由调用方提示用户。
 */
export function parseAnswerPayload(raw: string): Answer[] {
  const parsed = tryParseJson(raw)
  if (!parsed) return []

  let items: unknown[] = []

  if (Array.isArray(parsed)) {
    items = parsed
  } else if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record.answers)) {
      items = record.answers
    } else if (Array.isArray(record.data)) {
      items = record.data
    } else {
      // 兼容 { "1": "A", "2": "B" } 形式
      items = Object.entries(record)
        .filter(([key]) => /^\d+$/.test(key))
        .map(([key, value]) => ({ id: key, answer: value }))
    }
  }

  const answers = items
    .map(normalizeAnswerItem)
    .filter((item): item is Answer => item !== null)

  // 同一 id 以最后一条为准
  const deduped = new Map<string, Answer>()
  for (const answer of answers) deduped.set(answer.id, answer)
  return [...deduped.values()]
}
