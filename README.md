# dsh-codex-oauth

用 ChatGPT（Codex Pro/Plus）订阅在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里跑 Codex 模型的 OAuth 适配器。

非官方适配器。保留 `codex-pro` 路由和独立的 OAuth 凭据文件。

## 兼容性

- `0.2.0` 已在 npm 最新发布的 **dsh `0.2.1-rc.2`**、pi-ai `1.3.0` 上验证（2026-10-21）。需要 **Node.js 22.19.0 或以上**。
- 旧版 `0.1.0` 无法在此版本 dsh 上加载：`CallId` 已改为 `ToolCallId`；工具结果改成 `role: tool` 消息，回复重放数据改成 `response/blocks` 格式。
- 新版 [dsh-llm-pi-ai](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai) 已内置 OAuth 登录。新配置可以直接使用内置的 `openai-codex` 提供方；已有 `codex-pro` 会话可继续使用本插件。
- `0.2.0` 面向 dsh `0.2.1-rc.2` 起的 `0.2.x`；旧 dsh 请保留插件 `0.1.0`，未来 dsh 版本需重新验证。

## 安装

```sh
dsh plugin --profile web add github:Babulubobo/dsh-codex-oauth
```

在 `${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml` 的顶层数组追加：

```yaml
- insert:
    - id: llm-openai-codex
      name: 'dsh-codex-oauth'
```

重启 `dsh web`。

## 登录

Web 输入框执行 `/codex-login`（浏览器回调），或终端：

```sh
node "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-codex-oauth/bin/codex-login.mjs"
```

登录后模型选择器选 **OpenAI Codex Pro**。

终端脚本支持 `--device-code`（无浏览器环境）和 `--logout`。它可以独立运行，无需 dsh 的模块加载钩子。凭据沿用原路径，升级插件无需迁移文件。

## 说明

- 提供方路由 id 为 `codex-pro`；凭据存在 `$DSH_HOME/storages/codex-oauth.json`。
- dsh 的 LLM 和超时接口由宿主提供；pi-ai 和路径工具随插件安装。不要仅复制源码到 `node_modules`，否则登录脚本会缺少依赖。
- 保留原有的纯文本能力；不支持图片输入。

## 验证

```sh
npm install
npm test
```

回归测试使用真实的 dsh 服务和消息组装器，覆盖插件加载、延迟注册登录命令、工具结果、系统提示、回复重放和凭据持久化。模型响应和登录凭据使用测试数据，不会读取个人令牌或发送真实推理请求；真实账户的登录和模型访问仍需登录后确认。

## License

[MIT](./LICENSE)
