# ZCode Android APK 构建与使用指南

## 概述

ZCode Android APK 是一个**自包含**的 Android 应用，不依赖任何外部服务器。AI Agent 直接在手机上运行，通过 WebView 显示 UI，通过本地 HTTP+WebSocket 服务器通信。

## 架构原理

```
┌─────────────────────────────────────────────┐
│                 Android APK                  │
│                                              │
│  ┌─────────────┐    ┌─────────────────────┐ │
│  │  Java 层     │    │  Node.js 层          │ │
│  │  (MainActivity)│   │  (nodejs-mobile)     │ │
│  │              │    │                      │ │
│  │  启动 Node.js │───▶│  entry-android.cjs   │ │
│  │  加载 libnode │    │                      │ │
│  │  轮询 port.txt│    │  ┌────────────────┐ │ │
│  │              │    │  │ HTTP+WS Server │ │ │
│  │  WebView ────│───▶│  │ (127.0.0.1)    │ │ │
│  │  加载 localhost│   │  │                │ │ │
│  └─────────────┘    │  │ In-Process Agent│ │ │
│                      │  │ (PassThrough流) │ │ │
│                      │  │                │ │ │
│                      │  │ sql.js SQLite  │ │ │
│                      │  │ Web UI 静态文件 │ │ │
│                      │  └────────────────┘ │ │
│                      └─────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 数据流

1. `MainActivity` 启动 → 复制 assets 到 filesDir → `System.load(libnode.so)` → JNI 启动 Node.js
2. Node.js 运行 `entry-android.cjs`：初始化 SQLite shim → 加载 provider 配置 → 创建本地服务 → 启动 HTTP 服务器 → 写入 `port.txt`
3. Java 轮询 `port.txt` → 读到端口 → WebView 加载 `http://127.0.0.1:PORT/`
4. WebView 中的 React SPA 通过 WebSocket 连接 `ws://127.0.0.1:PORT/ws` → 调用 Agent 服务

### 进程内 Agent

桌面端通过 `child_process.spawn` 启动 Agent CLI 子进程，但 Android 上无法 spawn 第二个 Node.js 进程。解决方案：

- 用 `PassThrough` 流对替代 stdio 管道
- `runZCodeProtocolAgent` 在同一进程内运行
- `ZCodeStreamTransport` 连接 host 和 agent
- `FakeAgentChildProcess`（EventEmitter）模拟 ChildProcess 接口

## 环境要求

| 组件 | 版本 | 说明 |
|------|------|------|
| Android SDK | API 35+ | compileSdk 35 |
| Android NDK | r27+ | 编译 JNI bridge |
| CMake | 3.22.1 | 通过 SDK 安装 |
| Node.js | 24+ | 本机构建用（不是运行时） |
| pnpm | 10+ | 包管理器 |

### 安装 Android 工具

```bash
# 通过 sdkmanager 安装 NDK 和 CMake
sdkmanager "ndk;27.0.12077973"
sdkmanager "cmake;3.22.1"
```

### 配置 local.properties

```properties
sdk.dir=C:/Users/<用户名>/AppData/Local/Android/Sdk
```

## 构建步骤

### 1. 安装依赖

```bash
cd <repo-root>
pnpm install
```

### 2. 下载 Node.js 24 运行时

