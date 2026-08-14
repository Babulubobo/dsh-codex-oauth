/**
 * OpenAI Codex (ChatGPT Plus/Pro) OAuth adapter for the DeepSeek Harness.
 *
 * The harness LLM seam ships two adapters — `dsh-llm-deepseek` (DeepSeek
 * chat-completions) and `dsh-llm-pi-ai` (the pi-ai multi-provider twin).
 * pi-ai itself ships an `openai-codex` provider whose authentication is
 * ChatGPT OAuth only, but `dsh-llm-pi-ai` deliberately builds its `Models`
 * collection with no credential store and no login flow, so that provider
 * can never authenticate through the generic adapter. This plugin closes
 * that gap for exactly one route: it owns a persistent, file-backed OAuth
 * credential store, constructs a pi-ai `Models` collection over the
 * `openai-codex` provider, and registers a harness `LlmAdapter` for the
 * `codex-pro` provider route. Login is triggered with a `/codex-login` slash
 * command (when a command service is mounted) or with the bundled
 * `bin/codex-login.mjs` terminal helper.
 *
 * @module dsh-codex-oauth
 */
import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import {
  createModels,
  getSupportedThinkingLevels,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The harness provider route this adapter owns. */
export const PROVIDER = "codex-pro";
/** The pi-ai provider id whose factory supplies endpoint, OAuth flow, and models. */
export const PROVIDER_ID = "openai-codex";
/** Human-readable provider name shown in selectors. */
export const PROVIDER_NAME = "OpenAI Codex Pro";
/** Per-read idle budget while a provider stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_MS = 300000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";

/** Credential file holding the persisted OAuth token (0600). */
export function credentialPath() {
  return dshHomePath("storages", "codex-oauth.json");
}

// ---------------------------------------------------------------------------
// File-backed OAuth credential store (pi-ai `CredentialStore` interface)
// ---------------------------------------------------------------------------

/**
 * Persistent, single-process-serialized OAuth credential store. One JSON file
 * keyed by provider id; `modify` is the only write path, so OAuth refresh
 * inside pi-ai's locked refresh cannot double-rotate a token. Serialization is
 * in-process (the harness runs one host process), matching pi-ai's own
 * `InMemoryCredentialStore` discipline.
 */
export class FileCredentialStore {
  #file;
  #chains = new Map();
  constructor(file) {
    this.#file = file;
  }
  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error && error.code === "ENOENT") return {};
      throw error;
    }
  }
  async #save(data) {
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, this.#file);
  }
  #enqueue(providerId, task) {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const next = (async () => {
      await previous.catch(() => {});
      return task();
    })();
    this.#chains.set(providerId, next.catch(() => {}));
    return next;
  }
  async read(providerId) {
    const data = await this.#load();
    return data[providerId];
  }
  async list() {
    const data = await this.#load();
    return Object.entries(data)
      .filter(([, credential]) => credential && typeof credential.type === "string")
      .map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  modify(providerId, fn) {
    return this.#enqueue(providerId, async () => {
      const data = await this.#load();
      const current = data[providerId];
      const next = await fn(current);
      if (next !== undefined) {
        data[providerId] = next;
        await this.#save(data);
      }
      return next ?? current;
    });
  }
  delete(providerId) {
    return this.#enqueue(providerId, async () => {
      const data = await this.#load();
      delete data[providerId];
      await this.#save(data);
    });
  }
}

/** Build the pi-ai Models collection over the OAuth store. */
export function createCodexModels(store) {
  const models = createModels({ credentials: store });
  models.setProvider(openaiCodexProvider());
  return models;
}

// ---------------------------------------------------------------------------
// Harness message -> pi-ai context conversion (text + tool calls + reasoning)
// ---------------------------------------------------------------------------

function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Project a successful pi-ai response into durable, versioned replay state. */
function toPiReplayState(message) {
  return {
    kind: "pi-ai",
    version: 1,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    stopReason: message.stopReason,
    blocks: message.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text", ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }) };
        case "thinking":
          return {
            type: "reasoning",
            ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
            ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
          };
        case "toolCall":
          return { type: "tool-call", ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }) };
      }
    }),
  };
}

