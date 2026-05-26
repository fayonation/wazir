import { z } from "zod";

/**
 * Canonical session record. A session is one tmux pane on one worker
 * running one agent CLI. The session_id is also the agent's session
 * identifier (e.g. `claude --session-id <session_id>`), so callers can
 * resume the same conversation later.
 */
export const SessionSchema = z.object({
  session_id: z.string().uuid(),
  worker_id: z.string().min(1),
  agent: z.string().min(1),
  cwd: z.string().min(1),
  tmux_name: z.string().min(1),
  status: z.enum(["running", "exited", "unreachable"]).default("running"),
  created_at: z.number().int().positive(),
  last_activity_at: z.number().int().positive(),
  label: z.string().optional(),
  message_count: z.number().int().nonnegative().optional(),
});

export type Session = z.infer<typeof SessionSchema>;

/** Request body for spawning a session on a worker (hub → worker). */
export const SessionSpawnRequestSchema = z.object({
  agent: z.string().min(1).default("claude"),
  cwd: z.string().min(1),
  session_id: z.string().uuid().optional(),
  resume: z.boolean().default(false),
  label: z.string().max(120).optional(),
  /**
   * "print" (default) — register the session record only; turns will be
   *   driven by `claude --print --resume` from outside.
   * "tmux" — legacy interactive tmux pane.
   */
  mode: z.enum(["print", "tmux"]).default("print"),
});

export type SessionSpawnRequest = z.infer<typeof SessionSpawnRequestSchema>;

/** Request body for delivering text input to a session. */
export const SessionInputRequestSchema = z.object({
  text: z.string().min(1),
  press_enter: z.boolean().default(true),
});

export type SessionInputRequest = z.infer<typeof SessionInputRequestSchema>;

/**
 * Request body for running one non-interactive turn against a session via
 * `claude --print --resume`. This is the preferred path for the Telegram
 * adapter — each user message is one short-lived process and the response
 * comes back as a single string instead of being scraped from a tmux pane.
 */
export const SessionPromptRequestSchema = z.object({
  text: z.string().min(1),
  cwd: z.string().min(1),
});

export type SessionPromptRequest = z.infer<typeof SessionPromptRequestSchema>;

/** What the worker returns from /v1/sessions/:id/prompt. */
export const SessionPromptResponseSchema = z.object({
  text: z.string(),
  tools: z.array(
    z.object({ name: z.string(), preview: z.string() }),
  ),
  duration_ms: z.number().int().nonnegative(),
  stop_reason: z.string().nullable(),
});

export type SessionPromptResponse = z.infer<typeof SessionPromptResponseSchema>;

/** Response from a pane capture. */
export const SessionCaptureSchema = z.object({
  text: z.string(),
  cursor: z.number().int().nonnegative(),
  full: z.boolean(),
});

export type SessionCapture = z.infer<typeof SessionCaptureSchema>;

/** What the worker reports to the hub in heartbeats. */
export const SessionReportSchema = z.object({
  worker_id: z.string().min(1),
  sessions: z.array(SessionSchema),
});

export type SessionReport = z.infer<typeof SessionReportSchema>;

/**
 * Transcription request body — base64-encoded audio (any container ffmpeg can
 * read; Telegram delivers ogg/opus). Base64 over JSON keeps HMAC signing simple
 * for binary payloads in Phase 2.
 */
export const TranscribeRequestSchema = z.object({
  audio_base64: z.string().min(1),
  mime_type: z.string().optional(),
  language: z.string().optional(),
});

export type TranscribeRequest = z.infer<typeof TranscribeRequestSchema>;

export const TranscribeResponseSchema = z.object({
  text: z.string(),
  duration_ms: z.number().int().nonnegative(),
});

export type TranscribeResponse = z.infer<typeof TranscribeResponseSchema>;

export const SynthesizeRequestSchema = z.object({
  text: z.string().min(1).max(5000),
  voice: z.string().optional(),
});

export type SynthesizeRequest = z.infer<typeof SynthesizeRequestSchema>;

export const SynthesizeResponseSchema = z.object({
  audio_base64: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
});

export type SynthesizeResponse = z.infer<typeof SynthesizeResponseSchema>;

/**
 * A session found on disk by enumerating an agent's persisted state.
 * For Claude Code this is `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
 * These represent conversations that can be RESUMED — they may or may
 * not currently be tracked by a tmux pane.
 */
export const DiscoveredSessionSchema = z.object({
  session_id: z.string(),
  agent: z.string().min(1),
  cwd: z.string().min(1),
  first_message: z.string().optional(),
  last_assistant: z.string().optional(),
  message_count: z.number().int().nonnegative(),
  last_activity_at: z.number().int().positive(),
  model: z.string().optional(),
  /** User-given name from Wazir's `/rename`. Survives across spawn/kill. */
  label: z.string().optional(),
  /** User-given title from Claude Code's own `/rename` (custom-title in JSONL). */
  agent_title: z.string().optional(),
  /** Claude Code's auto-generated title (ai-title in JSONL). */
  ai_title: z.string().optional(),
});

export type DiscoveredSession = z.infer<typeof DiscoveredSessionSchema>;
