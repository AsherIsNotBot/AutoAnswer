import type { ErrorCode, LlmPayload, Req, Res } from '../types'

export class LlmError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

export interface VisionAskResult {
  content: string
  /** 本次请求因模型不支持视觉而丢弃了图片 */
  imagesDropped: boolean
}

let visionDisabled = false

/** 每次点击「启动答题」时重置，避免上一轮的降级状态影响新任务。 */
export function resetVisionState(): void {
  visionDisabled = false
}

export function isVisionDisabled(): boolean {
  return visionDisabled
}

function shouldRetryWithoutImages(error: { code: ErrorCode; message: string }): boolean {
  if (error.code === 'HTTP') {
    return /\b(400|413|415|422)\b/.test(error.message)
  }
  return false
}

/** 向 background 发消息，任何失败都归一化为 Res，不向调用方抛原始异常。 */
export async function sendMessage(req: Req): Promise<Res> {
  try {
    const res = (await chrome.runtime.sendMessage(req)) as Res | undefined
    if (!res) {
      return { ok: false, error: { code: 'UNKNOWN', message: '后台无响应，请重载扩展后重试' } }
    }
    return res
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: { code: 'UNKNOWN', message: `无法连接后台：${message}` },
    }
  }
}

/** 发送一次对话请求，返回模型文本内容。 */
export async function askLLM(payload: LlmPayload): Promise<string> {
  const res = await sendMessage({ type: 'LLM_CHAT', payload })
  if (!res.ok) throw new LlmError(res.error.code, res.error.message)
  return res.data.content
}

/**
 * 带图片的请求：模型不支持视觉（400/413/415/422）时自动去掉图片重试一次，
 * 并在本轮任务内记住降级状态，避免后续题目反复失败。
 */
export async function askLLMWithVision(payload: LlmPayload): Promise<VisionAskResult> {
  const images = payload.images ?? []
  if (images.length === 0) {
    return { content: await askLLM(payload), imagesDropped: false }
  }

  if (visionDisabled) {
    return {
      content: await askLLM({ ...payload, images: undefined }),
      imagesDropped: true,
    }
  }

  const res = await sendMessage({ type: 'LLM_CHAT', payload })
  if (res.ok) return { content: res.data.content, imagesDropped: false }

  if (!shouldRetryWithoutImages(res.error)) {
    throw new LlmError(res.error.code, res.error.message)
  }

  visionDisabled = true
  const content = await askLLM({ ...payload, images: undefined })
  return { content, imagesDropped: true }
}

/** 设置页“测试连接”用：极小 prompt，验证配置与链路是否可用。 */
export async function testConnection(): Promise<string> {
  return askLLM({ prompt: '请只回复两个字符：OK', temperature: 0 })
}
