import { z } from "zod";
import { ApprovalActionSchema } from "./approval.js";

export const NotificationActionSchema = z.object({
  id: ApprovalActionSchema,
  label: z.string().min(1),
  voice_phrase: z.string().min(1),
  style: z.enum(["primary", "secondary", "danger"]).default("secondary"),
});

export type NotificationAction = z.infer<typeof NotificationActionSchema>;

export const HubNotificationSchema = z.object({
  type: z.literal("approval_request"),
  approval_id: z.string().uuid(),
  title: z.string().min(1),
  body: z.string().min(1),
  voice_prompt: z.string().min(1),
  actions: z.array(NotificationActionSchema).min(1),
  expires_at: z.number().int().positive(),
  context: z
    .object({
      worker_id: z.string().min(1),
      source: z.string().min(1),
      cwd: z.string().optional(),
      risk_class: z.string().optional(),
    })
    .passthrough(),
});

export type HubNotification = z.infer<typeof HubNotificationSchema>;
