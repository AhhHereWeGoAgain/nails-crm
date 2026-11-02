package com.nailscrm.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewAssetLoader.AssetsPathHandler;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int IMPORT_FILE = 101;
    private static final int PHOTO_FILE = 103;
    private static final int EXPORT_FILE = 102;
    private static final String LOCAL_URL = "https://appassets.androidplatform.net/assets/index.html";
    private WebView webView;
    private ValueCallback<Uri[]> pendingFileChooser;
    private String pendingBackup;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        setContentView(webView);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(true);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new AssetsPathHandler(this)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !"appassets.androidplatform.net".equals(request.getUrl().getHost());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
                pendingFileChooser = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                boolean isPhoto = false;
                String[] accept = params.getAcceptTypes();
                if (accept != null) {
                    for (String type : accept) {
                        if (type != null && type.startsWith("image/")) {isPhoto = true; break;}
                    }
                }
                intent.setType(isPhoto ? "image/*" : "application/json");
                try { startActivityForResult(intent, isPhoto ? PHOTO_FILE : IMPORT_FILE); return true; }
                catch (Exception ex) {pendingFileChooser = null; return false;}
            }
        });
        webView.addJavascriptInterface(new BackupBridge(), "Android");
        webView.loadUrl(LOCAL_URL);
    }

    public class BackupBridge {
        @JavascriptInterface public void saveBackup(String json) {
            runOnUiThread(() -> {
                pendingBackup = json;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/json");
                String day = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(new Date());
                intent.putExtra(Intent.EXTRA_TITLE, "nails-crm-" + day + ".json");
                startActivityForResult(intent, EXPORT_FILE);
            });
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == IMPORT_FILE || requestCode == PHOTO_FILE) {
            if (pendingFileChooser != null) {
                pendingFileChooser.onReceiveValue(resultCode == RESULT_OK && data != null ? new Uri[]{data.getData()} : null);
                pendingFileChooser = null;
            }
        } else if (requestCode == EXPORT_FILE) {
            if (resultCode == RESULT_OK && data != null && pendingBackup != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                    if (out != null) out.write(pendingBackup.getBytes(StandardCharsets.UTF_8));
                } catch (Exception ignored) { }
            }
            pendingBackup = null;
        }
    }

    @Override public void onBackPressed() {
        webView.evaluateJavascript("document.getElementById('entry-dialog').open ? document.getElementById('entry-dialog').close() : null", null);
    }
    @Override protected void onDestroy() { if (webView != null) webView.destroy(); super.onDestroy(); }
}
