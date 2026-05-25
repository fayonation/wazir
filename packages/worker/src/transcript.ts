import { readFileSync, statSync } from "node:fs";

interface CachedEntry {
  model: string | null;
  mtimeMs: number;
}

const cache = new Map<string, CachedEntry>();

/**
 * Read the Claude Code transcript file and extract the most recent assistant
 * model id. Returns null if the file is missing, unreadable, or contains no
 * model field. Cached per-path on file mtime so repeat lookups inside a single
 * session are cheap.
 */
export function readModelFromTranscript(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(transcriptPath).mtimeMs;
  } catch {
    return null;
  }
  const cached = cache.get(transcriptPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.model;

  let text: string;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    cache.set(transcriptPath, { model: null, mtimeMs });
    return null;
  }
  const model = extractLatestModel(text);
  cache.set(transcriptPath, { model, mtimeMs });
  return model;
}

export function extractLatestModel(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      const model = findModelField(obj);
      if (model) return model;
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

function findModelField(obj: unknown): string | null {
  if (obj == null || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  if (typeof record.model === "string") return record.model;
  // Some transcript shapes nest the assistant message under "message"
  if (record.message && typeof record.message === "object") {
    const inner = (record.message as Record<string, unknown>).model;
    if (typeof inner === "string") return inner;
  }
  return null;
}

/** Render a short, human-friendly label like "Sonnet 4.6" from "claude-sonnet-4-6". */
export function prettyModel(modelId: string | null): string | null {
  if (!modelId) return null;
  const m = modelId.match(/claude-(opus|sonnet|haiku)-([\d-]+)/i);
  if (!m || !m[1] || !m[2]) return modelId;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  const version = m[2]!.replace(/-/g, ".");
  return `${family} ${version}`;
}
