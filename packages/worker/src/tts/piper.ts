/**
 * Local TTS for macOS.
 *
 * Primary: macOS `say` command (built-in, no install required, high quality).
 * Optional: piper binary at ~/.wazir/bin/piper-dist/piper/piper if someone
 * installs it with the correct shared libraries in the same directory.
 */
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

const PIPER_BIN = join(homedir(), ".wazir", "bin", "piper-dist", "piper", "piper");
const VOICE_MODEL = join(homedir(), ".wazir", "models", "en_US-lessac-medium.onnx");

export interface SynthResult {
  audio: Buffer;
  durationMs: number;
}

export async function synthesize(text: string): Promise<SynthResult> {
  // Prefer piper if it's properly installed (binary + model present).
  if (existsSync(PIPER_BIN) && existsSync(VOICE_MODEL)) {
    try {
      return await synthesizeWithPiper(text);
    } catch {
      // fall through to macOS say
    }
  }
  return await synthesizeWithSay(text);
}

async function synthesizeWithSay(text: string): Promise<SynthResult> {
  const id = randomUUID();
  const outAiff = join(tmpdir(), `wazir-tts-${id}.aiff`);
  const outOgg = join(tmpdir(), `wazir-tts-${id}.ogg`);
  const start = Date.now();
  try {
    await execFileAsync("say", ["-o", outAiff, "--", text]);
    await execFileAsync("ffmpeg", [
      "-y", "-i", outAiff,
      "-c:a", "libopus", "-b:a", "32k",
      outOgg,
    ]);
    return { audio: readFileSync(outOgg), durationMs: Date.now() - start };
  } finally {
    for (const f of [outAiff, outOgg]) {
      try { unlinkSync(f); } catch {}
    }
  }
}

async function synthesizeWithPiper(text: string): Promise<SynthResult> {
  const id = randomUUID();
  const outWav = join(tmpdir(), `wazir-tts-${id}.wav`);
  const outOgg = join(tmpdir(), `wazir-tts-${id}.ogg`);
  const start = Date.now();
  try {
    await runPiper(text, outWav);
    await execFileAsync("ffmpeg", [
      "-y", "-i", outWav,
      "-c:a", "libopus", "-b:a", "32k",
      outOgg,
    ]);
    return { audio: readFileSync(outOgg), durationMs: Date.now() - start };
  } finally {
    for (const f of [outWav, outOgg]) {
      try { unlinkSync(f); } catch {}
    }
  }
}

function runPiper(text: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BIN, ["--model", VOICE_MODEL, "--output_file", outFile], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const errs: string[] = [];
    child.stderr.on("data", (d: Buffer) => errs.push(d.toString()));
    child.stdin.write(text, "utf8");
    child.stdin.end();
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`piper exited ${code}: ${errs.join("").slice(0, 400)}`));
    });
    child.on("error", reject);
  });
}
