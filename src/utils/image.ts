import type { Question, QuestionImage } from '../types'
import { sendMessage } from './llm'

const MAX_IMAGES_PER_QUESTION = 4
const MAX_DIMENSION = 1600
const MAX_DATA_URL_LENGTH = 3_000_000
const MAX_BLOB_BYTES = 12 * 1024 * 1024
const FETCH_TIMEOUT_MS = 12_000

const imageCache = new Map<string, Promise<string | null>>()

export interface PrepareImageOptions {
  onWarning?: (message: string) => void
  maxPerQuestion?: number
}

function shorten(src: string): string {
  return src.length > 80 ? `${src.slice(0, 77)}...` : src
}

function isPlaceholder(src: string): boolean {
  return (
    /^data:image\/gif;base64,R0lGOD/i.test(src) ||
    /(blank|placeholder|loading)\.(gif|png|svg)/i.test(src)
  )
}

function bestSource(image: QuestionImage): string {
  const candidates = [image.element?.currentSrc, image.element?.src, image.src]
  return candidates.find((src) => src && !isPlaceholder(src)) ?? image.src
}

function buildLabel(question: Question, image: QuestionImage, index: number): string {
  const part =
    image.kind === 'option' ? `选项${image.optionLabel ?? '?'}配图` : '题干配图'
  return `题目${question.number} 图片${index + 1}（${part}）`
}

function waitForElement(image: HTMLImageElement, timeoutMs = 2500): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve()

  try {
    image.scrollIntoView({ block: 'center', inline: 'nearest' })
  } catch {
    // ignore
  }

  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      image.removeEventListener('load', done)
      image.removeEventListener('error', done)
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(done, timeoutMs)
    image.addEventListener('load', done, { once: true })
    image.addEventListener('error', done, { once: true })
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const timer = window.setTimeout(() => reject(new Error('图片加载超时')), 8000)
    image.onload = () => {
      window.clearTimeout(timer)
      resolve(image)
    }
    image.onerror = () => {
      window.clearTimeout(timer)
      reject(new Error('图片加载失败'))
    }
    image.src = src
  })
}

function renderJpeg(image: HTMLImageElement, scale: number, quality: number): string {
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建 canvas')
  // 透明图片转白底，避免 JPEG 出现黑块
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)

  return canvas.toDataURL('image/jpeg', quality)
}

async function compressDataUrl(source: string): Promise<string | null> {
  let image: HTMLImageElement
  try {
    image = await loadImage(source)
  } catch {
    return null
  }

  const width = image.naturalWidth
  const height = image.naturalHeight
  if (!width || !height) return null

  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height))

  try {
    let output = renderJpeg(image, scale, 0.82)
    if (output.length > MAX_DATA_URL_LENGTH) {
      output = renderJpeg(image, scale * 0.7, 0.7)
    }
    return output.length <= MAX_DATA_URL_LENGTH * 1.2 ? output : null
  } catch {
    return null
  }
}

async function fetchViaPage(src: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(src, {
      credentials: 'include',
      signal: controller.signal,
      cache: 'force-cache',
    })
    if (!response.ok) return null

    const blob = await response.blob()
    if (!blob.type.startsWith('image/') || blob.size > MAX_BLOB_BYTES) return null

    const dataUrl = await blobToDataUrl(blob)
    return await compressDataUrl(dataUrl)
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

async function fetchViaBackground(src: string): Promise<string | null> {
  const response = await sendMessage({ type: 'FETCH_IMAGE', payload: { url: src } })
  if (!response.ok) return null
  if (!response.data.content.startsWith('data:image/')) return null
  return await compressDataUrl(response.data.content)
}

async function resolveImage(image: QuestionImage): Promise<string | null> {
  if (image.element) await waitForElement(image.element)

  const src = bestSource(image)
  if (!src) return null

  if (src.startsWith('data:image/')) {
    return await compressDataUrl(src)
  }

  const cached = imageCache.get(src)
  if (cached) return cached

  const task = (async () => (await fetchViaPage(src)) ?? (await fetchViaBackground(src)))()
  imageCache.set(src, task)
  return task
}

/**
 * 抓取并压缩一道题的图片；只保留成功拿到 dataUrl 的图片，并重新编号。
 * 返回实际可发送的图片数量。
 */
export async function prepareQuestionImages(
  question: Question,
  options: PrepareImageOptions = {},
): Promise<number> {
  const images = question.images ?? []
  if (images.length === 0) return 0

  const limit = options.maxPerQuestion ?? MAX_IMAGES_PER_QUESTION
  const resolved: QuestionImage[] = []

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]

    if (index >= limit) {
      options.onWarning?.(
        `题目 ${question.number} 含 ${images.length} 张图，最多附带 ${limit} 张`,
      )
      break
    }

    const dataUrl = await resolveImage(image)
    if (!dataUrl) {
      options.onWarning?.(
        `题目 ${question.number} 的图片加载失败：${shorten(image.src)}`,
      )
      continue
    }

    resolved.push({ ...image, dataUrl })
  }

  resolved.forEach((image, index) => {
    image.label = buildLabel(question, image, index)
  })
  question.images = resolved
  return resolved.length
}

/** Prompt 与请求中的图片顺序保持一致：按题目顺序、题目内按 images 顺序。 */
export function flattenImageDataUrls(questions: Question[]): string[] {
  const result: string[] = []
  for (const question of questions) {
    for (const image of question.images ?? []) {
      if (image.dataUrl) result.push(image.dataUrl)
    }
  }
  return result
}

export function countQuestionImages(questions: Question[]): number {
  return questions.reduce((sum, question) => sum + (question.images?.length ?? 0), 0)
}
