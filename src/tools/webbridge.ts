/**
 * talent-agent / tools / webbridge.ts
 *
 * Authenticated browser control via Kimi WebBridge (port 10086).
 *
 * Replaces Playwright MCP — Playwright launches an *anonymous* Chrome that
 * hits LinkedIn's authwall on ~90% of profiles. WebBridge drives the user's
 * *real* Chrome session, which is daily-logged-in to LinkedIn.
 *
 * Tools exported as ExternalTools (Kimi external_tools wire protocol):
 *
 *   - webbridge_navigate(url, newTab?, session?)
 *   - webbridge_snapshot(session?)       → accessibility tree (text)
 *   - webbridge_evaluate(code, session?) → run JS, return value
 *   - webbridge_click(selector, session?)
 *   - webbridge_screenshot(filename?, session?) → saves PNG, returns path
 *
 * All tools default to session "talent" so every profile shares a tab group.
 * Screenshots are saved to disk; never returned as base64 (context flood).
 */

import type { ExternalTool } from "@moonshot-ai/kimi-agent-sdk";
import { jsonSchema } from "../core/types.ts";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const WB_URL = "http://127.0.0.1:10086/command";
const DEFAULT_SESSION = "talent";
const SCREENSHOT_DIR = "/tmp/talent-screenshots";

/** Low-level WebBridge POST. */
async function wb(
  action: string,
  args: Record<string, unknown> = {},
  session: string = DEFAULT_SESSION
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const body = JSON.stringify({ action, ...args, session });
  try {
    const res = await fetch(WB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      return { ok: false, error: `webbridge HTTP ${res.status}` };
    }
    return (await res.json()) as { ok: boolean; data?: unknown; error?: string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `webbridge unreachable: ${msg}` };
  }
}

