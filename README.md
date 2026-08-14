# dsh-codex-oauth

用 ChatGPT（Codex Pro/Plus）订阅在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里跑 Codex 模型的 OAuth 适配器。

> ⚠️ 非官方：OpenAI 未授权第三方工具这样使用订阅，有封号风险，风险自担。

## 安装

```sh
cp -R dsh-codex-oauth "$DSH_HOME/profiles/web/node_modules/"
```

在 profile 的 `cordis.patch.yml` 加：

```yaml
- insert:
    - id: llm-openai-codex
      name: 'dsh-codex-oauth'
```

重启 `dsh web`。

## 登录

Web 输入框执行 `/codex-login`（浏览器回调），或终端：

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-codex-oauth/bin/codex-login.mjs"
```

登录后模型选择器选 **OpenAI Codex Pro**。

## 说明

- 提供方路由 id 为 `codex-pro`；凭据存在 `$DSH_HOME/storages/codex-oauth.json`。
- 依赖（`@deepseek-ai/*`、`@earendil-works/pi-ai`）由 DSH 的模块 fallback 解析，无需手动安装。

## License

[MIT](./LICENSE)
