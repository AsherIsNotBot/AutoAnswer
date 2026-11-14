import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { crx, defineManifest } from '@crxjs/vite-plugin'

const manifest = defineManifest({
  manifest_version: 3,
  name: 'Auto Answer AI',
  version: '0.6.0',
  description: '悬浮式在线答题辅助面板（学习通 / 智慧树）',
  permissions: ['storage'],
  // 用户可自定义任意 LLM baseUrl，只能放宽到全部站点；实际请求只由 background 发出
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['*://*.chaoxing.com/*', '*://*.zhihuishu.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: true,
    },
    {
      // UEditor 的 window.UE 只存在于主世界，用于填空写入
      matches: ['*://*.chaoxing.com/*', '*://*.zhihuishu.com/*'],
      js: ['src/content/mainWorld.ts'],
      run_at: 'document_idle',
      all_frames: true,
      world: 'MAIN',
    },
  ],
})

export default defineConfig({
  plugins: [vue(), crx({ manifest })],
  build: {
    target: 'es2022',
  },
})
