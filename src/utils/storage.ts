import type { PanelSettings, PublicSettings, Settings } from '../types'

const SETTINGS_KEY = 'autoAnswer.settings'

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  autoSubmit: false,
  enableImages: false,
  imageMode: 'ocr',
  visionBaseUrl: '',
  visionApiKey: '',
  visionModel: '',
}

/** 面板初始值：只包含非敏感字段，避免把 Key 带进内容脚本状态。 */
export const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  baseUrl: DEFAULT_SETTINGS.baseUrl,
  model: DEFAULT_SETTINGS.model,
  autoSubmit: DEFAULT_SETTINGS.autoSubmit,
  enableImages: DEFAULT_SETTINGS.enableImages,
  imageMode: DEFAULT_SETTINGS.imageMode,
  visionBaseUrl: DEFAULT_SETTINGS.visionBaseUrl,
  visionModel: DEFAULT_SETTINGS.visionModel,
}

/** 剥离 Key，只保留面板需要的字段和「是否已配置」标记。 */
export function toPublicSettings(settings: Settings): PublicSettings {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    autoSubmit: settings.autoSubmit,
    enableImages: settings.enableImages,
    imageMode: settings.imageMode,
    visionBaseUrl: settings.visionBaseUrl,
    visionModel: settings.visionModel,
    hasApiKey: Boolean(settings.apiKey),
    hasVisionApiKey: Boolean(settings.visionApiKey),
  }
}

function normalize(input: Partial<Settings>): Settings {
  return {
    baseUrl: String(input.baseUrl ?? DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: String(input.apiKey ?? DEFAULT_SETTINGS.apiKey).trim(),
    model: String(input.model ?? DEFAULT_SETTINGS.model).trim(),
    autoSubmit: Boolean(input.autoSubmit),
    enableImages: Boolean(input.enableImages),
    imageMode: input.imageMode === 'direct' ? 'direct' : 'ocr',
    visionBaseUrl: String(input.visionBaseUrl ?? DEFAULT_SETTINGS.visionBaseUrl)
      .trim()
      .replace(/\/+$/, ''),
    visionApiKey: String(input.visionApiKey ?? DEFAULT_SETTINGS.visionApiKey).trim(),
    visionModel: String(input.visionModel ?? DEFAULT_SETTINGS.visionModel).trim(),
  }
}

export async function getSettings(): Promise<Settings> {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY)
    const raw = data[SETTINGS_KEY]
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
    return normalize(raw as Partial<Settings>)
  } catch {
    // 理论上 content script 也有 storage 权限，这里只做兜底
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalize({ ...(await getSettings()), ...patch })
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}
