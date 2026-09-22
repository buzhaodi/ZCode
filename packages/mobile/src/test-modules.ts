/**
 * 递增式模块加载测试：逐个 import 主要模块，定位哪个模块触发 FORTIFY 崩溃。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = typeof import.meta !== "undefined" && "dirname" in import.meta
  ? import.meta.dirname
  : process.cwd();
const dataDir = join(__dirname, "data");
mkdirSync(dataDir, { recursive: true });

const logFile = join(dataDir, "progress.log");
function log(msg: string) {
  try {
    writeFileSync(logFile, new Date().toISOString() + " " + msg + "\n", { flag: "a" });
  } catch { /* ignore */ }
}

log("=== MODULE TEST START ===");

try {
  log("M1: import @zcode/rpc...");
  const rpc = await import("@zcode/rpc");
  log("M1 OK: " + Object.keys(rpc).slice(0, 3).join(","));
} catch (e) { log("M1 FAIL: " + (e as Error).message); }

try {
  log("M2: import @zcode/shared...");
  const shared = await import("@zcode/shared");
  log("M2 OK: " + Object.keys(shared).slice(0, 3).join(","));
} catch (e) { log("M2 FAIL: " + (e as Error).message); }

try {
  log("M3: import @zcode/services/node...");
  const services = await import("@zcode/services/node");
  log("M3 OK: " + Object.keys(services).slice(0, 3).join(","));
} catch (e) { log("M3 FAIL: " + (e as Error).message); }

try {
  log("M4: import @zcode/server...");
  const server = await import("@zcode/server");
  log("M4 OK: " + Object.keys(server).slice(0, 3).join(","));
} catch (e) { log("M4 FAIL: " + (e as Error).message); }

try {
  log("M5: import @zcode/bootstrap...");
  const bootstrap = await import("@zcode/bootstrap");
  log("M5 OK: " + Object.keys(bootstrap).slice(0, 3).join(","));
} catch (e) { log("M5 FAIL: " + (e as Error).message); }

try {
  log("M6: import sql.js...");
  const sqljs = await import("sql.js");
  log("M6 OK: " + typeof sqljs.default);
} catch (e) { log("M6 FAIL: " + (e as Error).message); }

log("=== MODULE TEST END ===");
