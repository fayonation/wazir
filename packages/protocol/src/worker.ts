import { z } from "zod";

export const WorkerRegistrationSchema = z.object({
  worker_id: z.string().min(1),
  hostname: z.string().min(1),
  platform: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  worker_url: z.string().url(),
});

export type WorkerRegistration = z.infer<typeof WorkerRegistrationSchema>;

export const WorkerHeartbeatSchema = z.object({
  worker_id: z.string().min(1),
  ts: z.number().int().positive(),
});

export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;
