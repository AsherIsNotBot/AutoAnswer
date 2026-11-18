<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type {
  Answer,
  FillResult,
  PanelSettings,
  PublicSettings,
  PublicSettingsResponseData,
  Question,
  SecretField,
} from '../types'
import { DEFAULT_PANEL_SETTINGS } from '../utils/storage'
import { LlmError, askLLM, askLLMWithVision, askVision, isVisionDisabled, resetVisionState, sendMessage, testConnection } from '../utils/llm'
import { countQuestionImages, flattenImageDataUrls, prepareQuestionImages } from '../utils/image'
import { OCR_PROMPT, transcribeQuestionImages } from '../utils/ocr'
import {
  ANSWER_SYSTEM_PROMPT,
  buildAnswerPrompt,
  parseAnswerPayload,
} from '../utils/prompt'
import { createStrategy, questionTypeLabel, type BaseStrategy } from './strategies'
import {
  deserializeQuestion,
  fillInFrame,
  requestQuestionsFromFrames,
  submitFrames,
} from './bridge'

type LogLevel = 'info' | 'ok' | 'warn' | 'error'
type NoticeType = 'ok' | 'error' | 'info'

interface LogEntry {
  id: number
  time: string
  level: LogLevel
  message: string
}

interface RoutedQuestion {
  /** Prompt 中的全局 id：顶层为 "0"，iframe 为 "f0:0" */
  id: string
  /** iframe 内本地 id */
  localId: string
  frame: Window | null
  question: Question
  platform: string
}

const collapsed = ref(false)
const tab = ref<'settings' | 'console'>('settings')

const form = reactive<PanelSettings>({ ...DEFAULT_PANEL_SETTINGS })
const secretStatus = reactive({ apiKey: false, visionApiKey: false })
// 只写不读：Key 不会从后台回填到面板，输入后保存即清空
const apiKeyDraft = ref('')
const visionKeyDraft = ref('')
const saving = ref(false)
const testing = ref(false)
const testingVision = ref(false)
const running = ref(false)
const stopRequested = ref(false)
const platformName = ref(createStrategy(location.host)?.platform ?? '')
const visionPreset = ref('custom')

const VISION_PRESETS: Record<
  string,
  { label: string; baseUrl: string; model: string }
> = {
  zhipu: {
    label: '智谱免费视觉',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.1v-thinking-flash',
  },
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
  },
  qwen: {
    label: 'Qwen / DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-plus',
  },
  ollama: {
    label: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-vl:7b',
  },
}

let ocrDisabled = false

const notice = ref('')
const noticeType = ref<NoticeType>('info')

const logs = ref<LogEntry[]>([])
let logSeq = 0
let noticeTimer: ReturnType<typeof setTimeout> | undefined

const progress = reactive({ total: 0, filled: 0, skipped: 0, failed: 0 })
/** 智慧树分页页面上，本次开始前答题卡已显示作答的题数（不重复处理） */
const preAnswered = ref(0)
const processed = computed(
  () => progress.filled + progress.skipped + progress.failed + preAnswered.value,
)
const barWidth = computed(() =>
  progress.total > 0 ? `${Math.round((processed.value / progress.total) * 100)}%` : '0%',
)
const statusText = computed(() => {
  if (running.value) return '正在答题…'
  if (progress.total === 0) return '待开始'
  if (processed.value < progress.total) return '已中断'
  if (progress.failed > 0 || progress.skipped > 0) return '答题未完成'
  return '答题完成'
})

const hasVisionConfig = computed(() =>
  Boolean(
    form.visionBaseUrl.trim() ||
      form.visionModel.trim() ||
      secretStatus.visionApiKey,
  ),
)

const visionSummary = computed(() => {
  if (!form.enableImages) return ''
  if (!hasVisionConfig.value) {
    return `主模型：${form.model || '未配置'}（需支持视觉）`
  }
  const model = form.visionModel.trim() || form.model || '未配置'
  const base = form.visionBaseUrl.trim() || form.baseUrl || '未配置'
  return `视觉服务：${model} · ${base}`
})

function addLog(level: LogLevel, message: string): void {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  logs.value.unshift({ id: ++logSeq, time, level, message })
  if (logs.value.length > 100) logs.value.length = 100
}

function setNotice(message: string, type: NoticeType = 'info'): void {
  notice.value = message
  noticeType.value = type
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 6000)
}

