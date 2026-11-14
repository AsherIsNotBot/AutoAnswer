/**
 * MAIN world content script.
 * UEditor 实例（window.UE）只存在于页面主世界，隔离世界无法直接访问。
 * 隔离世界通过 DOM 事件 + 隐藏节点把 {id, value} 传进来，这里调用 UEditor API。
 */
interface UEditorLike {
  setContent?: (html: string) => void
  sync?: () => void
  fireEvent?: (name: string) => void
}

interface UEditorWindow extends Window {
  UE?: {
    getEditor?: (id: string) => UEditorLike | null | undefined
  }
  __aaUeditorBridge?: boolean
}

const SET_EVENT = 'aa:set-ueditor'
const PAYLOAD_ID = 'aa-ueditor-payload'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>')
}

const ueWindow = window as UEditorWindow

if (!ueWindow.__aaUeditorBridge) {
  ueWindow.__aaUeditorBridge = true

  document.addEventListener(SET_EVENT, () => {
    const holder = document.getElementById(PAYLOAD_ID)
    if (!holder?.textContent) return

    let payload: { id?: string; value?: string }
    try {
      payload = JSON.parse(holder.textContent) as { id?: string; value?: string }
    } catch {
      return
    }

    if (!payload.id) return

    const editor = ueWindow.UE?.getEditor?.(payload.id)
    if (!editor?.setContent) return

    try {
      editor.setContent(escapeHtml(String(payload.value ?? '')))
      editor.sync?.()
      editor.fireEvent?.('contentChange')
    } catch {
      // 页面可能尚未初始化完成，隔离世界仍有 DOM 兜底
    }
  })
}
