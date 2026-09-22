/**
 * node:sqlite 兼容层 — 用 sql.js (WASM SQLite) 在 Node 18 (nodejs-mobile) 上提供
 * 与 Node 22+ 内置 node:sqlite 模块一致的 DatabaseSync / StatementSync / backup 接口。
 *
 * 为什么需要它：nodejs-mobile 最新版本基于 Node 18，不包含 node:sqlite 模块。
 * 整个存储层（session store、task index、automation、off-peak repo）都依赖
 * DatabaseSync 的同步 API。本 shim 用 sql.js 的 WASM SQLite 引擎在内存中执行 SQL，
 * 并在写入后延迟将数据库快照持久化到磁盘文件。
 *
 * 限制：sql.js 是单进程内存引擎，不支持多进程文件锁和 WAL。Android 上只有一个
 * Node 进程访问数据库，因此不影响功能。PRAGMA journal_mode/busy_timeout 被静默
 * 接受为 no-op。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

// 同时兼容 ESM 和 CJS：ESM 下 createRequire 从 import.meta.url 创建 require；
// esbuild 打包为 CJS 时 import.meta.url 会被 polyfill。
const nodeRequire = createRequire(
  typeof import.meta !== "undefined" && "url" in import.meta
    ? import.meta.url
    : `file://${process.cwd()}/`,
);

// sql.js 的类型声明较弱，这里用宽松类型
type SqlJsDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
  getRowsModified(): number;
};

type SqlJsStatement = {
  bind(params: unknown[]): number;
  step(): boolean | null;
  getAsObject(): Record<string, unknown>;
  free(): void;
  reset(): void;
};

type SqlJsModule = {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
};

let sqlModule: SqlJsModule | null = null;
let initPromise: Promise<void> | null = null;

/**
 * 初始化 sql.js WASM 引擎。必须在创建任何 DatabaseSync 之前调用。
 * nodejs-mobile 的入口点会在启动时 await 此函数。
 *
 * @param wasmPath - sql-wasm.wasm 文件的路径；不传时从同目录 assets/ 查找
 */
export async function initSqliteShim(wasmPath?: string): Promise<void> {
  if (sqlModule) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // 动态导入 sql.js —— esbuild 打包时会作为外部依赖保留
    const initSqlJs = (await import("sql.js")).default;
    const locateFile = (file: string): string => {
      if (wasmPath) return wasmPath;
      // 默认从入口同目录的 assets/ 加载
      return `assets/${file}`;
    };
    sqlModule = await initSqlJs({ locateFile }) as unknown as SqlJsModule;
  })();
  return initPromise;
}

/**
 * 安装 Node 模块加载钩子，拦截 require("node:sqlite") 和 import "node:sqlite"
 * 调用，返回本 shim 的 DatabaseSync / backup。必须在 initSqliteShim() 完成后调用。
 *
 * esbuild 打包为 CJS 后，所有 `import { DatabaseSync } from "node:sqlite"`
 * 都会变成 require("node:sqlite")，因此 Module._load 钩子能覆盖全部调用点。
 *
 * banner 中预安装了一个钩子，返回 global.__zcodeSqliteModule（占位对象）。
 * 此函数更新该全局对象的 DatabaseSync/backup 属性，使模块加载阶段存储的
 * 引用（var import_node_sqlite = require("node:sqlite")）在运行时能拿到真实实现。
 */
export function installSqliteModuleHook(): void {
  // 更新 banner 预安装的全局对象
  const g = globalThis as unknown as { __zcodeSqliteModule?: { DatabaseSync: unknown; backup: unknown; SQLInputValue?: unknown } };
  if (g.__zcodeSqliteModule) {
    g.__zcodeSqliteModule.DatabaseSync = DatabaseSync;
    g.__zcodeSqliteModule.backup = backup;
    g.__zcodeSqliteModule.SQLInputValue = undefined;
  }
  // 同时安装新钩子（覆盖 banner 的钩子），确保后续 require("node:sqlite") 返回正确对象
  const Module = nodeRequire("module") as typeof import("node:module");
  const originalLoad = Module._load;
  Module._load = function (request: string, parent: NodeJS.Module | undefined, isMain: boolean) {
    if (request === "node:sqlite") {
      return g.__zcodeSqliteModule ?? { DatabaseSync, backup, SQLInputValue: undefined };
    }
    return originalLoad.apply(this, arguments as unknown as [string, NodeJS.Module | undefined, boolean]);
  };
}

// ── SQL 参数解析 ──────────────────────────────────────────────

