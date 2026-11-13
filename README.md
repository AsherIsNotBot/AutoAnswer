# Auto Answer AI

悬浮式在线答题辅助浏览器扩展，面向学习通（chaoxing.com）与智慧树（zhihuishu.com）。

当前为 **P6 可用版本**：已打通「解析题目 → 请求大模型 → 解析答案 → 自动填涂 → 可选交卷」完整链路，支持 iframe 内嵌题目、智慧树新版「一页一题」作业页，以及题干/选项中的图片题（视觉模型 + 文本降级）。

## 技术栈

- Vue 3 + TypeScript + Vite 8
- `@crxjs/vite-plugin` 3（Manifest V3）
- Chrome Extension MV3：Content Script + Background Service Worker

## 快速开始

```bash
npm install
npm run dev     # 开发模式，产物在 dist/
npm run build   # 类型检查 + 生产构建，产物在 dist/
```

加载扩展：

1. 打开 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目的 `dist/` 目录
4. 打开 `*.chaoxing.com` 或 `*.zhihuishu.com` 的答题页，右下角出现悬浮面板

> 修改代码后，生产构建需重新执行 `npm run build` 并在扩展页点击刷新；`npm run dev` 下 CRXJS 提供 HMR（首次仍需加载 `dist/`）。

## 使用说明

「设置」Tab：

| 字段 | 说明 |
| --- | --- |
| Base URL | OpenAI 兼容接口地址。填 `https://api.deepseek.com/v1` 或完整 `.../chat/completions` 均可；只填域名时自动补 `/v1/chat/completions` |
| API Key | 以 `Bearer` 方式发送，保存在 `chrome.storage.local`（明文） |
| 模型 | 例如 `deepseek-chat`、`gpt-4o-mini` 等 |
| 自动交卷 | 打开后，仅在**全部题目填写成功且无跳过/失败**时才弹出确认框；未完成时自动跳过交卷 |
| 发送题目图片 | 默认关闭。开启后题目中的图片会压缩并随请求发送；需模型支持视觉 |
| 视觉模型 | 可选。留空复用「模型」；填写后仅在带图片的请求中使用 |

图片处理规则：

- 单题最多 4 张，单次请求最多 8 张，总大小受限
- 最长边 1400px、JPEG 压缩；同一图片按地址缓存
- 同源图片由页面直接抓取；跨域或 CORS 受限图片由 Background 代理抓取
- 模型不支持视觉（HTTP 400/413/415/422）时自动去掉图片重试一次，本轮后续题目按纯文本作答，并在日志中提示

「控制台」Tab：

- **启动答题**
  - 普通页面：一次性解析当前页与直接子 iframe 的全部题目，批量请求模型后填涂
  - 智慧树新版作业页：识别「一页一题」结构，自动回到第一题，逐题请求、填写并点击「下一题」
- 实时日志：平台识别、题目数量、模型返回条数、逐题填涂结果
- 进度条与统计：已填 / 跳过 / 失败

## 目录结构

```text
src/
├── background/index.ts           # 消息路由 + LLM 请求代理（超时、错误归一化）
├── content/
│   ├── index.ts                  # 所有 frame 启动代理；仅顶层挂载 Shadow DOM 面板
│   ├── App.vue                   # 设置 / 控制台双 Tab，答题编排
│   ├── bridge.ts                 # 跨 iframe postMessage 协议（解析 / 填涂 / 交卷）
│   ├── style.css                 # 以 ?inline 字符串注入 shadowRoot
│   └── strategies/
│       ├── BaseStrategy.ts       # 通用解析、事件模拟、交卷逻辑
│       ├── XueXiTong.ts          # 学习通选择器
│       ├── ZhiHuiShu.ts          # 智慧树选择器 + 分页答题/交卷流程
│       └── index.ts              # createStrategy 工厂
├── utils/
│   ├── storage.ts                # chrome.storage.local 的 Promise 封装
│   ├── llm.ts                    # askLLM / askLLMWithVision / 视觉降级 / 错误类型
│   ├── image.ts                  # 图片收集、懒加载等待、抓取、压缩、缓存
│   └── prompt.ts                 # Prompt 模板、图片标记、JSON 容错提取与答案归一化
├── types.ts                      # Settings、消息协议、Question / Answer
└── vite-env.d.ts
```

## 关键设计

- **样式隔离**：CSS 通过 `?inline` 导入为字符串，写入 Shadow DOM；宿主节点 `all: initial` + 固定定位 + 最大 z-index。
- **iframe 支持**：`all_frames: true`。顶层只渲染一个面板；每个 frame 内运行轻量代理，接收 `postMessage` 后本地解析/填涂，结果回传顶层汇总。跨域 iframe 同样可用。
- **策略模式**：`BaseStrategy` 实现通用 DOM 解析与填涂；平台子类只声明选择器，页面改版时单点修改。
- **分页式答题**：`paged` 策略通过 `.questionBox` + `.Topicswitching-div` 识别「一页一题」页面；先点答题卡回到第一项，之后每题解析 → 请求 → 填涂 → 切下一项。切换结果分为 `moved / last / failed`：只有确认到达最后一项才结束，切换失败立即停止且不交卷。
- **组合题**：智慧树的 `.questionBox` 可能同时包含组合题父题干和当前子题。解析时取最后一个 `.questionTit` 所在子题块，题号（如 `1.2`）、题型、填空/选项都来自当前子题；父题干作为「组合题背景」一起发给模型。导航签名同时包含答题卡当前高亮项，避免 `1.1 → 1.2` 被误判为页面没变化。
- **交卷保护**：只有 `已填 === 总题数` 且 `跳过 = 失败 = 0` 才允许自动交卷；智慧树弹窗若包含「未作答 / 未完成 / 还有 N 题」等警告，不会点击提交。
- **事件模拟**：radio/checkbox 使用原生 `checked` setter + `mousedown/mouseup/click/change`；输入框使用原型 setter + `input/change/blur`，兼容 Vue/React 受控组件。
- **图片题**：解析阶段收集题干/选项中的 `img`（兼容懒加载 `data-src`），请求前在当前 frame 内抓取并用 canvas 压缩；跨域失败时由 Background 凭 `<all_urls>` 权限代理抓取。图片以 OpenAI 兼容的 `image_url` data URL 追加到消息中，Prompt 用「题目2 图片1（题干配图）」标注顺序；视觉模型不支持时自动去图重试。
- **答案容错**：Prompt 强制纯 JSON；解析器容忍代码块、前后废话、`{answers:[...]}` 包裹与 `{id: answer}` 映射。
- **请求代理**：API Key 与 LLM 请求都在 background 完成，Content Script 只传 prompt。

