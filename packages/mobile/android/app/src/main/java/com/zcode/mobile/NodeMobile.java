package com.zcode.mobile;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 在 Android 进程内启动 nodejs-mobile (Node.js 18) 运行时。
 *
 * 流程：
 * 1. 首次启动时将 assets/node/ 下的 JS 资源和 libnode.so 复制到 filesDir/node/
 * 2. 用 System.load() 加载 filesDir/node/libnode.so（绕过安装器的对齐问题）
 * 3. 加载 JNI bridge libzcode-node-mobile.so
 * 4. 调用 JNI startNodeWithArguments 启动 Node.js 运行 entry-android.cjs
 * 5. 轮询 filesDir/port.txt 获取 HTTP 服务器端口
 */
public class NodeMobile {
    private static final String TAG = "ZCODE-NodeMobile";
    private static final String NODE_ASSET_DIR = "node";
    private static final String NODE_FILES_DIR = "node";
    private static final String ENTRY_SCRIPT = "entry-android.cjs";
    private static final String PORT_FILE = "port.txt";
    private static final String LIBNODE_SO = "libnode.so";

    private final Context context;
    private String nodeScriptPath;
    private String nodePath;
    private boolean started = false;
    private boolean nativeLibsLoaded = false;

    public native boolean startNodeWithArguments(String[] arguments, String nodePath);
    public native String getCurrentABIName();

    public NodeMobile(Context context) {
        this.context = context;
    }

    /**
     * 首次启动时将 assets/node/ 复制到 filesDir/node/。
     * 后续启动跳过（通过版本标记判断是否需要更新）。
     */
    public void ensureAssetsCopied() throws IOException {
        File nodeDir = new File(context.getFilesDir(), NODE_FILES_DIR);
        File versionMarker = new File(nodeDir, ".assets-version");
        String currentVersion = "1.0.0";

        if (versionMarker.exists()) {
            String existingVersion = readFileSync(versionMarker);
            if (currentVersion.equals(existingVersion.trim())) {
                Log.i(TAG, "Assets already copied (version " + currentVersion + ")");
                nodeScriptPath = new File(nodeDir, ENTRY_SCRIPT).getAbsolutePath();
                nodePath = nodeDir.getAbsolutePath();
                return;
            }
        }

        Log.i(TAG, "Copying Node.js assets from APK to " + nodeDir.getAbsolutePath());
        if (nodeDir.exists()) {
            deleteRecursive(nodeDir);
        }
        nodeDir.mkdirs();

        copyAssetsRecursive(NODE_ASSET_DIR, nodeDir);
        writeFileSync(versionMarker, currentVersion);

        nodeScriptPath = new File(nodeDir, ENTRY_SCRIPT).getAbsolutePath();
        nodePath = nodeDir.getAbsolutePath();
        Log.i(TAG, "Assets copied. Script: " + nodeScriptPath);

        // 加载 native 库：先加载 libnode.so（从 files 目录，绕过安装器对齐问题），
        // 再加载 JNI bridge。libzcode-node-mobile.so 在 jniLibs 中由安装器提取。
        loadNativeLibs();
    }

    /**
     * 加载 native 库。先 System.load libnode.so（从 files 目录），
     * 再 System.loadLibrary JNI bridge。libnode.so 先加载后，
     * JNI bridge 的动态链接器能找到 libnode 的符号。
     */
    private void loadNativeLibs() {
        if (nativeLibsLoaded) return;

        File libnodeFile = new File(context.getFilesDir(), NODE_FILES_DIR + "/" + LIBNODE_SO);
        if (!libnodeFile.exists()) {
            Log.e(TAG, "libnode.so not found at " + libnodeFile.getAbsolutePath());
            return;
        }

        try {
            Log.i(TAG, "Loading libnode.so from " + libnodeFile.getAbsolutePath());
            System.load(libnodeFile.getAbsolutePath());
            Log.i(TAG, "libnode.so loaded successfully");
        } catch (UnsatisfiedLinkError e) {
            Log.e(TAG, "Failed to load libnode.so: " + e.getMessage());
            return;
        }

        try {
            Log.i(TAG, "Loading JNI bridge libzcode-node-mobile.so");
            System.loadLibrary("zcode-node-mobile");
            Log.i(TAG, "JNI bridge loaded successfully");
        } catch (UnsatisfiedLinkError e) {
            Log.e(TAG, "Failed to load JNI bridge: " + e.getMessage());
            return;
        }

        nativeLibsLoaded = true;
        Log.i(TAG, "All native libraries loaded");
    }

