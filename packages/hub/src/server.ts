import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
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
