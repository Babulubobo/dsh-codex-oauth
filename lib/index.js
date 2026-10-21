/** OpenAI Codex OAuth adapter for the dsh 0.2 LLM protocol. */
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ToolCallId,
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
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import {
  getSupportedThinkingLevels,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import {
  PROVIDER, PROVIDER_ID, PROVIDER_NAME,
  FileCredentialStore, createCodexModels, credentialPath, loginCodex, browserInteraction,
} from "./auth.js";
export * from "./auth.js";

const STREAM_IDLE_TIMEOUT_MS = 300000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";

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
function toPiReplayState(message, requestedModel) {
  return {
    response: {
      kind: "pi-ai",
      version: 2,
      api: message.api,
      provider: message.provider,
      model: requestedModel,
      ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
      ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
      ...(message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel }),
      stopReason: message.stopReason,
    },
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
          return {
            type: "tool-call",
            ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
            ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
          };
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
  // Old sessions use the flat v1 state; dsh 0.2 assembles a response/blocks envelope.
  const state = rawState?.response ?? rawState;
  if (!state || typeof state !== "object" || state.kind !== "pi-ai") return foreignAssistant(message);
  if (state.version !== (rawState.response === undefined ? 1 : 2)) return foreignAssistant(message);
  if (source.provider !== PROVIDER || state.provider !== PROVIDER_ID || state.model !== source.model) return foreignAssistant(message);
  if (typeof state.api !== "string") return foreignAssistant(message);
  const blocks = rawState.blocks;
  if (!Array.isArray(blocks) || blocks.length !== message.content.length) return foreignAssistant(message);
  if (blocks.some((block, index) => !block || block.type !== message.content[index].type)) return foreignAssistant(message);
  return {
    role: "assistant",
    content: message.content.map((block, index) => {
      const replay = blocks[index];
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
            ...(replay.namespace === undefined ? {} : { namespace: replay.namespace }),
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
    ...(state.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: state.providerThinkingLevel }),
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

function piTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/** Assemble the request-level pi-ai context envelope (text-only path). */
function toPiContext(options) {
  const toolNames = new Map();
  const messages = [];
  const system = [options.system];
  let leadingSystem = true;
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError("codex-pro adapter does not support image content", "UNSUPPORTED_CONTENT");
    }
    if (message.role === "system") {
      if (leadingSystem) system.push(flattenText(message));
      else messages.push({ role: "system", content: flattenText(message), timestamp: 0 });
      continue;
    }
    leadingSystem = false;
    if (message.role === "developer") {
      const toolsAdded = [];
      const toolsRemoved = [];
      for (const block of message.content) {
        if (block.type === "tool-addition") {
          const tool = options.tools?.find((tool) => tool.name === block.toolName);
          if (!tool) throw new LlmError(`Unknown added tool "${block.toolName}"`, "INVALID_REQUEST");
          toolsAdded.push(piTool(tool));
        } else if (block.type === "tool-removal") {
          toolsRemoved.push({ name: block.toolName });
        } else if (block.type !== "text") {
          throw new LlmError(`Unsupported developer content "${block.type}"`, "UNSUPPORTED_CONTENT");
        }
      }
      messages.push({
        role: "system", content: flattenText(message), timestamp: 0,
        ...(toolsAdded.length ? { toolsAdded } : {}),
        ...(toolsRemoved.length ? { toolsRemoved } : {}),
      });
      continue;
    }
    if (message.role === "assistant") {
      const assistant = toPiAssistant(message);
      for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(ToolCallId(block.id), block.name);
      messages.push(assistant);
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: toolNames.get(message.toolCallId) ?? "unknown",
        content: [{ type: "text", text: flattenText(message) || "(no output)" }],
        isError: message.isError ?? false,
        timestamp: 0,
      });
      continue;
    }
    messages.push({ role: "user", content: flattenText(message), timestamp: 0 });
  }
  const tools = options.tools?.filter((tool) => !tool.deferLoading).map(piTool);
  const systemPrompt = system.filter(Boolean).join("\n\n");
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
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

async function* toStreamChunks(events, contextWindow, requestedModel, signal) {
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
          id: ToolCallId(known?.id ?? ""),
          ...(known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        };
        break;
      }
      case "toolcall_end":
        yield {
          type: "block-end",
          index: event.contentIndex,
          block: { type: "tool-call", id: ToolCallId(event.toolCall.id), name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) },
        };
        break;
      case "done":
        yield { type: "usage", usage: mapUsage(event.message.usage) };
        yield { type: "finish", reason: mapStopReason(event.message, contextWindow), replayState: toPiReplayState(event.message, requestedModel) };
        return;
      case "error":
        yield { type: "usage", usage: mapUsage(event.error.usage) };
        yield { type: "finish", reason: mapStopReason(signal?.aborted ? { ...event.error, stopReason: "aborted" } : event.error, contextWindow) };
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
    if (options.stop !== undefined) throw new LlmError("codex-pro does not support stop sequences", "UNSUPPORTED_OPTION");
    const model = this.models.getModel(PROVIDER_ID, options.model);
    if (model === undefined) throw new LlmError(`codex-pro provider has no model "${options.model}"`, "UNKNOWN_MODEL");
    const reasoning = resolveReasoning(model, options.reasoningEffort);
    const context = toPiContext(options);

    const consumer = new AbortController();
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE);

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
      options.model,
      options.signal,
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
        // A timed-out next() may still be pending; do not wait behind it.
        void iterator.return(undefined).catch(() => {});
      }
      watchdog[Symbol.dispose]();
    }
  }
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
  ctx.inject(["commands"], (commandCtx) => commandCtx.commands.register({
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
  }));
}
