import { startWorker } from "@wazir/worker";
import { hostname } from "node:os";
import { loadConfig } from "../config.js";
import { resolveHmacSecret, loadDotEnv, mergeDotEnv } from "../secrets.js";

const WORKER_VERSION = "0.1.0";

export async function runWorker(): Promise<void> {
  mergeDotEnv(loadDotEnv());
  const config = loadConfig();
  const hmacSecret = await resolveHmacSecret();
  if (!hmacSecret) {
    console.error("error: HMAC secret missing. Run 'wazir init' or set WAZIR_HMAC_SECRET.");
    process.exitCode = 1;
    return;
  }
  const hubUrl = config.hub.url ?? `http://${config.hub.bind_host}:${config.hub.bind_port}`;
  const handle = await startWorker({
    workerId: config.worker.id,
    bindHost: config.worker.bind_host,
    bindPort: config.worker.bind_port,
    hubUrl,
    hmacSecret,
    hostname: config.worker.hostname ?? hostname(),
    version: WORKER_VERSION,
    riskPatterns: config.risk_patterns,
  });
  console.log(`wazir worker listening on ${handle.url} (hub: ${hubUrl})`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nreceived ${signal}, stopping worker...`);
    await handle.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
