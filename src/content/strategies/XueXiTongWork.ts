import type {
  Answer,
  FillResult,
  Question,
  QuestionOption,
  QuestionType,
} from '../../types'
import {
  BaseStrategy,
  splitAnswer,
  type StrategySelectors,
} from './BaseStrategy'

interface UEditorLike {
  setContent?: (html: string) => void
  sync?: () => void
  fireEvent?: (name: string) => void
}

interface UEditorWindow extends Window {
  UE?: {
    getEditor?: (id: string) => UEditorLike | null | undefined
  }
}

/**
 * 学习通「作业/考试」页（/mooc-ans/api/work、doHomeWorkNew）策略。
 *
 * 页面结构：
 *   .singleQuesId
 *     .TiMu
 *       .Zy_TItle .fontLabel  → 【单选题】题干
 *       .Zy_ulTop li.before-after → 选项（点击 li 触发 addChoice）
 *         .num_option           → 选项字母 A/B
 *         a.after               → 选项正文
 *       .blankItemDiv           → 填空，内部是 UEditor iframe
 *       .btnSubmit              → 提交
 */
export class XueXiTongWorkStrategy extends BaseStrategy {
  readonly platform = '学习通'

  protected readonly selectors: StrategySelectors = {
    question: ['.singleQuesId .TiMu', '.TiMu'],
    stem: ['.Zy_TItle .fontLabel', '.Zy_TItle', '.mark_name'],
    option: ['.Zy_ulTop li.before-after', '.Zy_ulTop li', 'li[onclick*="addChoice"]'],
    blank: ['textarea[id^="answerEditor"]'],
  }