/** Convert harness assistant content without trusting it as same-model replay. */
function foreignAssistant(message) {
  const source = message.source?.kind === "model" ? message.source : undefined;
  const content = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "reasoning":
        content.push({ type: "thinking", thinking: block.text });
        break;
      case "tool-call":
        content.push({ type: "toolCall", id: block.id, name: block.name, arguments: parseArguments(block.arguments) });
        break;
      default:
        break;
    }
  }
  return {
    role: "assistant",
    content,
    api: "dsh-foreign",
    provider: source?.provider ?? "dsh-foreign",
    model: source?.model ?? "dsh-foreign",
    usage: emptyPiUsage(),
    stopReason: content.some((piece) => piece.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
  };
}

/** Recombine durable harness content with validated pi-ai replay metadata. */
function replayedAssistant(message, source, rawState) {
  const state = rawState;
  if (!state || typeof state !== "object" || state.kind !== "pi-ai") return foreignAssistant(message);
  if (state.provider !== source.provider || state.model !== source.model) return foreignAssistant(message);
  if (!Array.isArray(state.blocks) || state.blocks.length !== message.content.length) return foreignAssistant(message);
  return {
    role: "assistant",
    content: message.content.map((block, index) => {
      const replay = state.blocks[index];
      if (!replay || replay.type !== block.type) return foreignAssistant(message).content[index];
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text, ...(replay.textSignature === undefined ? {} : { textSignature: replay.textSignature }) };
        case "reasoning":
          return {
            type: "thinking",
            thinking: block.text,
            ...(replay.thinkingSignature === undefined ? {} : { thinkingSignature: replay.thinkingSignature }),
            ...(replay.redacted === undefined ? {} : { redacted: replay.redacted }),
          };
        case "tool-call":
          return {
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: parseArguments(block.arguments),
            ...(replay.thoughtSignature === undefined ? {} : { thoughtSignature: replay.thoughtSignature }),
          };
        default:
          return foreignAssistant(message).content[index];
      }
    }),
    api: state.api,
    provider: state.provider,
    model: state.model,
    ...(state.responseModel === undefined ? {} : { responseModel: state.responseModel }),
    ...(state.responseId === undefined ? {} : { responseId: state.responseId }),
    usage: emptyPiUsage(),
    stopReason: state.stopReason,
    timestamp: 0,
  };
}

function toPiAssistant(message) {
  const source = message.source;
  if (source?.kind !== "model" || source.replayState === undefined) return foreignAssistant(message);
  return replayedAssistant(message, source, source.replayState);
}

function flattenText(message) {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function toolResultText(blocks) {
  return blocks
    .map((block) => (block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : ""))
    .join("");
}

function toolsOf(options) {
  return options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/** Assemble the request-level pi-ai context envelope (text-only path). */
function toPiContext(options) {
  const toolNames = new Map();
  const messages = [];
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError("codex-pro adapter does not support image content", "UNSUPPORTED_CONTENT");
    }
    if (message.role === "system") {
      messages.push({ role: "user", content: flattenText(message), timestamp: 0 });
      continue;
    }
    if (message.role === "assistant") {
      const assistant = toPiAssistant(message);
      for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
      messages.push(assistant);
      continue;
    }
    const text = flattenText(message);
    const results = message.content.filter((block) => block.type === "tool-result");
    if (text.length > 0 || results.length === 0) messages.push({ role: "user", content: text, timestamp: 0 });
    for (const result of results) {
      messages.push({
        role: "toolResult",
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? "unknown",
        content: [{ type: "text", text: toolResultText(result.content) || "(no output)" }],
        isError: result.isError ?? false,
        timestamp: 0,
      });
    }
  }
  const tools = toolsOf(options);
  return {
    ...(options.system !== undefined ? { systemPrompt: options.system } : {}),
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
  };
}

// ---------------------------------------------------------------------------
// pi-ai event stream -> harness StreamChunk protocol
// ---------------------------------------------------------------------------

function mapUsage(usage) {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
}

