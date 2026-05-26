import { existsSync, mkdirSync, statSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

const execFileAsync = promisify(execFile);

const WAZIR_DIR = resolve(homedir(), ".wazir");
const MODELS_DIR = resolve(WAZIR_DIR, "models");

// STT — whisper.cpp
const STT_MODEL_NAME = "ggml-base.en.bin";
const STT_MODEL_PATH = resolve(MODELS_DIR, STT_MODEL_NAME);
const STT_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const STT_MODEL_MB = 142;
const WHISPER_BINS = ["whisper-cli", "whisper-cpp", "whisper"];

interface CheckResult {
  ok: boolean;
  detail?: string;
}

export async function runInstallModels(): Promise<void> {
  console.log("Wazir install-models — sets up local STT (whisper.cpp) and TTS (macOS say)\n");

  // ── 1. Check / install whisper-cpp ─────────────────────────────────────
  const whisper = await findInPath(WHISPER_BINS);
  if (whisper) {
    console.log(`✓ whisper found: ${whisper}`);
  } else {
    console.log("• whisper-cpp not on $PATH. Installing via brew...");
    const brewOk = await checkBrew();
    if (!brewOk.ok) {
      console.error(`✗ ${brewOk.detail}`);
      process.exit(1);
    }
    const result = await runStreamed("brew", ["install", "whisper-cpp"]);
    if (!result.ok) {
      console.error("✗ brew install whisper-cpp failed");
      process.exit(1);
    }
    const after = await findInPath(WHISPER_BINS);
    if (!after) {
      console.error("✗ brew finished but no whisper binary on $PATH. Inspect with: brew info whisper-cpp");
      process.exit(1);
    }
    console.log(`✓ whisper installed: ${after}`);
  }

  // ── 2. Check / install ffmpeg ───────────────────────────────────────────
  const ffmpeg = await findInPath(["ffmpeg"]);
  if (ffmpeg) {
    console.log(`✓ ffmpeg found: ${ffmpeg}`);
  } else {
    console.log("• ffmpeg not on $PATH. Installing via brew...");
    const result = await runStreamed("brew", ["install", "ffmpeg"]);
    if (!result.ok) {
      console.error("✗ brew install ffmpeg failed");
      process.exit(1);
    }
    console.log("✓ ffmpeg installed");
  }

  // ── 3. Check macOS TTS (say command) ────────────────────────────────────
  const say = await findInPath(["say"]);
  if (say) {
    console.log(`✓ macOS TTS (say) found: ${say}`);
  } else {
    console.log("⚠ 'say' command not found — TTS voice replies will be unavailable.");
    console.log("  This is unexpected on macOS; check your system.");
  }

  // ── 4. Download STT model ───────────────────────────────────────────────
  mkdirSync(MODELS_DIR, { recursive: true });
  if (existsSync(STT_MODEL_PATH)) {
    const mb = Math.round(statSync(STT_MODEL_PATH).size / 1024 / 1024);
    console.log(`✓ STT model already at ${STT_MODEL_PATH} (${mb} MB)`);
  } else {
    console.log(`• downloading ${STT_MODEL_NAME} (~${STT_MODEL_MB} MB)...`);
    try {
      await downloadFile(STT_MODEL_URL, STT_MODEL_PATH);
    } catch (err) {
      console.error(`✗ download failed: ${(err as Error).message}`);
      process.exit(1);
    }
    const mb = Math.round(statSync(STT_MODEL_PATH).size / 1024 / 1024);
    console.log(`✓ downloaded ${mb} MB → ${STT_MODEL_PATH}`);
  }

  console.log("\n✅ STT + TTS ready.");
  console.log("   Voice note → Wazir transcribes → Claude responds → Wazir speaks back.");
  console.log("   Use /voice on|off|auto in Telegram to control voice replies.");
}

async function findInPath(names: string[]): Promise<string | null> {
  for (const n of names) {
    try {
      const { stdout } = await execFileAsync("which", [n]);
      const path = stdout.trim();
      if (path) return path;
    } catch {
      /* not found */
    }
  }
  return null;
}

async function checkBrew(): Promise<CheckResult> {
  try {
    await execFileAsync("which", ["brew"]);
    return { ok: true };
  } catch {
    return {
      ok: false,
      detail:
        "Homebrew is required to install whisper-cpp automatically. " +
        "Install brew from https://brew.sh or set up whisper.cpp manually and re-run.",
    };
  }
}

async function runStreamed(cmd: string, args: string[]): Promise<{ ok: boolean }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveProm) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => resolveProm({ ok: code === 0 }));
    child.on("error", () => resolveProm({ ok: false }));
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error("no response body");
  const totalStr = res.headers.get("content-length");
  const total = totalStr ? Number.parseInt(totalStr, 10) : 0;
  let downloaded = 0;
  let lastPct = -1;
  const out = createWriteStream(dest);
  const stream = Readable.fromWeb(res.body as NodeReadableStream);
  stream.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    if (total > 0) {
      const pct = Math.floor((downloaded / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        process.stdout.write(`\r  ${pct}% (${Math.round(downloaded / 1024 / 1024)} / ${Math.round(total / 1024 / 1024)} MB) `);
      }
    }
  });
  stream.pipe(out);
  await finished(out);
  process.stdout.write("\n");
}
