#!/usr/bin/env bun
/**
 * talent-agent / server.ts
 * Local web app: serves the dossier UI, a JSON API over talent.db, and a WS live feed.
 * Bind 127.0.0.1 only — it drives the user's real Chrome via WebBridge.
 */

import type { ServerWebSocket } from "bun";
import { defaultConfig, createRun, preflight as realPreflight } from "./core/agent.ts";
import { talentSkill } from "./skills/talent/index.ts";
import { buildSendPrompt } from "./skills/talent/prompts.ts";
import { storeCandidateTool } from "./tools/storage.ts";
import { webbridgeSendTools } from "./tools/webbridge.ts";
import { nextRunId, updateOutreach, setOutreachStatus } from "./core/memory.ts";
import { listRunsView, getRunView } from "./web/api.ts";
import { createRunManager, RunActiveError, NotActiveError, type RunManager, type LaunchParams, type SendParams } from "./web/runManager.ts";

const DASHBOARD = `${import.meta.dir}/../web/dashboard.html`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface ServerOptions {
  port?: number;
  manager?: RunManager;
  preflight?: () => void;
}

export function makeServer(opts: ServerOptions = {}) {
  const clients = new Set<ServerWebSocket<unknown>>();
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) { try { ws.send(data); } catch { /* dropped */ } }
  };

  const preflight = opts.preflight ?? realPreflight;

  const manager: RunManager = opts.manager ?? createRunManager({
    broadcast,
    createRun: (config, options) => createRun(config, options),
    buildConfigAndPrompt: (p: LaunchParams) => {
      let tools = [...talentSkill.tools];
      if (!p.notion) tools = tools.filter(t => t.name !== "save_to_notion");
      if (!p.telegram) tools = tools.filter(t => t.name !== "notify_recruiter");
      // Own the runId here and pass it in, so the id in the prompt, the DB row,
      // and the WS event key are guaranteed identical (no fragile parse-back).
      const runId = nextRunId(p.spec);
      const prompt = talentSkill.buildPrompt(p.spec, runId, p.jd);
      const config = defaultConfig({
        workDir: process.cwd(),
        thinking: p.thinking,
        agentFile: `${process.cwd()}/agent.yaml`,
        mcpConfig: `${process.cwd()}/mcp.json`,
      });
      return { config, prompt, tools, runId };
    },
    buildSendJob: (p: SendParams) => {
      const config = defaultConfig({
        workDir: process.cwd(),
        thinking: false,            // deterministic for a single send
        agentFile: `${process.cwd()}/agent.yaml`,
        mcpConfig: `${process.cwd()}/mcp.json`,
      });
      const prompt = buildSendPrompt({ runId: p.runId, name: p.name, linkedinUrl: p.linkedinUrl, note: p.note });
      return { config, prompt, tools: [...webbridgeSendTools, storeCandidateTool], jobId: `send-${Date.now()}` };
    },
  });

  const server = Bun.serve({
    port: opts.port ?? Number(process.env["PORT"] ?? 3000),
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/ws") {
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return new Response("ws upgrade failed", { status: 400 });
      }

      if (pathname === "/" || pathname === "/index.html") {
        return new Response(Bun.file(DASHBOARD));
      }

      if (pathname === "/api/runs" && req.method === "GET") {
        return json(listRunsView());
      }

      if (pathname === "/api/runs" && req.method === "POST") {
        let body: Partial<LaunchParams> = {};
        try { body = await req.json() as Partial<LaunchParams>; } catch { /* empty */ }
        if (!body.spec || !String(body.spec).trim()) return json({ error: "spec is required" }, 400);
        try { preflight(); } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        try {
          const { runId } = manager.launch({
            spec: String(body.spec),
            jd: typeof body.jd === "string" && body.jd.trim() ? body.jd.trim() : undefined,
            thinking: body.thinking ?? true,
            notion: body.notion ?? true,
            telegram: body.telegram ?? true,
          });
          return json({ runId });
        } catch (e) {
          if (e instanceof RunActiveError) return json({ error: e.message, activeRunId: manager.activeRunId() }, 409);
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      const interruptMatch = pathname.match(/^\/api\/runs\/([^/]+)\/interrupt$/);
      if (interruptMatch && req.method === "POST") {
        try { await manager.interrupt(interruptMatch[1]); return json({ ok: true }); }
        catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof NotActiveError ? 409 : 500); }
      }

      const steerMatch = pathname.match(/^\/api\/runs\/([^/]+)\/steer$/);
      if (steerMatch && req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { message?: string };
        if (!body.message) return json({ error: "message is required" }, 400);
        try { await manager.steer(steerMatch[1], body.message); return json({ ok: true }); }
        catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof NotActiveError ? 409 : 500); }
      }

      const replayMatch = pathname.match(/^\/api\/runs\/([^/]+)\/replay$/);
      if (replayMatch && req.method === "GET") {
        return handleReplay(replayMatch[1]);
      }

      // Edit a candidate's outreach draft (persisted before/independent of sending).
      const editMatch = pathname.match(/^\/api\/runs\/([^/]+)\/candidate\/([^/]+)\/outreach$/);
      if (editMatch && req.method === "POST") {
        const view = getRunView(editMatch[1]);
        if (!view) return json({ error: "run not found" }, 404);
        const cand = view.candidates.find(c => c.id === editMatch[2]);
        if (!cand) return json({ error: "candidate not found" }, 404);
        const body = await req.json().catch(() => ({})) as { linkedinMessage?: string; emailBody?: string };
        const patch: Record<string, unknown> = {};
        if (typeof body.linkedinMessage === "string") patch["linkedinMessage"] = body.linkedinMessage;
        if (typeof body.emailBody === "string") patch["emailBody"] = body.emailBody;
        if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
        updateOutreach(cand.url, patch);
        broadcast({ type: "candidates_updated", runId: editMatch[1] });
        return json({ ok: true });
      }

      // Send outreach to ONE candidate (human-approved). Uses the (optionally edited) note.
      const sendMatch = pathname.match(/^\/api\/runs\/([^/]+)\/send$/);
      if (sendMatch && req.method === "POST") {
        const view = getRunView(sendMatch[1]);
        if (!view) return json({ error: "run not found" }, 404);
        const body = await req.json().catch(() => ({})) as { candidateId?: string; note?: string };
        const cand = view.candidates.find(c => c.id === body.candidateId);
        if (!cand) return json({ error: "candidate not found" }, 404);
        const note = (typeof body.note === "string" && body.note.trim()) ? body.note.trim() : cand.li;
        if (!note) return json({ error: "no outreach note to send" }, 400);
        if (typeof body.note === "string" && body.note.trim() && body.note.trim() !== cand.li) {
          updateOutreach(cand.url, { linkedinMessage: body.note.trim() }); // persist the edit
        }
        try { preflight(); } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        try {
          const { jobId } = manager.sendOutreach({ runId: sendMatch[1], linkedinUrl: cand.url, name: cand.name, note });
          setOutreachStatus(cand.url, "sending");
          broadcast({ type: "candidates_updated", runId: sendMatch[1] });
          return json({ jobId });
        } catch (e) {
          if (e instanceof RunActiveError) return json({ error: e.message, activeRunId: manager.activeRunId() }, 409);
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && req.method === "GET") {
        const view = getRunView(runMatch[1]);
        return view ? json(view) : json({ error: "run not found" }, 404);
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { clients.add(ws); ws.send(JSON.stringify({ type: "hello", activeRunId: manager.activeRunId() })); },
      close(ws) { clients.delete(ws); },
      message() { /* client → server messages unused; control is via REST */ },
    },
  });

  return { port: server.port as number, stop: () => server.stop(true), broadcast };
}

/** Replay a finished run's stored Kimi session events as mapped AgentEvents. */
async function handleReplay(runId: string): Promise<Response> {
  const { parseSessionEvents } = await import("@moonshot-ai/kimi-agent-sdk");
  const { createEventAssembler } = await import("./core/agent.ts");
  const run = listRunsView().find(r => r.runId === runId);
  if (!run) return json({ error: "run not found" }, 404);
  if (!run.kimiSessionId) return json({ error: "no kimi session id stored for this run" }, 409);
  try {
    const events = await parseSessionEvents(process.cwd(), run.kimiSessionId);
    // Run persisted events through the same assembler as live runs so replayed
    // tool calls carry their full reassembled arguments (not empty inputs).
    const assembler = createEventAssembler();
    const mapped: unknown[] = [];
    for (const e of events) for (const m of assembler.push(e)) mapped.push(m);
    for (const m of assembler.flush()) mapped.push(m);
    return json({ runId, events: mapped });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

// Start when run directly: `bun src/server.ts`
if (import.meta.main) {
  const { port } = makeServer();
  console.log(`\x1b[1m🎯 Talent Agent web\x1b[0m → http://127.0.0.1:${port}`);
}
