import type { Question, QuestionImage } from '../types'
import { LlmError, askVision } from './llm'

/**
 * OCR 专用 Prompt：只做转写，不做解释或答案推断。
 * 视觉模型可以是智谱、Gemini、Qwen、Ollama 等任意 OpenAI 兼容服务。
 */
export const OCR_PROMPT = `你是一个 OCR 引擎。请逐字转写图片中的所有文字。

要求：
1. 保持原有顺序与换行；
2. 数学公式使用 LaTeX；
3. 表格使用 Markdown；
4. 不要解释、总结、补充或输出任何额外文字；
5. 图片中没有文字时只输出空字符串。`

const CACHE_LIMIT = 200
const ocrCache = new Map<string, string>()

export interface OcrOptions {
  onWarning?: (message: string) => void
}

export interface OcrResult {
  total: number
  transcribed: number
}

function hashImage(dataUrl: string): string {
  let hash = 2166136261
  for (let index = 0; index < dataUrl.length; index += 1) {
    hash ^= dataUrl.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${(hash >>> 0).toString(36)}:${dataUrl.length}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function describeError(error: unknown): string {
  if (error instanceof LlmError) return `[${error.code}] ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function isFatalVisionError(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false
  if (error.code === 'NO_CONFIG' || error.code === 'RATE_LIMIT') return true
  return error.code === 'HTTP' && /HTTP\s+(401|403)/.test(error.message)
}

function cleanupText(text: string): string {
  return text
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim()
}

function remember(hash: string, text: string): void {
  if (ocrCache.size >= CACHE_LIMIT) {
    const oldest = ocrCache.keys().next().value
    if (oldest) ocrCache.delete(oldest)
  }
  ocrCache.set(hash, text)
}

async function transcribeImage(
  image: QuestionImage,
  options: OcrOptions,
): Promise<string> {
  const dataUrl = image.dataUrl
  if (!dataUrl) return ''

  const hash = hashImage(dataUrl)
  const cached = ocrCache.get(hash)
  if (cached !== undefined) return cached

  let lastError: unknown

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = await askVision({
        prompt: OCR_PROMPT,
        images: [dataUrl],
        temperature: 0,
      })
      const text = cleanupText(raw)

      if (!text) {
        options.onWarning?.('图片中未识别到文字')
      }

      remember(hash, text)
      return text
    } catch (error) {
      lastError = error

      // 速率限制退避重试；仍然失败则交给上层停止本轮 OCR
      if (error instanceof LlmError && error.code === 'RATE_LIMIT' && attempt < 2) {
        await delay(1200 * (attempt + 1))
        continue
      }
      break
    }
  }

  if (isFatalVisionError(lastError)) throw lastError

  options.onWarning?.(`图片转写失败：${describeError(lastError)}`)
  return ''
}

/**
 * 把一道题的图片逐张转成文字，并拼接到题干末尾。
 * 单张失败只记录警告；Key 无效、无权限、持续限流会抛出，由上层停止本轮 OCR。
 */
export async function transcribeQuestionImages(
  question: Question,
  options: OcrOptions = {},
): Promise<OcrResult> {
  const images = question.images ?? []
  if (images.length === 0) return { total: 0, transcribed: 0 }

  const texts: string[] = []

  for (let index = 0; index < images.length; index += 1) {
    const text = await transcribeImage(images[index], options)
    if (!text) continue

    texts.push(images.length > 1 ? `【图片${index + 1}】\n${text}` : text)
  }

  if (texts.length > 0) {
    question.stem = `${question.stem}\n\n【图片文字】\n${texts.join('\n\n')}`
  }

  return { total: images.length, transcribed: texts.length }
}

/** 仅用于调试或未来设置页清理缓存 */
export function clearOcrCache(): void {
  ocrCache.clear()
}
