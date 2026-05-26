import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { Server } from "node:http";
import { z } from "zod";
import {
  ApprovalRequestSchema,
  WorkerRegistrationSchema,
  UserDecisionSchema,
  SessionSpawnRequestSchema,
  SessionInputRequestSchema,
  SessionSchema,
  HMAC_HEADER_SIGNATURE,
  HMAC_HEADER_TIMESTAMP,
  signPayload,
  type ApprovalRequest,
  type HubNotification,
  type InterfaceAdapter,
  type Session,
} from "@wazir/protocol";
import { openDatabase } from "./db.js";
import { ApprovalStore, WorkerStore, SessionStore, ChatStateStore, SessionLabelStore } from "./store.js";
import { HubSessionService } from "./sessionService.js";
import { createHmacMiddleware, rawBodyCapture, type RawBodyRequest } from "./hmacMiddleware.js";
import { RateLimiter } from "./rateLimit.js";
import { AdapterRegistry } from "./adapterRegistry.js";
import { PendingApprovalRegistry } from "./pendingApprovals.js";
import { createLogger, type HubLogger } from "./logger.js";

export interface HubStartOptions {
  bindHost: string;
  bindPort: number;
  dbPath: string;
  hmacSecret: string;
  adapters: InterfaceAdapter[];
  logger?: HubLogger;
}

export interface HubHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export async function startHub(opts: HubStartOptions): Promise<HubHandle> {
  const logger = opts.logger ?? createLogger();
  const db = openDatabase(opts.dbPath);
  const approvals = new ApprovalStore(db);
  const workers = new WorkerStore(db);
  const sessions = new SessionStore(db);
  const chatStates = new ChatStateStore(db);
  const sessionLabels = new SessionLabelStore(db);
  const sessionService = new HubSessionService(sessions, workers, chatStates, sessionLabels, opts.hmacSecret, logger);
  const workerDecisionLimiter = new RateLimiter(60, 60_000);
  const workerSubmitLimiter = new RateLimiter(120, 60_000);

  const pending = new PendingApprovalRegistry(logger, async (approvalId) => {
    const row = approvals.getApproval(approvalId);
    if (!row || row.status !== "pending") return;
    approvals.markTimedOut(approvalId, Date.now());
    await registry.cancel(approvalId, "timed_out");
    await postCallback(row.callback_url, {
      request_id: row.request_id,
      decision: "reject",
      command: row.command,
      actor: "system:timeout",
    });
  });

  const registry = new AdapterRegistry(logger, async (approvalId, decision) => {
    const row = approvals.getApproval(approvalId);
    if (!row) {
      logger.warn({ approval_id: approvalId }, "decision for unknown approval");
      return;
    }
    if (row.status !== "pending") {
      logger.warn({ approval_id: approvalId, status: row.status }, "decision for non-pending approval");
      return;
    }
    if (!workerDecisionLimiter.allow(decision.actor)) {
      logger.warn({ actor: decision.actor }, "decision rate limited");
      return;
    }
    const finalCommand = decision.action === "modify" ? decision.modified_command ?? row.command : row.command;
    const updated = approvals.decideApproval(
      approvalId,
      decision.action,
      finalCommand,
      decision.actor,
      Date.now(),
    );
    if (!updated) return;
    pending.resolve(approvalId);
    await postCallback(row.callback_url, {
      request_id: row.request_id,
      decision: decision.action,
      command: finalCommand,
      actor: decision.actor,
    });
  }, sessionService);

  for (const adapter of opts.adapters) {
    await registry.register(adapter);
  }

