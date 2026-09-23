/**
 * Android 入口 —— 在 nodejs-mobile (Node 18) 内运行的启动脚本。
 *
 * 流程：
 * 1. 初始化 sql.js WASM + 安装 node:sqlite 钩子（替代 Node 22+ 的内置 SQLite）
 * 2. 创建进程内 agent 工厂（PassThrough 流对 + runZCodeProtocolAgent）
 * 3. 创建本地服务集合（file/git/settings/agent 等 40+ 服务）
 * 4. 启动 HTTP+WebSocket 服务器，绑定 127.0.0.1:0（随机端口）
 * 5. 向 native 层报告端口（stdout），由 native 启动 WebView 加载 localhost
 *
 * WebView 连接链路：WebView → http://localhost:PORT/（加载 SPA）→ ws://localhost:PORT/ws（RPC）
 * 全部在手机本地完成，不依赖外部服务器。
 */
import { PassThrough } from "node:stream";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { initSqliteShim, installSqliteModuleHook } from "./sqlite-shim.js";
import { runZCodeProtocolAgent } from "@zcode/bootstrap";
import {
  createLocalServices,
  materializeZCodeBuiltinProviderConfig,
  ZCodeStreamTransport,
  type ZCodeInProcessAgentFactory,
} from "@zcode/services/node";
import { createHttpServer } from "@zcode/server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Android 数据目录（由 native 层通过 ZCODE_DATA_DIR 环境变量传入） */
function resolveDataDir(): string {
  const dir = process.env["ZCODE_DATA_DIR"];
  if (dir && existsSync(dir)) return dir;
  // 兜底：nodejs-mobile 的工作目录
  return join(__dirname, "data");
}

