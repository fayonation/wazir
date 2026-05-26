import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Server } from "node:http";
import {
  ApprovalDecisionCallbackSchema,
  SessionSpawnRequestSchema,
  SessionInputRequestSchema,
  TranscribeRequestSchema,
  SynthesizeRequestSchema,
  type RiskPattern,
} from "@wazir/protocol";
import { createHmacMiddleware, rawBodyCapture, type RawBodyRequest } from "./hmacMiddleware.js";
import { compilePatterns, classify, type CompiledPattern } from "./risk.js";
import { HubClient } from "./hubClient.js";
import {
  ClaudeHookPayloadSchema,
  buildAllowResponse,
  buildDenyResponse,
  buildModifyResponse,
} from "./claudeHook.js";
import { createLogger, type WorkerLogger } from "./logger.js";
import { readModelFromTranscript, prettyModel } from "./transcript.js";
import { TmuxManager } from "./tmux/index.js";
import { discoverClaudeSessions, findClaudeSession } from "./discovery/claude.js";
import { transcribe } from "./transcription/index.js";
import { synthesize } from "./tts/index.js";
import { renderPanePng } from "./screenshot/index.js";

export interface WorkerStartOptions {
  workerId: string;
  bindHost: string;
  bindPort: number;
  hubUrl: string;
  hmacSecret: string;
  hostname?: string;
  version: string;
  riskPatterns: RiskPattern[];
  logger?: WorkerLogger;
  heartbeatIntervalMs?: number;
  approvalTimeoutSeconds?: number;
}

export interface WorkerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

interface PendingDecision {
  resolve: (value: { decision: "approve" | "reject" | "modify"; command: string; actor: string }) => void;
  timer: NodeJS.Timeout;
}

