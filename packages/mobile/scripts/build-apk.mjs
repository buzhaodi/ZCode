/**
 * 完整构建脚本：
 * 1. esbuild 打包 entry-android.cjs（JS 入口 + agent runtime + server + sqlite shim）
 * 2. 复制 JS bundle + WASM + provider config + web UI 到 Android assets/node/
 * 3. （可选）运行 Gradle 构建 APK
 *
 * 用法：
 *   node scripts/build-apk.mjs          # 只打包 assets（不构建 APK）
 *   node scripts/build-apk.mjs --apk    # 打包 assets + 构建 APK
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const mobileRoot = resolve(__dirname, "..");
const androidDir = join(mobileRoot, "android");
const assetsNodeDir = join(androidDir, "app", "src", "main", "assets", "node");
const buildAndroidDir = join(mobileRoot, "dist", "android");

const buildApk = process.argv.includes("--apk");

// ── Step 1: esbuild 打包 ──
console.log("[build-apk] Step 1: bundling JS entry...");
execSync("node scripts/build-android-entry.mjs", {
  cwd: mobileRoot,
  stdio: "inherit",
});

// ── Step 2: 复制到 Android assets ──
console.log("[build-apk] Step 2: copying to Android assets...");

// 清空旧的 assets/node/
if (existsSync(assetsNodeDir)) {
  rmSync(assetsNodeDir, { recursive: true });
}
mkdirSync(assetsNodeDir, { recursive: true });

// 复制 entry-android.cjs
const cjsSrc = join(buildAndroidDir, "entry-android.cjs");
if (!existsSync(cjsSrc)) {
  console.error("[build-apk] ERROR: entry-android.cjs not found at " + cjsSrc);
  process.exit(1);
}
cpSync(cjsSrc, join(assetsNodeDir, "entry-android.cjs"));
console.log("[build-apk]   ✓ entry-android.cjs");

// 复制 assets/ (WASM + provider config)
const assetsSrc = join(buildAndroidDir, "assets");
if (existsSync(assetsSrc)) {
  cpSync(assetsSrc, join(assetsNodeDir, "assets"), { recursive: true });
  console.log("[build-apk]   ✓ assets/ (WASM + provider config)");
}

// 复制 web UI
const webSrc = join(buildAndroidDir, "web");
if (existsSync(webSrc)) {
  cpSync(webSrc, join(assetsNodeDir, "web"), { recursive: true });
  console.log("[build-apk]   ✓ web/ (UI)");
}

// 复制 libnode.so（从 jniLibs 复制到 assets，运行时由 Java 复制到 files 目录后 System.load 加载）
const libnodeSrc = join(androidDir, "app", "src", "main", "jniLibs", "arm64-v8a", "libnode.so");
if (existsSync(libnodeSrc)) {
  cpSync(libnodeSrc, join(assetsNodeDir, "libnode.so"));
  console.log("[build-apk]   ✓ libnode.so");
} else {
  console.warn(`[build-apk] WARNING: libnode.so not found at ${libnodeSrc}`);
}

console.log("[build-apk] Assets ready at: " + assetsNodeDir);

// 列出 assets/node/ 内容
const entries = readdirSync(assetsNodeDir);
console.log("[build-apk] Contents: " + entries.join(", "));

// ── Step 3: 构建 APK (可选) ──
if (buildApk) {
  console.log("[build-apk] Step 3: building APK with Gradle...");
  const gradlew = join(androidDir, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (!existsSync(gradlew)) {
    console.error("[build-apk] ERROR: Gradle wrapper not found at " + gradlew);
    console.error("[build-apk] Run: cd " + androidDir + " && gradle wrapper");
    process.exit(1);
  }
  execSync(`"${gradlew}" assembleDebug`, {
    cwd: androidDir,
    stdio: "inherit",
  });

  const apkPath = join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  if (existsSync(apkPath)) {
    console.log("[build-apk] APK built: " + apkPath);
  } else {
    console.error("[build-apk] ERROR: APK not found at expected path");
    process.exit(1);
  }
} else {
  console.log("[build-apk] Skipping APK build. Run with --apk to build the APK.");
}