/** 工作区目录：用户文件操作的根路径 */
function resolveWorkspacePath(): string {
  const workspace = process.env["ZCODE_WORKSPACE_PATH"];
  if (workspace) {
    mkdirSync(workspace, { recursive: true });
    return workspace;
  }
  const dataDir = resolveDataDir();
  const workspacePath = join(dataDir, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

/** 存储目录：sessions、settings、tasks-index 等数据库文件 */
function resolveStorageDir(): string {
  const storage = process.env["ZCODE_STORAGE_DIR"];
  if (storage) {
    mkdirSync(storage, { recursive: true });
    return storage;
  }
  // 兜底：使用 app 数据目录下的 zcode 子目录（由 ZCODE_DATA_DIR 指定，不落到 /data）
  const dir = join(resolveDataDir(), "zcode");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Web UI 静态文件目录（由 build 脚本复制到此） */
function resolveWebStaticRoot(): string | undefined {
  const root = process.env["ZCODE_WEB_STATIC_ROOT"];
  if (root && existsSync(root)) return root;
  // 默认从同目录的 web/ 加载
  const local = join(__dirname, "web");
  return existsSync(local) ? local : undefined;
}

/**
 * 创建进程内 agent 工厂。
 *
 * 每次被 ZCodeAgentProcessManager 调用时：
 * 1. 创建一对 PassThrough 流
 * 2. 在后台启动 runZCodeProtocolAgent（agent 在同一进程内运行）
 * 3. 创建 ZCodeStreamTransport 连接 host 和 agent
 * 4. 返回 transport
 */
function createInProcessAgentFactory(
  builtinProviderConfigPath?: string,
  personalProviderConfigPath?: string,
): ZCodeInProcessAgentFactory {
  const workspacePath = resolveWorkspacePath();
  const storageDir = resolveStorageDir();

  return async (context) => {
    const agentInput = new PassThrough();
    const agentOutput = new PassThrough();

    // 在后台启动 agent —— 不 await（agent 会持续运行直到输入流关闭）
    runZCodeProtocolAgent({
      input: agentInput,
      output: agentOutput,
      cwd: context.workspacePath || workspacePath,
      presentationSurface: "terminal",
      env: {
        ...process.env,
        ZCODE_STORAGE_DIR: storageDir,
        HOME: resolveDataDir(),
        SHELL: process.env["SHELL"] ?? "/system/bin/sh",
        PATH: process.env["PATH"] ?? "/system/bin:/system/xbin",
        ...(builtinProviderConfigPath ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinProviderConfigPath } : {}),
        ...(personalProviderConfigPath ? { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalProviderConfigPath } : {}),
      },
    }).catch((error: unknown) => {
      // agent 崩溃时记录错误到文件和 stderr
      const msg = error instanceof Error ? error.stack ?? error.message : String(error);
      const errLine = `[android-entry] agent crashed: ${msg}\n`;
      console.error(errLine);
      try {
        const { writeFileSync, mkdirSync } = require("node:fs");
        const { join } = require("node:path");
        const d = resolveDataDir();
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, "agent-crash.log"), errLine, { flag: "a" });
      } catch { /* ignore */ }
      agentOutput.destroy(error instanceof Error ? error : new Error(msg));
    });

    // 创建流传输：
    // - inputStream = agentOutput（agent 写入的，host 读取）
    // - outputStream = agentInput（host 写入的，agent 读取）
    const transport = new ZCodeStreamTransport(agentOutput, agentInput);

    // 记录 agent 返回的消息到文件，用于调试
    transport.onMessage((msg: unknown) => {
      try {
        const m = msg as Record<string, unknown>;
        const d = resolveDataDir();
        const { appendFileSync } = require("node:fs");
        const { join } = require("node:path");
        const summary = JSON.stringify(m).slice(0, 500);
        appendFileSync(join(d, "agent-protocol.log"), `${new Date().toISOString()} [agent→host] ${summary}\n`);
      } catch { /* ignore */ }
    });

    // 等待 agent 首帧就绪（简单延迟；agent 启动后立即可以接收请求）
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    return transport;
  };
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const storageDir = resolveStorageDir();
  const workspacePath = resolveWorkspacePath();
  const webStaticRoot = resolveWebStaticRoot();

  // 进度日志：每一步都写文件，崩溃时可知停在哪一步
  const progressFile = join(dataDir, "progress.log");
  const log = (msg: string) => {
    try {
      const ts = new Date().toISOString();
      writeFileSync(progressFile, `${ts} ${msg}\n`, { flag: "a" });
      console.log(`[android-entry] ${msg}`);
    } catch { /* ignore */ }
  };

  log(`START dataDir=${dataDir} storageDir=${storageDir}`);

  // 1. 初始化 sql.js WASM
  const wasmPath = join(__dirname, "assets", "sql-wasm.wasm");
  log(`STEP1 init sqlite shim wasm=${wasmPath}`);
  await initSqliteShim(wasmPath);
  log("STEP1 DONE sqlite shim ready");

  // 2. 安装 node:sqlite require 钩子
  log("STEP2 install sqlite hook");
  installSqliteModuleHook();
  log("STEP2 DONE");

  // 3. 初始化 provider 配置（先于 agent factory，因为 factory 需要配置路径）
  log("STEP3 provider config");
  let zcodeBuiltinProviderConfigFilePath: string | undefined;
  let personalProviderConfigFilePath: string | undefined;
  const providerConfigPath = join(__dirname, "assets", "zcode-builtin.json");
  if (existsSync(providerConfigPath)) {
    const providerConfigContent = readFileSync(providerConfigPath, "utf8");
    zcodeBuiltinProviderConfigFilePath = await materializeZCodeBuiltinProviderConfig({
      environmentConfigRoot: storageDir,
      content: providerConfigContent,
    });
    // 个人 provider 配置：优先使用 UI 配置的 ~/.zcode/v2/provider_config.json
    // 如果不存在则创建空配置（用户后续可通过 UI 添加）
    const userProviderConfig = join(dataDir, ".zcode", "v2", "provider_config.json");
    if (existsSync(userProviderConfig)) {
      personalProviderConfigFilePath = userProviderConfig;
      log(`STEP3 using user provider config: ${personalProviderConfigFilePath}`);
    } else {
      const personalDir = join(storageDir, "runtime", "provider", "personal");
      mkdirSync(personalDir, { recursive: true });
      personalProviderConfigFilePath = join(personalDir, "provider_config.json");
      if (!existsSync(personalProviderConfigFilePath)) {
        writeFileSync(personalProviderConfigFilePath, JSON.stringify({
          schemaVersion: 1,
          revision: 0,
          config: { providerConfigRules: { templateRules: [], providers: {} } },
        }));
      }
      log(`STEP3 using default (empty) provider config: ${personalProviderConfigFilePath}`);
    }
    log(`STEP3 DONE builtin=${zcodeBuiltinProviderConfigFilePath} personal=${personalProviderConfigFilePath}`);
  } else {
    log("STEP3 SKIP provider config not found");
  }

  // 在 process.env 中设置 provider config 路径，createLocalServices 会读取
  if (zcodeBuiltinProviderConfigFilePath) {
    process.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = zcodeBuiltinProviderConfigFilePath;
  }
  if (personalProviderConfigFilePath) {
    process.env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"] = personalProviderConfigFilePath;
  }

  // 诊断：验证 personal config 可读
  const diagPath = join(dataDir, ".zcode", "v2", "provider_config.json");
  if (existsSync(diagPath)) {
    const content = readFileSync(diagPath, "utf8");
    const parsed = JSON.parse(content);
    const providers = parsed?.config?.providerConfigRules?.providerRules ?? [];
    log(`DIAG personal config at ${diagPath}: ${providers.length} providers, ${JSON.stringify(providers.map((p: any) => p.providerId))}`);
  } else {
    log(`DIAG personal config NOT found at ${diagPath}`);
  }
  log(`DIAG getDataBaseDir env: ZCODE_DATA_BASE_DIR=${process.env.ZCODE_DATA_BASE_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);

  // 4. 创建进程内 agent 工厂（传入 provider config 路径）
  log("STEP4 create agent factory");
  const inProcessAgentFactory = createInProcessAgentFactory(
    zcodeBuiltinProviderConfigFilePath,
    personalProviderConfigFilePath,
  );
  log("STEP4 DONE");

  // 5. 创建本地服务集合
  log("STEP5 create local services");
  const services = createLocalServices({
    inProcessAgentFactory,
    zcodeBuiltinProviderConfigFilePath,
    agentRuntimeContext: {
      runtimeSurface: "remote_workspace_host",
    },
  });
  log("STEP5 DONE local services created");

  // 6. 启动 HTTP+WebSocket 服务器
  log("STEP6 start HTTP server");
  const port = 0; // 随机端口
  const server = createHttpServer(services, port, {
    host: "127.0.0.1",
    ...(webStaticRoot ? { staticRoot: webStaticRoot, spaFallback: true } : {}),
  });

  // 等待服务器开始监听
  await new Promise<void>((resolve) => {
    if (server.listening) {
      resolve();
    } else {
      server.once("listening", () => resolve());
    }
  });

  // 7. 获取实际监听端口并报告给 native 层
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  log(`STEP7 DONE HTTP server on port ${actualPort}`);

  // 向 native 层报告端口：同时写文件和 stdout
  // native Java 层轮询 port.txt 获取端口号，然后启动 WebView
  const portFilePath = join(dataDir, "port.txt");
  writeFileSync(portFilePath, String(actualPort));
  console.log(`ZCODE_PORT:${actualPort}`);

  // 保持进程运行
  process.on("SIGTERM", () => {
    console.log("[android-entry] received SIGTERM, shutting down");
    server.close();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[android-entry] fatal: ${msg}`);
  process.exit(1);
});