export async function startWorker(opts: WorkerStartOptions): Promise<WorkerHandle> {
  const logger = opts.logger ?? createLogger();
  const compiledPatterns = compilePatterns(opts.riskPatterns);
  const hubClient = new HubClient(opts.hubUrl, opts.hmacSecret);
  const host = opts.hostname ?? hostname();
  const approvalTimeoutSeconds = opts.approvalTimeoutSeconds ?? 540;
  const pendingDecisions = new Map<string, PendingDecision>();
  const tmuxManager = new TmuxManager(logger, opts.workerId);
  const rehydrated = await tmuxManager.rehydrate();
  if (rehydrated > 0) {
    logger.info({ count: rehydrated }, "rehydrated existing tmux sessions after worker restart");
  }
  const workerUrl = `http://${opts.bindHost}:${opts.bindPort}`;

  await hubClient.register({
    worker_id: opts.workerId,
    hostname: host,
    platform: process.platform,
    version: opts.version,
    capabilities: ["claude-code-hook", "tmux"],
    worker_url: workerUrl,
  });
  logger.info({ hub_url: opts.hubUrl }, "registered with hub");

  const heartbeatTimer = setInterval(() => {
    hubClient.heartbeat(opts.workerId).catch((err) => {
      logger.warn({ err }, "heartbeat failed");
    });
    void (async () => {
      try {
        const sessions = await tmuxManager.listSessions();
        await hubClient.reportSessions(opts.workerId, sessions);
      } catch (err) {
        logger.warn({ err }, "session report failed");
      }
    })();
  }, opts.heartbeatIntervalMs ?? 30_000);
  heartbeatTimer.unref();

  const app = express();
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => rawBodyCapture(req as RawBodyRequest, _res as Response, buf),
    }),
  );

  app.get("/v1/health", (_req, res) => {
    res.json({ ok: true, worker_id: opts.workerId, pending: pendingDecisions.size });
  });

  // boundLocator returns the URL the worker is actually listening on; resolved after listen()
  let boundLocator = () => `http://${opts.bindHost}:${opts.bindPort}`;

  app.post("/v1/hooks/claude-code/pre-tool-use", async (req: RawBodyRequest, res: Response) => {
    const parsed = ClaudeHookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ details: parsed.error.flatten() }, "invalid claude hook payload");
      res.status(200).json(buildAllowResponse("wazir: invalid hook payload, allowing by default"));
      return;
    }
    const payload = parsed.data;
    if (payload.tool_name !== "Bash") {
      res.status(200).json(buildAllowResponse());
      return;
    }
    const command = payload.tool_input.command;
    const risk = classify(command, compiledPatterns);
    if (!risk.risky) {
      res.status(200).json(buildAllowResponse());
      return;
    }
    const requestId = randomUUID();
    const callbackUrl = `${boundLocator()}/v1/decisions/${requestId}`;
    const decisionPromise = new Promise<{ decision: "approve" | "reject" | "modify"; command: string; actor: string }>(
      (resolve) => {
        const timer = setTimeout(() => {
          pendingDecisions.delete(requestId);
          resolve({ decision: "reject", command, actor: "system:worker_timeout" });
        }, approvalTimeoutSeconds * 1000);
        timer.unref();
        pendingDecisions.set(requestId, { resolve, timer });
      },
    );

    const modelId = readModelFromTranscript(payload.transcript_path);
    const modelLabel = prettyModel(modelId);

    try {
      await hubClient.submitApproval({
        request_id: requestId,
        source: "claude-code",
        worker_id: opts.workerId,
        session_id: payload.session_id,
        command,
        context: {
          cwd: payload.cwd,
          tool_name: payload.tool_name,
          risk_class: risk.pattern?.label,
          extra: {
            ...(modelId ? { model_id: modelId } : {}),
            ...(modelLabel ? { model_label: modelLabel } : {}),
          },
        },
        callback_url: callbackUrl,
        timeout_seconds: approvalTimeoutSeconds,
      });
    } catch (err) {
      const pending = pendingDecisions.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingDecisions.delete(requestId);
      }
      logger.error({ err, request_id: requestId }, "hub submit failed; allowing by default");
      res.status(200).json(buildAllowResponse("wazir: hub unreachable, allowing"));
      return;
    }

    logger.info({ request_id: requestId, risk: risk.pattern?.label }, "approval requested");
    const result = await decisionPromise;
    logger.info({ request_id: requestId, decision: result.decision, actor: result.actor }, "approval resolved");

    if (result.decision === "approve") {
      res.status(200).json(buildAllowResponse(`wazir: approved by ${result.actor}`));
      return;
    }
    if (result.decision === "reject") {
      res.status(200).json(buildDenyResponse(`wazir: rejected by ${result.actor}`));
      return;
    }
    res.status(200).json(buildModifyResponse(result.command, `wazir: modified by ${result.actor}`));
  });

  const hmac = createHmacMiddleware(opts.hmacSecret);

  // ---------------------------------------------------------------
  // Session endpoints — hub forwards CLI/adapter requests here.
  // ---------------------------------------------------------------

  app.post("/v1/sessions/spawn", hmac, async (req: RawBodyRequest, res: Response) => {
    const parsed = SessionSpawnRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    try {
      const spawnOpts: Parameters<typeof tmuxManager.spawnSession>[0] = {
        agent: parsed.data.agent,
        cwd: parsed.data.cwd,
        resume: parsed.data.resume,
      };
      if (parsed.data.session_id !== undefined) spawnOpts.sessionId = parsed.data.session_id;
      if (parsed.data.label !== undefined) spawnOpts.label = parsed.data.label;
      const session = await tmuxManager.spawnSession(spawnOpts);
      res.status(200).json(session);
    } catch (err) {
      logger.error({ err }, "session spawn failed");
      res.status(500).json({ error: "spawn_failed", detail: (err as Error).message });
    }
  });

  app.get("/v1/sessions", hmac, async (_req: RawBodyRequest, res: Response) => {
    try {
      const list = await tmuxManager.listSessions();
      res.json({ sessions: list });
    } catch (err) {
      res.status(500).json({ error: "list_failed", detail: (err as Error).message });
    }
  });

  app.post("/v1/sessions/:session_id/input", hmac, async (req: RawBodyRequest, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    const parsed = SessionInputRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    try {
      await tmuxManager.sendInput(sessionId, parsed.data.text, parsed.data.press_enter);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "input_failed", detail: (err as Error).message });
    }
  });

  app.get("/v1/sessions/:session_id/capture", hmac, async (req: RawBodyRequest, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    const sinceRaw = req.query.since;
    const visibleRaw = req.query.visible_only;
    const captureOpts: Parameters<typeof tmuxManager.capturePane>[1] = {};
    if (typeof sinceRaw === "string") {
      const parsed = Number.parseInt(sinceRaw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) captureOpts.since = parsed;
    }
    if (typeof visibleRaw === "string" && (visibleRaw === "1" || visibleRaw === "true")) {
      captureOpts.visibleOnly = true;
    }
    try {
      const result = await tmuxManager.capturePane(sessionId, captureOpts);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "capture_failed", detail: (err as Error).message });
    }
  });

  app.get("/v1/sessions/:session_id/screenshot", hmac, async (req: RawBodyRequest, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    const label = typeof req.query.label === "string" ? req.query.label : undefined;
    try {
      const capture = await tmuxManager.capturePane(sessionId, { visibleOnly: true });
      const png = renderPanePng(capture.text, label);
      res.set("content-type", "image/png");
      res.send(png);
    } catch (err) {
      res.status(500).json({ error: "screenshot_failed", detail: (err as Error).message });
    }
  });

  app.delete("/v1/sessions/:session_id", hmac, async (req: RawBodyRequest, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    try {
      const killed = await tmuxManager.killSession(sessionId);
      res.json({ ok: killed });
    } catch (err) {
      res.status(500).json({ error: "kill_failed", detail: (err as Error).message });
    }
  });

  app.get("/v1/sessions/discovered", hmac, (_req: RawBodyRequest, res: Response) => {
    try {
      const list = discoverClaudeSessions();
      res.json({ sessions: list });
    } catch (err) {
      res.status(500).json({ error: "discovery_failed", detail: (err as Error).message });
    }
  });

  app.get("/v1/sessions/discovered/:session_id", hmac, (req: RawBodyRequest, res: Response) => {
    const sessionId = req.params.session_id;
    if (!sessionId) { res.status(400).json({ error: "missing_session_id" }); return; }
    const found = findClaudeSession(sessionId);
    if (!found) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(found);
  });

  app.post("/v1/transcribe", hmac, async (req: RawBodyRequest, res: Response) => {
    const parsed = TranscribeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    let audio: Buffer;
    try {
      audio = Buffer.from(parsed.data.audio_base64, "base64");
    } catch {
      res.status(400).json({ error: "invalid_base64" });
      return;
    }
    if (audio.length === 0) {
      res.status(400).json({ error: "empty_audio" });
      return;
    }
    try {
      const transcribeOpts: Parameters<typeof transcribe>[1] = {};
      if (parsed.data.language !== undefined) transcribeOpts.language = parsed.data.language;
      const result = await transcribe(audio, transcribeOpts);
      logger.info(
        { duration_ms: result.durationMs, audio_bytes: audio.length, chars: result.text.length },
        "transcription complete",
      );
      res.json({ text: result.text, duration_ms: result.durationMs });
    } catch (err) {
      logger.error({ err }, "transcription failed");
      res.status(500).json({ error: "transcription_failed", detail: (err as Error).message });
    }
  });

  app.post("/v1/synthesize", hmac, async (req: RawBodyRequest, res: Response) => {
    const parsed = SynthesizeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await synthesize(parsed.data.text);
      logger.info({ duration_ms: result.durationMs, bytes: result.audio.length }, "synthesis complete");
      res.json({ audio_base64: result.audio.toString("base64"), duration_ms: result.durationMs });
    } catch (err) {
      logger.error({ err }, "synthesis failed");
      res.status(500).json({ error: "synthesis_failed", detail: (err as Error).message });
    }
  });

  app.post("/v1/decisions/:request_id", hmac, (req: RawBodyRequest, res: Response) => {
    const requestId = req.params.request_id;
    if (!requestId) {
      res.status(400).json({ error: "missing_request_id" });
      return;
    }
    const parsed = ApprovalDecisionCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.request_id !== requestId) {
      res.status(400).json({ error: "request_id_mismatch" });
      return;
    }
    const pending = pendingDecisions.get(requestId);
    if (!pending) {
      res.status(404).json({ error: "no_pending_request" });
      return;
    }
    clearTimeout(pending.timer);
    pendingDecisions.delete(requestId);
    pending.resolve({
      decision: parsed.data.decision,
      command: parsed.data.command,
      actor: parsed.data.actor,
    });
    res.json({ ok: true });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.bindPort, opts.bindHost, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.bindPort;
  const url = `http://${opts.bindHost}:${port}`;
  boundLocator = () => url;
  logger.info({ url, worker_id: opts.workerId, patterns: compiledPatterns.length }, "worker started");

  return {
    port,
    url,
    stop: async () => {
      clearInterval(heartbeatTimer);
      for (const p of pendingDecisions.values()) {
        clearTimeout(p.timer);
        p.resolve({ decision: "reject", command: "", actor: "system:shutdown" });
      }
      pendingDecisions.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      logger.info("worker stopped");
    },
  };
}