function classifyPiAiError(message) {
  if (/\b(?:401|403)\b/.test(message)) return "AUTH";
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
  if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
  if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
  if (/\b5\d\d\b/.test(message)) return "SERVER";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
  if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return "TRANSPORT";
  return "PI_AI_ERROR";
}

function mapStopReason(message, contextWindow) {
  const overflow =
    isContextOverflow(message, contextWindow) ||
    (message.stopReason === "error" && message.errorMessage !== undefined && isContextWindowExceededError(message.errorMessage));
  if (overflow) {
    return { kind: "error", failure: { message: message.errorMessage ?? `context overflow for model "${message.model}"`, code: CONTEXT_WINDOW_EXCEEDED_CODE } };
  }
  switch (message.stopReason) {
    case "stop":
      if (message.content.length === 0) {
        return { kind: "error", failure: { message: `model "${message.model}" returned a completed response with no content`, code: EMPTY_RESPONSE_CODE } };
      }
      return { kind: "stop" };
    case "length":
      return { kind: "max-tokens" };
    case "toolUse":
      return { kind: "tool-calls" };
    case "aborted":
      return { kind: "aborted", failure: { message: message.errorMessage ?? "pi-ai stream aborted", code: "ABORTED" } };
    case "error": {
      const text = message.errorMessage ?? "pi-ai stream error";
      return { kind: "error", failure: { message: text, code: classifyPiAiError(text) } };
    }
    default:
      return { kind: "error", failure: { message: `unknown stop reason "${message.stopReason}"`, code: "PI_AI_ERROR" } };
  }
}

async function* toStreamChunks(events, contextWindow) {
  const toolIds = new Map();
  for await (const event of events) {
    switch (event.type) {
      case "start":
        break;
      case "text_start":
        yield { type: "block-start", index: event.contentIndex, blockType: "text" };
        break;
      case "text_delta":
        yield { type: "text-delta", index: event.contentIndex, text: event.delta };
        break;
      case "text_end":
        yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
        break;
      case "thinking_start":
        yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
        break;
      case "thinking_delta":
        yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
        break;
      case "thinking_end":
        yield { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } };
        break;
      case "toolcall_start": {
        const partial = event.partial?.content?.[event.contentIndex];
        const id = partial?.type === "toolCall" ? partial.id : "";
        const name = partial?.type === "toolCall" ? partial.name : "";
        toolIds.set(event.contentIndex, { id, name });
        yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
        break;
      }
      case "toolcall_delta": {
        const known = toolIds.get(event.contentIndex);
        yield {
          type: "tool-call-delta",
          index: event.contentIndex,
          id: CallId(known?.id ?? ""),
          ...(known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        };
        break;
      }
      case "toolcall_end":
        yield {
          type: "block-end",
          index: event.contentIndex,
          block: { type: "tool-call", id: CallId(event.toolCall.id), name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) },
        };
        break;
      case "done":
        yield { type: "usage", usage: mapUsage(event.message.usage) };
        yield { type: "finish", reason: mapStopReason(event.message, contextWindow), replayState: toPiReplayState(event.message) };
        return;
      case "error":
        yield { type: "usage", usage: mapUsage(event.error.usage) };
        yield { type: "finish", reason: mapStopReason(event.error, contextWindow) };
        return;
    }
  }
  throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");
}

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

