// fleet/auto: one pi model that answers from whichever fleet server is up.
// Install: copy to ~/.pi/agent/extensions/fleet-router.ts (pi loads every file there).
// Order is tried top to bottom; a server counts as up when GET <baseUrl>/models answers.
// Override the order with FLEET_ROUTER_ORDER="provider/id,provider/id".
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Placeholders: put your own models here, best first, as "provider/model-id" exactly as `pi --list-models`
// prints them (the provider is the one in ~/.pi/agent/models.json), or set FLEET_ROUTER_ORDER instead.
const DEFAULT_ORDER = [
  "my-gpu-server/my-large-model",
  "my-second-server/my-large-model",
  "my-laptop/my-small-model",
];
const UP_FOR_MS = 20_000;
const DOWN_FOR_MS = 60_000;
const PROBE_MS = 1500;
const HEADROOM = 8192; // tokens kept free for the answer

// An unset or empty FLEET_ROUTER_ORDER means the list above.
const fromEnv = (process.env.FLEET_ROUTER_ORDER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const order = fromEnv.length ? fromEnv : DEFAULT_ORDER;
const seen = new Map<string, { up: boolean; until: number }>();

function split(ref: string) {
  const i = ref.indexOf("/");
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

async function isUp(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  const hit = seen.get(baseUrl);
  if (hit && hit.until > Date.now()) return hit.up;
  let up = false;
  try {
    const timeout = AbortSignal.timeout(PROBE_MS);
    const r = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    up = r.ok;
  } catch {
    up = false;
  }
  seen.set(baseUrl, { up, until: Date.now() + (up ? UP_FOR_MS : DOWN_FOR_MS) });
  return up;
}

function markDown(baseUrl: string) {
  seen.set(baseUrl, { up: false, until: Date.now() + DOWN_FOR_MS });
}

// Rough size of the conversation: 4 characters per token.
function estimateTokens(messages: readonly any[]): number {
  let chars = 0;
  for (const m of messages) {
    const c = m?.content;
    if (typeof c === "string") chars += c.length;
    else if (Array.isArray(c)) for (const part of c) chars += JSON.stringify(part ?? "").length;
  }
  return Math.ceil(chars / 4);
}

// Errors that mean "this server can't take it now", as opposed to a bad request.
const SERVER_TROUBLE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|fetch failed|socket|timed? ?out|overload|unavailable|\b5\d\d\b|context|too long|maximum context/i;

export default function (pi: ExtensionAPI) {
  pi.registerVirtualModel({
    provider: "fleet",
    id: "auto",
    name: "Fleet auto (first server that is up)",
    thinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 131072,
    maxTokens: 32768,
    input: ["text"],
    async route(request, ctx: any) {
      const level = request.thinkingLevel;
      const sticky = request.failed ?? request.previous;

      // Tool follow-ups stay on the model that is handling the turn (keeps the prompt cache).
      if (request.reason === "continuation" && request.previous) {
        return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? level };
      }

      let skip: string | undefined;
      if (request.reason === "retry" && request.failed) {
        const err = String(request.failed.message?.errorMessage ?? "");
        if (!SERVER_TROUBLE.test(err)) {
          return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? level };
        }
        skip = request.failed.model.baseUrl;
        if (skip) markDown(skip);
      }

      const need = estimateTokens(request.messages) + HEADROOM;
      const fits = (m: any) => !m.contextWindow || m.contextWindow >= need;

      // Keep the model that answered last if it is still up and big enough.
      if (request.reason !== "retry" && sticky && fits(sticky.model) && sticky.model.baseUrl &&
          (await isUp(sticky.model.baseUrl, request.signal))) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? level };
      }

      const tried: string[] = [];
      for (const ref of order) {
        if (ref.indexOf("/") < 1) { tried.push(`${ref} (not "provider/model-id")`); continue; }
        const { provider, id } = split(ref);
        const model = ctx?.modelRegistry?.find(provider, id);
        if (!model) { tried.push(`${ref} (pi has no such model)`); continue; }
        if (!model.baseUrl) { tried.push(`${ref} (no baseUrl)`); continue; }
        if (model.baseUrl === skip) { tried.push(`${ref} (just failed)`); continue; }
        if (!fits(model)) { tried.push(`${ref} (context ${model.contextWindow} < ${need})`); continue; }
        if (await isUp(model.baseUrl, request.signal)) return { model, thinkingLevel: level };
        tried.push(`${ref} (down)`);
      }
      throw new Error(`fleet/auto: no model to answer. Tried ${tried.join(", ")}. ` +
        "Set FLEET_ROUTER_ORDER (or DEFAULT_ORDER in fleet-router.ts) to names from `pi --list-models`.");
    },
  });
}
