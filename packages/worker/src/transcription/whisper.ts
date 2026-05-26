import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL_PATH = resolve(homedir(), ".wazir", "models", "ggml-base.en.bin");

/**
 * whisper.cpp ships under several brew binary names depending on version
 * (`whisper-cli` is the current canonical name; older formulas used `whisper-cpp`).
 * We resolve at runtime.
 */
const WHISPER_BIN_CANDIDATES = ["whisper-cli", "whisper-cpp", "whisper"];

export interface TranscribeOptions {
  /** Path to a ggml-format whisper model. Defaults to ~/.wazir/models/ggml-base.en.bin. */
  modelPath?: string;
  language?: string;
  /** Override the whisper binary path; otherwise resolved from $PATH. */
  binPath?: string;
}

export interface TranscribeResult {
  text: string;
  durationMs: number;
  binUsed: string;
  modelPath: string;
}

/** Synchronous lookup of the first available whisper binary in $PATH. */
export async function findWhisperBin(): Promise<string | null> {
  for (const name of WHISPER_BIN_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync("which", [name]);
      const trimmed = stdout.trim();
      if (trimmed) return trimmed;
    } catch {
      // not on PATH, try next
    }
  }
  return null;
}

/** Synchronous check for ffmpeg in $PATH. */
export async function findFfmpegBin(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", ["ffmpeg"]);
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Transcribe an audio buffer (any container ffmpeg can read — Telegram sends
 * ogg/opus) to text using a local whisper.cpp binary.
 *
 * Throws if dependencies (whisper, ffmpeg, model) are missing — the CLI
 * `wazir install-models` is responsible for installing them.
 */
export async function transcribe(
  audio: Buffer,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const modelPath = opts.modelPath ?? DEFAULT_MODEL_PATH;
  if (!existsSync(modelPath)) {
    throw new Error(
      `whisper model not found at ${modelPath}. Run 'pnpm wazir:install-models' first.`,
    );
  }
  const bin = opts.binPath ?? (await findWhisperBin());
  if (!bin) {
    throw new Error(
      "no whisper binary on $PATH. Install whisper.cpp (brew install whisper-cpp) " +
        "or run 'pnpm wazir:install-models'.",
    );
  }
  const ffmpeg = await findFfmpegBin();
  if (!ffmpeg) {
    throw new Error("ffmpeg is required to decode incoming audio. Install with 'brew install ffmpeg'.");
  }

  const start = Date.now();
  const workDir = mkdtempSync(join(tmpdir(), "wazir-stt-"));
  try {
    const inputPath = join(workDir, "input.bin");
    writeFileSync(inputPath, audio);
    const wavPath = join(workDir, "input.wav");
    // whisper.cpp wants 16 kHz mono PCM s16le
    await execFileAsync(ffmpeg, [
      "-loglevel", "error",
      "-y",
      "-i", inputPath,
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      wavPath,
    ]);

    const outPrefix = join(workDir, "out");
    const args = [
      "--model", modelPath,
      "--file", wavPath,
      "--output-txt",
      "--output-file", outPrefix,
      "--no-prints",
      "--no-timestamps",
      "--language", opts.language ?? "en",
    ];
    await execFileAsync(bin, args, { maxBuffer: 8 * 1024 * 1024 });

    const txtPath = `${outPrefix}.txt`;
    if (!existsSync(txtPath)) {
      throw new Error("whisper did not produce a transcript file");
    }
    const text = readFileSync(txtPath, "utf8").trim();
    return {
      text,
      durationMs: Date.now() - start,
      binUsed: bin,
      modelPath,
    };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