  const app = express();
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => rawBodyCapture(req as RawBodyRequest, _res as Response, buf),
    }),
  );

  const hmac = createHmacMiddleware(opts.hmacSecret);

  app.get("/v1/health", (_req, res) => {
    res.json({
      ok: true,
      adapters: registry.names(),
      workers: workers.listWorkers().length,
    });
  });

  app.post("/v1/workers", hmac, (req: RawBodyRequest, res: Response) => {
    const parsed = WorkerRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    workers.upsertWorker(parsed.data, Date.now());
    res.json({ registered_at: new Date().toISOString() });
  });

  app.post("/v1/workers/:worker_id/heartbeat", hmac, (req: RawBodyRequest, res: Response) => {
    const workerId = req.params.worker_id;
    if (!workerId) {
      res.status(400).json({ error: "missing_worker_id" });
      return;
    }
    const ok = workers.heartbeat(workerId, Date.now());
    if (!ok) {
      res.status(404).json({ error: "unknown_worker" });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/v1/approvals", hmac, async (req: RawBodyRequest, res: Response) => {
    const parsed = ApprovalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const approvalReq: ApprovalRequest = parsed.data;
    if (!workerSubmitLimiter.allow(approvalReq.worker_id)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    const approvalId = randomUUID();
    const now = Date.now();
    approvals.insertApproval(approvalId, approvalReq, now);

    const notification = buildNotification(approvalId, approvalReq, now);
    pending.track(
      approvalId,
      approvalReq.callback_url,
      approvalReq.worker_id,
      approvalReq.command,
      approvalReq.timeout_seconds * 1000,
    );

    try {
      await registry.broadcast(notification);
      desktopNotify(notification.title, notification.body);
    } catch (err) {
      logger.error({ err, approval_id: approvalId }, "broadcast failed; rejecting approval");
      pending.resolve(approvalId);
      approvals.decideApproval(approvalId, "reject", approvalReq.command, "system:broadcast_failed", Date.now());
      res.status(502).json({ error: "no_adapter_reachable", approval_id: approvalId });
      return;
    }

    res.status(202).json({ approval_id: approvalId });
  });

  app.post("/v1/approvals/:approval_id/decide", async (req: Request, res: Response) => {
    const approvalId = req.params.approval_id;
    if (!approvalId) {
      res.status(400).json({ error: "missing_approval_id" });
      return;
    }
    const parsed = UserDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const row = approvals.getApproval(approvalId);
    if (!row) {
      res.status(404).json({ error: "unknown_approval" });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({ error: "already_decided", status: row.status });
      return;
    }
    const decision = parsed.data;
    if (!workerDecisionLimiter.allow(decision.actor)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const finalCommand = decision.action === "modify" ? decision.modified_command ?? row.command : row.command;
    const updated = approvals.decideApproval(approvalId, decision.action, finalCommand, decision.actor, Date.now());
    if (!updated) {
      res.status(409).json({ error: "race_condition" });
      return;
    }
    pending.resolve(approvalId);
    await postCallback(row.callback_url, {
      request_id: row.request_id,
      decision: decision.action,
      command: finalCommand,
      actor: decision.actor,
    });
    res.json({ ok: true });
  });

  app.get("/v1/approvals", hmac, (_req: RawBodyRequest, res: Response) => {
    const limitRaw = (_req.query.limit as string | undefined) ?? "20";
    const limit = Math.min(200, Math.max(1, Number.parseInt(limitRaw, 10) || 20));
    res.json({ approvals: approvals.recentApprovals(limit) });
  });

  // -----------------------------------------------------------------
  // Session endpoints — hub-mediated CRUD. Hub forwards to worker by URL.
  // -----------------------------------------------------------------

  function pickWorker(workerId?: string) {
    if (workerId) return workers.getWorker(workerId);
    const all = workers.listWorkers();
    return all[0];
  }

  async function forwardToWorker(
    workerUrl: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(opts.hmacSecret, raw, ts);
    const init: RequestInit = {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        [HMAC_HEADER_SIGNATURE]: sig,
        [HMAC_HEADER_TIMESTAMP]: String(ts),
      },
      ...(body !== undefined ? { body: raw } : {}),
    };
    const res = await fetch(`${workerUrl}${path}`, init);
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  app.post("/v1/sessions", hmac, async (req: RawBodyRequest, res: Response) => {
    const parsed = SessionSpawnRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const workerIdRaw = req.query.worker_id;
    const workerId = typeof workerIdRaw === "string" ? workerIdRaw : undefined;
    const worker = pickWorker(workerId);
    if (!worker || !worker.worker_url) {
      res.status(503).json({ error: "no_worker_available" });
      return;
    }
    try {
      const result = await forwardToWorker(worker.worker_url, "POST", "/v1/sessions/spawn", parsed.data);
      if (result.status !== 200) {
        res.status(result.status).json(result.body ?? { error: "worker_error" });
        return;
      }
      const session = SessionSchema.parse(result.body);
      sessions.upsert(session);
      res.status(201).json(session);
    } catch (err) {
      logger.error({ err }, "session spawn forwarding failed");
      res.status(502).json({ error: "worker_unreachable", detail: (err as Error).message });
    }
  });

  app.get("/v1/sessions", hmac, (req: RawBodyRequest, res: Response) => {
    const workerIdRaw = req.query.worker_id;
    const cwdRaw = req.query.cwd;
    const rows = sessions.list({
      workerId: typeof workerIdRaw === "string" ? workerIdRaw : undefined,
      cwd: typeof cwdRaw === "string" ? cwdRaw : undefined,
    });
    res.json({ sessions: rows });
  });

  app.get("/v1/sessions/:session_id", hmac, (req: RawBodyRequest, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    const row = sessions.get(sessionId);
    if (!row) { res.status(404).json({ error: "unknown_session" }); return; }
    res.json(row);
  });

  app.post("/v1/sessions/:session_id/input", hmac, async (req: RawBodyRequest, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    const parsed = SessionInputRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const row = sessions.get(sessionId);
    if (!row) { res.status(404).json({ error: "unknown_session" }); return; }
    const worker = workers.getWorker(row.worker_id);
    if (!worker || !worker.worker_url) {
      res.status(503).json({ error: "worker_unavailable" });
      return;
    }
    try {
      const result = await forwardToWorker(
        worker.worker_url,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionId)}/input`,
        parsed.data,
      );
      res.status(result.status).json(result.body ?? {});
    } catch (err) {
      res.status(502).json({ error: "worker_unreachable", detail: (err as Error).message });
    }
  });

  app.get("/v1/sessions/:session_id/capture", hmac, async (req: RawBodyRequest, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    const row = sessions.get(sessionId);
    if (!row) { res.status(404).json({ error: "unknown_session" }); return; }
    const worker = workers.getWorker(row.worker_id);
    if (!worker || !worker.worker_url) {
      res.status(503).json({ error: "worker_unavailable" });
      return;
    }
    try {
      const since = typeof req.query.since === "string" ? `?since=${encodeURIComponent(req.query.since)}` : "";
      const result = await forwardToWorker(
        worker.worker_url,
        "GET",
        `/v1/sessions/${encodeURIComponent(sessionId)}/capture${since}`,
      );
      res.status(result.status).json(result.body ?? {});
    } catch (err) {
      res.status(502).json({ error: "worker_unreachable", detail: (err as Error).message });
    }
  });

  app.delete("/v1/sessions/:session_id", hmac, async (req: RawBodyRequest, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    const row = sessions.get(sessionId);
    if (!row) { res.status(404).json({ error: "unknown_session" }); return; }
    const worker = workers.getWorker(row.worker_id);
    if (worker?.worker_url) {
      try {
        await forwardToWorker(
          worker.worker_url,
          "DELETE",
          `/v1/sessions/${encodeURIComponent(sessionId)}`,
        );
      } catch (err) {
        logger.warn({ err, session_id: sessionId }, "worker kill forwarding failed (will still drop from registry)");
      }
    }
    sessions.delete(sessionId);
    res.json({ ok: true });
  });

  // -----------------------------------------------------------------
  // Dashboard browser API — same signed worker endpoints under the
  // hood, but un-signed at the network edge because browsers can't
  // compute HMACs. Guard at the network layer (localhost / tailnet).
  // -----------------------------------------------------------------

  app.get("/dashboard/api/sessions", async (_req: Request, res: Response) => {
    try {
      const tracked = await sessionService.listSessions();
      const discovered = await sessionService.listDiscoveredSessions();
      res.json({ tracked, discovered });
    } catch (err) {
      res.status(500).json({ error: "list_failed", detail: (err as Error).message });
    }
  });

  app.post("/dashboard/api/sessions/:session_id/prompt-stream", async (req: Request, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    const body = req.body as { text?: string; cwd?: string };
    if (typeof body?.text !== "string" || body.text.length === 0) {
      res.status(400).json({ error: "missing_text" });
      return;
    }
    const worker = pickWorker();
    if (!worker?.worker_url) {
      res.status(503).json({ error: "no_worker_available" });
      return;
    }
    const cwd = body.cwd ?? sessions.get(sessionId)?.cwd ?? process.env.HOME ?? "/";

    const signedBody = JSON.stringify({ text: body.text, cwd });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(opts.hmacSecret, signedBody, ts);

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${worker.worker_url}/v1/sessions/${encodeURIComponent(sessionId)}/prompt-stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HMAC_HEADER_SIGNATURE]: sig,
          [HMAC_HEADER_TIMESTAMP]: String(ts),
        },
        body: signedBody,
      });
    } catch (err) {
      res.status(502).json({ error: "worker_unreachable", detail: (err as Error).message });
      return;
    }
    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status).json({ error: "worker_error", status: upstream.status });
      return;
    }

    res.set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();

    const reader = upstream.body.getReader();
    req.on("close", () => { reader.cancel().catch(() => {}); });
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
    } catch (err) {
      logger.warn({ err, session_id: sessionId }, "SSE proxy error");
    } finally {
      try { res.end(); } catch { /* already ended */ }
    }
  });

  app.post("/dashboard/api/transcribe", async (req: Request, res: Response) => {
    const worker = pickWorker();
    if (!worker?.worker_url) { res.status(503).json({ error: "no_worker_available" }); return; }
    const body = req.body as { audio_base64?: string; mime_type?: string; language?: string };
    if (typeof body?.audio_base64 !== "string") {
      res.status(400).json({ error: "missing_audio_base64" });
      return;
    }
    try {
      const result = await forwardToWorker(worker.worker_url, "POST", "/v1/transcribe", body);
      res.status(result.status).json(result.body ?? {});
    } catch (err) {
      res.status(502).json({ error: "worker_unreachable", detail: (err as Error).message });
    }
  });

  app.post("/dashboard/api/synthesize", async (req: Request, res: Response) => {
    const worker = pickWorker();
    if (!worker?.worker_url) { res.status(503).json({ error: "no_worker_available" }); return; }
    const body = req.body as { text?: string };
    if (typeof body?.text !== "string" || body.text.length === 0) {
      res.status(400).json({ error: "missing_text" });
      return;
    }
    try {
      const result = await forwardToWorker(worker.worker_url, "POST", "/v1/synthesize", body);
      res.status(result.status).json(result.body ?? {});
    } catch (err) {
      res.status(502).json({ error: "worker_unreachable", detail: (err as Error).message });
    }
  });

  // Serve the dashboard UI itself.
  const DASHBOARD_HTML = buildDashboardHtml();
  app.get(["/dashboard", "/dashboard/"], (_req: Request, res: Response) => {
    res.set("content-type", "text/html; charset=utf-8");
    res.send(DASHBOARD_HTML);
  });

  // Workers post their current session list here on a periodic basis.
  app.post("/v1/workers/:worker_id/sessions", hmac, (req: RawBodyRequest, res: Response) => {
    const workerId = req.params.worker_id;
    if (!workerId) { res.status(400).json({ error: "missing_worker_id" }); return; }
    const list = z.array(SessionSchema).safeParse((req.body as { sessions?: unknown })?.sessions);
    if (!list.success) {
      res.status(400).json({ error: "invalid_body", details: list.error.flatten() });
      return;
    }
    sessions.reconcile(workerId, list.data, Date.now());
    res.json({ ok: true, count: list.data.length });
  });

  async function postCallback(url: string, body: {
    request_id: string;
    decision: "approve" | "reject" | "modify";
    command: string;
    actor: string;
  }): Promise<void> {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(opts.hmacSecret, raw, ts);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HMAC_HEADER_SIGNATURE]: sig,
          [HMAC_HEADER_TIMESTAMP]: String(ts),
        },
        body: raw,
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status, url },
          "callback returned non-2xx",
        );
      }
    } catch (err) {
      logger.error({ err, url }, "callback POST failed");
    }
  }

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.bindPort, opts.bindHost, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.bindPort;
  const url = `http://${opts.bindHost}:${port}`;
  logger.info({ url, adapters: registry.names() }, "hub started");

  return {
    port,
    url,
    stop: async () => {
      await registry.stopAll();
      pending.clearAll();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
      logger.info("hub stopped");
    },
  };
}

/**
 * Fire a non-blocking macOS desktop notification when a new approval is
 * broadcast. Lets the user know to check Telegram or run `wazir pending`.
 * Silently no-ops on non-Mac platforms (osascript missing).
 */
function desktopNotify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  // Strip newlines / quote chars so the AppleScript string stays well-formed.
  const safeTitle = title.replace(/["\\\n]/g, " ").slice(0, 80);
  const safeBody = body.replace(/["\\\n]/g, " ").slice(0, 240);
  const script = `display notification "${safeBody}" with title "Wazir" subtitle "${safeTitle}" sound name "Submarine"`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) {
      // Don't surface — notifications are best-effort.
    }
  });
}

/**
 * Inline, dependency-free dashboard. Single HTML file so we don't need a
 * build pipeline; ship in the hub binary so a user with the hub running
 * gets the UI for free at http://<host>:7842/dashboard.
 *
 * Features:
 *   - Mobile-first chat layout (full viewport, bubbles, sticky input).
 *   - Streaming responses via SSE (consumed with fetch + ReadableStream
 *     because EventSource is GET-only and our prompt is a POST).
 *   - Voice input via MediaRecorder → /dashboard/api/transcribe.
 *   - Voice output: auto-plays TTS for each completed assistant turn.
 *   - Session picker; remembers the chosen session in localStorage.
 */
function buildDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#1e1e2e" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<title>Wazir</title>
<style>
  :root {
    --bg: #1e1e2e;
    --panel: #181826;
    --fg: #cdd6f4;
    --muted: #7f849c;
    --border: #313244;
    --accent: #89b4fa;
    --user: #2b3046;
    --assistant: #1e2336;
    --danger: #f38ba8;
    --safe-top: env(safe-area-inset-top);
    --safe-bottom: env(safe-area-inset-bottom);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    color: var(--fg);
    background: var(--bg);
    -webkit-font-smoothing: antialiased;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
  }
  header {
    padding: calc(var(--safe-top) + 10px) 14px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    z-index: 2;
  }
  header h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--fg);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  header h1 .label { color: var(--accent); }
  header h1 .id { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 4px; }
  header button {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  #picker {
    position: absolute;
    top: calc(var(--safe-top) + 56px);
    left: 8px;
    right: 8px;
    max-height: 70vh;
    overflow: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 6px;
    z-index: 3;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    display: none;
  }
  #picker .item {
    padding: 10px 12px;
    border-radius: 8px;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }
  #picker .item:last-child { border-bottom: none; }
  #picker .item:hover { background: var(--bg); }
  #picker .item .title { font-weight: 600; color: var(--fg); font-size: 14px; }
  #picker .item .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  #picker .item.active { background: var(--bg); }
  #picker .item.active .title::before { content: "★ "; color: var(--accent); }
  main {
    flex: 1;
    overflow-y: auto;
    padding: 14px 12px 8px;
    -webkit-overflow-scrolling: touch;
  }
  .msg {
    max-width: 88%;
    margin: 0 0 10px;
    padding: 10px 13px;
    border-radius: 14px;
    word-wrap: break-word;
    white-space: pre-wrap;
    line-height: 1.5;
  }
  .msg.user {
    background: var(--user);
    align-self: flex-end;
    margin-left: auto;
    border-bottom-right-radius: 4px;
  }
  .msg.assistant {
    background: var(--assistant);
    align-self: flex-start;
    border-bottom-left-radius: 4px;
  }
  .msg.tool {
    background: transparent;
    color: var(--muted);
    font-size: 12px;
    padding: 4px 8px;
    border-left: 2px solid var(--border);
    margin-left: 2px;
    border-radius: 0;
  }
  .msg.error {
    background: transparent;
    color: var(--danger);
    padding: 4px 8px;
    font-size: 13px;
  }
  main { display: flex; flex-direction: column; }
  footer {
    padding: 8px 8px calc(var(--safe-bottom) + 8px);
    background: var(--panel);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  textarea {
    flex: 1;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 10px 14px;
    font: inherit;
    resize: none;
    max-height: 140px;
    min-height: 42px;
    outline: none;
  }
  textarea:focus { border-color: var(--accent); }
  .icon-btn {
    flex: 0 0 42px;
    height: 42px;
    border-radius: 50%;
    border: none;
    background: var(--bg);
    color: var(--fg);
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .icon-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
  .icon-btn.recording { background: var(--danger); color: #1e1e2e; }
  .icon-btn.send { background: var(--accent); color: #1e1e2e; }
  #status { color: var(--muted); font-size: 11px; padding: 4px 14px; }
</style>
</head>
<body>
  <header>
    <h1><span class="label" id="sessionLabel">no session</span><span class="id" id="sessionId"></span></h1>
    <button id="pickerBtn" type="button">switch</button>
  </header>
  <div id="picker"></div>
  <main id="chat"></main>
  <div id="status"></div>
  <footer>
    <button id="micBtn" class="icon-btn" type="button" title="hold to talk">🎙</button>
    <textarea id="input" rows="1" placeholder="message" autocomplete="off" autocorrect="on"></textarea>
    <button id="sendBtn" class="icon-btn send" type="button" title="send">➤</button>
  </footer>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const chat = $("chat");
  const input = $("input");
  const sendBtn = $("sendBtn");
  const micBtn = $("micBtn");
  const picker = $("picker");
  const sessionLabel = $("sessionLabel");
  const sessionIdEl = $("sessionId");
  const status = $("status");
  let activeSessionId = localStorage.getItem("wazir.activeSessionId") || null;
  let activeSessionCwd = localStorage.getItem("wazir.activeSessionCwd") || null;
  let activeSessionTitle = localStorage.getItem("wazir.activeSessionTitle") || null;
  let inflight = false;

  function renderActive() {
    if (!activeSessionId) {
      sessionLabel.textContent = "no session";
      sessionIdEl.textContent = "";
      return;
    }
    sessionLabel.textContent = activeSessionTitle || "session";
    sessionIdEl.textContent = activeSessionId.slice(0, 8);
  }

  function bubble(role, text) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.textContent = text;
    chat.appendChild(div);
    chat.parentElement.scrollTop = chat.parentElement.scrollHeight;
    requestAnimationFrame(() => { div.scrollIntoView({ block: "end" }); });
    return div;
  }

  function setStatus(text) { status.textContent = text || ""; }

  async function refreshSessions() {
    try {
      const r = await fetch("/dashboard/api/sessions");
      if (!r.ok) return;
      const body = await r.json();
      const all = [...(body.tracked || [])];
      for (const d of (body.discovered || [])) {
        if (!all.find((x) => x.session_id === d.session_id)) all.push(d);
      }
      all.sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0));
      renderPicker(all);
      if (!activeSessionId && all.length > 0) {
        chooseSession(all[0]);
      }
    } catch (err) { setStatus("could not load sessions: " + err.message); }
  }

  function chooseSession(s) {
    activeSessionId = s.session_id;
    activeSessionCwd = s.cwd || null;
    activeSessionTitle =
      s.label || s.agent_title || s.ai_title ||
      (s.first_message ? s.first_message.slice(0, 40) : null) ||
      s.agent || "session";
    localStorage.setItem("wazir.activeSessionId", activeSessionId);
    if (activeSessionCwd) localStorage.setItem("wazir.activeSessionCwd", activeSessionCwd);
    if (activeSessionTitle) localStorage.setItem("wazir.activeSessionTitle", activeSessionTitle);
    renderActive();
    picker.style.display = "none";
  }

  function renderPicker(sessions) {
    picker.innerHTML = "";
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "item";
      empty.textContent = "(no sessions yet — start one from your terminal with claude)";
      picker.appendChild(empty);
      return;
    }
    for (const s of sessions) {
      const item = document.createElement("div");
      item.className = "item" + (s.session_id === activeSessionId ? " active" : "");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent =
        s.label || s.agent_title || s.ai_title ||
        (s.first_message ? s.first_message.slice(0, 60) : null) ||
        s.agent;
      const meta = document.createElement("div");
      meta.className = "meta";
      const id = s.session_id.slice(0, 8);
      const ago = formatAgo(s.last_activity_at);
      meta.textContent = id + " · " + (s.cwd || "") + " · " + ago;
      item.appendChild(title);
      item.appendChild(meta);
      item.addEventListener("click", () => chooseSession(s));
      picker.appendChild(item);
    }
  }

  function formatAgo(ts) {
    if (!ts) return "?";
    const diff = Date.now() - ts;
    if (diff < 60_000) return Math.floor(diff/1000) + "s ago";
    if (diff < 3_600_000) return Math.floor(diff/60_000) + "m ago";
    if (diff < 86_400_000) return Math.floor(diff/3_600_000) + "h ago";
    return Math.floor(diff/86_400_000) + "d ago";
  }

  $("pickerBtn").addEventListener("click", () => {
    picker.style.display = picker.style.display === "block" ? "none" : "block";
    if (picker.style.display === "block") refreshSessions();
  });

  async function send() {
    if (inflight) return;
    const text = input.value.trim();
    if (!text) return;
    if (!activeSessionId) {
      setStatus("pick a session first");
      return;
    }
    inflight = true;
    sendBtn.disabled = true;
    input.value = "";
    autoSizeInput();
    bubble("user", text);
    const assistantBubble = bubble("assistant", "");
    setStatus("…");

    try {
      const body = JSON.stringify({ text, cwd: activeSessionCwd || undefined });
      const r = await fetch("/dashboard/api/sessions/" + encodeURIComponent(activeSessionId) + "/prompt-stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!r.ok || !r.body) {
        let detail = "";
        try { detail = JSON.stringify(await r.json()); } catch {}
        bubble("error", "hub error " + r.status + " " + detail);
        return;
      }
      let buf = "";
      let finalText = "";
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\\n\\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message", data = "";
          for (const line of block.split("\\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (!data) continue;
          let payload;
          try { payload = JSON.parse(data); } catch { continue; }
          if (event === "text") {
            assistantBubble.textContent += payload.delta || "";
            finalText += payload.delta || "";
            assistantBubble.scrollIntoView({ block: "end" });
          } else if (event === "tool") {
            const t = document.createElement("div");
            t.className = "msg tool";
            t.textContent = "🔧 " + payload.name + (payload.preview ? ": " + payload.preview : "");
            chat.appendChild(t);
          } else if (event === "done") {
            // finalText already accumulated via text events; payload.text is a safety fallback.
            if (!finalText && payload.text) {
              assistantBubble.textContent = payload.text;
              finalText = payload.text;
            }
            setStatus(payload.duration_ms ? Math.round(payload.duration_ms/100)/10 + "s" : "");
          } else if (event === "error") {
            bubble("error", payload.detail || "error");
          }
        }
      }
      if (finalText) speakOut(finalText);
    } catch (err) {
      bubble("error", err.message || String(err));
    } finally {
      inflight = false;
      sendBtn.disabled = false;
    }
  }

  async function speakOut(text) {
    try {
      const r = await fetch("/dashboard/api/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) return;
      const body = await r.json();
      if (!body.audio_base64) return;
      const audio = new Audio("data:audio/ogg;base64," + body.audio_base64);
      audio.play().catch(() => { /* autoplay blocked — silent */ });
    } catch { /* swallow */ }
  }

  let mediaRecorder = null;
  let recChunks = [];
  let pressing = false;

  async function startRecording() {
    if (pressing) return;
    pressing = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
      recChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recChunks, { type: mime });
        if (blob.size < 1000) { setStatus("recording too short"); return; }
        setStatus("transcribing…");
        try {
          const buf = await blob.arrayBuffer();
          const b64 = bytesToB64(new Uint8Array(buf));
          const r = await fetch("/dashboard/api/transcribe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audio_base64: b64, mime_type: blob.type }),
          });
          if (!r.ok) { setStatus("transcribe failed " + r.status); return; }
          const body = await r.json();
          const text = (body.text || "").trim();
          if (!text) { setStatus("(silent)"); return; }
          input.value = text;
          autoSizeInput();
          setStatus("");
          send();
        } catch (err) { setStatus("transcribe error: " + err.message); }
      };
      mediaRecorder.start();
      micBtn.classList.add("recording");
      setStatus("recording…");
    } catch (err) {
      setStatus("mic denied or unavailable: " + err.message);
      pressing = false;
    }
  }
  function stopRecording() {
    if (!pressing) return;
    pressing = false;
    micBtn.classList.remove("recording");
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  }
  micBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); startRecording(); });
  micBtn.addEventListener("pointerup", stopRecording);
  micBtn.addEventListener("pointerleave", stopRecording);
  micBtn.addEventListener("pointercancel", stopRecording);

  function bytesToB64(u8) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function autoSizeInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }
  input.addEventListener("input", autoSizeInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener("click", send);

  renderActive();
  refreshSessions();
})();
</script>
</body>
</html>
`;
}

function buildNotification(approvalId: string, req: ApprovalRequest, now: number): HubNotification {
  const riskClass = req.context.risk_class ?? "command";
  const title = `Approve ${riskClass}?`;
  const cwd = req.context.cwd ? ` : ${req.context.cwd}` : "";
  const body = `${req.command}\n@ ${req.worker_id}${cwd}`;
  const voicePrompt = `Approve a ${riskClass} from ${req.worker_id}?`;
  const extra = (req.context.extra ?? {}) as Record<string, unknown>;
  const modelLabel = typeof extra.model_label === "string" ? extra.model_label : undefined;
  const modelId = typeof extra.model_id === "string" ? extra.model_id : undefined;
  return {
    type: "approval_request",
    approval_id: approvalId,
    title,
    body,
    voice_prompt: voicePrompt,
    actions: [
      { id: "approve", label: "Approve", voice_phrase: "approve", style: "primary" },
      { id: "reject", label: "Reject", voice_phrase: "reject", style: "danger" },
      { id: "modify", label: "Modify", voice_phrase: "modify", style: "secondary" },
    ],
    expires_at: Math.floor((now + req.timeout_seconds * 1000) / 1000),
    context: {
      worker_id: req.worker_id,
      source: req.source,
      cwd: req.context.cwd,
      risk_class: req.context.risk_class,
      ...(modelLabel ? { model_label: modelLabel } : {}),
      ...(modelId ? { model_id: modelId } : {}),
    },
  };
}
