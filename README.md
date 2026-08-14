# dsh-codex-oauth

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](./package.json)
[![dsh](https://img.shields.io/badge/dsh-0.1.x-lightgrey.svg)](https://github.com/deepseek-ai/deepseek-harness)

OpenAI **Codex（ChatGPT Plus/Pro 订阅）OAuth 适配器**，接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 `llm` seam —— 让你用 ChatGPT 订阅账号在 DSH 里跑 Codex 模型。

> **English abstract**：A DeepSeek Harness LLM-seam adapter that authenticates to the OpenAI Codex backend (`chatgpt.com/backend-api`) with a **ChatGPT Plus/Pro subscription** via OAuth — the same "Sign in with ChatGPT" flow the official Codex CLI uses — plus a persistent OAuth credential store and a `/codex-login` command.

---

## ⚠️ 重要声明（务必先读）

- **本项目非官方**，与 OpenAI、Anthropic、DeepSeek 均无任何关联。
- 它复用的是官方 Codex CLI 的 OAuth 通道，把 **ChatGPT 订阅**当作程序化后端来用。OpenAI **并未授权**第三方工具这样访问订阅；订阅按条款不包含 API 访问权。
- **有账号被警告/封禁的风险**，OpenAI 也可能随时改协议或失效。**风险自担**。
- 若要条款干净：请使用 [platform.openai.com](https://platform.openai.com) 的 **API key**（按量计费），或改用 xAI **SuperGrok**（xAI 官方允许第三方工具用订阅 OAuth）。

---

## 它解决什么

DSH 内置的 `dsh-llm-pi-ai` 虽然挂着 pi-ai 的 `openai-codex` 提供方（ChatGPT OAuth），但该适配器**刻意不持有 OAuth 凭据存储、也不运行登录流程**，所以那条路由永远无法认证。本插件为**这一条路由**补上缺口：

- 一个持久化、文件存储的 OAuth 凭据库（`$DSH_HOME/storages/codex-oauth.json`，0600 权限）
- 基于 `openaiCodexProvider()` 的 pi-ai `Models` 集合（自带 ChatGPT OAuth 登录、token 刷新、`chatgpt.com/backend-api` 请求）
- 一个注册到 `codex-pro` 提供方路由的 `LlmAdapter`（文本 + 工具调用 + 推理）

## 特性

- ✅ 一条命令/斜杠命令完成 ChatGPT OAuth 登录（浏览器回调 + 无头设备码两种方式）
- ✅ OAuth token 自动刷新（复用 pi-ai 的锁式刷新，避免并发双刷）
- ✅ 凭据落盘 0600，不把任何密钥写进 settings
- ✅ 与 DSH 的 `llm/stream` waterfall、重试策略、会话回放（replay state）完全兼容
- ⚠️ 暂不支持图片输入（catalog 统一按 `text` 上报，遇到图片明确报 `UNSUPPORTED_CONTENT`）

## 安装

### 1. 把插件装进 profile 的 `node_modules`

```sh
# 假设 profile 为 web（路径换成你自己的）
mkdir -p "$DSH_HOME/profiles/web/node_modules"
cp -R dsh-codex-oauth "$DSH_HOME/profiles/web/node_modules/"
```

> 依赖（`@deepseek-ai/*`、`@earendil-works/pi-ai`）无需手动安装 —— DSH 的模块 fallback（`$DSH_HOME/profiles/node_modules`）会解析它们。

### 2. 在 profile 的 `cordis.patch.yml` 里加一行入口

```yaml
- insert:
    - id: llm-openai-codex
      name: 'dsh-codex-oauth'
```

重启 `dsh web`（或让 watcher 热重载）。

## 登录

### 方式一：Web 斜杠命令（推荐）

1. 在 DSH Web 输入框输入 `/codex-login` 回车。
2. 浏览器打开 OpenAI 登录页；完成后 `http://localhost:1455` 的回调自动接管，命令返回成功。
3. 在模型选择器选 **OpenAI Codex Pro** 下的模型（`gpt-5.6-luna` / `gpt-5.6-sol` / `gpt-5.5` …）。

### 方式二：终端脚本

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-codex-oauth/bin/codex-login.mjs"
# 无头环境用设备码流程：
node "…/bin/codex-login.mjs" --device-code
# 退出登录（删除凭据）：
node "…/bin/codex-login.mjs" --logout
```

## 工作原理

```
DSH agent loop
   └─ ctx.llm.stream({ provider: 'codex-pro', model: 'gpt-5.6-luna', ... })
        └─ OpenAiCodexAdapter.stream()
             ├─ 校验模型 + 推理等级
             ├─ harness 消息 → pi-ai Context（text / reasoning / tool-call）
             ├─ pi-ai Models.streamSimple(model, ctx, {signal, headers, maxRetries: 0})
             │    └─ 从 FileCredentialStore 读 OAuth 凭据 → 过期则刷新 → 得到 access token
             │    └─ 走 chatgpt.com/backend-api 的 codex responses 协议
             └─ pi-ai 事件流 → harness StreamChunk 协议
```

凭据文件 `$DSH_HOME/storages/codex-oauth.json` 形如：

```json
{
  "openai-codex": {
    "type": "oauth",
    "access": "…",
    "refresh": "…",
    "expires": 1234567890000,
    "accountId": "…"
  }
}
```

## 目录结构

```
dsh-codex-oauth/
├── lib/
│   └── index.js          # 插件主体：FileCredentialStore + Adapter + apply()
├── bin/
│   └── codex-login.mjs   # 终端登录脚本
├── package.json
├── LICENSE
└── README.md
```

## 常见问题

**Q：为什么提供方路由叫 `codex-pro`，而不是 `openai-codex`？**
为避免与 pi-ai 内置目录里那个「休眠」的 `openai-codex`（永远无法认证）在模型选择器里重名混淆。

**Q：登录后模型列表为空 / 请求报 `Provider is not configured`？**
说明 OAuth 凭据没存上。重跑 `/codex-login`，确认 `$DSH_HOME/storages/codex-oauth.json` 已生成。

**Q：能用于 OpenAI API key 吗？**
不能，也不该。本插件只走 ChatGPT 订阅 OAuth 后端；API key 请用 DSH 内置的 `openai` 提供方。

**Q：想用 Grok / Claude 订阅？**
- **Grok（xAI SuperGrok）**：官方允许第三方 OAuth，是更合规的订阅选择（可参考本项目同构实现）。
- **Claude（Pro/Max）**：Anthropic 已官方禁止第三方订阅 OAuth，请用 `ANTHROPIC_API_KEY`。

## License

[MIT](./LICENSE)
