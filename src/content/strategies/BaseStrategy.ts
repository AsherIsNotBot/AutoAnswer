import type {
  Answer,
  FillResult,
  Question,
  QuestionImage,
  QuestionOption,
  QuestionType,
} from '../../types'

export interface StrategySelectors {
  /** 题目容器，按优先级依次尝试，命中即停止 */
  question: string[]
  /** 题干 */
  stem: string[]
  /** 选项容器（内部可以没有原生 input） */
  option: string[]
  /** 填空/简答输入控件 */
  blank: string[]
}

/** 分页式页面切换下一题的结果 */
export type NextQuestionResult = 'moved' | 'last' | 'failed'

const TYPE_LABELS: Record<QuestionType, string> = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
  blank: '填空',
  short: '简答',
  unknown: '未知',
}

export function questionTypeLabel(type: QuestionType): string {
  return TYPE_LABELS[type] ?? '未知'
}

function cleanText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function uniqueElements<T extends Element>(nodes: T[]): T[] {
  return [...new Set(nodes)]
}

function isVisible(element: Element): boolean {
  const html = element as HTMLElement
  if (typeof html.getClientRects !== 'function') return true
  const style = window.getComputedStyle(html)
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    html.getClientRects().length > 0
  )
}

/** 把答案统一成字符串数组：数组直接使用，字符串按分隔符拆分。 */
export function splitAnswer(answer: Answer, separators: RegExp): string[] {
  if (Array.isArray(answer.answer)) {
    return answer.answer.map((item) => String(item).trim()).filter(Boolean)
  }
  return String(answer.answer)
    .split(separators)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 选择题答案归一化为选项字母，容忍 "A."、"A、ref"、全角字母等写法。 */
export function normalizeLetters(question: Question, answer: Answer): string[] {
  const raw = splitAnswer(answer, /[,，;；、\s]+/)
  const letters = new Set<string>()

  for (const item of raw) {
    const text = item.trim()
    if (!text) continue

    // 判断题自然语言映射
    if (question.type === 'judge') {
      const judge = mapJudge(question, text)
      if (judge) {
        letters.add(judge)
        continue
      }
    }

    const direct = text.toUpperCase().match(/^[A-Z]$/)
    if (direct) {
      letters.add(direct[0])
      continue
    }

    const leading = text.toUpperCase().match(/^([A-Z])[\s.、．:：)）]/)
    if (leading) {
      letters.add(leading[1])
      continue
    }

    // 兼容 "AC" 这类未加分隔符的连续字母
    const sequence = text.toUpperCase().match(/^([A-Z]{2,})$/)
    if (sequence) {
      for (const char of sequence[1]) letters.add(char)
      continue
    }

    // 模型可能直接返回选项文本
    const matched = question.options.find(
      (option) =>
        option.text === text ||
        option.text.includes(text) ||
        text.includes(option.text),
    )
    if (matched) letters.add(matched.label)
  }

  return [...letters]
}

function mapJudge(question: Question, text: string): string | null {
  const positive = /^(对|正确|是|√|✓|true|t|yes|y)$/i.test(text)
  const negative = /^(错|错误|否|×|✗|false|f|no|n)$/i.test(text)
  if (!positive && !negative) return null

  const target = positive ? /对|正确|是|√|✓/ : /错|错误|否|×|✗/
  const option = question.options.find((item) => target.test(item.text))
  if (option) return option.label
  // 没有文字线索时按常见顺序：对=A、错=B
  return positive ? question.options[0]?.label ?? 'A' : question.options[1]?.label ?? 'B'
}

/**
 * 各平台策略基类：统一实现「容器 → 题干 → 选项 → 输入框」的解析流程与事件模拟，
 * 子类只需提供平台名称与选择器，必要时覆写 submit 等钩子。
 */
export abstract class BaseStrategy {
  abstract readonly platform: string
  protected abstract readonly selectors: StrategySelectors

  /** 是否为「一页一题」的分页式答题页（智慧树新版作业页） */
  get paged(): boolean {
    return false
  }

