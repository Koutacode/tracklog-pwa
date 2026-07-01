package com.tracklog.assist;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private File downloadApk(String downloadUrl) throws Exception {
        Context context = getContext();
        File updateDir = new File(context.getCacheDir(), "updates");
        if (!updateDir.exists() && !updateDir.mkdirs()) {
            throw new IllegalStateException("更新ファイルの保存先を作成できませんでした。");
        }

        File tempFile = new File(updateDir, "tracklog-assist-update.tmp");
        File apkFile = new File(updateDir, "tracklog-assist-update.apk");
        if (tempFile.exists()) tempFile.delete();
        if (apkFile.exists()) apkFile.delete();

        HttpURLConnection connection = (HttpURLConnection) new URL(downloadUrl).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(120000);
        connection.setRequestProperty("User-Agent", "TrackLogUpdate/1.0");
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive,*/*");

        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            connection.disconnect();
            throw new IllegalStateException("APKの取得に失敗しました。HTTP " + status);
        }

        try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(tempFile)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }

        if (!tempFile.renameTo(apkFile)) {
            throw new IllegalStateException("更新ファイルを確定できませんでした。");
        }
        return apkFile;
    }

    private void openInstallPermissionSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject result = new JSObject();
            result.put("opened", true);
            result.put("requiresPermission", true);
            result.put("openedSettings", true);
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("アプリ更新の許可設定を開けませんでした。", ex);
        }
    }

    private void openInstaller(File apkFile) {
        Context context = getContext();
        Uri apkUri = FileProvider.getUriForFile(
            context,
            context.getPackageName() + ".fileprovider",
            apkFile
        );
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.startActivity(intent);
    }

    @PluginMethod
    public void installFromUrl(PluginCall call) {
        String downloadUrl = call.getString("url");
        if (downloadUrl == null || downloadUrl.trim().isEmpty()) {
            call.reject("url が必要です。");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            openInstallPermissionSettings(call);
            return;
        }

        new Thread(() -> {
            try {
                File apkFile = downloadApk(downloadUrl.trim());
                getActivity().runOnUiThread(() -> {
                    try {
                        openInstaller(apkFile);
                        JSObject result = new JSObject();
                        result.put("opened", true);
                        result.put("requiresPermission", false);
                        result.put("openedSettings", false);
                        call.resolve(result);
                    } catch (Exception ex) {
                        call.reject("更新インストーラーを開けませんでした。", ex);
                    }
                });
            } catch (Exception ex) {
                call.reject("更新APKの準備に失敗しました。", ex);
            }
        }).start();
    }
}
