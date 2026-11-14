import type { ErrorCode, LlmPayload, Req, Res } from '../types'
import { getSettings } from '../utils/storage'

const REQUEST_TIMEOUT_MS = 60_000
const IMAGE_TIMEOUT_MS = 15_000
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_IMAGES_PER_REQUEST = 8
const MAX_IMAGES_TOTAL_LENGTH = 12_000_000

class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

function toErrorPayload(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'UNKNOWN', message: error.message }
  return { code: 'UNKNOWN', message: String(error) }
}

/** 兼容用户填 ".../v1"、".../v1/" 或完整 ".../chat/completions"。 */
function resolveEndpoint(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new AppError('NO_CONFIG', `Base URL 无效：${baseUrl || '(空)'}`)
  }

  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed

  // 只填了域名（没有路径）时按 OpenAI 惯例补 /v1
  if (!url.pathname || url.pathname === '/') {
    return `${url.origin}/v1/chat/completions`
  }
  return `${trimmed}/chat/completions`
}

function sanitizeImages(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const images: string[] = []
  let totalLength = 0

  for (const item of value) {
    if (typeof item !== 'string') continue
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(item)) continue
    if (item.length > 8_000_000) continue
    if (totalLength + item.length > MAX_IMAGES_TOTAL_LENGTH) break

    images.push(item)
    totalLength += item.length
    if (images.length >= MAX_IMAGES_PER_REQUEST) break
  }

  return images
}

function normalizeContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

async function handleChat(payload: LlmPayload): Promise<{ content: string; model?: string }> {
  if (!payload?.prompt?.trim()) {
    throw new AppError('UNKNOWN', 'prompt 不能为空')
  }

  const settings = await getSettings()
  const images = sanitizeImages(payload.images)
  const useVision = images.length > 0

  // 视觉配置逐项回退主配置：留空即使用答题模型的对应配置
  const baseUrl = useVision
    ? settings.visionBaseUrl || settings.baseUrl
    : settings.baseUrl
  const apiKey = useVision
    ? settings.visionApiKey || settings.apiKey
    : settings.apiKey
  const model = useVision
    ? settings.visionModel || settings.model
    : settings.model

  if (!apiKey) {
    throw new AppError(
      'NO_CONFIG',
      useVision
        ? '请填写视觉服务 API Key（留空会复用主模型 Key）'
        : '请先在面板「设置」中填写 API Key',
    )
  }
  if (!model) {
    throw new AppError(
      'NO_CONFIG',
      useVision
        ? '请填写视觉模型名称（留空会复用主模型）'
        : '请先在面板「设置」中填写模型名称',
    )
  }
  if (!baseUrl) {
    throw new AppError('NO_CONFIG', '请填写模型 Base URL')
  }

  const endpoint = resolveEndpoint(baseUrl)

  const userContent =
    images.length > 0
      ? [
          { type: 'text', text: payload.prompt },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ]
      : payload.prompt

  const messages = [
    ...(payload.system ? [{ role: 'system', content: payload.system }] : []),
    { role: 'user', content: userContent },
  ]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: payload.temperature ?? 0.1,
        stream: false,
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AppError('TIMEOUT', `请求超时（${REQUEST_TIMEOUT_MS / 1000}s），请检查 Base URL 或网络`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new AppError('UNKNOWN', `网络请求失败：${message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 500)
    if (
      response.status === 429 ||
      /"code"\s*:\s*"?1302"?/.test(body) ||
      body.includes('1302')
    ) {
      throw new AppError('RATE_LIMIT', `触发速率限制（1302/429）：${body || '请稍后重试'}`)
    }
    if (body.includes('1305')) {
      throw new AppError('RATE_LIMIT', `平台过载（1305）：${body}`)
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        'HTTP',
        `HTTP ${response.status}：API Key 无效或无权限${body ? `：${body}` : ''}`,
      )
    }
    throw new AppError(
      'HTTP',
      `HTTP ${response.status} ${response.statusText}${body ? `：${body}` : ''}`,
    )
  }

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new AppError('PARSE', '接口返回的不是合法 JSON')
  }

  const data = json as {
    model?: string
    error?: { code?: string | number; message?: string }
    choices?: Array<{ message?: { content?: unknown } }>
  }

  if (data.error) {
    const code = String(data.error.code ?? '')
    if (code === '1302' || code === '1305') {
      throw new AppError('RATE_LIMIT', `平台限流（${code}）：${data.error.message ?? ''}`)
    }
    throw new AppError(
      'HTTP',
      `接口错误${code ? ` ${code}` : ''}：${data.error.message ?? '未知错误'}`,
    )
  }

  const content = normalizeContent(data?.choices?.[0]?.message?.content)
  if (!content.trim()) {
    throw new AppError('PARSE', '响应缺少 choices[0].message.content，可能不是 OpenAI 兼容接口')
  }

  return { content, model: data.model }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

async function handleFetchImage(url: string): Promise<{ content: string; mimeType: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AppError('UNKNOWN', '图片地址无效')
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new AppError('UNKNOWN', '仅支持 http/https 图片')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(parsed.toString(), {
      credentials: 'include',
      signal: controller.signal,
      cache: 'force-cache',
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AppError('TIMEOUT', '图片下载超时')
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new AppError('UNKNOWN', `图片下载失败：${message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new AppError('HTTP', `图片请求失败：HTTP ${response.status}`)
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!contentType.startsWith('image/')) {
    throw new AppError('UNKNOWN', `返回内容不是图片：${contentType || '未知类型'}`)
  }

  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError('UNKNOWN', '图片超过 12MB，已跳过')
  }

  return {
    content: `data:${contentType};base64,${toBase64(buffer)}`,
    mimeType: contentType,
  }
}

chrome.runtime.onMessage.addListener(
  (request: Req, _sender, sendResponse: (response: Res) => void) => {
    if (request?.type === 'PING') {
      sendResponse({ ok: true, data: { content: 'pong' } })
      return false
    }

    if (request?.type === 'LLM_CHAT') {
      handleChat(request.payload)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: toErrorPayload(error) }))
      return true // 保持消息通道，等待异步 fetch
    }

    if (request?.type === 'FETCH_IMAGE') {
      handleFetchImage(request.payload.url)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: toErrorPayload(error) }))
      return true
    }

    return false
  },
)
