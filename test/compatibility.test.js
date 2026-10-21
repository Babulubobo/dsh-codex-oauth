import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { BlockAssembler, attributionHeaders } from "@deepseek-ai/dsh-llm";
import Commands from "@deepseek-ai/dsh-commands";
import * as plugin from "../lib/index.js";

const catalog = plugin.createCodexModels({});
const model = catalog.getModels(plugin.PROVIDER_ID)[0];
const request = { provider: plugin.PROVIDER, model: model.id, messages: [] };
const usage = {
  input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const native = {
  role: "assistant", api: model.api, provider: plugin.PROVIDER_ID, model: model.id,
  content: [
    { type: "thinking", thinking: "Checking", thinkingSignature: "encrypted-reasoning" },
    { type: "text", text: "Running a tool", textSignature: "message-id" },
    { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "README.md" } },
  ],
  usage, stopReason: "toolUse", timestamp: 0, responseId: "response-id",
  providerThinkingLevel: "high",
};

function adapterWith(message = native, inspect = () => {}) {
  return new plugin.OpenAiCodexAdapter({
    getModel: () => model,
    async *streamSimple(selected, context, options) {
      inspect(context, options);
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type === "toolCall") {
          yield { type: "toolcall_start", contentIndex, partial: message };
          yield { type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments) };
          yield { type: "toolcall_end", contentIndex, toolCall: block };
        } else {
          const type = block.type;
          yield { type: `${type}_start`, contentIndex };
          yield { type: `${type}_delta`, contentIndex, delta: block.text ?? block.thinking };
          yield { type: `${type}_end`, contentIndex, content: block.text ?? block.thinking };
        }
      }
      if (message.stopReason === "error") yield { type: "error", error: message };
      else yield { type: "done", message };
    },
  });
}

async function assemble(adapter, options = request) {
  const assembler = new BlockAssembler();
  for await (const chunk of adapter.stream(options)) assembler.push(chunk);
  return assembler;
}

test("mounts on dsh 0.2 and registers the login command when commands arrives later", async (t) => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  const mounted = await ctx.plugin(plugin);
  assert.deepEqual(ctx.llm.listProviders(), [{ id: plugin.PROVIDER, name: plugin.PROVIDER_NAME }]);
  assert.ok((await ctx.llm.listModels(plugin.PROVIDER)).some((entry) => entry.id === model.id));
  await ctx.plugin(Commands);
  await setImmediate();
  assert.ok(ctx.commands.list().some((command) => command.name === "codex-login"));
  await mounted.dispose();
  assert.deepEqual(ctx.llm.listProviders(), []);
  assert.deepEqual(ctx.commands.list(), []);
});

test("preserves system prompts, first-class tool results and deferred tool updates", async () => {
  const tool = { name: "read_file", description: "Read a file", parameters: { type: "object" }, deferLoading: true };
  const adapter = adapterWith(native, (context, options) => {
    assert.equal(context.systemPrompt, "One-shot instructions\n\nSession instructions");
    assert.equal(context.tools, undefined);
    assert.equal(context.messages[2].role, "toolResult");
    assert.equal(context.messages[2].toolCallId, "call-1");
    assert.equal(context.messages[2].toolName, "read_file");
    assert.equal(context.messages[2].isError, true);
    assert.deepEqual(context.messages[2].content, [{ type: "text", text: "file missing" }]);
    assert.equal(context.messages[3].role, "system");
    assert.equal(context.messages[3].toolsAdded[0].name, tool.name);
    assert.deepEqual(context.messages[3].toolsRemoved, [{ name: "old_tool" }]);
    assert.equal(context.messages[4].role, "system");
    assert.deepEqual(options.headers, attributionHeaders());
  });
  await assemble(adapter, {
    ...request, system: "One-shot instructions", tools: [tool],
    messages: [
      { role: "system", content: [{ type: "text", text: "Session instructions" }] },
      { role: "user", content: [{ type: "text", text: "Read the file" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: tool.name, arguments: "{}" }] },
      { role: "tool", toolCallId: "call-1", isError: true, content: [{ type: "text", text: "file missing" }] },
      { role: "developer", content: [
        { type: "tool-addition", toolName: tool.name }, { type: "tool-removal", toolName: "old_tool" },
      ] },
      { role: "system", content: [{ type: "text", text: "Updated instructions" }] },
    ],
  });
});