## 当前进度

已完成（P0–P6）：

- [x] Vite + Vue 3 + TS + CRXJS 工程与 MV3 manifest
- [x] Shadow DOM 面板注入（右下角、可折叠）
- [x] 设置项保存/读取、刷新后回填
- [x] Background 代理 LLM 请求：URL 归一化、60s 超时、非 2xx 与解析错误处理
- [x] 「测试连接」端到端可用
- [x] `BaseStrategy` + 策略工厂 + 学习通 / 智慧树选择器
- [x] 单选 / 多选 / 判断 / 填空填涂与逐题日志、进度条
- [x] Prompt 模板与答案 JSON 容错解析
- [x] iframe（含跨域）题目解析、填涂、交卷广播
- [x] 自动交卷（二次确认）
- [x] 智慧树新版作业页：`.questionBox` 解析、Element UI 选项、答题卡回第一题、逐题「下一题」、弹窗交卷
- [x] 智慧树组合题：父题干 + 当前子题（1.1 / 1.2）解析，题号/题型/填空取自当前子题
- [x] 图片题：题干/选项图片收集、压缩、缓存、跨域代理、多模态请求、视觉不支持时文本降级
- [x] 交卷安全闸门：未答完、切换失败、平台提示未作答时均不会自动提交

后续可做：

- [ ] 真实考试页选择器校准（智慧树已按保存页面 DOM 适配，选择题选项结构如与 Element UI 有差异需再补）
- [ ] 分页式页面批量提问（当前每题一次请求，题量大时较慢）
- [ ] 嵌套 iframe 汇总（当前只处理直接子 frame）
- [ ] 失败题目重试、答案人工修正
- [ ] 解析结果预览与“只解析不填写”模式

## 本地验证记录

使用 Chrome 151（无头）+ 本地 mock 学习通页 + 跨域智慧树 iframe + OpenAI 兼容 mock 服务验证：

- 面板挂载成功，页面 40px 红色样式未影响面板；CSS 仅存在于 shadowRoot
- 顶层 4 题 + 跨域 iframe 1 题，共 5 题全部识别并填涂
- 单选 A、多选 B/D、判断“对”、填空 `createApp` 均正确写入；iframe 内单选同样选中
- 模型返回带前言与 ```` ```json ```` 代码块，仍能正确提取答案
- 进度条 5/5，统计“已填 5 · 跳过 0 · 失败 0”
- 开启自动交卷后弹出确认框，接受后顶层与 iframe 的交卷按钮均被触发
- 智慧树新版作业页（按 `hiexam.zhihuishu.com` 保存文件里的真实 DOM 复刻）：`.questionBox` + `.questionTit` / `.questionContent`，3 题（问答/单选/多选）全部填涂成功，答题卡显示 3/3；开启自动交卷后 `.Submithomeworkbtn` → 弹窗 `.Submissionbtn` 链路成功触发
- 智慧树组合题（按 `test.html` 复刻）：答题卡 `1.1 / 1.2 / 2 / 3`，父题干保留、子题切换；`1.1` 两个填空、`1.2` 问答、后两题单选，4/4 全部填涂，题号与题型正确（`#1.1 [填空]`、`#1.2 [简答]`）
- 交卷闸门：模型只返回部分答案时日志为 `答题未完成：已填 0/4…已跳过自动交卷`，不弹确认、不提交；4/4 完成但平台弹「还有 2 题未作答」时，扩展拒绝点击提交并记录警告
- 图片题：题干同源图片 + 选项跨域图片（无 CORS 头）共 2 张，请求体为 `text + image_url` 数组，`visionModel` 生效，3 题全部填涂
- 视觉降级：纯文本 mock 接口对多模态内容返回 400，扩展自动去掉图片重试成功，日志提示「模型不支持视觉输入，已去掉图片重试」，3 题仍全部填涂

## 已知限制

- 智慧树选择题选项按 Element UI 的 `label.el-radio` / `label.el-checkbox` 适配；若真实页面选项是其他自定义结构，需要在 `ZhiHuiShu.ts` 的 `selectors.option` 补选择器
- 分页式页面（一页一题）当前是**每题一次模型请求**，题量大时耗时与费用会增加
- 图片单题最多 4 张、单次请求最多 8 张；超出部分会跳过并在日志提示
- 顶层通过 `postMessage` 只向**直接子 iframe** 发起解析；多层嵌套需要后续补转发
- API Key 以明文保存在 `chrome.storage.local`，请勿在共用设备上使用
- 本工具只做页面 DOM 读写与大模型调用，不破解平台校验；请仅在自测、练习或已获授权的场景使用
