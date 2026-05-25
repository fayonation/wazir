import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class TmuxError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly code: number | null,
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

export interface TmuxExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Run `tmux` with the given args. We never invoke a shell, so user-supplied
 * text (commands, session ids, input strings) is passed as discrete argv
 * entries — no quoting or escaping required.
 */
export async function tmux(args: string[]): Promise<TmuxExecResult> {
  try {
    const result = await execFileAsync("tmux", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024, // 16 MiB — pane captures can be large
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    throw new TmuxError(
      e.message,
      typeof e.stderr === "string" ? e.stderr : "",
      typeof e.code === "number" ? e.code : null,
    );
  }
}

/** True if a tmux session with the given exact name exists. */
export async function hasSession(name: string): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
}
