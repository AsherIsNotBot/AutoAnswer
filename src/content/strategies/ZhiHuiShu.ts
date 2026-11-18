import type { QuestionType, QuestionOption } from '../../types'
import {
  BaseStrategy,
  type NextQuestionResult,
  type StrategySelectors,
} from './BaseStrategy'

/**
 * 智慧树解析策略。
 *
 * 新版作业/考试页（hiexam.zhihuishu.com）是「一页一题」：
 *   - 题目：.questionBox
 *   - 标题：.questionTit（1.【组合题】 / 1.2.【问答题】）
 *   - 题干：.questionContent
 *   - 选项：Element UI 的 label.el-radio / label.el-checkbox
 *   - 填空/问答：textarea.ShortAnswer-textarea / input
 *   - 翻页：.Nextbtndiv .Topicswitchingbtn（禁用时加 Topicswitchingbtn-gray）
 *   - 答题卡：.Answercard-div ... li（当前项 greenbordercur，已答项 greenbgcur）
 *   - 交卷：.Submithomeworkbtn → 可见 el-dialog 内的 .Submissionbtn
 *
 * 组合题会在同一个 .questionBox 里保留父题干，只替换当前子题：
 *   .questionBox
 *     ├─ .parentBox（1.【组合题】 + 背景 + 图片）
 *     └─ div（1.2.【问答题】 + 小问 + textarea）
 * 因此题号/题型/填空必须取最后一个 .questionTit 所在的子题块，而不是第一个。
 */
export class ZhiHuiShuStrategy extends BaseStrategy {
  readonly platform = '智慧树'

  protected readonly selectors: StrategySelectors = {
    question: ['.questionBox', '.ques_item', '.subject_node', '.examPaper_subject .subject'],
    stem: ['.questionTit', '.ques_title', '.subject_title', '.question-title', '.mark_name'],
    option: [
      '.el-radio',
      '.el-checkbox',
      '.option-item',
      '.optionItem',
      '.option_item',
      '.option_item_box',
      'label.option_item',
      '.optionLi',
      '.answer-item',
      '.num_option',
      '.answerBg',
    ],
    blank: [
      'textarea.ShortAnswer-textarea',
      'textarea',
      'input[type="text"]',
      'input:not([type])',
    ],
  }

  private submitAborted = false

  override get paged(): boolean {
    return (
      !!document.querySelector('.questionBox') &&
      !!document.querySelector('.Topicswitching-div')
    )
  }

  override getPagedTotal(): number {
    return document.querySelectorAll(
      '.Answercard-div .jobclassallnumber-div li',
    ).length
  }

  /** 组合题：返回当前子题（最后一个 .questionTit）所在的容器 */
  protected override getQuestionScope(container: HTMLElement): HTMLElement {
    return this.activeQuestionBlock(container)
  }

  /**
   * 从当前子题标题向上找，返回同时包含题干/输入控件的最小容器。
   * 组合题的父题干在子题块之外；普通题的标题可能在 header 里，需要向上合并。
   */
  private activeQuestionBlock(container: HTMLElement): HTMLElement {
    const titles = [...container.querySelectorAll<HTMLElement>('.questionTit')]
    const activeTitle = titles.at(-1)
    if (!activeTitle) return container

    let node = activeTitle.parentElement
    while (node && node !== container) {
      if (
        node.querySelector('.questionContent') ||
        node.querySelector('textarea, input[type="text"], input:not([type])')
      ) {
        return node
      }
      node = node.parentElement
    }
    return container
  }

  protected override parseStem(container: HTMLElement): string {
    const titles = [...container.querySelectorAll<HTMLElement>('.questionTit')]
    const activeTitle = titles.at(-1)
    const activeBlock = this.activeQuestionBlock(container)

    const activeContent =
      activeBlock.querySelector<HTMLElement>('.questionContent') ??
      container.querySelector<HTMLElement>('.questionContent')

    // 组合题的父题干：不在当前子题块内的 .questionContent
    const parentContent = [...container.querySelectorAll<HTMLElement>('.questionContent')].find(
      (element) => !activeBlock.contains(element),
    )

    const titleText = this.normalize(activeTitle?.textContent) || this.normalize(titles[0]?.textContent)
    const parentText = this.normalize(parentContent?.textContent)
    const activeText = this.normalize(activeContent?.textContent)

    if (titleText || parentText || activeText) {
      return [
        titleText,
        parentText ? `组合题背景：${parentText}` : '',
        activeText,
      ]
        .filter(Boolean)
        .join(' ')
    }

    return super.parseStem(container)
  }

  protected override detectType(
    stem: string,
    options: QuestionOption[],
    blanks: HTMLElement[],
  ): QuestionType {
    if (/【多选|多选题/.test(stem)) return 'multiple'
    if (/【判断|判断题/.test(stem)) return 'judge'
    if (/【填空|填空题/.test(stem)) return 'blank'
    if (/【问答|问答题|简答|论述/.test(stem)) return 'short'
    return super.detectType(stem, options, blanks)
  }