/**
 * 从 SQL 文本中提取命名参数的前缀和名称。
 * node:sqlite 默认 allowBareNamedParameters: true，调用方传入 { name: value }
 * 而不带 @/:/$ 前缀。sql.js 要求绑定键包含前缀，因此需要做转换。
 */
function extractNamedParams(sql: string): Map<string, string> {
  // 匹配 @name, :name, $name（排除 :: 类型转换和 $1 数字占位符）
  const re = /[@:$]([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const bareToPrefixed = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const prefix = match[0][0];
    const bareName = match[1];
    if (!bareToPrefixed.has(bareName)) {
      bareToPrefixed.set(bareName, `${prefix}${bareName}`);
    }
  }
  return bareToPrefixed;
}

/**
 * 将 node:sqlite 风格的参数转换为 sql.js 能接受的格式。
 * - 数组参数（位置绑定）直接传递
 * - 对象参数（命名绑定）将裸键名加上 @/:/$ 前缀
 */
function normalizeParams(
  sql: string,
  params: unknown[],
): unknown[] | Record<string, unknown> {
  if (params.length === 0) return [];

  const first = params[0];
  // node:sqlite 允许 run({ name: value }) 单对象参数做命名绑定
  if (
    params.length === 1 &&
    typeof first === "object" &&
    first !== null &&
    !Array.isArray(first) &&
    !(first instanceof Uint8Array) &&
    !(first instanceof ArrayBuffer)
  ) {
    const bareToPrefixed = extractNamedParams(sql);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
      const prefixed = bareToPrefixed.get(key) ?? `@${key}`;
      result[prefixed] = value;
    }
    return result;
  }

  // 位置绑定
  return params;
}

// ── 错误增强 ──────────────────────────────────────────────────

const SQLITE_OK = 0;
const SQLITE_ERROR = 1;
const SQLITE_BUSY = 5;

/**
 * 给 sql.js 抛出的错误附加 errcode 属性。
 * migration-runner 检查 (error.errcode & 0xff) === 5 (SQLITE_BUSY) 来决定是否重试。
 * sql.js 单进程不会产生 SQLITE_BUSY，但 errcode 属性必须存在以避免属性访问崩溃。
 */
function augmentError(error: unknown): unknown {
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    if (!("errcode" in e)) {
      e.errcode = SQLITE_ERROR;
    }
  }
  return error;
}

// ── DatabaseSync ──────────────────────────────────────────────

interface DatabaseSyncOptions {
  timeout?: number;
  readOnly?: boolean;
}

interface StatementSyncOptions {
  timeout?: number;
}

export class DatabaseSync {
  private readonly db: SqlJsDatabase;
  private readonly filePath: string | null;
  private readonly readOnly: boolean;
  private inTransaction = false;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  // sql.js 是内存引擎，不支持 WAL；migration-runner 会检查 journal_mode 是否为 wal。
  // 用 flag 模拟 WAL 设置，让 migration prelude 通过。
  private journalMode = "memory";

  constructor(path: string, options?: DatabaseSyncOptions) {
    if (!sqlModule) {
      throw new Error(
        "node:sqlite shim not initialized — call initSqliteShim() before constructing DatabaseSync",
      );
    }
    this.filePath = path === ":memory:" ? null : path;
    this.readOnly = options?.readOnly ?? false;

    // 从磁盘加载已有数据库文件
    if (this.filePath && existsSync(this.filePath)) {
      const data = readFileSync(this.filePath);
      this.db = new sqlModule.Database(new Uint8Array(data));
    } else if (this.filePath) {
      // 新数据库 —— 确保目录存在
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.db = new sqlModule.Database();
    } else {
      // :memory:
      this.db = new sqlModule.Database();
    }

    // 设置 busy_timeout（sql.js 单进程内存模式无实际意义，但兼容 PRAGMA 调用）
    // 不执行任何 PRAGMA —— exec 中拦截为 no-op
  }

  exec(sql: string): void {
    // PRAGMA 拦截：sql.js 是内存引擎，WAL/busy_timeout/foreign_keys 等无实际意义。
    // 但 migration-runner 会设置和检查这些 PRAGMA，需要在内存中模拟。
    if (this.tryHandlePragmaExec(sql)) return;
    try {
      this.db.exec(sql);
      this.trackTransactionState(sql);
      if (!this.readOnly && this.isWriteSqlImpl(sql)) {
        this.markDirty();
      }
    } catch (error) {
      throw augmentError(error);
    }
  }

