<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { Answer, FillResult, Question, Settings } from '../types'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../utils/storage'
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

const form = reactive<Settings>({ ...DEFAULT_SETTINGS })
const saving = ref(false)
const testing = ref(false)
const testingVision = ref(false)
const showKey = ref(false)
const running = ref(false)
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
const processed = computed(() => progress.filled + progress.skipped + progress.failed)
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

const visionSummary = computed(() => {
  if (!form.enableImages) return ''
  const hasCustom = Boolean(
    form.visionBaseUrl.trim() || form.visionApiKey.trim() || form.visionModel.trim(),
  )
  if (!hasCustom) {
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
    const hasVisionConfig = Boolean(
      form.visionBaseUrl.trim() || form.visionApiKey.trim() || form.visionModel.trim(),
    )
    const hint = hasVisionConfig
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

  const hasVisionConfig = Boolean(
    form.visionBaseUrl.trim() || form.visionApiKey.trim() || form.visionModel.trim(),
  )

  try {
    const result = await transcribeQuestionImages(question, {
      onWarning: (message) => addLog('warn', `${label}${message}`),
    })

    if (result.total > 0 && result.transcribed === 0) {
      addLog(
        'warn',
        `${label}图片文字识别失败${hasVisionConfig ? '' : '；当前使用主模型识图，请确认其支持视觉或配置视觉服务'}`,
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

async function load(): Promise<void> {
  try {
    Object.assign(form, await getSettings())
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

async function persist(): Promise<boolean> {
  if (!form.baseUrl.trim()) {
    setNotice('Base URL 不能为空', 'error')
    return false
  }
  if (!form.apiKey.trim()) {
    setNotice('API Key 不能为空', 'error')
    return false
  }
  if (!form.model.trim()) {
    setNotice('模型名称不能为空', 'error')
    return false
  }

  saving.value = true
  try {
    Object.assign(form, await saveSettings({ ...form }))
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

  await strategy.goToFirst()
  await delay(300)

  const maxPages = 200
  let page = 0
  let aborted = false

  for (; page < maxPages; page += 1) {
    let questions = strategy.parseQuestions()
    if (questions.length === 0) {
      await delay(400)
      questions = strategy.parseQuestions()
    }

    if (questions.length === 0) {
      progress.skipped += 1
      addLog('warn', `第 ${page + 1} 页未解析到题目，尝试切到下一题`)
    } else {
      const question = questions[0]
      const task: RoutedQuestion = {
        id: question.id,
        localId: question.id,
        frame: null,
        question,
        platform: strategy.platform,
      }

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

    const nav = await strategy.nextQuestion()
    if (nav === 'failed') {
      aborted = true
      addLog('error', '切换下一题失败，已停止（未交卷），请检查页面是否加载完成')
      break
    }
    if (nav === 'last') break
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
    progress.total > 0 &&
    progress.filled === progress.total &&
    progress.skipped === 0 &&
    progress.failed === 0

  if (!complete) {
    addLog(
      'warn',
      `答题未完成：已填 ${progress.filled}/${progress.total || '?'} · 跳过 ${progress.skipped} · 失败 ${progress.failed}，已跳过自动交卷`,
    )
    return
  }

  addLog(
    'ok',
    `答题完成：已填 ${progress.filled} · 跳过 ${progress.skipped} · 失败 ${progress.failed}`,
  )

  if (!form.autoSubmit) return

  const confirmed = window.confirm(
    `已填写 ${progress.filled}/${progress.total} 道题，确定现在交卷吗？`,
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

  running.value = true
  tab.value = 'console'
  platformName.value = strategy.platform
  progress.total = 0
  progress.filled = 0
  progress.skipped = 0
  progress.failed = 0
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

    // 当前页面直接填涂
    for (const { task, answer } of topFills) {
      applyFillResult(task, strategy.fillAnswer(task.question, answer))
    }

    // 逐个 iframe 批量填涂
    for (const [frame, items] of frameFills) {
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

    await finishRun(strategy, [...frameFills.keys()], false, ownQuestions.length > 0)
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
          <span class="label">API Key</span>
          <div class="input-row">
            <input
              v-model="form.apiKey"
              :type="showKey ? 'text' : 'password'"
              placeholder="sk-..."
              spellcheck="false"
              autocomplete="off"
            />
            <button class="mini-btn" type="button" @click="showKey = !showKey">
              {{ showKey ? '隐藏' : '显示' }}
            </button>
          </div>
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
              <span class="label">视觉 API Key</span>
              <input
                v-model="form.visionApiKey"
                type="password"
                placeholder="留空使用主 Key"
                spellcheck="false"
                autocomplete="off"
              />
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

      <footer class="footer">v0.6.0 · 仅用于被授权的练习环境</footer>
    </template>
  </div>
</template>