    /**
     * 启动 Node.js 运行时。
     */
    public void start() {
        if (started) {
            Log.w(TAG, "Node.js already started");
            return;
        }
        if (nodeScriptPath == null) {
            Log.e(TAG, "Assets not copied. Call ensureAssetsCopied() first.");
            return;
        }

        // Set env vars for Node.js entry script.
        // Android 默认 HOME 指向 /data（不可写），os.homedir() 与 ~/.zcode 会落到
        // /data/.zcode 导致权限错误。这里将所有路径指向 app 的可写 files/cache 目录。
        String filesDir = context.getFilesDir().getAbsolutePath();
        String cacheDir = context.getCacheDir().getAbsolutePath();
        try {
            Os.setenv("ZCODE_DATA_DIR", filesDir, true);
            Os.setenv("HOME", filesDir, true);
            Os.setenv("ZCODE_STORAGE_DIR", new File(filesDir, "zcode").getAbsolutePath(), true);
            Os.setenv("ZCODE_WORKSPACE_PATH", new File(filesDir, "workspace").getAbsolutePath(), true);
            Os.setenv("TMPDIR", cacheDir, true);
        } catch (ErrnoException e) {
            Log.w(TAG, "Failed to set env vars: " + e.getMessage());
        }

        String[] args = {"node", nodeScriptPath};
        Log.i(TAG, "Starting Node.js: " + nodeScriptPath);
        boolean result = startNodeWithArguments(args, nodePath);
        if (result) {
            started = true;
            Log.i(TAG, "Node.js started successfully");
        } else {
            Log.e(TAG, "Failed to start Node.js");
        }
    }

    /**
     * 轮询 port.txt 获取 HTTP 服务器端口。
     * @param timeoutMs 最大等待时间（毫秒）
     * @return 端口号，或 -1 表示超时
     */
    public int waitForPort(long timeoutMs) {
        File portFile = new File(context.getFilesDir(), PORT_FILE);
        long deadline = System.currentTimeMillis() + timeoutMs;

        while (System.currentTimeMillis() < deadline) {
            if (portFile.exists()) {
                try {
                    String portStr = readFileSync(portFile).trim();
                    int port = Integer.parseInt(portStr);
                    Log.i(TAG, "Got port: " + port);
                    return port;
                } catch (Exception e) {
                    Log.w(TAG, "Failed to parse port file: " + e.getMessage());
                }
            }
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        Log.e(TAG, "Timed out waiting for port");
        return -1;
    }

    public boolean isStarted() {
        return started;
    }

    // ── 资源复制辅助 ──

    private void copyAssetsRecursive(String assetPath, File destDir) throws IOException {
        String[] children = context.getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            // 这是一个文件，复制它
            copyAssetFile(assetPath, destDir);
            return;
        }
        // 这是一个目录
        destDir.mkdirs();
        for (String child : children) {
            copyAssetsRecursive(assetPath + "/" + child, new File(destDir, child));
        }
    }

    private void copyAssetFile(String assetPath, File destFile) throws IOException {
        if (destFile.isDirectory()) {
            destFile.mkdirs();
            return;
        }
        destFile.getParentFile().mkdirs();
        InputStream in = context.getAssets().open(assetPath);
        try {
            OutputStream out = new FileOutputStream(destFile);
            try {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
    }

    private void deleteRecursive(File file) {
        if (file.isDirectory()) {
            for (File child : file.listFiles()) {
                deleteRecursive(child);
            }
        }
        file.delete();
    }

    private String readFileSync(File file) {
        try {
            InputStream in = new java.io.FileInputStream(file);
            try {
                byte[] data = new byte[(int) file.length()];
                in.read(data);
                return new String(data);
            } finally {
                in.close();
            }
        } catch (IOException e) {
            return "";
        }
    }

    private void writeFileSync(File file, String content) throws IOException {
        file.getParentFile().mkdirs();
        FileOutputStream out = new FileOutputStream(file);
        try {
            out.write(content.getBytes());
        } finally {
            out.close();
        }
    }
}
