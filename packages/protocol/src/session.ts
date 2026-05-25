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
});

export type SessionSpawnRequest = z.infer<typeof SessionSpawnRequestSchema>;

/** Request body for delivering text input to a session. */
export const SessionInputRequestSchema = z.object({
  text: z.string().min(1),
  press_enter: z.boolean().default(true),
});

export type SessionInputRequest = z.infer<typeof SessionInputRequestSchema>;

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
