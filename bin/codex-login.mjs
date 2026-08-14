#!/usr/bin/env node
/**
 * Terminal login for the OpenAI Codex (ChatGPT Plus/Pro) OAuth adapter.
 *
 * Run from inside the profile's node_modules tree (where the harness module
 * fallback resolves `@deepseek-ai/*` and `@earendil-works/pi-ai`), e.g.:
 *
 *   node "$DSH_HOME/profiles/web/node_modules/dsh-codex-oauth/bin/codex-login.mjs"
 *
 * Options:
 *   --device-code   use the device-code flow instead of the browser flow.
 *   --logout        remove the stored credential instead of logging in.
 */
import { createInterface } from "node:readline";
import {
  FileCredentialStore,
  createCodexModels,
  credentialPath,
  loginCodex,
  openBrowser,
} from "../lib/index.js";

const args = process.argv.slice(2);
const logout = args.includes("--logout");
const deviceCode = args.includes("--device-code");

const store = new FileCredentialStore(credentialPath());
const models = createCodexModels(store);

if (logout) {
  await store.delete("openai-codex");
  console.log("Removed the stored Codex OAuth credential.");
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

const interaction = {
  notify(event) {
    switch (event.type) {
      case "auth_url":
        console.log(`\n${event.instructions ?? "Complete the login to finish."}\n`);
        console.log(event.url + "\n");
        openBrowser(event.url);
        break;
      case "device_code":
        console.log(`\nOpen ${event.verificationUri} and enter the code: ${event.userCode}\n`);
        console.log(`(expires in ${event.expiresInSeconds}s)\n`);
        break;
      case "info":
        console.log(event.message);
        break;
      case "progress":
        console.log(event.message);
        break;
    }
  },
  prompt: async (prompt) => {
    if (prompt.type === "select") return deviceCode ? "device_code" : "browser";
    if (prompt.type === "manual_code") {
      return ask("If your browser did not open, complete the login and paste the redirect URL/code here (or press Enter to keep waiting): ");
    }
    if (prompt.type === "text") return ask(`${prompt.message} `);
    if (prompt.type === "secret") return ask(`${prompt.message} `);
    return "";
  },
};

try {
  const method = deviceCode ? "device_code" : "browser";
  await loginCodex(models, interaction, method);
  console.log("\nCodex Pro login complete. The credential is stored in " + credentialPath());
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`\nCodex login failed: ${detail}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
