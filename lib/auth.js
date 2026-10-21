/** Shared OAuth storage and login helpers; also usable without the dsh loader. */
import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

/** The harness provider route this adapter owns. */
export const PROVIDER = "codex-pro";
/** The pi-ai provider id whose factory supplies endpoint, OAuth flow, and models. */
export const PROVIDER_ID = "openai-codex";
/** Human-readable provider name shown in selectors. */
export const PROVIDER_NAME = "OpenAI Codex Pro";

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
