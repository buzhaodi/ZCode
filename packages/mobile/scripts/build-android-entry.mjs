/**
 * esbuild 打包脚本 —— 将 Android 入口和所有依赖打包为单个 CJS 文件。
 *
 * 输出结构：
 *   dist/android/
 *     entry-android.cjs       — 主入口（包含 agent runtime + server + services + sqlite shim）
 *     assets/sql-wasm.wasm     — sql.js WASM 引擎
 *     web/                      — Web UI 静态文件（React SPA）
 *
 * 外部依赖（不打包，运行时不需要也不可加载）：
 *   koffi            — FFI 库，仅 TUI 和 Windows 使用，app-server 模式不加载
 *   @zcode/tui       — 原生 TUI 渲染器，app-server 模式不需要
 *   playwright-core  — 浏览器自动化，Android 不需要
 *
 * node:* 内置模块由 esbuild 自动外部化（platform=node）。
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const mobileRoot = resolve(__dirname, "..");
const repoRoot = resolve(mobileRoot, "..", "..");
const outDir = join(mobileRoot, "dist", "android");

// 确保输出目录存在
mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "assets"), { recursive: true });

// ── 复制 sql.js WASM 文件 ──
const wasmSrc = join(repoRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
const wasmDest = join(outDir, "assets", "sql-wasm.wasm");
if (existsSync(wasmSrc)) {
  cpSync(wasmSrc, wasmDest);
  console.log(`[build] copied sql-wasm.wasm → ${wasmDest}`);
} else {
  console.warn(`[build] WARNING: sql-wasm.wasm not found at ${wasmSrc}`);
}

// ── 复制 built-in provider 配置 ──
const providerConfigSrc = join(
  repoRoot, "apps", "zcode-cli", "packages", "cli", "dist", "provider", "zcode-builtin.json",
);
const providerConfigDest = join(outDir, "assets", "zcode-builtin.json");
if (existsSync(providerConfigSrc)) {
  cpSync(providerConfigSrc, providerConfigDest);
  console.log(`[build] copied provider config → ${providerConfigDest}`);
} else {
  console.warn(`[build] WARNING: provider config not found at ${providerConfigSrc}`);
}

// ── 复制 Web UI 静态文件 ──
const webSrc = join(mobileRoot, "dist");
const webDest = join(outDir, "web");
if (existsSync(join(webSrc, "index.html"))) {
  mkdirSync(webDest, { recursive: true });
  // 只复制 web 相关文件，避免把 android/ 目录复制进自身
  for (const name of ["index.html", "assets", "pdfjs"]) {
    const src = join(webSrc, name);
    if (existsSync(src)) {
      cpSync(src, join(webDest, name), { recursive: true });
    }
  }
  console.log(`[build] copied web UI → ${webDest}`);
} else {
  console.warn(`[build] WARNING: web UI not found at ${webSrc}. Run web build first.`);
}

// ── esbuild 打包 ──
const entryPoint = join(mobileRoot, "src", "entry-android.ts");
const outfile = join(outDir, "entry-android.cjs");

/** 不打包的模块列表（运行时不加载或不可加载）。
 * esbuild platform=node 会自动外部化 node:* 内置模块。 */
const external = [
  "koffi",
  "@zcode/tui",
  "playwright-core",
  "@mbears/opentui-core",
  "bun-ffi-structs",
  "unsafe-pointer",
];

console.log(`[build] bundling ${entryPoint} → ${outfile}`);