function describeError(error: unknown): string {
  if (error instanceof LlmError) return `[${error.code}] ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function applyVisionPreset(): void {
  const preset = VISION_PRESETS[visionPreset.value]
  if (!preset) return
  form.visionBaseUrl = preset.baseUrl
  form.visionModel = preset.model
}

function createTestImage(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 720
  canvas.height = 260
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建测试图片')

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = '#2563eb'
  context.lineWidth = 6
  context.strokeRect(20, 20, 680, 220)
  context.fillStyle = '#111827'
  context.font = 'bold 44px sans-serif'
  context.fillText('识图测试 ABC 123', 44, 110)
  context.font = '30px sans-serif'
  context.fillText('公式: E = mc²', 44, 175)

  return canvas.toDataURL('image/jpeg', 0.9)
}

async function onTestVision(): Promise<void> {
  if (testingVision.value) return
  if (!form.enableImages) {
    setNotice('请先开启图片识别', 'error')
    return
  }
  if (!(await persist())) return

  testingVision.value = true
  setNotice('正在测试识图…', 'info')
  addLog('info', `测试识图：${visionSummary.value}`)

  try {
    const started = performance.now()
    const text = await askVision({
      prompt: OCR_PROMPT,
      images: [createTestImage()],
      temperature: 0,
    })
    const elapsed = Math.round(performance.now() - started)
    const preview = text.trim().slice(0, 160) || '(空)'
    addLog('ok', `识图成功（${elapsed}ms）：${preview}`)
    setNotice('识图成功', 'ok')
  } catch (error) {
    const hint = hasVisionConfig.value
      ? ''
      : '；当前使用主模型识图，请确认主模型支持视觉，或填写视觉服务'
    const message = `${describeError(error)}${hint}`
    addLog('error', `识图失败：${message}`)
    setNotice(message, 'error')
  } finally {
    testingVision.value = false
  }
}

async function recognizeQuestionImages(
  question: Question,
  label: string,
): Promise<number> {
  if (!form.enableImages || form.imageMode !== 'ocr' || ocrDisabled) return 0

  try {
    const result = await transcribeQuestionImages(question, {
      onWarning: (message) => addLog('warn', `${label}${message}`),
    })

    if (result.total > 0 && result.transcribed === 0) {
      addLog(
        'warn',
        `${label}图片文字识别失败${hasVisionConfig.value ? '' : '；当前使用主模型识图，请确认其支持视觉或配置视觉服务'}`,
      )
    } else if (result.transcribed > 0) {
      addLog('info', `${label}已转写 ${result.transcribed}/${result.total} 张图片`)
    }

    return result.transcribed
  } catch (error) {
    ocrDisabled = true
    addLog(
      'error',
      `${label}图片识别中断：${describeError(error)}；本轮后续题目按纯文本继续`,
    )
    return 0
  }
}

function applyPublicSettings(settings: PublicSettings): void {
  form.baseUrl = settings.baseUrl
  form.model = settings.model
  form.autoSubmit = settings.autoSubmit
  form.enableImages = settings.enableImages
  form.imageMode = settings.imageMode
  form.visionBaseUrl = settings.visionBaseUrl
  form.visionModel = settings.visionModel
  secretStatus.apiKey = settings.hasApiKey
  secretStatus.visionApiKey = settings.hasVisionApiKey
}

async function load(): Promise<void> {
  try {
    const res = await sendMessage<PublicSettingsResponseData>({
      type: 'GET_PUBLIC_SETTINGS',
    })
    if (!res.ok) throw new LlmError(res.error.code, res.error.message)
    applyPublicSettings(res.data.settings)
  } catch (error) {
    setNotice(`读取配置失败：${describeError(error)}`, 'error')
  }

  const ping = await sendMessage({ type: 'PING' })
  if (ping.ok) {
    addLog('ok', '面板已注入，后台通信正常')
  } else {
    addLog('error', `后台通信失败：${ping.error.message}`)
  }
}

async function saveSecret(field: SecretField, value: string): Promise<PublicSettings> {
  const res = await sendMessage<PublicSettingsResponseData>({
    type: 'SET_SECRET',
    field,
    value,
  })
  if (!res.ok) throw new LlmError(res.error.code, res.error.message)
  return res.data.settings
}

async function onClearSecret(field: SecretField): Promise<void> {
  try {
    const settings = await saveSecret(field, '')
    secretStatus[field] = field === 'apiKey'
      ? settings.hasApiKey
      : settings.hasVisionApiKey
    if (field === 'apiKey') apiKeyDraft.value = ''
    else visionKeyDraft.value = ''
    setNotice('已清除 Key', 'ok')
    addLog('info', field === 'apiKey' ? '已清除主模型 Key' : '已清除视觉 Key')
  } catch (error) {
    setNotice(`清除失败：${describeError(error)}`, 'error')
  }
}

async function persist(): Promise<boolean> {
  if (!form.baseUrl.trim()) {
    setNotice('Base URL 不能为空', 'error')
    return false
  }
  if (!secretStatus.apiKey && !apiKeyDraft.value.trim()) {
    setNotice('API Key 不能为空', 'error')
    return false
  }
  if (!form.model.trim()) {
    setNotice('模型名称不能为空', 'error')
    return false
  }

  saving.value = true
  try {
    // Key 单独发送，保存后立即从面板状态中清空
    if (apiKeyDraft.value.trim()) {
      const settings = await saveSecret('apiKey', apiKeyDraft.value.trim())
      secretStatus.apiKey = settings.hasApiKey
      apiKeyDraft.value = ''
    }
    if (visionKeyDraft.value.trim()) {
      const settings = await saveSecret('visionApiKey', visionKeyDraft.value.trim())
      secretStatus.visionApiKey = settings.hasVisionApiKey
      visionKeyDraft.value = ''
    }

    const res = await sendMessage<PublicSettingsResponseData>({
      type: 'SAVE_PUBLIC_SETTINGS',
      patch: {
        baseUrl: form.baseUrl,
        model: form.model,
        autoSubmit: form.autoSubmit,
        enableImages: form.enableImages,
        imageMode: form.imageMode,
        visionBaseUrl: form.visionBaseUrl,
        visionModel: form.visionModel,
      },
    })
    if (!res.ok) throw new LlmError(res.error.code, res.error.message)
    applyPublicSettings(res.data.settings)

    setNotice('设置已保存', 'ok')
    addLog('ok', `设置已保存（${form.model}）`)
    return true
  } catch (error) {
    setNotice(`保存失败：${describeError(error)}`, 'error')
    addLog('error', `保存失败：${describeError(error)}`)
    return false
  } finally {
    saving.value = false
  }
}

async function onSave(): Promise<void> {
  await persist()
}

async function onTest(): Promise<void> {
  if (testing.value) return
  if (!(await persist())) return

  testing.value = true
  setNotice('正在测试连接…', 'info')
  addLog('info', '测试连接中…')
  try {
    const content = await testConnection()
    setNotice('连接成功', 'ok')
    addLog('ok', `连接成功，模型回复：${content.slice(0, 60)}`)
  } catch (error) {
    const message = describeError(error)
    setNotice(message, 'error')
    addLog('error', `连接失败：${message}`)
  } finally {
    testing.value = false
  }
}

function taskLabel(task: RoutedQuestion): string {
  const platform =
    task.platform && task.platform !== platformName.value ? `·${task.platform}` : ''
  return `#${task.question.number}${platform} [${questionTypeLabel(task.question.type)}]`
}