  prepare(sql: string, _options?: StatementSyncOptions): StatementSync {
    // PRAGMA journal_mode 读取：返回模拟的 WAL/memory 状态
    const pragmaRead = this.tryHandlePragmaRead(sql);
    if (pragmaRead) return pragmaRead;
    return new StatementSync(this, this.db, sql);
  }

  get isTransaction(): boolean {
    return this.inTransaction;
  }

  close(): void {
    this.flush();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.db.close();
  }

  /** 内部：暴露底层 sql.js Database 供 backup() 使用 */
  get _rawDb(): SqlJsDatabase {
    return this.db;
  }

  // ── 持久化 ──

  private markDirty(): void {
    this.dirty = true;
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (!this.filePath || this.readOnly) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.flush(), 200);
    // 不阻塞事件循环退出
    (this.persistTimer as { unref?: () => void }).unref?.();
  }

  /** 立即将内存数据库快照写入磁盘。在 close() 和外部检查点调用。 */
  flush(): void {
    if (!this.filePath || this.readOnly || !this.dirty) return;
    try {
      const data = this.db.export();
      writeFileSync(this.filePath, Buffer.from(data));
      this.dirty = false;
    } catch {
      // 持久化失败不阻断执行；下次写入会重试
    }
  }

  // ── 事务状态追踪 ──

  private trackTransactionState(sql: string): void {
    const trimmed = sql.trim().replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").trim();
    const upper = trimmed.toUpperCase();
    if (upper.startsWith("BEGIN")) {
      this.inTransaction = true;
    } else if (upper.startsWith("COMMIT") || upper.startsWith("ROLLBACK") || upper.startsWith("END")) {
      this.inTransaction = false;
    }
  }

  /** 判断 SQL 是否可能修改数据（DDL/DML），用于决定是否标记 dirty */
  private isWriteSqlImpl(sql: string): boolean {
    const upper = sql.trim().replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").trim().toUpperCase();
    // BEGIN/COMMIT/ROLLBACK 不产生数据变更（事务控制）
    // PRAGMA 在 sql.js 中是 no-op
    return (
      upper.startsWith("INSERT") ||
      upper.startsWith("UPDATE") ||
      upper.startsWith("DELETE") ||
      upper.startsWith("CREATE") ||
      upper.startsWith("DROP") ||
      upper.startsWith("ALTER") ||
      upper.startsWith("REPLACE") ||
      upper.startsWith("ATTACH") ||
      upper.startsWith("DETACH") ||
      upper.startsWith("VACUUM")
    );
  }

  /** StatementSync 调用：通知数据库有写入操作 */
  _notifyWrite(): void {
    if (!this.readOnly) {
      this.markDirty();
    }
  }

  /** StatementSync 调用：检查 SQL 是否是写入 */
  _isWriteSql(sql: string): boolean {
    return this.isWriteSqlImpl(sql);
  }

  // ── PRAGMA 拦截 ──

  /**
   * 拦截 PRAGMA 设置语句。对于 sql.js 内存引擎，WAL/busy_timeout/foreign_keys
   * 无实际意义，静默接受即可。journal_mode 的值被记录以便 prepare 读取时返回。
   */
  private tryHandlePragmaExec(sql: string): boolean {
    const trimmed = sql.trim().replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").trim();
    const pragmaMatch = trimmed.match(/^pragma\s+(\w+)\s*(?:=\s*(.+?))?\s*$/i);
    if (!pragmaMatch) return false;

    const name = pragmaMatch[1].toLowerCase();
    const value = pragmaMatch[2]?.replace(/['"]/g, "").trim();

    switch (name) {
      case "journal_mode":
        if (value) this.journalMode = value.toLowerCase();
        this.trackTransactionState(sql);
        return true;
      case "busy_timeout":
      case "foreign_keys":
      case "synchronous":
      case "wal_autocheckpoint":
        // no-op for in-memory engine
        this.trackTransactionState(sql);
        return true;
      default:
        // 其他 PRAGMA 交给 sql.js 处理
        return false;
    }
  }

  /**
   * 拦截 PRAGMA 读取语句（如 `PRAGMA journal_mode`）。
   * 返回一个特殊的 StatementSync，其 get() 返回模拟值；不是 PRAGMA 读取时返回 null。
   */
  private tryHandlePragmaRead(sql: string): StatementSync | null {
    const trimmed = sql.trim().replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").trim();
    const pragmaReadMatch = trimmed.match(/^pragma\s+(\w+)\s*$/i);
    if (!pragmaReadMatch) return null;

    const name = pragmaReadMatch[1].toLowerCase();
    if (name === "journal_mode") {
      return new PragmaReadStatementSync({ journal_mode: this.journalMode });
    }
    return null;
  }
}

// ── PragmaReadStatementSync ───────────────────────────────────

/**
 * 特殊语句：用于 PRAGMA 读取（如 `PRAGMA journal_mode`）。
 * 不经过 sql.js，直接返回 DatabaseSync 中记录的模拟值。
 */
class PragmaReadStatementSync {
  constructor(private readonly row: Record<string, unknown>) {}

  run(..._params: unknown[]): RunResult {
    return { changes: 0, lastInsertRowid: 0 };
  }

  get(..._params: unknown[]): Record<string, unknown> | undefined {
    return { ...this.row };
  }

  all(..._params: unknown[]): Record<string, unknown>[] {
    return [{ ...this.row }];
  }
}

// ── StatementSync ─────────────────────────────────────────────

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class StatementSync {
  private readonly dbSync: DatabaseSync;
  private readonly db: SqlJsDatabase;
  private readonly sql: string;
  private readonly isWrite: boolean;

  constructor(dbSync: DatabaseSync, db: SqlJsDatabase, sql: string) {
    this.dbSync = dbSync;
    this.db = db;
    this.sql = sql;
    this.isWrite = dbSync._isWriteSql(sql);
  }

  /**
   * 执行 SQL 并返回受影响行数。对应 node:sqlite StatementSync.run()。
   * 支持位置绑定 run(v1, v2, ...) 和命名绑定 run({ name: value })。
   */
  run(...params: unknown[]): RunResult {
    const stmt = this.db.prepare(this.sql);
    try {
      const normalized = normalizeParams(this.sql, params);
      if (Array.isArray(normalized)) {
        stmt.bind(normalized);
      } else {
        // 命名参数：sql.js bind 接受对象
        const values = Object.values(normalized);
        // sql.js 的 bind(array) 按位置绑定；对于命名参数需要使用 bindParameterName
        // 但 sql.js 的 Statement.bind 只支持数组。需要手动按名称绑定。
        this.bindNamed(stmt, normalized);
      }
      stmt.step();
      const changes = this.db.getRowsModified();
      if (this.isWrite) {
        this.dbSync._notifyWrite();
      }
      return { changes, lastInsertRowid: 0 };
    } catch (error) {
      throw augmentError(error);
    } finally {
      stmt.free();
    }
  }

  /**
   * 执行查询并返回第一行（对象形式）或 undefined。对应 node:sqlite StatementSync.get()。
   */
  get(...params: unknown[]): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(this.sql);
    try {
      const normalized = normalizeParams(this.sql, params);
      if (Array.isArray(normalized)) {
        stmt.bind(normalized);
      } else {
        this.bindNamed(stmt, normalized);
      }
      const hasRow = stmt.step();
      if (hasRow) {
        return stmt.getAsObject();
      }
      return undefined;
    } catch (error) {
      throw augmentError(error);
    } finally {
      stmt.free();
    }
  }

  /**
   * 执行查询并返回所有行的数组。对应 node:sqlite StatementSync.all()。
   */
  all(...params: unknown[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(this.sql);
    try {
      const normalized = normalizeParams(this.sql, params);
      if (Array.isArray(normalized)) {
        stmt.bind(normalized);
      } else {
        this.bindNamed(stmt, normalized);
      }
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } catch (error) {
      throw augmentError(error);
    } finally {
      stmt.free();
    }
  }

  // ── 命名参数绑定 ──

  /**
   * sql.js 的 Statement.bind() 同时接受位置数组和命名参数对象。
   * 命名参数对象的键需包含前缀（@name, :name, $name）——
   * 已在 normalizeParams 中将裸键转换为带前缀的键，这里直接传递。
   */
  private bindNamed(stmt: SqlJsStatement, params: Record<string, unknown>): void {
    stmt.bind(params as unknown as unknown[]);
  }
}

// ── backup() ──────────────────────────────────────────────────

/**
 * 在线备份：将源数据库导出到目标文件路径。
 * node:sqlite 的 backup() 使用 SQLite online backup API；
 * 这里简化为 export() + writeFileSync，功能等价（单进程无并发）。
 */
export function backup(sourceDb: DatabaseSync, targetPath: string): void {
  const data = sourceDb._rawDb.export();
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, Buffer.from(data));
}

// ── 类型导出（兼容 type-only imports）──────────────────────────

export type SQLInputValue = string | number | bigint | boolean | null | Uint8Array;
