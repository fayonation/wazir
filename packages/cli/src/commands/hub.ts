import { startHub } from "@wazir/hub";
import { loadConfig } from "../config.js";
import { resolveHmacSecret, loadDotEnv, mergeDotEnv } from "../secrets.js";
import { buildAdapters } from "../buildAdapters.js";

export async function runHub(): Promise<void> {
  mergeDotEnv(loadDotEnv());
  const config = loadConfig();
  const hmacSecret = await resolveHmacSecret();
  if (!hmacSecret) {
    console.error("error: HMAC secret missing. Run 'wazir init' or set WAZIR_HMAC_SECRET.");
    process.exitCode = 1;
    return;
  }
  const adapters = await buildAdapters(config, {
    logger: {
      info: (...a) => console.log("[adapter]", ...a),
      warn: (...a) => console.warn("[adapter]", ...a),
      error: (...a) => console.error("[adapter]", ...a),
    },
  });
  if (adapters.length === 0) {
    console.warn("warning: no enabled adapters; approvals will fail until at least one is reachable");
  }
  const handle = await startHub({
    bindHost: config.hub.bind_host,
    bindPort: config.hub.bind_port,
    dbPath: config.hub.db_path,
    hmacSecret,
    adapters,
  });
  console.log(`wazir hub listening on ${handle.url}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nreceived ${signal}, stopping hub...`);
    await handle.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