  /** 分页式页面的总题数，未知返回 0 */
  getPagedTotal(): number {
    return 0
  }

  /** 分页式页面：回到第一题 */
  async goToFirst(): Promise<void> {
    // 默认无分页
  }

  /** 分页式页面：切到下一题 */
  async nextQuestion(): Promise<NextQuestionResult> {
    return 'failed'
  }

  /** 交卷失败/被拦截时的提示，供 UI 记录 */
  lastNotice = ''

  /** 分页页面无法可靠定位起始题目时置为 true，由编排层停止本次答题 */
  startFailed = false

  /** 分页页面本次开始的题目下标（0 起），用于日志与跳过已答题 */
  startIndex = 0

  /** 组合题等结构可覆写：返回当前实际作答的子题容器 */
  protected getQuestionScope(container: HTMLElement): HTMLElement {
    return container
  }

  protected waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now()
      const timer = window.setInterval(() => {
        if (predicate()) {
          window.clearInterval(timer)
          resolve(true)
          return
        }
        if (Date.now() - started > timeoutMs) {
          window.clearInterval(timer)
          resolve(false)
        }
      }, 100)
    })
  }

  // ---------------------------------------------------------------- 解析

  parseQuestions(): Question[] {
    const containers = this.pickElements(document, this.selectors.question)
    return containers.map((container, index) => this.parseQuestion(container, index))
  }

  isReady(): boolean {
    return this.parseQuestions().length > 0
  }

  protected parseQuestion(container: HTMLElement, index: number): Question {
    const scope = this.getQuestionScope(container)
    const stem = this.parseStem(container)
    const number =
      stem.match(/^\s*(\d+(?:\.\d+)*)\s*[.、．)]/)?.[1] ?? String(index + 1)

    const optionNodes = this.pickElements(scope, this.selectors.option).filter(
      (node) => !this.isNestedOption(node),
    )
    const options = optionNodes.map((node, optionIndex) =>
      this.parseOption(node, optionIndex),
    )

    // 合并所有填空候选，按 DOM 顺序排列，避免只取到 textarea 而漏掉 input
    const blankElements = this.pickAllElements(scope, this.selectors.blank).filter(
      (element) => !this.isInsideOption(element, optionNodes),
    ) as Array<HTMLInputElement | HTMLTextAreaElement>

    const type = this.detectType(stem, options, blankElements)
    const images = this.parseImages(container, options)

    return {
      id: String(index),
      number,
      type,
      stem,
      options,
      blanks: blankElements.length,
      images,
      element: container,
      blankElements,
    }
  }

  protected parseStem(container: HTMLElement): string {
    for (const selector of this.selectors.stem) {
      const node = container.querySelector<HTMLElement>(selector)
      const text = cleanText(node?.textContent)
      if (text) return text
    }

    // 兜底：复制容器后剔除选项，取剩余文本
    const clone = container.cloneNode(true) as HTMLElement
    const optionSelector = this.selectors.option.join(',')
    if (optionSelector) {
      clone.querySelectorAll(optionSelector).forEach((node) => node.remove())
    }
    clone.querySelectorAll('input, textarea, button').forEach((node) => node.remove())
    return cleanText(clone.textContent).slice(0, 500)
  }

  protected parseOption(node: HTMLElement, index: number): QuestionOption {
    const input =
      node instanceof HTMLInputElement && /^(radio|checkbox)$/.test(node.type)
        ? node
        : node.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')

    const raw = cleanText(node.textContent)
    const leading = raw.match(/^([A-Za-z])[\s.、．:：)）]/)
    const labelFromInput =
      input?.value && /^[A-Za-z]$/.test(input.value) ? input.value.toUpperCase() : ''
    const label =
      labelFromInput || leading?.[1]?.toUpperCase() || String.fromCharCode(65 + index)

    const text =
      raw.replace(/^[A-Za-z][\s.、．:：)）]*/, '').trim() ||
      (input ? `选项 ${label}` : raw)

    const clickable =
      input?.closest('label') ??
      (node instanceof HTMLLabelElement ? node : node.querySelector('label')) ??
      node

    return { label, text, element: clickable as HTMLElement, input: input ?? undefined }
  }

  protected parseImages(
    container: HTMLElement,
    options: QuestionOption[],
  ): QuestionImage[] {
    const images: QuestionImage[] = []
    const seen = new Set<string>()

    for (const node of container.querySelectorAll<HTMLImageElement>('img')) {
      if (this.isDecorativeImage(node)) continue

      const src = this.imageSource(node)
      if (!src || seen.has(src)) continue

      const option = options.find(
        (item) =>
          item.element?.contains(node) ||
          item.input?.closest('label')?.contains(node),
      )

      seen.add(src)
      images.push({
        src,
        kind: option ? 'option' : 'stem',
        optionLabel: option?.label,
        alt: node.alt || undefined,
        element: node,
      })
    }

    return images
  }

  private imageSource(node: HTMLImageElement): string {
    const candidates = [
      node.currentSrc,
      node.src,
      node.dataset.src,
      node.dataset.original,
      node.getAttribute('data-lazy-src'),
      node.getAttribute('data-actualsrc'),
    ]

    return (
      candidates.find(
        (src) => src && !this.isPlaceholderImage(src),
      ) ?? ''
    )
  }

  private isPlaceholderImage(src: string): boolean {
    return (
      /^data:image\/gif;base64,R0lGOD/i.test(src) ||
      /(blank|placeholder|loading)\.(gif|png|svg)/i.test(src)
    )
  }

  private isDecorativeImage(node: HTMLImageElement): boolean {
    const src = this.imageSource(node)
    if (!src) return true
    if (/^data:image\/svg\+xml/i.test(src) && src.length < 1500) return true

    const rect = node.getBoundingClientRect()
    const width = node.naturalWidth || node.width || Math.round(rect.width)
    const height = node.naturalHeight || node.height || Math.round(rect.height)

    if (width > 0 && height > 0) {
      if (width <= 2 || height <= 2) return true
      if (width * height < 1500) return true
      if (width < 20 || height < 12) return true
    }

    const hint = `${node.className} ${node.alt} ${src}`.toLowerCase()
    return /(^|[^a-z])(icon|logo|avatar|emoji|sprite)([^a-z]|$)/.test(hint)
  }

  protected detectType(
    stem: string,
    options: QuestionOption[],
    blanks: HTMLElement[],
  ): QuestionType {
    if (options.some((option) => option.input?.type === 'checkbox')) return 'multiple'
    if (options.some((option) => option.input?.type === 'radio')) {
      const judgeHint =
        stem.includes('判断') ||
        (options.length === 2 &&
          options.every((option) => /^(对|错|正确|错误|是|否|√|×)/.test(option.text)))
      return judgeHint ? 'judge' : 'single'
    }
    if (blanks.length > 0) {
      return /简答|论述|问答|名词解释|简述/.test(stem) ? 'short' : 'blank'
    }
    if (options.length > 0) return 'single'
    return 'unknown'
  }

  // ---------------------------------------------------------------- 填涂

  fillAnswer(question: Question, answer: Answer): FillResult {
    try {
      if (question.type === 'blank' || question.type === 'short') {
        return this.fillBlanks(question, answer)
      }

      const letters = normalizeLetters(question, answer)
      if (letters.length === 0) {
        return { id: question.id, status: 'failed', message: '无法从答案中解析出选项' }
      }

      let clicked = 0
      for (const letter of letters) {
        const option = question.options.find(
          (item) => item.label === letter || item.label.toUpperCase() === letter,
        )
        if (!option) continue
        this.clickOption(option)
        clicked += 1
      }

      if (clicked === 0) {
        return {
          id: question.id,
          status: 'failed',
          message: `未找到选项 ${letters.join(',')}`,
        }
      }
      return { id: question.id, status: 'filled', message: letters.join(',') }
    } catch (error) {
      return {
        id: question.id,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  protected fillBlanks(question: Question, answer: Answer): FillResult {
    const values = splitAnswer(answer, /\s*[|｜]\s*|\n/)
    const inputs = question.blankElements ?? []

    if (inputs.length === 0) {
      // 有些平台用 contenteditable 代替输入框
      const editable = question.element?.querySelector<HTMLElement>('[contenteditable="true"]')
      if (editable) {
        editable.textContent = values.join('\n')
        editable.dispatchEvent(new Event('input', { bubbles: true }))
        return { id: question.id, status: 'filled', message: 'contenteditable' }
      }
      return { id: question.id, status: 'failed', message: '未找到填空输入框' }
    }

    // 只有一个输入框时，模型可能仍用 | 分段；应写入完整答案而不是只取第一段
    if (inputs.length === 1) {
      this.setNativeValue(inputs[0], values.join('\n'))
      return {
        id: question.id,
        status: 'filled',
        message: `1 空 · ${values.length} 段`,
      }
    }

    const filledCount = Math.min(inputs.length, values.length)
    inputs.forEach((input, index) => {
      this.setNativeValue(input, values[index] ?? '')
    })

    if (values.length < inputs.length) {
      return {
        id: question.id,
        status: 'failed',
        message: `仅填写 ${filledCount}/${inputs.length} 空`,
      }
    }

    return {
      id: question.id,
      status: 'filled',
      message: `${inputs.length} 空 · ${values.join(' | ')}`,
    }
  }

  protected clickOption(option: QuestionOption): void {
    const input = option.input
    const target = option.element ?? input

    if (input && (input.type === 'radio' || input.type === 'checkbox')) {
      if (!input.checked) {
        this.dispatchMouseSequence(input)
        input.click()
      }
      if (!input.checked) {
        target?.click()
      }
      if (!input.checked) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'checked',
        )?.set
        setter?.call(input, true)
      }
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }

    if (target) {
      this.dispatchMouseSequence(target)
      target.click()
    }
  }

  protected dispatchMouseSequence(element: HTMLElement): void {
    const options: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
    }
    element.dispatchEvent(new MouseEvent('mousedown', options))
    element.dispatchEvent(new MouseEvent('mouseup', options))
  }

  protected setNativeValue(
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ): void {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(element, value)
    else element.value = value

    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    element.dispatchEvent(new Event('blur', { bubbles: true }))
  }

  // ---------------------------------------------------------------- 交卷

  submit(): boolean | Promise<boolean> {
    const button = this.findSubmitButton()
    if (!button) return false
    button.click()
    return true
  }

  protected findSubmitButton(): HTMLElement | null {
    const selectors = [
      '#submitBtn',
      '.completeBtn',
      '.submitBtn',
      '.submit-btn',
      'button',
      'a',
      'input[type="submit"]',
    ]
    const nodes = uniqueElements(
      selectors.flatMap((selector) => [
        ...document.querySelectorAll<HTMLElement>(selector),
      ]),
    )

    return (
      nodes.find((node) => {
        const text = cleanText(node.textContent || node.getAttribute('value'))
        return (
          isVisible(node) &&
          /^(交卷|提交试卷|提交答案|提交|submit)$/i.test(text)
        )
      }) ?? null
    )
  }

  // ---------------------------------------------------------------- 工具

  protected pickElements(scope: ParentNode, selectors: string[]): HTMLElement[] {
    for (const selector of selectors) {
      const nodes = [...scope.querySelectorAll<HTMLElement>(selector)]
      if (nodes.length > 0) return uniqueElements(nodes)
    }
    return []
  }

  protected pickAllElements(scope: ParentNode, selectors: string[]): HTMLElement[] {
    const combined = selectors.filter(Boolean).join(',')
    if (!combined) return []
    return [...scope.querySelectorAll<HTMLElement>(combined)]
  }

  protected isNestedOption(node: HTMLElement): boolean {
    const optionSelector = this.selectors.option.join(',')
    if (!optionSelector) return false
    const parent = node.parentElement?.closest(optionSelector)
    return Boolean(parent && parent !== node)
  }

  protected isInsideOption(node: HTMLElement, optionNodes: HTMLElement[]): boolean {
    return optionNodes.some((option) => option.contains(node))
  }
}
