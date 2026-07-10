package com.tracklog.assist;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
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
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static class ApkValidationResult {
        String packageName;
        String versionName;
        long versionCode;
        long currentVersionCode;
        boolean upToDate;
    }

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

    @SuppressWarnings("deprecation")
    private PackageInfo getArchivePackageInfo(File apkFile) {
        PackageManager packageManager = getContext().getPackageManager();
        long flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return packageManager.getPackageArchiveInfo(
                apkFile.getAbsolutePath(),
                PackageManager.PackageInfoFlags.of(flags)
            );
        }
        return packageManager.getPackageArchiveInfo(apkFile.getAbsolutePath(), (int) flags);
    }

    @SuppressWarnings("deprecation")
    private PackageInfo getInstalledPackageInfo(String packageName) throws PackageManager.NameNotFoundException {
        PackageManager packageManager = getContext().getPackageManager();
        long flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return packageManager.getPackageInfo(
                packageName,
                PackageManager.PackageInfoFlags.of(flags)
            );
        }
        return packageManager.getPackageInfo(packageName, (int) flags);
    }

    @SuppressWarnings("deprecation")
    private Signature[] getPackageSignatures(PackageInfo packageInfo) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && packageInfo.signingInfo != null) {
            return packageInfo.signingInfo.hasMultipleSigners()
                    ? packageInfo.signingInfo.getApkContentsSigners()
                    : packageInfo.signingInfo.getSigningCertificateHistory();
        }
        return packageInfo.signatures == null ? new Signature[0] : packageInfo.signatures;
    }

    private String sha256(Signature signature) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray());
        StringBuilder result = new StringBuilder(digest.length * 2);
        for (byte value : digest) result.append(String.format("%02X", value));
        return result.toString();
    }

    private Set<String> signingCertificateDigests(PackageInfo packageInfo) throws Exception {
        Set<String> result = new HashSet<>();
        for (Signature signature : getPackageSignatures(packageInfo)) result.add(sha256(signature));
        return result;
    }

    private void verifySigningCertificate(PackageInfo installed, PackageInfo downloaded) throws Exception {
        Set<String> installedDigests = signingCertificateDigests(installed);
        Set<String> downloadedDigests = signingCertificateDigests(downloaded);
        if (installedDigests.isEmpty() || downloadedDigests.isEmpty()) {
            throw new IllegalStateException("APKの署名証明書を確認できませんでした。");
        }
        installedDigests.retainAll(downloadedDigests);
        if (installedDigests.isEmpty()) {
            throw new IllegalStateException("現在のアプリと署名が異なるAPKです。管理者へ連絡してください。");
        }
    }

    @SuppressWarnings("deprecation")
    private long getVersionCode(PackageInfo packageInfo) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return packageInfo.getLongVersionCode();
        }
        return packageInfo.versionCode;
    }

    private ApkValidationResult validateDownloadedApk(File apkFile) throws Exception {
        PackageInfo downloaded = getArchivePackageInfo(apkFile);
        if (downloaded == null) {
            throw new IllegalStateException("取得したAPKの情報を読み取れませんでした。");
        }

        String currentPackageName = getContext().getPackageName();
        if (!currentPackageName.equals(downloaded.packageName)) {
            throw new IllegalStateException("別アプリのAPKです: " + downloaded.packageName);
        }

        PackageInfo installed = getInstalledPackageInfo(currentPackageName);
        verifySigningCertificate(installed, downloaded);
        ApkValidationResult result = new ApkValidationResult();
        result.packageName = downloaded.packageName;
        result.versionName = downloaded.versionName;
        result.versionCode = getVersionCode(downloaded);
        result.currentVersionCode = getVersionCode(installed);
        result.upToDate = result.versionCode <= result.currentVersionCode;
        return result;
    }

    private JSObject buildResult(boolean opened, boolean requiresPermission, boolean openedSettings, ApkValidationResult validation) {
        JSObject result = new JSObject();
        result.put("opened", opened);
        result.put("requiresPermission", requiresPermission);
        result.put("openedSettings", openedSettings);
        if (validation != null) {
            result.put("upToDate", validation.upToDate);
            result.put("downloadedPackageName", validation.packageName);
            result.put("downloadedVersionName", validation.versionName);
            result.put("downloadedVersionCode", validation.versionCode);
            result.put("currentVersionCode", validation.currentVersionCode);
        }
        return result;
    }

    private void openInstallPermissionSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            call.resolve(buildResult(true, true, true, null));
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
                ApkValidationResult validation = validateDownloadedApk(apkFile);
                getActivity().runOnUiThread(() -> {
                    try {
                        if (validation.upToDate) {
                            call.resolve(buildResult(false, false, false, validation));
                            return;
                        }
                        openInstaller(apkFile);
                        call.resolve(buildResult(true, false, false, validation));
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
