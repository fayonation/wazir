import { z } from "zod";

export const ClaudeBashToolInputSchema = z
  .object({
    command: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

export const ClaudeHookPayloadSchema = z
  .object({
    session_id: z.string(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    hook_event_name: z.string().optional(),
    tool_name: z.string(),
    tool_input: ClaudeBashToolInputSchema,
  })
  .passthrough();

export type ClaudeHookPayload = z.infer<typeof ClaudeHookPayloadSchema>;

export type ClaudePermissionDecision = "allow" | "deny" | "ask";

export interface ClaudeHookResponse {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: ClaudePermissionDecision;
    permissionDecisionReason?: string;
  };
}

export interface ClaudeHookModifyResponse extends ClaudeHookResponse {
  hookSpecificOutput: ClaudeHookResponse["hookSpecificOutput"] & {
    updatedInput?: { command: string };
  };
}

export function buildAllowResponse(reason?: string): ClaudeHookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
}

export function buildDenyResponse(reason: string): ClaudeHookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export function buildModifyResponse(newCommand: string, reason: string): ClaudeHookModifyResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
      updatedInput: { command: newCommand },
    },
  };
}
