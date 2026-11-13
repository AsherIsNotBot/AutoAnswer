import { createApp } from 'vue'
import App from './App.vue'
import styles from './style.css?inline'
import { startFrameAgent } from './bridge'

const HOST_ID = 'auto-answer-ai-root'

// 每个 frame 都启动消息代理：顶层负责 UI 与编排，iframe 负责本地解析/填涂
type AgentWindow = Window & { __aaAgentCleanup?: () => void }
const agentWindow = window as AgentWindow
agentWindow.__aaAgentCleanup?.()
agentWindow.__aaAgentCleanup = startFrameAgent()

function mount(): void {
  // 学习通等平台题目常嵌在 iframe 中：只在顶层页面渲染面板，避免重复
  if (window.top !== window.self) return

  // 兼容开发期 HMR / 脚本重复注入：先清掉旧面板再挂载
  document.getElementById(HOST_ID)?.remove()

  const host = document.createElement('div')
  host.id = HOST_ID
  // all: initial 隔离页面继承样式；后续声明覆盖定位相关属性
  host.style.cssText =
    'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;'

  const shadowRoot = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = styles
  shadowRoot.appendChild(style)

  const appRoot = document.createElement('div')
  appRoot.id = 'auto-answer-ai-app'
  shadowRoot.appendChild(appRoot)

  ;(document.body ?? document.documentElement).appendChild(host)
  createApp(App).mount(appRoot)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true })
} else {
  mount()
}
