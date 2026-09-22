/**
 * 快速验证 sqlite-shim 的核心 API 面。
 * 在当前 Node 24 上运行 —— 验证 shim 逻辑正确，然后在 Node 18 (nodejs-mobile) 上运行。
 */
import { initSqliteShim, installSqliteModuleHook, DatabaseSync, backup } from "./sqlite-shim.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, "..", "..", "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm");

async function main() {
  console.log("1. 初始化 sql.js WASM...");
  await initSqliteShim(wasmPath);
  console.log("   ✓ sql.js 已加载");

  console.log("2. 安装 require 钩子...");
  installSqliteModuleHook();
  console.log("   ✓ node:sqlite 钩子已安装");

  // 验证通过 require("node:sqlite") 能拿到 DatabaseSync
  const { createRequire } = await import("node:module");
  const nodeRequire = createRequire(import.meta.url);
  const mod = nodeRequire("node:sqlite");
  console.log("   ✓ require('node:sqlite') 返回:", typeof mod.DatabaseSync, typeof mod.backup);

  console.log("3. 创建内存数据库...");
  const db = new DatabaseSync(":memory:");
  console.log("   ✓ DatabaseSync 创建成功");

  console.log("4. exec DDL...");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)");
  console.log("   ✓ CREATE TABLE 成功");

  console.log("5. prepare + run（位置参数）...");
  const insertStmt = db.prepare("INSERT INTO users (name, age) VALUES (?, ?)");
  const result1 = insertStmt.run("Alice", 30);
  const result2 = insertStmt.run("Bob", 25);
  console.log("   ✓ 插入 Alice:", JSON.stringify(result1));
  console.log("   ✓ 插入 Bob:", JSON.stringify(result2));

  console.log("6. prepare + get（位置参数）...");
  const getStmt = db.prepare("SELECT * FROM users WHERE name = ?");
  const alice = getStmt.get("Alice");
  console.log("   ✓ 查询 Alice:", JSON.stringify(alice));

  console.log("7. prepare + all（位置参数）...");
  const allStmt = db.prepare("SELECT * FROM users ORDER BY age DESC");
  const allUsers = allStmt.all();
  console.log("   ✓ 查询所有:", JSON.stringify(allUsers));

  console.log("8. exec 事务...");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO users (name, age) VALUES (?, ?)").run("Charlie", 40);
  console.log("   ✓ isTransaction:", db.isTransaction);
  db.exec("COMMIT");
  console.log("   ✓ isTransaction after commit:", db.isTransaction);

  console.log("9. prepare + run（命名参数 @ 前缀，裸键绑定）...");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_key TEXT, title TEXT, status TEXT)");
  const taskStmt = db.prepare(
    "INSERT INTO tasks (workspace_key, title, status) VALUES (@workspace_key, @title, @status)",
  );
  const taskResult = taskStmt.run({
    workspace_key: "/sdcard/workspace",
    title: "Test task",
    status: "pending",
  });
  console.log("   ✓ 命名参数插入:", JSON.stringify(taskResult));

  console.log("10. prepare + all（命名参数 WHERE 条件）...");
  const filterStmt = db.prepare(
    "SELECT * FROM tasks WHERE @workspace_key IS NULL OR workspace_key = @workspace_key",
  );
  const filtered = filterStmt.all({ workspace_key: "/sdcard/workspace" });
  console.log("   ✓ 命名参数查询:", JSON.stringify(filtered));

  console.log("11. 文件持久化...");
  const dbPath = join(tmpdir(), `zcode-test-${Date.now()}.db`);
  const fileDb = new DatabaseSync(dbPath);
  fileDb.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
  fileDb.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("hello", "world");
  fileDb.flush();
  console.log("   ✓ 数据库文件存在:", existsSync(dbPath));
  fileDb.close();

  console.log("12. 从文件重新加载数据库...");
  const reloadDb = new DatabaseSync(dbPath);
  const row = reloadDb.prepare("SELECT value FROM kv WHERE key = ?").get("hello");
  console.log("   ✓ 重新加载后查询:", JSON.stringify(row));
  reloadDb.close();

  console.log("13. backup()...");
  const backupPath = join(tmpdir(), `zcode-backup-${Date.now()}.db`);
  const srcDb = new DatabaseSync(dbPath);
  backup(srcDb, backupPath);
  console.log("   ✓ 备份文件存在:", existsSync(backupPath));
  const backupDb = new DatabaseSync(backupPath);
  const backupRow = backupDb.prepare("SELECT value FROM kv WHERE key = ?").get("hello");
  console.log("   ✓ 备份内容查询:", JSON.stringify(backupRow));
  backupDb.close();
  srcDb.close();

  console.log("14. PRAGMA journal_mode (migration-runner 兼容)...");
  const pragmaDb = new DatabaseSync(":memory:");
  // 模拟 migration-runner 的 WAL 检查流程
  const mode1 = pragmaDb.prepare("pragma journal_mode").get();
  console.log("   ✓ 初始 journal_mode:", JSON.stringify(mode1));
  // 尝试设置 WAL
  pragmaDb.exec("pragma journal_mode = wal");
  const mode2 = pragmaDb.prepare("pragma journal_mode").get();
  console.log("   ✓ 设置后 journal_mode:", JSON.stringify(mode2));
  // 设置 WAL 后应该是 "wal"（模拟值）
  if (mode2?.journal_mode !== "wal") throw new Error("WAL 模式设置失败");
  // 其他 PRAGMA 也应被接受
  pragmaDb.exec("pragma busy_timeout = 5000");
  pragmaDb.exec("pragma foreign_keys = on");
  console.log("   ✓ busy_timeout 和 foreign_keys 已接受");
  pragmaDb.close();

  db.close();
  console.log("\n✅ 所有测试通过");
}

main().catch((err) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});
