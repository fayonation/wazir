import { z } from "zod";

export const RiskPatternSchema = z.object({
  name: z.string().min(1),
  regex: z.string().min(1),
  label: z.string().min(1),
});

export type RiskPattern = z.infer<typeof RiskPatternSchema>;

export const TelegramAdapterConfigSchema = z.object({
  token_env: z.string().default("WAZIR_TELEGRAM_TOKEN"),
  allowlist: z.array(z.number().int()).default([]),
  use_inline_buttons: z.boolean().default(true),
  max_command_chars: z.number().int().positive().default(1200),
});

export type TelegramAdapterConfig = z.infer<typeof TelegramAdapterConfigSchema>;

export const CliAdapterConfigSchema = z.object({});
export type CliAdapterConfig = z.infer<typeof CliAdapterConfigSchema>;

export const AdapterConfigSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("telegram"),
    enabled: z.boolean().default(true),
    config: TelegramAdapterConfigSchema,
  }),
  z.object({
    name: z.literal("cli"),
    enabled: z.boolean().default(false),
    config: CliAdapterConfigSchema.default({}),
  }),
]);

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

export const WorkerConfigSchema = z.object({
  id: z.string().min(1),
  hostname: z.string().optional(),
  bind_host: z.string().default("127.0.0.1"),
  bind_port: z.number().int().positive().default(7843),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const HubConfigSchema = z.object({
  bind_host: z.string().default("127.0.0.1"),
  bind_port: z.number().int().positive().default(7842),
  db_path: z.string().default("~/.wazir/hub.db"),
  url: z.string().url().optional(),
});

export type HubConfig = z.infer<typeof HubConfigSchema>;

export const RepoConfigSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const LoggingConfigSchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  file: z.string().optional(),
  rotate: z.enum(["daily", "never"]).default("daily"),
});

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

export const WazirConfigSchema = z.object({
  version: z.literal(1),
  worker: WorkerConfigSchema,
  hub: HubConfigSchema,
  adapters: z.array(AdapterConfigSchema).default([]),
  risk_patterns: z.array(RiskPatternSchema).default([]),
  repos: z.array(RepoConfigSchema).default([]),
  logging: LoggingConfigSchema.default({}),
});

export type WazirConfig = z.infer<typeof WazirConfigSchema>;

export const DEFAULT_RISK_PATTERNS: RiskPattern[] = [
  { name: "rm_force", regex: "\\brm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\\b", label: "rm -rf" },
  { name: "rm_plain", regex: "\\brm\\s+", label: "rm" },
  { name: "git_push_force", regex: "\\bgit\\s+push\\s+.*--force\\b|\\bgit\\s+push\\s+.*-f\\b", label: "git push --force" },
  { name: "git_push", regex: "\\bgit\\s+push\\b", label: "git push" },
  { name: "git_reset_hard", regex: "\\bgit\\s+reset\\s+--hard\\b", label: "git reset --hard" },
  { name: "git_clean", regex: "\\bgit\\s+clean\\b", label: "git clean" },
  { name: "sudo", regex: "\\bsudo\\b", label: "sudo" },
  { name: "publish", regex: "\\b(npm|yarn|pnpm)\\s+publish\\b", label: "package publish" },
  { name: "migration", regex: "\\b(prisma\\s+migrate|knex\\s+migrate|sequelize\\s+db:migrate)\\b", label: "migration" },
];
