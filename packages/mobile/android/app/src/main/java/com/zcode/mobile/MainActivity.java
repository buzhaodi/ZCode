package com.zcode.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;

/**
 * ZCode Android 主 Activity。
 *
 * 启动流程：
 * 1. 在后台线程初始化 NodeMobile（复制 assets → filesDir）
 * 2. 启动 Node.js（运行 entry-android.cjs）
 * 3. 轮询 port.txt 获取 HTTP 端口
 * 4. 用 WebView 加载 http://127.0.0.1:PORT/
 *
 * WebView 连接到本地 HTTP+WebSocket 服务器，所有 AI agent 逻辑在手机本地运行。
 */
public class MainActivity extends Activity {
    private static final String TAG = "ZCODE-MainActivity";
    private static final long PORT_TIMEOUT_MS = 30_000;

    private NodeMobile nodeMobile;
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // targetSdk 35 在 API 35+ 默认强制 edge-to-edge，WebView 内容会绘制到状态栏背后，
        // 导致顶部工具栏与状态栏重叠、无法点击。恢复传统 insets 行为，内容从状态栏下方开始。
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(true);
        }
        // 状态栏底色与 app 暗色背景(#161616)一致，避免顶部色带；暗色主题下系统图标为浅色，可见。
        getWindow().setStatusBarColor(android.graphics.Color.parseColor("#161616"));

        nodeMobile = new NodeMobile(this);
        webView = new WebView(this);
        setContentView(webView);

        // 配置 WebView
        configureWebView();

        // 在后台线程初始化 Node.js
        new Thread(() -> {
            try {
                Log.i(TAG, "Copying assets...");
                nodeMobile.ensureAssetsCopied();

                // 设置环境变量
                File filesDir = getFilesDir();
                String dataDir = filesDir.getAbsolutePath();
                // Node.js entry 通过环境变量获取路径
                // ZCODE_DATA_DIR 由 JNI 层设置（或通过 args 传递）
                // 这里通过在 args 中传环境变量太复杂，改用文件约定
                // entry-android.cjs 已经有 fallback 逻辑：使用 __dirname 推导路径

                Log.i(TAG, "Starting Node.js...");
                nodeMobile.start();

                Log.i(TAG, "Waiting for port...");
                int port = nodeMobile.waitForPort(PORT_TIMEOUT_MS);
                if (port < 0) {
                    Log.e(TAG, "Failed to get port from Node.js");
                    runOnUiThread(() -> webView.loadData(
                            "<html><body><h2>Failed to start ZCode</h2>" +
                            "<p>Node.js runtime did not respond. Check logcat for details.</p></body></html>",
                            "text/html", "UTF-8"));
                    return;
                }

                String url = "http://127.0.0.1:" + port + "/";
                Log.i(TAG, "Loading WebView: " + url);
                runOnUiThread(() -> webView.loadUrl(url));

            } catch (Exception e) {
                Log.e(TAG, "Initialization failed", e);
                runOnUiThread(() -> webView.loadData(
                        "<html><body><h2>Initialization Error</h2>" +
                        "<pre>" + e.getMessage() + "</pre></body></html>",
                        "text/html", "UTF-8"));
            }
        }).start();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
        });
        webView.setWebChromeClient(new WebChromeClient());
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