await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  outfile,
  external,
  // 保持函数名以便调试
  keepNames: true,
  // 生成 sourcemap 便于调试
  sourcemap: "linked",
  // 别名解析：@zcode/* 包从 node_modules 解析
  alias: {
    // 确保从 workspace 根解析 @zcode 包
  },
  define: {
    "process.env.ZCODE_RUNTIME_ENV": JSON.stringify("production"),
    // CJS bundle 中 import.meta 不可用；用 __filename 派生
    "import.meta.url": "__zcode_import_meta_url",
    "import.meta.dirname": "__dirname",
  },
  loader: {
    // 处理 .node 文件（native addons）—— 不打包，留为 require
    ".node": "empty",
  },
  banner: {
    js: `#!/usr/bin/env node\n// ZCode Android entry — bundled by esbuild\n// Target: nodejs-mobile (Node 18)\n\nvar __zcode_import_meta_url = require("url").pathToFileURL(__filename).href;\nvar __fs = require("fs");\nvar __path = require("path");\nvar __dataDir = process.env.ZCODE_DATA_DIR || __path.join(__dirname, "data");\ntry { __fs.mkdirSync(__dataDir, {recursive:true}); __fs.writeFileSync(__path.join(__dataDir, "progress.log"), "BANNER OK\\n"); } catch(e){}\n// 确保 TMPDIR 指向 app 可写目录（Android /tmp 不可写）\nprocess.env.TMPDIR = __path.join(__dataDir, "..", "cache");\ntry { __fs.mkdirSync(process.env.TMPDIR, {recursive:true}); } catch(e){}\n// 覆盖 os.tmpdir()：nodejs-mobile 的 os.tmpdir() 读 C 层 getenv，不读 process.env。\n// 在 banner 里替换 os 模块的 tmpdir 方法，确保后续 require("os").tmpdir() 返回正确路径。\nvar __os = require("os");\n__os.tmpdir = function() { return process.env.TMPDIR || "/tmp"; };\n// 覆盖 os.homedir()：同 tmpdir，nodejs-mobile 读 C 层 getenv，不读 process.env.HOME。\n// 个人 provider 配置在 ~/.zcode/v2/provider_config.json，homedir 必须正确。\nprocess.env.HOME = process.env.HOME || __dataDir;\n__os.homedir = function() { return process.env.HOME || __dataDir; };\n// 设置 ZCODE_DATA_BASE_DIR：getDataBaseDir() 优先读这个，决定 .zcode/v2/ 的位置\nprocess.env.ZCODE_DATA_BASE_DIR = process.env.HOME;\ntry { __fs.appendFileSync(__path.join(__dataDir, "progress.log"), "TMPDIR=" + process.env.TMPDIR + " HOME=" + __os.homedir() + "\\n"); } catch(e){}\nfunction __writeCrash(type, err){\n  try{\n    __fs.mkdirSync(__dataDir, {recursive:true});\n    var msg = new Date().toISOString()+"\\n["+type+"] "+(err&&err.stack||err)+"\\n";\n    __fs.appendFileSync(__path.join(__dataDir, "crash.log"), msg);\n  }catch(e){}\n}\nprocess.on("uncaughtException", function(err){ __writeCrash("uncaughtException", err); process.exit(1); });\nprocess.on("unhandledRejection", function(err){ __writeCrash("unhandledRejection", err); process.exit(1); });\n// 预安装 node:sqlite 钩子：始终拦截，使用 sql.js shim（原生 node:sqlite 在 nodejs-mobile 上有兼容问题）\nvar __sqlitePlaceholder = function(){ throw new Error("DatabaseSync not initialized — call initSqliteShim() first"); };\nglobal.__zcodeSqliteModule = { DatabaseSync: __sqlitePlaceholder, backup: __sqlitePlaceholder, SQLInputValue: undefined };\n// node:sea 在 Node < 21 不存在，Node 24 有但兼容处理\nvar __missingBuiltin = { DatabaseSync: __sqlitePlaceholder, backup: __sqlitePlaceholder, isSEA: false, assets: {}, getAsset: function(){ return undefined; }, getAssetKeys: function(){ return []; } };\nvar __Module = require("module");\nvar __origLoad = __Module._load;\n__Module._load = function(request, parent, isMain) {\n  if (request === "node:sqlite") return global.__zcodeSqliteModule;\n  if (request === "node:sea") { try { return __origLoad.call(this, request, parent, isMain); } catch(e2) { return __missingBuiltin; } }\n  return __origLoad.apply(this, arguments);\n};\n// Intl polyfill：nodejs-mobile 无 ICU，Intl 全局不存在。提供最小化实现。\nglobalThis.Intl = globalThis.Intl || {};\nif (typeof globalThis.Intl.DateTimeFormat === "undefined") {\n  globalThis.Intl = {\n    DateTimeFormat: function(locale, opts) {\n      var o = opts || {};\n      return {\n        format: function(d) { return new Date(d || Date.now()).toISOString().slice(0, 19).replace("T", " "); },\n        formatToParts: function(d) { return [{ type: "year", value: String(new Date(d || Date.now()).getFullYear()) }]; },\n        resolvedOptions: function() { return { locale: locale || "en-US", timeZone: "UTC", calendar: "gregory", numberingSystem: "latn" }; }\n      };\n    },\n    NumberFormat: function(locale, opts) {\n      return {\n        format: function(n) { return String(n); },\n        formatToParts: function(n) { return [{ type: "integer", value: String(Math.trunc(n)) }]; },\n        resolvedOptions: function() { return { locale: locale || "en-US" }; }\n      };\n    },\n    Collator: function(locale, opts) {\n      return { compare: function(a, b) { return a < b ? -1 : a > b ? 1 : 0; }, resolvedOptions: function() { return { locale: locale || "en-US" }; } };\n    },\n    ListFormat: function(locale, opts) {\n      return { format: function(arr) { return arr.join(", "); } };\n    },\n    PluralRules: function(locale, opts) {\n      return { select: function(n) { return n === 1 ? "one" : "other"; } };\n    },\n    RelativeTimeFormat: function(locale, opts) {\n      return { format: function(v, u) { return v + " " + u; } };\n    },\n    Segmenter: function(locale, opts) {\n      return { segment: function(s) { return { [Symbol.iterator]: function*() { for (var c of s) yield { segment: c, index: 0, input: s }; } }; } };\n    },\n    getCanonicalLocales: function(l) { return Array.isArray(l) ? l : [l]; },\n    supportedValuesOf: function(k) { return []; }\n  };\n}\n// ES2023 Array 方法 polyfill（Node 18 缺失 toSorted/toReversed/toSpliced/with）\nif (!Array.prototype.toSorted) { Array.prototype.toSorted = function(c) { return [...this].sort(c); }; }\nif (!Array.prototype.toReversed) { Array.prototype.toReversed = function() { return [...this].reverse(); }; }\nif (!Array.prototype.toSpliced) { Array.prototype.toSpliced = function(s, d) { var a = [...this]; a.splice(s, d, ...Array.prototype.slice.call(arguments, 2)); return a; }; }\nif (!Array.prototype.with) { Array.prototype.with = function(i, v) { var a = [...this]; a[i] = v; return a; }; }\n`,
  },
  logLevel: "info",
});