从 [fogtape/nodejs-mobile](https://github.com/fogtape/nodejs-mobile/releases) 下载 `nodejs-mobile-android-lite-24.21.0-0.zip`：

```bash
cd packages/mobile
curl -sL "https://github.com/fogtape/nodejs-mobile/releases/download/v24.21.0-0/nodejs-mobile-android-lite-24.21.0-0.zip" -o node24.zip
unzip -o node24.zip "bin/arm64-v8a/libnode.so" "include/*" -d node24-extracted

# 放置 libnode.so
cp node24-extracted/bin/arm64-v8a/libnode.so android/app/src/main/assets/node/libnode.so
cp node24-extracted/bin/arm64-v8a/libnode.so android/app/src/main/jniLibs/arm64-v8a/libnode.so

# 放置 Node.js 头文件（JNI 编译需要）
rm -rf android/app/src/main/cpp/include/node
cp -r node24-extracted/include/node android/app/src/main/cpp/include/node

# 清理下载文件
rm -rf node24.zip node24-extracted
```

### 3. 构建 Web UI

```bash
cd packages/web
npx vite build
# 复制到 mobile/dist
cd ../..
rm -rf packages/mobile/dist/index.html packages/mobile/dist/assets packages/mobile/dist/pdfjs
cp -r packages/web/dist/* packages/mobile/dist/
```

### 4. 构建 JS Bundle

```bash
cd packages/mobile
node scripts/build-android-entry.mjs
```

这会：
- 用 esbuild 将 `src/entry-android.ts` + 所有依赖打包为单个 CJS 文件（~37MB）
- 在 banner 中注入 polyfill（Intl、toSorted、os.tmpdir/homedir 等）
- 后处理替换 Unicode 属性转义（`\p{L}` 等，作为安全网）
- 复制 WASM、provider config、web UI 到 `android/app/src/main/assets/node/`

### 5. 构建 APK

```bash
cd packages/mobile/android
./gradlew assembleDebug
```

输出：`app/build/outputs/apk/debug/app-debug.apk`

### 一键构建

```bash
cd packages/mobile
node scripts/build-apk.mjs --apk
```

### 6. 安装到设备

```bash
adb install -r packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

## 配置 API Provider

应用启动后需要配置 AI 模型的 API Key。有两种方式：

### 方式一：通过 UI 配置（推荐）

1. 打开 ZCode
2. 进入设置 → 添加供应商
3. 填入：
   - API 类型：`openai-chat-completions`
   - Base URL：你的 API 代理地址（如 `http://192.168.x.x:8790/v1`）
   - API Key：你的密钥
   - 模型 ID：可用的模型名（如 `zhanlu/glm-5.1`）

### 方式二：直接写配置文件

```bash
adb shell "run-as com.zcode.mobile cat files/.zcode/v2/provider_config.json"
```

配置格式：

```json
{
  "schemaVersion": 1,
  "config": {
    "providerOrder": ["my-provider"],
    "providerConfigRules": {
      "providerRules": [{
        "providerId": "my-provider",
        "providerName": "我的供应商",
        "config": {
          "group": "standard-personal",
          "access": { "type": "api-key", "apiKey": "你的key" },
          "api": { "type": "openai-chat-completions", "baseUrl": "http://192.168.x.x:PORT/v1" },
          "personalModelIds": ["模型ID"],
          "modelOrder": ["模型ID"]
        }
      }]
    },
    "modelConfigRules": {
      "providerModelRules": [{
        "modelId": "模型ID",
        "config": { "enabled": true, "properties": { "contextWindow": 1048000 } },
        "providerId": "my-provider"
      }],
      "manualProviderModelRules": []
    }
  }
}
```

**注意**：Base URL 不能用 `127.0.0.1`（指向手机自身），必须用电脑的局域网 IP（如 `192.168.x.x`）。

## 关键技术决策

### 为什么用 nodejs-mobile 而不是 Capacitor 远程连接？

原始的 Capacitor 方案中手机是纯远程客户端，Agent 跑在服务器上。用户要求不依赖外部服务器，所以必须把 Agent 运行时嵌入 APK。

### 为什么用 Node 24 而不是 Node 18？

原版 nodejs-mobile 只到 Node 18，缺少 `Intl`、`\p{L}` 正则、`Array.toSorted()` 等。fogtape/nodejs-mobile fork 基于 Node 24.21.0，有完整 ICU 和 ES2023 支持，大幅减少 polyfill。

### 为什么用 sql.js 而不是原生 node:sqlite？

Node 24 有原生 `node:sqlite`，但在 fogtape/nodejs-mobile 构建上打开数据库时报错（兼容性问题）。sql.js（WASM SQLite）作为 shim 更可靠。sql.js 在内存中运行，写入后延迟持久化到磁盘。

### 为什么不能用模拟器测试？

Google Play 模拟器使用 16KB 内核页。预编译的 libnode.so 的 ELF 段偏移可能只有 4KB 对齐，会被拒绝加载。真机通常用 4KB 页，没有这个问题。fogtape/nodejs-mobile 的构建支持 16KB 页对齐。

## 已知限制

| 限制 | 原因 | 影响 |
|------|------|------|
| Shell 工具功能有限 | Android Toybox sh，无 bash/git/ripgrep | Bash 命令可用但功能受限 |
| sql.js 性能 | 内存引擎，写入后延迟持久化 | 大量数据写入时较慢 |
| APK 较大（~130MB） | libnode.so 66MB + JS bundle 37MB | 可通过只打包 arm64 减小 |
| 模拟器兼容性 | 16KB 页对齐问题 | 需要真机或 4KB 页模拟器 |
| 无 node:sqlite 原生 | nodejs-mobile 构建兼容问题 | 使用 sql.js WASM shim 替代 |

## 调试

### 查看启动日志

```bash
adb shell "run-as com.zcode.mobile cat files/progress.log"
```

### 查看 Agent 崩溃日志

```bash
adb shell "run-as com.zcode.mobile cat files/agent-crash.log"
adb shell "run-as com.zcode.mobile cat files/crash.log"
```

### 查看 Agent 协议日志

```bash
adb shell "run-as com.zcode.mobile cat files/agent-protocol.log"
```

### 查看 logcat

```bash
adb logcat -d | grep -iE "ZCODE|FORTIFY|FATAL"
```

### 测试 Agent 连接

```bash
# 转发端口
adb forward tcp:PORT tcp:PORT

# 用 curl 测试服务器
curl http://127.0.0.1:PORT/api/server-info
```

## 文件结构

```
packages/mobile/
├── src/
│   ├── entry-android.ts      # Android 入口（主逻辑）
│   ├── sqlite-shim.ts         # node:sqlite 兼容层（sql.js WASM）
│   └── sql.js.d.ts            # sql.js 类型声明
├── scripts/
│   ├── build-android-entry.mjs  # esbuild 打包 + polyfill 注入
│   └── build-apk.mjs            # 完整构建脚本（assets 复制 + gradle）
├── android/
│   ├── app/
│   │   ├── build.gradle        # AGP 配置（C++20, NDK, abiFilters）
│   │   ├── src/main/
│   │   │   ├── AndroidManifest.xml
│   │   │   ├── java/com/zcode/mobile/
│   │   │   │   ├── MainActivity.java   # WebView + Node.js 启动
│   │   │   │   └── NodeMobile.java     # JNI wrapper + asset 复制
│   │   │   ├── cpp/
│   │   │   │   ├── native-lib.cpp       # JNI bridge（调用 node::Start）
│   │   │   │   ├── CMakeLists.txt
│   │   │   │   └── include/node/        # Node 24 头文件
│   │   │   ├── jniLibs/arm64-v8a/
│   │   │   │   └── libnode.so           # Node 24 运行时（66MB）
│   │   │   ├── assets/node/             # 构建时生成（gitignored）
│   │   │   │   ├── entry-android.cjs    # JS bundle（37MB）
│   │   │   │   ├── libnode.so           # Node 运行时副本
│   │   │   │   ├── assets/
│   │   │   │   │   ├── sql-wasm.wasm    # SQLite WASM 引擎
│   │   │   │   │   └── zcode-builtin.json  # 内置 provider 配置
│   │   │   │   └── web/                 # React SPA 静态文件
│   │   │   └── res/                     # 图标等资源
│   │   └── proguard-rules.pro
│   ├── build.gradle                     # 项目级 Gradle
│   ├── settings.gradle
│   ├── gradle.properties
│   ├── gradlew / gradlew.bat
│   └── local.properties                 # SDK 路径（gitignored）
├── package.json
└── .gitignore                           # 忽略所有构建产物
```

## 修改后的源码文件

除了 `packages/mobile/` 内的文件，以下仓库源码也被修改：

| 文件 | 修改内容 |
|------|---------|
| `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` | 新增 `inProcessAgentFactory` 选项 + `startInProcessClient` |
| `packages/services/src/zcode-agent/zcodeStreamTransport.ts` | 新文件：进程内流传输 |
| `packages/services/src/zcode-agent/zcodeAgentService.ts` | 传递 `inProcessAgentFactory` 给 3 个 manager |
| `packages/services/src/node.ts` | 导出 `ZCodeStreamTransport` + `ZCodeInProcessAgentFactory` |
| `packages/services/src/file/file.ts` | 新增 `createDirectory` 接口方法 |
| `packages/services/src/file/fileService.ts` | 实现 `createDirectory` |
| `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | 侧边栏隐藏时显示汉堡菜单按钮 |
| `packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx` | 新建文件夹按钮 |
| `packages/ui/src/i18n/locales/en-US.ts` / `zh-CN.ts` | 新增 i18n 文本 |
| `packages/shared/src/conversation-preview-artifacts.ts` | Unicode 属性转义替换（兼容性） |
| `packages/web/src/main.tsx` | localhost 自动重试连接 |
