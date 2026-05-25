import { z } from "zod";

export const RiskClassSchema = z.string().min(1).max(64);

export const ApprovalContextSchema = z
  .object({
    cwd: z.string().optional(),
    tool_name: z.string().optional(),
    risk_class: RiskClassSchema.optional(),
    repo: z.string().optional(),
    extra: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const ApprovalRequestSchema = z.object({
  request_id: z.string().uuid(),
  source: z.string().min(1),
  worker_id: z.string().min(1),
  session_id: z.string().min(1),
  command: z.string().min(1),
  context: ApprovalContextSchema,
  callback_url: z.string().url(),
  timeout_seconds: z.number().int().positive().max(3600),
});

export type ApprovalContext = z.infer<typeof ApprovalContextSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalActionSchema = z.enum(["approve", "reject", "modify"]);
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const UserDecisionSchema = z
  .object({
    action: ApprovalActionSchema,
    modified_command: z.string().min(1).optional(),
    actor: z.string().min(1),
    reason: z.string().optional(),
  })
  .refine(
    (d) => d.action !== "modify" || (d.modified_command !== undefined && d.modified_command.length > 0),
    { message: "modify action requires a modified_command" },
  );

export type UserDecision = z.infer<typeof UserDecisionSchema>;

export const ApprovalDecisionCallbackSchema = z.object({
  request_id: z.string().uuid(),
  decision: ApprovalActionSchema,
  command: z.string().min(1),
  actor: z.string().min(1),
});

export type ApprovalDecisionCallback = z.infer<typeof ApprovalDecisionCallbackSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "decided",
  "timed_out",
  "cancelled",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
