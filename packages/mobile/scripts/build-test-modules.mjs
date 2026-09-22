/**
 * esbuild 打包 test-modules.ts → test-modules.cjs
 * 用于递增式定位哪个模块触发 FORTIFY 崩溃。
 */
import { build } from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const mobileRoot = resolve(__dirname, "..");
const outfile = join(mobileRoot, "dist", "android", "test-modules.cjs");

const external = [
  "koffi", "@zcode/tui", "playwright-core",
  "@mbears/opentui-core", "bun-ffi-structs", "unsafe-pointer",
];

function resolve(...p) { return p.join("/").replace(/\\/g, "/"); }

await build({
  entryPoints: [join(mobileRoot, "src", "test-modules.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile,
  external,
  keepNames: true,
  define: {
    "import.meta.url": "__zcode_import_meta_url",
    "import.meta.dirname": "__dirname",
  },
  banner: {
    js: `var __zcode_import_meta_url = require("url").pathToFileURL(__filename).href;\n`,
  },
  logLevel: "info",
});

// Apply same Unicode property escape patches
import { readFileSync, writeFileSync } from "node:fs";
let content = readFileSync(outfile, "utf8");
const replacements = [
  [/\\\\p\{[^}]+\}/g, "[\\\\u0080-\\\\uFFFF]"],
  [/\\p\{[^}]+\}/g, "\\u0080-\\uFFFF"],
];
for (const [p, r] of replacements) content = content.replace(p, r);
writeFileSync(outfile, content);

console.log(`[build] test-modules.cjs done → ${outfile}`);