console.log(`[build] done → ${outfile}`);

// ── 后处理：替换 Unicode 属性转义 ──
// nodejs-mobile (Node 18) 的 V8 不含完整 ICU，\p{L}\p{N}\p{M}\p{S} 会抛 SyntaxError。
// 用等价的字符范围替换：ASCII 字母数字 + 非 ASCII BMP 字符 (\u00c0-\uFFFF)
import { readFileSync, writeFileSync as writeFile2 } from "node:fs";

let bundleContent = readFileSync(outfile, "utf8");
let patchCount = 0;

// 先替换双反斜杠（RegExp 构造器字符串 "\\p{L}"），再替换单反斜杠（正则字面量 \p{L}）
// 顺序很重要：先处理双反斜杠，否则单反斜杠替换会部分匹配
const replacements = [
  // 双反斜杠：\\p{X} → [...]（RegExp 构造器字符串，输出需 \\u = JS字符串中的 \u）
  [/\\\\p\{L\}/g, "[a-zA-Z\\\\u00c0-\\\\uFFFF]"],
  [/\\\\p\{N\}/g, "[0-9]"],
  [/\\\\p\{M\}/g, ""],
  [/\\\\p\{S\}/g, ""],
  [/\\\\p\{P\}/g, "[\\\\u0021-\\\\u002f\\\\u003a-\\\\u0040\\\\u005b-\\\\u0060\\\\u007b-\\\\u007e\\\\u00a1-\\\\u00bf\\\\u2000-\\\\u206f\\\\u3000-\\\\u303f]"],
  [/\\\\p\{Pd\}/g, "[\\\\u002d\\\\u2010-\\\\u2015]"],
  [/\\\\p\{Cc\}/g, "[\\\\u0000-\\\\u001f\\\\u007f]"],
  // 通配：所有剩余的 \\p{...} → [\\u0080-\\uFFFF]（非 ASCII BMP 字符的广覆盖）
  [/\\\\p\{[^}]+\}/g, "[\\\\u0080-\\\\uFFFF]"],
  // 单反斜杠：\p{X} → 字符范围（正则字面量，输出需 \u = 正则的 Unicode 转义）
  [/\\p\{L\}/g, "a-zA-Z\\u00c0-\\uFFFF"],
  [/\\p\{N\}/g, "0-9"],
  [/\\p\{M\}/g, ""],
  [/\\p\{S\}/g, ""],
  [/\\p\{P\}/g, "\\u0021-\\u002f\\u003a-\\u0040\\u005b-\\u0060\\u007b-\\u007e\\u00a1-\\u00bf\\u2000-\\u206f\\u3000-\\u303f"],
  [/\\p\{Pd\}/g, "\\u002d\\u2010-\\u2015"],
  [/\\p\{Cc\}/g, "\\u0000-\\u001f\\u007f"],
  // 通配：所有剩余的 \p{...} → \u0080-\uFFFF
  [/\\p\{[^}]+\}/g, "\\u0080-\\uFFFF"],
];

for (const [pattern, replacement] of replacements) {
  const before = bundleContent.length;
  bundleContent = bundleContent.replace(pattern, replacement);
  if (bundleContent.length !== before) patchCount++;
}

if (patchCount > 0) {
  writeFile2(outfile, bundleContent);
  console.log(`[build] patched ${patchCount} Unicode property escape patterns`);
} else {
  console.log("[build] no Unicode property escapes found (OK)");
}

console.log(`[build] output size: see ${outfile}`);
