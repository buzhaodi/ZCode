package com.zcode.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

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
    /** 本地 HTTP+WS server 端口，供 OAuth 回调重写 zcode:// → http://127.0.0.1:PORT 使用。 */
    private int serverPort = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // targetSdk 35 在 API 35+ 默认强制 edge-to-edge。setDecorFitsSystemWindows(true) 在多数设备
        // 能让内容从状态栏下方开始，但部分厂商 ROM（如小米 HyperOS）会忽略该标志，内容仍绘制到
        // 状态栏背后。下面再用 WindowInsets 把状态栏/导航栏高度作为容器 padding 下推内容，
        // 保证无论系统是否尊重 decor-fits 标志，顶部都不与状态栏重叠。
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(true);
        }
        // 状态栏底色与 app 暗色背景(#161616)一致，避免顶部色带；暗色主题下系统图标为浅色，可见。
        getWindow().setStatusBarColor(android.graphics.Color.parseColor("#161616"));

        nodeMobile = new NodeMobile(this);
        webView = new WebView(this);

        // 外层容器：暗色背景填充系统栏区域（透明状态栏下露出 #161616，与 app 一致），
        // 并把系统栏 insets 作为 padding，使 WebView 内容从系统栏下方开始。
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(android.graphics.Color.parseColor("#161616"));
        FrameLayout.LayoutParams wvLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT);
        container.addView(webView, wvLp);
        setContentView(container);
        container.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int top, bottom;
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                    // statusBars/navigationBars 不含 IME，键盘仍由 adjustResize 处理。
                    top = insets.getInsets(WindowInsets.Type.statusBars()).top;
                    bottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
                } else {
                    top = insets.getSystemWindowInsetTop();
                    bottom = 0;
                }
                v.setPadding(0, top, 0, bottom);
                return insets;
            }
        });

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
                serverPort = port;
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
                Uri uri = request.getUrl();
                // OAuth 登录回调用 zcode:// 自定义 scheme，WebView 无法加载会报
                // net::ERR_UNKNOWN_URL_SCHEME。登录走的是服务端 oauthService（桌面/CLI 流），
                // BigModel 回调的 state 是后端生成的 nonce，不是 web SPA 的 base64url state，
                // 所以不能交给 web SPA 的 /share/callback。这里把完整 zcode:// URL 交给本地 server 的
                // /api/v1/oauth/cli/callback 路由，由服务端 oauthService.handleCallback 兑换授权码后跳回根页。
                if ("zcode".equals(uri.getScheme()) && serverPort > 0) {
                    String target = "http://127.0.0.1:" + serverPort
                            + "/api/v1/oauth/cli/callback?callbackUrl=" + Uri.encode(uri.toString());
                    Log.i(TAG, "OAuth callback -> server-side: " + target);
                    view.loadUrl(target);
                    return true;
                }
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