/** Truncate large strings before sending back to the model. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

// ─── webbridge_navigate ────────────────────────────────────────────────────

export const webbridgeNavigateTool: ExternalTool = {
  name: "webbridge_navigate",
  description: `Open a URL in the user's real (authenticated) Chrome browser via Kimi WebBridge.
Use this INSTEAD of any browser_navigate / playwright tools — the user is logged into LinkedIn here, so profile pages render fully (not the authwall).
Always pass newTab=true on the FIRST navigate. Subsequent navigations in the same session reuse the tab.
After navigate, ALWAYS wait by calling webbridge_snapshot to read the page.
Returns: { url, tabId, ok }.`,
  parameters: jsonSchema(
    {
      url: { type: "string", description: "Full URL to open (https://…)" },
      newTab: { type: "boolean", description: "Open in a new tab (default: true on first call)" },
      session: { type: "string", description: "Session/tab-group name (default: talent)" },
    },
    ["url"]
  ),
  handler: async (params) => {
    const url = String(params["url"] ?? "").trim();
    if (!url) return { output: "error: url is required", message: "validation_failed" };
    const newTab = params["newTab"] !== false; // default true
    const session = String(params["session"] ?? DEFAULT_SESSION);

    const res = await wb("navigate", { url, newTab }, session);
    if (!res.ok) {
      return { output: `error: ${res.error ?? "navigate failed"}`, message: "webbridge_error" };
    }
    return {
      output: JSON.stringify({ ok: true, data: res.data }),
      message: `navigated to ${url}`,
    };
  },
};

// ─── webbridge_snapshot ────────────────────────────────────────────────────

export const webbridgeSnapshotTool: ExternalTool = {
  name: "webbridge_snapshot",
  description: `Read the current page as an accessibility tree (text). This is the PRIMARY way to extract content from LinkedIn profiles.
Returns the page's URL, title, and a structured snapshot of interactive + text elements with @e refs you can pass to webbridge_click.
The snapshot is capped at ~12000 chars; use webbridge_evaluate for targeted extraction if you need more.
Detect the authwall by checking if the URL contains "/authwall" or the title is "Sign In" — in that case skip the profile.`,
  parameters: jsonSchema(
    {
      session: { type: "string", description: "Session/tab-group name (default: talent)" },
    },
    []
  ),
  handler: async (params) => {
    const session = String(params["session"] ?? DEFAULT_SESSION);
    const res = await wb("snapshot", {}, session);
    if (!res.ok) {
      return { output: `error: ${res.error ?? "snapshot failed"}`, message: "webbridge_error" };
    }
    const data = res.data as { url?: string; title?: string; tree?: unknown } | undefined;
    const url = data?.url ?? "";
    const title = data?.title ?? "";
    const treeRaw = data?.tree;
    const treeStr =
      typeof treeRaw === "string" ? treeRaw : JSON.stringify(treeRaw ?? null);

    const authwalled =
      /\/authwall|\/login|\/checkpoint/i.test(url) ||
      /^sign in|^join now/i.test(title.trim());

    const payload = {
      url,
      title,
      authwalled,
      tree: clip(treeStr, 12000),
    };
    return {
      output: JSON.stringify(payload),
      message: authwalled ? `authwall detected at ${url}` : `snapshot ${url}`,
    };
  },
};

// ─── webbridge_evaluate ────────────────────────────────────────────────────

export const webbridgeEvaluateTool: ExternalTool = {
  name: "webbridge_evaluate",
  description: `Run JavaScript in the current page (the real authenticated Chrome session). Use this for targeted extraction when the snapshot tree is insufficient.
Supports async/await. Always return a JSON-serializable value via JSON.stringify (compact, no formatting) to avoid context truncation.
Wrap multi-statement code in an IIFE: (() => { ... })().
Returns the value field of the result, truncated to 8000 chars.`,
  parameters: jsonSchema(
    {
      code: { type: "string", description: "JavaScript expression or IIFE returning a value" },
      session: { type: "string", description: "Session/tab-group name (default: talent)" },
    },
    ["code"]
  ),
  handler: async (params) => {
    const code = String(params["code"] ?? "").trim();
    if (!code) return { output: "error: code is required", message: "validation_failed" };
    const session = String(params["session"] ?? DEFAULT_SESSION);

    const res = await wb("evaluate", { code }, session);
    if (!res.ok) {
      return { output: `error: ${res.error ?? "evaluate failed"}`, message: "webbridge_error" };
    }
    const d = res.data as { value?: unknown; type?: string } | unknown;
    const value =
      d !== null && typeof d === "object" && "value" in (d as object)
        ? (d as { value?: unknown }).value
        : d;
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value ?? null);
    return {
      output: clip(serialized, 8000),
      message: "evaluate ok",
    };
  },
};

// ─── webbridge_click ────────────────────────────────────────────────────────

export const webbridgeClickTool: ExternalTool = {
  name: "webbridge_click",
  description: `Click an element by @e ref (from snapshot) or CSS selector. Useful for "Show more" buttons on LinkedIn profiles.
Returns the tag + visible text of the clicked element.`,
  parameters: jsonSchema(
    {
      selector: { type: "string", description: "@e ref (e.g. @e123) or CSS selector" },
      session: { type: "string", description: "Session/tab-group name (default: talent)" },
    },
    ["selector"]
  ),
  handler: async (params) => {
    const selector = String(params["selector"] ?? "").trim();
    if (!selector) return { output: "error: selector is required", message: "validation_failed" };
    const session = String(params["session"] ?? DEFAULT_SESSION);

    const res = await wb("click", { selector }, session);
    if (!res.ok) {
      return { output: `error: ${res.error ?? "click failed"}`, message: "webbridge_error" };
    }
    return { output: JSON.stringify(res.data ?? { ok: true }), message: "clicked" };
  },
};

// ─── webbridge_type ──────────────────────────────────────────────────────────

export const webbridgeTypeTool: ExternalTool = {
  name: "webbridge_type",
  description: `Type text into a text input or textarea (e.g. a LinkedIn connection-note box or message composer).
Sets the value using the native React-safe setter and fires input/change events, so React-controlled fields (LinkedIn) register the text.
Pass a CSS selector for the field; if omitted, the currently focused element is used (click the field first).
Returns { ok, len } with the resulting field length so you can verify the text landed.`,
  parameters: jsonSchema(
    {
      text: { type: "string", description: "The exact text to type (e.g. the connection note)" },
      selector: { type: "string", description: "CSS selector of the input/textarea (optional; defaults to the focused element)" },
      session: { type: "string", description: "Session/tab-group name (default: talent)" },
    },
    ["text"]
  ),
  handler: async (params) => {
    const text = String(params["text"] ?? "");
    if (!text) return { output: "error: text is required", message: "validation_failed" };
    const selector = params["selector"] != null ? String(params["selector"]) : "";
    const session = String(params["session"] ?? DEFAULT_SESSION);

    // Build React-safe value-set code; JSON.stringify handles escaping of both args.
    const targetExpr = selector ? `document.querySelector(${JSON.stringify(selector)})` : `document.activeElement`;
    const code = `(() => {
      const el = ${targetExpr};
      if (!el || !('value' in el)) return JSON.stringify({ ok: false, error: "no editable element" });
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return JSON.stringify({ ok: true, len: el.value.length });
    })()`;

    const res = await wb("evaluate", { code }, session);
    if (!res.ok) return { output: `error: ${res.error ?? "type failed"}`, message: "webbridge_error" };
    const d = res.data as { value?: unknown } | undefined;
    const value = d && typeof d === "object" && "value" in d ? (d as { value?: unknown }).value : d;
    return { output: typeof value === "string" ? value : JSON.stringify(value ?? null), message: "typed" };
  },
};

// ─── webbridge_screenshot ──────────────────────────────────────────────────

export const webbridgeScreenshotTool: ExternalTool = {
  name: "webbridge_screenshot",
  description: `Capture a screenshot of the current page and save it to disk. Returns the file path (NOT base64 - that would flood the context).
Use sparingly - the snapshot tree usually gives you what you need. Useful for debugging or for visual verification of a profile.`,
  parameters: jsonSchema(
    {
      filename: { type: "string", description: "Output filename (default: auto timestamp under /tmp/talent-screenshots/)" },
      session: { type: "string", description: "Session/tab-group name (default: talent)" },
    },
    []
  ),
  handler: async (params) => {
    const session = String(params["session"] ?? DEFAULT_SESSION);
    const fileArg = String(params["filename"] ?? "").trim();
    const outPath = fileArg
      ? (fileArg.startsWith("/") ? fileArg : `${SCREENSHOT_DIR}/${fileArg}`)
      : `${SCREENSHOT_DIR}/shot-${Date.now()}.png`;

    if (!existsSync(dirname(outPath))) {
      mkdirSync(dirname(outPath), { recursive: true });
    }

    const res = await wb("screenshot", { format: "png" }, session);
    if (!res.ok) {
      return { output: `error: ${res.error ?? "screenshot failed"}`, message: "webbridge_error" };
    }
    const d = res.data as { format?: string; data?: string; dataLength?: number } | undefined;
    const b64 = d?.data;
    if (!b64 || typeof b64 !== "string") {
      return { output: "error: webbridge returned no image data", message: "webbridge_error" };
    }
    try {
      writeFileSync(outPath, Buffer.from(b64, "base64"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `error: write failed: ${msg}`, message: "fs_error" };
    }
    return {
      output: JSON.stringify({ path: outPath, bytes: Buffer.from(b64, "base64").length }),
      message: `saved screenshot ${outPath}`,
    };
  },
};

// ─── Bundle ────────────────────────────────────────────────────────────────

// Note: webbridgeScreenshotTool is intentionally NOT registered — screenshots
// are not used by the agent (snapshot + evaluate cover extraction). The tool
// definition is kept above for ad-hoc/manual use but excluded from the bundle.
export const webbridgeTools: ExternalTool[] = [
  webbridgeNavigateTool,
  webbridgeSnapshotTool,
  webbridgeEvaluateTool,
  webbridgeClickTool,
];

// Send flow additionally needs typing into the note/message composer.
export const webbridgeSendTools: ExternalTool[] = [
  webbridgeNavigateTool,
  webbridgeSnapshotTool,
  webbridgeEvaluateTool,
  webbridgeClickTool,
  webbridgeTypeTool,
];
