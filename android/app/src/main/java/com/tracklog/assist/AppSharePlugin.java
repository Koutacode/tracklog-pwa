package com.tracklog.assist;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AppShare")
public class AppSharePlugin extends Plugin {
    private Intent buildTextShareIntent(String packageName, String title, String subject, String text) {
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("text/plain");
        if (packageName != null && !packageName.trim().isEmpty()) {
            intent.setPackage(packageName);
        }
        intent.putExtra(Intent.EXTRA_TEXT, text);
        if (subject != null && !subject.trim().isEmpty()) {
            intent.putExtra(Intent.EXTRA_SUBJECT, subject);
        } else if (title != null && !title.trim().isEmpty()) {
            intent.putExtra(Intent.EXTRA_SUBJECT, title);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    private Intent buildViewIntent(String url, String packageName) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (packageName != null && !packageName.trim().isEmpty()) {
            intent.setPackage(packageName);
        }
        return intent;
    }

    private boolean canHandleIntent(Intent intent, PackageManager packageManager) {
        return intent.resolveActivity(packageManager) != null;
    }

    @PluginMethod
    public void shareTextToPackage(PluginCall call) {
        String packageName = call.getString("packageName");
        String title = call.getString("title");
        String subject = call.getString("subject");
        String text = call.getString("text");

        if (packageName == null || packageName.trim().isEmpty()) {
            call.reject("packageName が必要です。");
            return;
        }
        if (text == null || text.trim().isEmpty()) {
            call.reject("共有テキストが空です。");
            return;
        }

        PackageManager packageManager = getContext().getPackageManager();
        try {
            packageManager.getPackageInfo(packageName, PackageManager.GET_ACTIVITIES);
        } catch (Exception ex) {
            call.reject("対象アプリが見つかりません。", ex);
            return;
        }

        Intent intent = buildTextShareIntent(packageName, title, subject, text);

        if (intent.resolveActivity(packageManager) == null) {
            call.reject("対象アプリでテキスト共有を処理できません。");
            return;
        }

        try {
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("対象アプリを開けませんでした。", ex);
        }
    }

    @PluginMethod
    public void shareText(PluginCall call) {
        String title = call.getString("title");
        String subject = call.getString("subject");
        String text = call.getString("text");

        if (text == null || text.trim().isEmpty()) {
            call.reject("共有テキストが空です。");
            return;
        }

        PackageManager packageManager = getContext().getPackageManager();
        Intent shareIntent = buildTextShareIntent(null, title, subject, text);
        Intent chooserIntent = Intent.createChooser(shareIntent, title != null && !title.trim().isEmpty() ? title : "共有");
        chooserIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (!canHandleIntent(shareIntent, packageManager)) {
            call.reject("テキスト共有を処理できるアプリがありません。");
            return;
        }

        try {
            getContext().startActivity(chooserIntent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("共有シートを開けませんでした。", ex);
        }
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        String packageName = call.getString("packageName");

        if (url == null || url.trim().isEmpty()) {
            call.reject("url が必要です。");
            return;
        }

        PackageManager packageManager = getContext().getPackageManager();
        boolean packageInstalled = false;
        if (packageName != null && !packageName.trim().isEmpty()) {
            try {
                packageManager.getPackageInfo(packageName, PackageManager.GET_ACTIVITIES);
                packageInstalled = true;
            } catch (Exception ignored) {
                packageInstalled = false;
            }
        }

        Intent packageIntent = packageInstalled ? buildViewIntent(url, packageName) : null;
        Intent fallbackIntent = buildViewIntent(url, null);
        Intent targetIntent = null;

        if (packageIntent != null && canHandleIntent(packageIntent, packageManager)) {
            targetIntent = packageIntent;
        } else if (canHandleIntent(fallbackIntent, packageManager)) {
            targetIntent = fallbackIntent;
        }

        if (targetIntent == null) {
            call.reject("対象アプリで URL を処理できません。");
            return;
        }

        try {
            getContext().startActivity(targetIntent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("対象アプリを開けませんでした。", ex);
        }
    }
}