  private normalize(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim()
  }

  private answerCardItems(): HTMLElement[] {
    return [
      ...document.querySelectorAll<HTMLElement>(
        '.Answercard-div .jobclassallnumber-div li',
      ),
    ]
  }

  private activeIndex(): number {
    const items = this.answerCardItems()
    const byClass = items.findIndex(
      (item) =>
        item.classList.contains('greenbordercur') ||
        item.classList.contains('greenborder'),
    )
    if (byClass >= 0) return byClass

    // 兜底：部分页面切换后只更新题号文字，不保留当前项高亮 class
    const title = this.questionTitle()
    const number = title.match(/^\s*(\d+)/)?.[1]
    if (!number) return -1
    return items.findIndex((item) => this.normalize(item.textContent) === number)
  }

  private questionTitle(): string {
    const titles = [...document.querySelectorAll<HTMLElement>('.questionBox .questionTit')]
    return this.normalize(titles.at(-1)?.textContent)
  }

  /** 导航后等待题干真正换掉，并留出选项渲染时间，避免在加载中间填涂 */
  private async waitForQuestionSettled(
    previousTitle: string,
    timeoutMs = 6000,
  ): Promise<boolean> {
    const changed = await this.waitFor(
      () => this.questionTitle() !== previousTitle,
      timeoutMs,
    )
    if (!changed) return false
    await new Promise((resolve) => window.setTimeout(resolve, 300))
    return true
  }

  /** 签名必须包含当前子题，否则组合题 1.1 → 1.2 会被误判为“没变化” */
  private currentSignature(): string {
    const card = this.answerCardItems()[this.activeIndex()]
    const cardText = this.normalize(card?.textContent)
    const titles = [...document.querySelectorAll<HTMLElement>('.questionBox .questionTit')]
      .map((element) => this.normalize(element.textContent))
      .join(' || ')
    const lastContent = [...document.querySelectorAll<HTMLElement>('.questionBox .questionContent')]
      .at(-1)
      ?.textContent
    return `${cardText}::${titles}::${this.normalize(lastContent).slice(0, 60)}`
  }

  private enabledSwitcher(text: string): HTMLElement | null {
    const buttons = [
      ...document.querySelectorAll<HTMLElement>('.Nextbtndiv .Topicswitchingbtn'),
    ]
    return (
      buttons.find(
        (button) =>
          button.textContent?.includes(text) &&
          !button.classList.contains('Topicswitchingbtn-gray'),
      ) ?? null
    )
  }

  /** 已答题会在答题卡上带 greenbgcur；优先从第一道未答题开始，避免覆盖已有答案 */
  private firstTargetIndex(): number {
    const items = this.answerCardItems()
    const firstUnanswered = items.findIndex(
      (item) => !item.classList.contains('greenbgcur'),
    )
    return firstUnanswered >= 0 ? firstUnanswered : 0
  }

  override async goToFirst(): Promise<void> {
    this.startFailed = false
    this.lastNotice = ''

    const items = this.answerCardItems()
    const target = this.firstTargetIndex()
    this.startIndex = target
    if (items.length === 0 || this.activeIndex() === target) return

    const targetItem = items[target]
    if (!targetItem) return

    // 优先点答题卡目标项；只等题干真正切换，不能只等 class 变化
    const beforeTitle = this.questionTitle()
    const before = this.currentSignature()
    const current = this.activeIndex()
    targetItem.click()
    const moved = await this.waitFor(
      () =>
        this.questionTitle() !== beforeTitle ||
        this.activeIndex() === target ||
        this.currentSignature() !== before,
      4000,
    )
    if (moved) {
      const settled = await this.waitForQuestionSettled(beforeTitle, 5000)
      if (!settled) {
        this.startFailed = true
        this.lastNotice = '起始题目加载超时，已停止本次答题（未交卷），请等待页面加载完成后重试'
      }
      return
    }

    const blocked = this.visibleDialog()
    if (blocked) {
      const text = this.dialogText(blocked)
      this.lastNotice = `切换题目时出现平台弹窗，已停止本次答题：${text.slice(0, 80)}`
      this.closeDialog(blocked)
      this.startFailed = true
      return
    }

    // 只有目标在当前题之前时，才允许用「上一题」少量回退
    if (target < current) {
      const maxClicks = Math.min(current - target, 30)
      for (let i = 0; i < maxClicks; i += 1) {
        if (this.activeIndex() === target) return

        const prev = this.enabledSwitcher('上一题')
        if (!prev) break

        const title = this.questionTitle()
        prev.click()
        const changed = await this.waitFor(() => this.questionTitle() !== title, 800)
        if (!changed) break
        await this.waitForQuestionSettled(title, 3000)
      }
    }

    if (this.activeIndex() !== target) {
      this.startFailed = true
      this.lastNotice = `无法可靠定位到第 ${target + 1} 题，已停止本次答题（未交卷）。请手动点击答题卡后重试。`
    }
  }

