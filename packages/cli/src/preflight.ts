const SUPPORTED_MAJORS = new Set([20, 22]);

export function preflight(): void {
  const [majorStr] = process.versions.node.split(".");
  const major = Number.parseInt(majorStr ?? "0", 10);
  if (!SUPPORTED_MAJORS.has(major)) {
    console.error(
      `error: Wazir requires Node 20 or 22, but you're on v${process.versions.node}.`,
    );
    console.error(
      "       better-sqlite3 has no prebuilt binary for Node 24+ on arm64.",
    );
    console.error("       Fix: run 'nvm use 20' before any pnpm command (the repo's .nvmrc pins 20).");
    process.exit(1);
  }
}