function applyFillResult(task: RoutedQuestion, result: FillResult): void {
  if (result.status === 'filled') {
    progress.filled += 1
    addLog('ok', `${taskLabel(task)} 已填：${result.message ?? '-'}`)
    return
  }
  if (result.status === 'skipped') {
    progress.skipped += 1
    addLog('warn', `${taskLabel(task)} 已跳过：${result.message ?? '未作答'}`)
    return
  }
  progress.failed += 1
  addLog('error', `${taskLabel(task)} 填涂失败：${result.message ?? '未知原因'}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** 停止本轮答题：不取消已在途的模型请求，但不再继续下一题，也不会交卷 */
function onStop(): void {
  if (!running.value) return
  stopRequested.value = true
  addLog('warn', '已请求停止：当前请求结束后停止，且不会自动交卷')
}

let visionFallbackNotified = false

async function prepareQuestionImageSet(
  questions: Question[],
  label: string,
): Promise<number> {
  if (
    !form.enableImages ||
    isVisionDisabled() ||
    (form.imageMode === 'ocr' && ocrDisabled)
  ) {
    return 0
  }

  let total = 0
  for (const question of questions) {
    total += await prepareQuestionImages(question, {
      onWarning: (message) => addLog('warn', message),
    })
  }

  if (total > 0) addLog('info', `${label}附带 ${total} 张图片`)
  return total
}

async function askWithOptionalImages(prompt: string, images: string[]): Promise<string> {
  const payload = {
    prompt,
    system: ANSWER_SYSTEM_PROMPT,
    temperature: 0,
    images: images.length > 0 ? images : undefined,
  }

  if (images.length === 0) return askLLM(payload)

  const result = await askLLMWithVision(payload)
  if (result.imagesDropped && !visionFallbackNotified) {
    visionFallbackNotified = true
    addLog(
      'warn',
      '模型不支持视觉输入，已去掉图片重试；本轮后续题目按纯文本作答',
    )
  }
  return result.content
}

/**
 * 分页式答题页（智慧树新版作业页）：一页一题，逐题解析 → 请求模型 → 填涂 → 下一题。
 * 单题失败不会中断后续题目。
 */
async function runPaged(strategy: BaseStrategy): Promise<void> {
  const total = strategy.getPagedTotal()
  progress.total = total
  addLog(
    'info',
    `检测到分页答题页（${total > 0 ? `共 ${total} 题` : '题数未知'}），逐题请求模型…`,
  )
  addLog('info', '正在定位第一题…')

  await strategy.goToFirst()
  if (strategy.startFailed) {
    addLog('warn', strategy.lastNotice || '无法定位到第一题，已停止（未交卷）')
    await finishRun(strategy, [], true)
    return
  }
  preAnswered.value = strategy.startIndex
  if (strategy.startIndex > 0) {
    addLog(
      'info',
      `答题卡显示前 ${strategy.startIndex} 题已答，本次从第 ${strategy.startIndex + 1} 题开始（不重复处理已答题）`,
    )
  }
  addLog('info', `已定位到第 ${strategy.startIndex + 1} 题，开始逐题处理`)

  // 页面题数已知时按题数封顶，避免异常页面无限翻页
  const maxPages = total > 0 ? total + 2 : 50
  const deadline = Date.now() + 15 * 60_000
  let page = 0
  let aborted = false
  let emptyPages = 0

  for (; page < maxPages; page += 1) {
    if (stopRequested.value) {
      aborted = true
      addLog('info', '已按请求停止答题（未交卷）')
      break
    }
    if (Date.now() > deadline) {
      aborted = true
      addLog('warn', '已超过 15 分钟，停止本轮答题（未交卷）')
      break
    }

    let questions = strategy.parseQuestions()
    if (questions.length === 0) {
      await delay(400)
      questions = strategy.parseQuestions()
    }

    if (questions.length === 0) {
      emptyPages += 1
      progress.skipped += 1
      addLog('warn', `第 ${page + 1} 页未解析到题目，尝试切到下一题`)
      if (emptyPages >= 3) {
        aborted = true
        addLog('warn', '连续 3 页未解析到题目，已停止（未交卷）')
        break
      }
    } else {
      emptyPages = 0
      const question = questions[0]
      const task: RoutedQuestion = {
        id: question.id,
        localId: question.id,
        frame: null,
        question,
        platform: strategy.platform,
      }

      // 分页页面一题一次请求，先写日志，避免长请求期间看起来像卡死
      addLog('info', `${taskLabel(task)} 正在请求模型…`)

      try {
        await prepareQuestionImageSet([question], `${taskLabel(task)} `)

        const ocrMode = form.enableImages && form.imageMode === 'ocr'
        if (ocrMode && !ocrDisabled) {
          await recognizeQuestionImages(question, `${taskLabel(task)} `)
        }

        const raw = ocrMode
          ? await askLLM({
              prompt: buildAnswerPrompt([question], { includeImages: false }),
              system: ANSWER_SYSTEM_PROMPT,
              temperature: 0,
            })
          : await askWithOptionalImages(
              buildAnswerPrompt([question]),
              flattenImageDataUrls([question]),
            )
        const answers = parseAnswerPayload(raw)
        const answer = answers.find((item) => item.id === question.id) ?? answers[0]

        if (!answer) {
          progress.skipped += 1
          addLog('warn', `${taskLabel(task)} 模型未返回答案，已跳过`)
        } else {
          applyFillResult(task, strategy.fillAnswer(question, answer))
        }
      } catch (error) {
        progress.failed += 1
        addLog('error', `${taskLabel(task)} 请求失败：${describeError(error)}`)
      }

      if (progress.total === 0) progress.total = page + 1
    }

    if (stopRequested.value) {
      aborted = true
      addLog('info', '已按请求停止答题（未交卷）')
      break
    }

    const nav = await strategy.nextQuestion()
    if (nav === 'failed') {
      aborted = true
      addLog(
        'error',
        strategy.lastNotice ||
          '切换下一题失败，已停止（未交卷），请检查页面是否加载完成',
      )
      break
    }
    if (nav === 'last') break
    // 给页面留出渲染/自动保存时间，避免连续快速切换拖慢页面
    await delay(200)
  }

  if (page >= maxPages) {
    aborted = true
    addLog('warn', `已处理 ${maxPages} 页，停止以避免死循环`)
  }

  await finishRun(strategy, [], aborted)
}

async function finishRun(
  strategy: BaseStrategy,
  frameWindows: Window[],
  aborted = false,
  hasLocalQuestions = true,
): Promise<void> {
  const complete =
    !aborted &&
    !stopRequested.value &&
    progress.total > 0 &&
    progress.filled + preAnswered.value === progress.total &&
    progress.skipped === 0 &&
    progress.failed === 0

  const preNote =
    preAnswered.value > 0 ? ` · 另有 ${preAnswered.value} 题此前已答` : ''

  if (!complete) {
    addLog(
      'warn',
      `答题未完成：已填 ${progress.filled}/${progress.total || '?'}${preNote} · 跳过 ${progress.skipped} · 失败 ${progress.failed}，已跳过自动交卷`,
    )
    return
  }

  addLog(
    'ok',
    `答题完成：已填 ${progress.filled}${preNote} · 跳过 ${progress.skipped} · 失败 ${progress.failed}`,
  )

  if (!form.autoSubmit) return

  // 页面不在前台时不做阻塞式 confirm，避免用户看不到弹窗却卡住页面
  if (document.visibilityState !== 'visible' || !document.hasFocus()) {
    addLog('warn', '页面不在前台，已跳过自动交卷，请手动提交')
    return
  }

  const answeredTotal = progress.filled + preAnswered.value
  const preConfirm =
    preAnswered.value > 0 ? `（本轮 ${progress.filled} 题，此前已答 ${preAnswered.value} 题）` : ''
  const confirmed = window.confirm(
    `已填写 ${answeredTotal}/${progress.total} 道题${preConfirm}，确定现在交卷吗？`,
  )
  if (!confirmed) {
    addLog('info', '已取消自动交卷')
    return
  }

  // 题目全在 iframe 时，顶层页面没有交卷按钮，不要误点页面上的其他“提交”
  const submittedTop = hasLocalQuestions ? await strategy.submit() : false
  const frameOutcome = await submitFrames(frameWindows)

  // 智慧树的提交按钮在弹窗里异步点击，稍等后检查是否被“未完成题目”提示拦截
  await delay(800)

  const notices = [
    ...(strategy.lastNotice ? [strategy.lastNotice] : []),
    ...frameOutcome.notices,
  ]

  if (notices.length > 0) {
    for (const notice of new Set(notices)) addLog('warn', notice)
    return
  }

  if (submittedTop || frameOutcome.submitted) {
    addLog('ok', '已触发交卷')
  } else {
    addLog('warn', '未找到交卷按钮，请手动提交')
  }
}

async function onStart(): Promise<void> {
  if (running.value) return

  const strategy = createStrategy(location.host)
  if (!strategy) {
    addLog('error', `当前站点不受支持：${location.host}`)
    setNotice('当前站点不受支持', 'error')
    return
  }

  if (!secretStatus.apiKey && !apiKeyDraft.value.trim()) {
    tab.value = 'settings'
    setNotice('请先填写 API Key 并保存', 'error')
    return
  }
  // 面板里刚输入的新 Key / 视觉 Key 先落盘，再开始请求
  if (apiKeyDraft.value.trim() || visionKeyDraft.value.trim()) {
    if (!(await persist())) return
  }

  running.value = true
  stopRequested.value = false
  tab.value = 'console'
  platformName.value = strategy.platform
  progress.total = 0
  progress.filled = 0
  progress.skipped = 0
  progress.failed = 0
  preAnswered.value = 0
  resetVisionState()
  visionFallbackNotified = false
  ocrDisabled = false

  try {
    if (form.enableImages) {
      addLog(
        'info',
        `图片识别：${form.imageMode === 'ocr' ? '图片转文字' : '视觉模型直接作答'} · ${visionSummary.value}`,
      )
    } else {
      addLog('info', '图片识别：关，按纯文本作答')
    }

    if (strategy.paged) {
      await runPaged(strategy)
      return
    }

    addLog('info', `平台：${strategy.platform}，开始解析题目…`)

    const ownQuestions = strategy.parseQuestions()
    if (ownQuestions.length > 0) {
      addLog('info', `当前页面解析到 ${ownQuestions.length} 道题`)
    }

    const withImages =
      form.enableImages &&
      !isVisionDisabled() &&
      !(form.imageMode === 'ocr' && ocrDisabled)
    let frameResults = await requestQuestionsFromFrames(withImages)

    // 嵌套 iframe 可能晚于顶层页面加载，零结果时稍等重试一次
    if (frameResults.every((result) => result.questions.length === 0)) {
      await delay(700)
      frameResults = await requestQuestionsFromFrames(withImages)
    }

    frameResults.forEach((result) => {
      result.warnings.forEach((warning) => addLog('warn', `[iframe] ${warning}`))
    })

    const frameQuestionCount = frameResults.reduce(
      (sum, item) => sum + item.questions.length,
      0,
    )
    if (frameQuestionCount > 0) {
      addLog(
        'info',
        `iframe 中解析到 ${frameQuestionCount} 道题（${frameResults.length} 个 frame）`,
      )
    }

    if (withImages && ownQuestions.length > 0) {
      await prepareQuestionImageSet(ownQuestions, '当前页面')
    }

    const tasks: RoutedQuestion[] = ownQuestions.map((question) => ({
      id: question.id,
      localId: question.id,
      frame: null,
      question,
      platform: strategy.platform,
    }))

    frameResults.forEach((result, frameIndex) => {
      result.questions.forEach((serialized) => {
        const id = `f${frameIndex}:${serialized.id}`
        tasks.push({
          id,
          localId: serialized.id,
          frame: result.frame,
          question: deserializeQuestion({ ...serialized, id }),
          platform: result.platform,
        })
      })
    })

    if (tasks.length === 0) {
      addLog('warn', '未识别到题目，请确认已进入答题页并等待页面加载完成')
      setNotice('未识别到题目', 'error')
      return
    }

    progress.total = tasks.length
    addLog('info', `共 ${tasks.length} 道题，正在请求大模型…`)

    const tasksQuestions = tasks.map((task) => task.question)
    const images = flattenImageDataUrls(tasksQuestions)
    const imageCount = countQuestionImages(tasksQuestions)
    const ocrMode = form.enableImages && form.imageMode === 'ocr'

    if (imageCount === 0) {
      if (form.enableImages && !isVisionDisabled()) {
        addLog('info', '未发现可发送的题目图片，按纯文本作答')
      }
    } else if (ocrMode) {
      addLog('info', `共发现 ${images.length} 张图片，开始转写文字…`)

      let transcribed = 0
      for (const task of tasks) {
        transcribed += await recognizeQuestionImages(
          task.question,
          `${taskLabel(task)} `,
        )
        if (ocrDisabled) break
      }

      if (transcribed > 0) {
        addLog('info', `图片文字转写完成：${transcribed}/${images.length}`)
      }
    } else {
      addLog('info', `共附带 ${images.length} 张图片（${imageCount} 处）`)
    }

    const raw = ocrMode
      ? await askLLM({
          prompt: buildAnswerPrompt(tasksQuestions, { includeImages: false }),
          system: ANSWER_SYSTEM_PROMPT,
          temperature: 0,
        })
      : await askWithOptionalImages(
          buildAnswerPrompt(tasksQuestions),
          images,
        )

    const answers = parseAnswerPayload(raw)
    if (answers.length === 0) {
      addLog('error', `模型返回无法解析为答案 JSON：${raw.slice(0, 120)}`)
      setNotice('模型返回格式异常', 'error')
      return
    }
    addLog('ok', `模型返回 ${answers.length} 条答案`)

    const answerMap = new Map(answers.map((answer) => [answer.id, answer]))
    const topFills: Array<{ task: RoutedQuestion; answer: Answer }> = []
    const frameFills = new Map<Window, Array<{ task: RoutedQuestion; answer: Answer }>>()

    for (const task of tasks) {
      const answer = answerMap.get(task.id)
      if (!answer) {
        progress.skipped += 1
        addLog('warn', `${taskLabel(task)} 模型未返回答案，已跳过`)
        continue
      }
      if (task.frame) {
        const list = frameFills.get(task.frame) ?? []
        list.push({ task, answer })
        frameFills.set(task.frame, list)
      } else {
        topFills.push({ task, answer })
      }
    }

    // 用户已请求停止：不再填涂，也不交卷
    if (stopRequested.value) {
      addLog('info', '已按请求停止答题（未交卷）')
      await finishRun(strategy, [...frameFills.keys()], true, ownQuestions.length > 0)
      return
    }

    // 当前页面直接填涂
    for (const { task, answer } of topFills) {
      if (stopRequested.value) break
      applyFillResult(task, strategy.fillAnswer(task.question, answer))
    }

    // 逐个 iframe 批量填涂
    for (const [frame, items] of frameFills) {
      if (stopRequested.value) break
      const results = await fillInFrame(
        frame,
        items.map((item) => ({ ...item.answer, id: item.task.localId })),
      )
      const resultMap = new Map(results.map((result) => [result.id, result]))

      for (const item of items) {
        const result = resultMap.get(item.task.localId)
        if (!result) {
          applyFillResult(item.task, {
            id: item.task.localId,
            status: 'failed',
            message: 'iframe 未响应填涂指令',
          })
          continue
        }
        applyFillResult(item.task, result)
      }
    }

    await finishRun(
      strategy,
      [...frameFills.keys()],
      stopRequested.value,
      ownQuestions.length > 0,
    )
  } catch (error) {
    const message = describeError(error)
    addLog('error', `答题中断：${message}`)
    setNotice(message, 'error')
  } finally {
    running.value = false
  }
}

function clearLogs(): void {
  logs.value = []
}

onMounted(load)
</script>

<template>
  <div class="panel" :class="{ 'is-collapsed': collapsed }">
    <header class="header">
      <div class="brand">
        <span class="dot" />
        <span class="title">Auto Answer AI</span>
        <span class="badge">P8</span>
      </div>
      <button
        class="icon-btn"
        type="button"
        :title="collapsed ? '展开面板' : '收起面板'"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? '▲' : '▼' }}
      </button>
    </header>

    <template v-if="!collapsed">
      <nav class="tabs">
        <button
          type="button"
          :class="{ active: tab === 'settings' }"
          @click="tab = 'settings'"
        >
          设置
        </button>
        <button
          type="button"
          :class="{ active: tab === 'console' }"
          @click="tab = 'console'"
        >
          控制台
        </button>
      </nav>

      <section v-if="tab === 'settings'" class="body">
        <label class="field">
          <span class="label">Base URL</span>
          <input
            v-model="form.baseUrl"
            type="text"
            placeholder="https://api.deepseek.com/v1"
            spellcheck="false"
            autocomplete="off"
          />
        </label>

        <label class="field">
          <span class="label">
            API Key
            <em class="key-state" :class="{ missing: !secretStatus.apiKey }">
              {{ secretStatus.apiKey ? '已配置' : '未配置' }}
            </em>
          </span>
          <div class="input-row">
            <input
              v-model="apiKeyDraft"
              type="password"
              :placeholder="secretStatus.apiKey ? '留空则保持当前 Key' : 'sk-...'"
              spellcheck="false"
              autocomplete="new-password"
            />
            <button
              class="mini-btn"
              type="button"
              :disabled="!secretStatus.apiKey"
              @click="onClearSecret('apiKey')"
            >
              清除
            </button>
          </div>
          <span class="field-tip">已保存的 Key 不回显；输入新 Key 后点「保存设置」。</span>
        </label>

        <label class="field">
          <span class="label">模型</span>
          <input
            v-model="form.model"
            type="text"
            placeholder="deepseek-chat"
            spellcheck="false"
            autocomplete="off"
          />
        </label>

        <label class="switch-row">
          <input v-model="form.autoSubmit" type="checkbox" />
          <span>自动交卷</span>
          <em>交卷前会二次确认</em>
        </label>

        <label class="switch-row">
          <input v-model="form.enableImages" type="checkbox" />
          <span>图片识别</span>
          <em>默认关闭</em>
        </label>

        <template v-if="form.enableImages">
          <label class="field">
            <span class="label">图片处理方式</span>
            <select v-model="form.imageMode">
              <option value="ocr">图片转文字（推荐）</option>
              <option value="direct">视觉模型直接作答</option>
            </select>
          </label>

          <div class="vision-section">
            <div class="vision-head">
              <span class="label">视觉服务（可选）</span>
              <span class="vision-summary">{{ visionSummary }}</span>
            </div>

            <label class="field">
              <span class="label">视觉 Base URL</span>
              <input
                v-model="form.visionBaseUrl"
                type="text"
                placeholder="留空使用主模型地址"
                spellcheck="false"
                autocomplete="off"
              />
            </label>

            <label class="field">
              <span class="label">
                视觉 API Key
                <em class="key-state" :class="{ missing: !secretStatus.visionApiKey }">
                  {{ secretStatus.visionApiKey ? '已配置' : '复用主 Key' }}
                </em>
              </span>
              <div class="input-row">
                <input
                  v-model="visionKeyDraft"
                  type="password"
                  :placeholder="secretStatus.visionApiKey ? '留空则保持当前 Key' : '留空使用主 Key'"
                  spellcheck="false"
                  autocomplete="new-password"
                />
                <button
                  class="mini-btn"
                  type="button"
                  :disabled="!secretStatus.visionApiKey"
                  @click="onClearSecret('visionApiKey')"
                >
                  清除
                </button>
              </div>
            </label>

            <label class="field">
              <span class="label">视觉模型</span>
              <input
                v-model="form.visionModel"
                type="text"
                placeholder="留空使用主模型"
                spellcheck="false"
                autocomplete="off"
              />
            </label>

            <div class="preset-row">
              <select v-model="visionPreset" @change="applyVisionPreset">
                <option value="custom">自定义</option>
                <option
                  v-for="(preset, key) in VISION_PRESETS"
                  :key="key"
                  :value="key"
                >
                  {{ preset.label }}
                </option>
              </select>
              <button
                class="mini-btn"
                type="button"
                :disabled="testingVision"
                @click="onTestVision"
              >
                {{ testingVision ? '识图中…' : '测试识图' }}
              </button>
            </div>
          </div>
        </template>

        <div class="actions">
          <button class="btn primary" type="button" :disabled="saving" @click="onSave">
            {{ saving ? '保存中…' : '保存设置' }}
          </button>
          <button class="btn ghost" type="button" :disabled="testing" @click="onTest">
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
        </div>

        <p v-if="notice" class="notice" :class="noticeType">{{ notice }}</p>
        <p class="tip">
          API Key 只保存在后台，面板不回显，请求也由后台发出。
          配置保存在 chrome.storage.local（明文），请勿在共用电脑上使用。
          开启图片识别后，图片会上传到视觉服务；视觉服务留空时使用主模型。
          OCR 模式会先把图片转成文字，再交给答题模型。
        </p>
      </section>

      <section v-else class="body">
        <div class="console-head">
          <span class="platform-chip" :class="{ unknown: !platformName }">
            {{ platformName || '未识别平台' }}
          </span>
          <span class="tip">自动交卷：{{ form.autoSubmit ? '开' : '关' }}</span>
        </div>

        <div class="actions">
          <button
            class="btn primary"
            type="button"
            :disabled="running || !platformName"
            @click="onStart"
          >
            {{ running ? '答题中…' : '启动答题' }}
          </button>
          <button
            v-if="running"
            class="btn ghost"
            type="button"
            @click="onStop"
          >
            停止答题
          </button>
          <button class="btn ghost" type="button" @click="clearLogs">清空日志</button>
        </div>

        <div v-if="progress.total > 0" class="status-card">
          <div class="status-row">
            <span>{{ statusText }}</span>
            <span class="status-count">{{ processed }}/{{ progress.total }}</span>
          </div>
          <div class="bar"><i :style="{ width: barWidth }" /></div>
          <div class="status-meta">
            <span>已填 {{ progress.filled }}</span>
            <span v-if="preAnswered > 0">此前已答 {{ preAnswered }}</span>
            <span>跳过 {{ progress.skipped }}</span>
            <span>失败 {{ progress.failed }}</span>
          </div>
        </div>

        <p v-if="!running" class="tip">
          识别当前页面与 iframe 中的题目，交给大模型作答后自动填涂；交卷需自行确认。
        </p>

        <ul class="logs">
          <li v-for="log in logs" :key="log.id" :class="log.level">
            <span class="time">{{ log.time }}</span>
            <span class="msg">{{ log.message }}</span>
          </li>
          <li v-if="logs.length === 0" class="empty">暂无日志</li>
        </ul>
      </section>

      <footer class="footer">v0.6.2 · 仅用于被授权的练习环境</footer>
    </template>
  </div>
</template>