test("dsh assembly preserves Codex replay signatures, including after truncation", async () => {
  for (const stopReason of ["toolUse", "length"]) {
    const assembled = await assemble(adapterWith({ ...native, stopReason }));
    assert.equal(assembled.finish.kind, stopReason === "length" ? "max-tokens" : "tool-calls");
    assert.equal(assembled.replayState.response.responseId, native.responseId);
    assert.equal(assembled.replayState.blocks.length, assembled.blocks().length);
    const message = assembled.message({
      provider: plugin.PROVIDER, model: model.id, replayState: assembled.replayState,
    });
    await assemble(adapterWith(native, (context) => {
      const replay = context.messages[0];
      assert.equal(replay.provider, plugin.PROVIDER_ID);
      assert.equal(replay.api, model.api);
      assert.equal(replay.responseId, native.responseId);
      assert.equal(replay.providerThinkingLevel, "high");
      assert.equal(replay.content[0].thinkingSignature, "encrypted-reasoning");
      assert.equal(replay.content[1].textSignature, "message-id");
      assert.equal(replay.content.length, stopReason === "length" ? 2 : 3);
    }), { ...request, messages: [message] });
  }
});

test("reads legacy replay state but degrades mismatched metadata without signatures", async () => {
  const assembled = await assemble(adapterWith());
  const legacy = { ...assembled.replayState.response, version: 1, blocks: assembled.replayState.blocks };
  for (const replayState of [legacy, { ...legacy, version: 999 }]) {
    const message = assembled.message({ provider: plugin.PROVIDER, model: model.id, replayState });
    await assemble(adapterWith(native, (context) => {
      assert.equal(context.messages[0].content[0].thinkingSignature,
        replayState.version === 1 ? "encrypted-reasoning" : undefined);
    }), { ...request, messages: [message] });
  }
});

test("maps cancellation and rejects unsupported stop sequences", async () => {
  const signal = AbortSignal.abort("cancelled");
  const assembled = await assemble(adapterWith({ ...native, content: [], stopReason: "error", errorMessage: "connection closed" }), { ...request, signal });
  assert.equal(assembled.finish.kind, "aborted");
  await assert.rejects(assemble(adapterWith(), { ...request, stop: ["END"] }), { code: "UNSUPPORTED_OPTION" });
});

test("pi-ai login persists private credentials and logout removes them", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-codex-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "codex-oauth.json");
  const store = new plugin.FileCredentialStore(file);
  const models = plugin.createCodexModels(store);
  const provider = models.getProvider(plugin.PROVIDER_ID);
  const credential = { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 60000 };
  models.setProvider({ ...provider, auth: { oauth: {
    async login(interaction) {
      assert.equal(await interaction.prompt({ type: "select" }), "device_code");
      return credential;
    },
  } } });
  await plugin.loginCodex(models, { notify() {}, prompt() { throw new Error("Unexpected prompt"); } }, "device_code");
  assert.deepEqual(await new plugin.FileCredentialStore(file).read(plugin.PROVIDER_ID), credential);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  await store.delete(plugin.PROVIDER_ID);
  assert.equal(await store.read(plugin.PROVIDER_ID), undefined);
});

test("pi-ai sends the Codex request and decodes an SSE response without network access", async () => {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
  const credential = { type: "oauth", access: `test.${payload}.test`, refresh: "unused", expires: Date.now() + 3600000 };
  const models = plugin.createCodexModels({
    async read() { return credential; },
    async modify(id, update) { return await update(credential) ?? credential; },
  });
  const provider = models.getProvider(plugin.PROVIDER_ID);
  let sent = false;
  models.setProvider({ ...provider, streamSimple(selected, context, options) {
    return provider.streamSimple(selected, context, {
      ...options, transport: "sse",
      async fetch(url, init) {
        sent = true;
        assert.equal(new URL(url).hostname, "chatgpt.com");
        const headers = new Headers(init.headers);
        for (const [key, value] of Object.entries(attributionHeaders())) assert.equal(headers.get(key), value);
        assert.equal(headers.get("chatgpt-account-id"), "test-account");
        const body = JSON.parse(headers.get("content-encoding") === "zstd"
          ? zlib.zstdDecompressSync(init.body).toString() : init.body);
        assert.equal(body.instructions, "Test instructions");
        assert.ok(body.input.some((item) => item.type === "function_call_output" && item.call_id === "call-1"));
        const item = { type: "message", id: "msg-test", role: "assistant", content: [] };
        const events = [
          { type: "response.created", response: { id: "resp-test", model: model.id } },
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
          { type: "response.output_item.done", output_index: 0, item: { ...item, content: [{ type: "output_text", text: "OK", annotations: [] }] } },
          { type: "response.completed", response: { id: "resp-test", model: model.id, status: "completed", usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
  } });
  const assembled = await assemble(new plugin.OpenAiCodexAdapter(models), {
    ...request, messages: [
      { role: "system", content: [{ type: "text", text: "Test instructions" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "file contents" }] },
    ],
  });
  assert.ok(sent, JSON.stringify(assembled.finish));
  assert.deepEqual(assembled.finish, { kind: "stop" });
  assert.deepEqual(assembled.blocks(), [{ type: "text", text: "OK" }]);
  assert.equal(assembled.replayState.response.responseId, "resp-test");
});