  override async nextQuestion(): Promise<NextQuestionResult> {
    this.lastNotice = ''

    const items = this.answerCardItems()
    const index = this.activeIndex()

    // 已经是最后一项：绝不点击“下一题”，避免触发平台在末页的提交行为
    if (items.length > 0 && index === items.length - 1) return 'last'

    const next = this.enabledSwitcher('下一题')
    if (!next) {
      return items.length === 0 ? 'last' : 'failed'
    }

    const beforeTitle = this.questionTitle()
    const beforeIndex = index
    next.click()

    // 等待题干切换；同时留意平台弹窗（例如未保存/未作答提示）
    const changed = await this.waitFor(
      () =>
        this.questionTitle() !== beforeTitle ||
        this.activeIndex() !== beforeIndex ||
        !!this.visibleDialog(),
      5000,
    )

    const dialog = this.visibleDialog()
    if (dialog) {
      const text = this.dialogText(dialog)
      this.lastNotice = this.isIncompleteWarning(text)
        ? `平台提示存在未完成题目，已停止自动答题：${text.slice(0, 80)}`
        : `切换下一题时出现平台弹窗，已停止自动答题：${text.slice(0, 80)}`
      this.closeDialog(dialog)
      return 'failed'
    }

    if (!changed) {
      this.lastNotice = '点击「下一题」后页面没有切换到新题目，已停止（未交卷）'
      return 'failed'
    }

    // 题干已切换，再等选项/输入框渲染完成，避免在加载中间填涂
    const settled = await this.waitForQuestionSettled(beforeTitle, 5000)
    if (!settled) {
      this.lastNotice = '下一题加载超时，已停止（未交卷），请等待页面加载完成后重试'
      return 'failed'
    }
    return 'moved'
  }

  /** 只关闭提示类弹窗，绝不点「提交 / 确定」 */
  private closeDialog(dialog: HTMLElement): void {
    const buttons = [...dialog.querySelectorAll<HTMLElement>('button, a')]
    const safe = buttons.find((button) =>
      /取消|我知道了|关闭|返回/.test(button.textContent ?? ''),
    )
    if (safe) {
      safe.click()
      return
    }
    dialog.querySelector<HTMLElement>('.el-dialog__headerbtn')?.click()
  }

  private visibleDialog(): HTMLElement | null {
    const dialogs = [...document.querySelectorAll<HTMLElement>('.el-dialog__wrapper')]
    return (
      dialogs.find((dialog) => {
        if (dialog.classList.contains('yulan-dialog')) return false
        const style = window.getComputedStyle(dialog)
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          dialog.getClientRects().length > 0
        )
      }) ?? null
    )
  }

  private dialogText(dialog: HTMLElement | null): string {
    return this.normalize(dialog?.innerText || dialog?.textContent || '')
  }

  private isIncompleteWarning(text: string): boolean {
    return /未作答|未完成|尚未完成|还有\s*\d*\s*题|剩余\s*\d*\s*题/.test(text)
  }

  private clickDialogSubmit(): boolean {
    const dialog = this.visibleDialog()
    if (!dialog) return false

    const text = this.dialogText(dialog)
    if (this.isIncompleteWarning(text)) {
      this.lastNotice = `平台提示存在未完成题目，已停止自动提交：${text.slice(0, 80)}`
      this.submitAborted = true
      return false
    }

    const submit = dialog.querySelector<HTMLElement>('.Submissionbtn')
    if (!submit) return false
    submit.click()
    return true
  }

  override submit(): boolean {
    this.lastNotice = ''
    this.submitAborted = false

    if (this.clickDialogSubmit()) return true

    const trigger = document.querySelector<HTMLElement>('.Submithomeworkbtn')
    if (!trigger) return Boolean(super.submit())

    trigger.click()

    // 可能先弹「迟交提醒」或「还有题目未作答」，轮询处理并识别警告
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1

      if (this.submitAborted) {
        window.clearInterval(timer)
        return
      }

      if (this.clickDialogSubmit()) {
        window.clearInterval(timer)
        return
      }

      const dialog = this.visibleDialog()
      if (dialog && this.isIncompleteWarning(this.dialogText(dialog))) {
        this.lastNotice = `平台提示存在未完成题目，已停止自动提交：${this.dialogText(dialog).slice(0, 80)}`
        this.submitAborted = true
        window.clearInterval(timer)
        return
      }

      const ack = [...(dialog?.querySelectorAll<HTMLElement>('button') ?? [])].find(
        (button) => button.textContent?.includes('我知道了'),
      )
      ack?.click()

      if (attempts > 15) window.clearInterval(timer)
    }, 400)

    return true
  }
}