function resolveReasoning(model, effort) {
  if (effort === undefined) return undefined;
  if (getSupportedThinkingLevels(model).includes(effort)) return effort === "off" ? undefined : effort;
  throw new LlmError(`codex-pro model "${model.id}" does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}

function reasoningInfo(model) {
  if (!model.reasoning) return {};
  return {
    reasoning: {
      efforts: getSupportedThinkingLevels(model).map((level) => ({
        id: ReasoningEffortId(level),
        name: level.charAt(0).toUpperCase() + level.slice(1),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAiCodexAdapter extends LlmAdapter {
  models;
  constructor(models) {
    super();
    this.models = models;
  }
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }
  listModels(provider) {
    return Promise.resolve(
      this.models.getModels(PROVIDER_ID).map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: ["text"],
      })),
    );
  }
  resolveModel(provider, model, _signal) {
    return Promise.resolve().then(() => {
      const resolved = this.models.getModel(PROVIDER_ID, model);
      if (resolved === undefined) {
        throw new LlmError(`codex-pro provider has no model "${model}"`, "UNKNOWN_MODEL");
      }
      return {
        provider,
        id: resolved.id,
        name: resolved.name,
        inputModalities: ["text"],
        context: { contextWindow: resolved.contextWindow },
        defaultMaxTokens: resolved.maxTokens,
        ...reasoningInfo(resolved),
      };
    });
  }
  async *stream(options) {
    const model = this.models.getModel(PROVIDER_ID, options.model);
    if (model === undefined) throw new LlmError(`codex-pro provider has no model "${options.model}"`, "UNKNOWN_MODEL");
    const reasoning = resolveReasoning(model, options.reasoningEffort);

    const consumer = new AbortController();
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE);

    const context = toPiContext(options);
    const iterator = toStreamChunks(
      this.models.streamSimple(model, context, {
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
        signal: watchdog.signal,
        headers: attributionHeaders(),
        maxRetries: 0,
      }),
      model.contextWindow,
    )[Symbol.asyncIterator]();

    let exhausted = false;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
          throw new LlmError(`codex-pro stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT");
        }
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`codex-pro stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT", { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError("codex-pro request aborted by caller", "ABORTED", { cause: error });
      throw error;
    } finally {
      consumer.abort("codex-pro stream consumer stopped");
      if (!exhausted) {
        try {
          await iterator.return(undefined);
        } catch {}
      }
      watchdog[Symbol.dispose]();
    }
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/** Open a URL in the platform default browser. Best-effort; never throws. */
export function openBrowser(url) {
  try {
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true });
    else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  } catch {}
}

/**
 * Run the ChatGPT OAuth login against the shared Models collection.
 * @param models - the pi-ai Models collection built over the store.
 * @param interaction - pi-ai `AuthInteraction`.
 * @param method - "browser" (default) or "device_code".
 * @returns the stored OAuth credential.
 */
export function loginCodex(models, interaction, method = "browser") {
  const wrap = {
    ...interaction,
    prompt: async (prompt) => {
      if (prompt.type === "select") return method;
      return interaction.prompt(prompt);
    },
  };
  return models.login(PROVIDER_ID, "oauth", wrap);
}

/** An `AuthInteraction` that opens the browser and never blocks on manual code. */
export function browserInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type === "auth_url") openBrowser(event.url);
    },
    prompt: async (prompt) => {
      if (prompt.type === "select") return "browser";
      if (prompt.type === "manual_code") {
        // Browser callback on localhost is the primary path; wait for cancellation.
        return new Promise((resolve) => {
          const done = () => resolve("");
          if (prompt.signal?.aborted || signal?.aborted) return done();
          prompt.signal?.addEventListener("abort", done, { once: true });
          signal?.addEventListener("abort", done, { once: true });
        });
      }
      return "";
    },
  };
}

// ---------------------------------------------------------------------------
// Cordis plugin
// ---------------------------------------------------------------------------

export const name = "llm-openai-codex";
export const inject = ["llm"];

export function apply(ctx) {
  const store = new FileCredentialStore(credentialPath());
  const models = createCodexModels(store);
  const adapter = new OpenAiCodexAdapter(models);
  ctx.llm.registerAdapter([PROVIDER], adapter);

  // Slash command when a command service is mounted (the shipped web profile).
  const commands = ctx.get("commands");
  commands?.register({
    name: "codex-login",
    description: "Sign in with an OpenAI ChatGPT (Codex Pro) account via OAuth",
    handler: async (invocation) => {
      try {
        await loginCodex(models, browserInteraction(invocation.signal));
        return {
          kind: "success",
          text: "Codex Pro login complete. Select the OpenAI Codex Pro provider in the model picker to use your subscription.",
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { kind: "error", text: `Codex login failed: ${detail}` };
      }
    },
  });
}