  protected override parseOption(node: HTMLElement, index: number): QuestionOption {
    const letterEl = node.querySelector<HTMLElement>('.num_option')
    const letterText = (letterEl?.textContent ?? '').trim().toUpperCase()
    const dataText = (letterEl?.getAttribute('data') ?? '').trim().toUpperCase()

    const label = /^[A-Z]$/.test(letterText)
      ? letterText
      : /^[A-Z]$/.test(dataText)
        ? dataText
        : String.fromCharCode(65 + index)

    const text =
      (node.querySelector('a.after')?.textContent ?? node.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()

    // 真正的点击逻辑在 li 的 addChoice(this) 上
    return { label, text, element: node }
  }

  protected override detectType(
    stem: string,
    options: QuestionOption[],
    blanks: HTMLElement[],
  ): QuestionType {
    if (/【多选|多选题/.test(stem)) return 'multiple'
    if (/【判断|判断题/.test(stem)) return 'judge'
    if (/【填空|填空题/.test(stem)) return 'blank'
    if (/【简答|简答题|【问答|【论述/.test(stem)) return 'short'
    if (/【单选|单选题/.test(stem)) return 'single'
    return super.detectType(stem, options, blanks)
  }

  protected override fillBlanks(question: Question, answer: Answer): FillResult {
    const values = splitAnswer(answer, /\s*[|｜]\s*|\n/)
    const textareas = (question.blankElements ?? []).filter(
      (element): element is HTMLTextAreaElement =>
        element instanceof HTMLTextAreaElement,
    )

    if (textareas.length > 0) {
      textareas.forEach((textarea, index) => {
        const value =
          textareas.length === 1 ? values.join('\n') : (values[index] ?? '')
        this.writeUEditor(textarea, value, question.element)
      })
      return {
        id: question.id,
        status: 'filled',
        message: `${textareas.length} 空`,
      }
    }

    // 有些页面只留下 UEditor iframe，没有可用的隐藏 textarea
    const containers = [
      ...(question.element?.querySelectorAll<HTMLElement>('.blankItemDiv, .textDIV') ?? []),
    ]
    const iframes = containers
      .map((container) => container.querySelector<HTMLIFrameElement>('iframe'))
      .filter((iframe): iframe is HTMLIFrameElement => iframe !== null)

    if (iframes.length > 0) {
      iframes.forEach((iframe, index) => {
        const value = iframes.length === 1 ? values.join('\n') : (values[index] ?? '')
        this.writeEditorFrame(iframe, value)
      })
      return {
        id: question.id,
        status: 'filled',
        message: `${iframes.length} 空（iframe）`,
      }
    }

    return { id: question.id, status: 'failed', message: '未找到 UEditor 填空输入框' }
  }

  private writeUEditor(
    textarea: HTMLTextAreaElement,
    value: string,
    container?: HTMLElement,
  ): void {
    // UEditor 实例在主世界，隔离世界通过事件桥接写入
    this.requestMainWorldUEditor(textarea.id, value)

    const editor = (window as UEditorWindow).UE?.getEditor?.(textarea.id)
    const html = this.escapeHtml(value).replace(/\n/g, '<br>')

    if (editor?.setContent) {
      try {
        editor.setContent(html)
        editor.sync?.()
        editor.fireEvent?.('contentChange')
        return
      } catch {
        // 回退到原生赋值 / iframe
      }
    }

    this.setNativeValue(textarea, value)

    const scope = textarea.closest('.blankItemDiv, .textDIV, .TiMu') ?? container
    const iframe = scope?.querySelector<HTMLIFrameElement>('iframe')
    if (iframe) this.writeEditorFrame(iframe, value)
  }

  private requestMainWorldUEditor(id: string, value: string): void {
    if (!id) return

    const holder = document.createElement('div')
    holder.id = 'aa-ueditor-payload'
    holder.style.display = 'none'
    holder.textContent = JSON.stringify({ id, value })
    document.documentElement.appendChild(holder)
    document.dispatchEvent(new Event('aa:set-ueditor'))
    holder.remove()
  }

  private writeEditorFrame(iframe: HTMLIFrameElement, value: string): boolean {
    const documentRef = iframe.contentDocument
    if (!documentRef?.body) return false

    documentRef.body.innerHTML = this.escapeHtml(value).replace(/\n/g, '<br>')
    documentRef.body.dispatchEvent(new Event('input', { bubbles: true }))
    documentRef.body.dispatchEvent(new Event('keyup', { bubbles: true }))
    documentRef.body.dispatchEvent(new Event('blur', { bubbles: true }))
    return true
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  override submit(): boolean | Promise<boolean> {
    const button = document.querySelector<HTMLElement>('.ZY_sub .btnSubmit, .btnSubmit')
    if (!button) return super.submit()

    button.click()

    // 提交前页面会先做 validate 请求，再弹 #confirmSubWin（「确认提交？」）。
    // 只确认普通提交；出现「还有 N 题未作答」这类平台警告时绝不代点确定。
    return this.confirmSubmitDialog()
  }

  /** 轮询等待确认弹窗（提交前的 validate 请求可能耗时），带安全拦截。 */
  private confirmSubmitDialog(): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = (): void => {
        if (Date.now() - started > 6000) {
          // 没有确认弹窗，说明页面直接提交了
          resolve(true)
          return
        }

        const dialog = document.querySelector<HTMLElement>('#confirmSubWin')
        if (!dialog || !this.isVisible(dialog)) {
          window.setTimeout(tick, 300)
          return
        }

        const text = (dialog.textContent ?? '').replace(/\s+/g, '')
        // 平台提示未作答 / 未完成时，只记录不点击，交由用户处理
        if (/未作答|未完成|还有\d+题|漏做/.test(text)) {
          this.lastNotice = `平台提示存在未完成题目，已停止自动交卷：${text.slice(0, 80)}`
          resolve(false)
          return
        }

        const ok = [...dialog.querySelectorAll<HTMLElement>('a, button')].find(
          (element) => element.textContent?.trim() === '确定',
        )
        ok?.click()
        resolve(true)
      }

      window.setTimeout(tick, 300)
    })
  }

  private isVisible(element: HTMLElement): boolean {
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
}
