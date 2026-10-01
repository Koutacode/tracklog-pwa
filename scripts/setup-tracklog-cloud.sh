#!/usr/bin/env bash
# Linux task development setup only. Never publishes an APK or reads credentials.
# Primary references checked 2026-10-01:
# https://developer.android.com/tools/sdkmanager
# https://dl.google.com/android/repository/repository2-1.xml
# https://nodejs.org/dist/v22.23.3/SHASUMS256.txt
# https://ubuntu.com/developers/docs/howto/java-setup/
set -euo pipefail
set +x
umask 077
fail() { printf 'TrackLog setup: %s\n' "$*" >&2; exit 1; }
trap 'printf "TrackLog setup failed at line %s. Android build is NOT verified.\n" "$LINENO" >&2' ERR

task_repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
task_dev_root="${TRACKLOG_CLOUD_DEV_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tracklog-cloud}"
check_only=false
accept_licenses=false
while (($#)); do
  case "$1" in
    --check) check_only=true; shift ;;
    --accept-android-licenses) accept_licenses=true; shift ;;
    --repo) (($# >= 2)) || fail '--repo requires a directory'; task_repo="$2"; shift 2 ;;
    --help)
      printf '%s\n' 'Usage: bash scripts/setup-tracklog-cloud.sh [--check] [--repo DIR] [--accept-android-licenses]' \
        'Default: install missing tools, persist taskdev-env.sh, npm ci, then check tools.' \
        '--check: offline toolchain preflight only; no installs or file writes.' \
        'For a new SDK, pass --accept-android-licenses after reviewing the Android SDK license.' \
        'New shell: source "${TRACKLOG_CLOUD_DEV_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tracklog-cloud}/taskdev-env.sh"' \
        'Toolchain preflight is not Gradle compilation, runtime QA, or release verification.'
      exit 0 ;;
    *) fail 'Unknown option; use --help' ;;
  esac
done
[[ "$(uname -s)" == Linux ]] || fail 'Linux is required; do not install from Windows/macOS.'
[[ "$(uname -m)" == x86_64 ]] || fail 'This Android build-tools setup requires Linux x86_64.'
[[ -f "$task_repo/package-lock.json" && -f "$task_repo/android/gradlew" ]] || fail 'TrackLog checkout is missing package-lock.json or android/gradlew.'
[[ "$task_dev_root" == /* && "$task_dev_root" != / ]] || fail 'TRACKLOG_CLOUD_DEV_ROOT must be an absolute, task-owned directory.'
task_env_file="$task_dev_root/taskdev-env.sh"
task_work=''
cleanup() { if [[ -n "$task_work" && -d "$task_work" ]]; then rm -rf -- "$task_work"; fi; }
trap cleanup EXIT

have() { command -v "$1" >/dev/null 2>&1; }
apt_installed=false
apt_prefix=()
install_packages() {
  "$check_only" && fail 'Missing required tools; run setup first.'
  have apt-get || fail 'Missing tools require a Debian/Ubuntu image with apt-get or a pre-provisioned toolchain.'
  if ((EUID != 0)); then
    have sudo && sudo -n true >/dev/null 2>&1 || fail 'Installing missing tools requires root or working sudo -n. No installation was attempted.'
    apt_prefix=(sudo -n)
  fi
  if ! "$apt_installed"; then
    "${apt_prefix[@]}" env DEBIAN_FRONTEND=noninteractive apt-get update
    apt_installed=true
  fi
  "${apt_prefix[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

missing=()
for pair in curl:curl unzip:unzip git:git gh:gh python3:python3 tar:tar xz:xz-utils sha256sum:coreutils sha1sum:coreutils; do
  have "${pair%%:*}" || missing+=("${pair#*:}")
done
if ((${#missing[@]})); then install_packages ca-certificates "${missing[@]}"; fi
for tool in curl unzip git gh python3 tar xz sha256sum sha1sum; do have "$tool" || fail "Required tool unavailable: $tool"; done

node_22() { have node && [[ "$(node --version 2>/dev/null)" == v22.* ]] && have npm; }
if [[ -x "$task_dev_root/node/bin/node" ]]; then export PATH="$task_dev_root/node/bin:$PATH"; fi
if ! node_22; then
  "$check_only" && fail 'Node.js 22 and npm are required.'
  mkdir -p -- "$task_dev_root"
  task_work="$(mktemp -d "$task_dev_root/setup.XXXXXXXX")"
  node_version=22.23.3
  node_archive="node-v${node_version}-linux-x64.tar.xz"
  node_base="https://nodejs.org/dist/v${node_version}"
  curl --fail --silent --show-error --location --retry 3 --proto '=https' --proto-redir '=https' \
    "$node_base/SHASUMS256.txt" -o "$task_work/node-shasums.txt"
  curl --fail --silent --show-error --location --retry 3 --proto '=https' --proto-redir '=https' \
    "$node_base/$node_archive" -o "$task_work/$node_archive"
  node_sha="$(awk -v file="$node_archive" '$2 == file {print $1}' "$task_work/node-shasums.txt")"
  [[ "$node_sha" =~ ^[a-f0-9]{64}$ ]] || fail 'Node official SHA256 manifest did not contain exactly one archive checksum.'
  (cd "$task_work" && printf '%s  %s\n' "$node_sha" "$node_archive" | sha256sum -c -)
  [[ ! -e "$task_dev_root/node" ]] || fail 'Existing task Node installation is incomplete; choose a fresh TRACKLOG_CLOUD_DEV_ROOT.'
  mkdir -- "$task_dev_root/node"
  tar -xJf "$task_work/$node_archive" --strip-components=1 -C "$task_dev_root/node"
  export PATH="$task_dev_root/node/bin:$PATH"
fi
node_22 || fail 'Node.js 22/npm validation failed.'
task_node_bin="$(dirname -- "$(command -v node)")"

jdk_21() {
  [[ -n "${1:-}" && -x "$1/bin/java" && -x "$1/bin/javac" ]] || return 1
  [[ "$("$1/bin/javac" -version 2>&1)" == 'javac 21'* ]] || return 1
  "$1/bin/java" -version 2>&1 | grep -Eq 'version "21([.+"]|$)'
}
find_jdk() {
  local candidate
  if jdk_21 "${JAVA_HOME:-}"; then task_java="$JAVA_HOME"; return 0; fi
  if have javac; then
    candidate="$(dirname -- "$(dirname -- "$(readlink -f -- "$(command -v javac)")")")"
    if jdk_21 "$candidate"; then task_java="$candidate"; return 0; fi
  fi
  for candidate in /usr/lib/jvm/* /opt/java/openjdk; do
    if jdk_21 "$candidate"; then task_java="$candidate"; return 0; fi
  done
  return 1
}
if "$check_only" && [[ -n "${JAVA_HOME:-}" ]] && ! jdk_21 "$JAVA_HOME"; then
  fail 'Full JDK 21 is required at the explicitly configured JAVA_HOME (java AND javac); preflight does not repair a wrong JDK or JRE.'
fi
if ! find_jdk; then
  "$check_only" && fail 'Full JDK 21 is required (java AND javac); a JRE is insufficient.'
  install_packages openjdk-21-jdk-headless
  find_jdk || fail 'JDK 21 is still unavailable after apt installation.'
fi
export JAVA_HOME="$task_java"
export PATH="$JAVA_HOME/bin:$PATH"

task_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$task_sdk" ]]; then
  for candidate in "$task_dev_root/android-sdk" /opt/android-sdk /opt/android-sdk-linux /usr/local/lib/android/sdk; do
    if [[ -d "$candidate" ]]; then task_sdk="$candidate"; break; fi
  done
fi
task_sdk="${task_sdk:-$task_dev_root/android-sdk}"
export ANDROID_HOME="$task_sdk" ANDROID_SDK_ROOT="$task_sdk"
sdk_ready() {
  [[ -f "$task_sdk/platforms/android-36/android.jar" \
    && -f "$task_sdk/platforms/android-36/source.properties" \
    && -f "$task_sdk/build-tools/36.0.0/source.properties" \
    && -s "$task_sdk/licenses/android-sdk-license" \
    && -x "$task_sdk/build-tools/36.0.0/aapt" \
    && -x "$task_sdk/build-tools/36.0.0/aapt2" \
    && -x "$task_sdk/build-tools/36.0.0/apksigner" \
    && -x "$task_sdk/build-tools/36.0.0/zipalign" \
    && -x "$task_sdk/platform-tools/adb" ]] \
    && grep -Eq '^AndroidVersion.ApiLevel[[:space:]]*=[[:space:]]*36[[:space:]]*$' "$task_sdk/platforms/android-36/source.properties" \
    && grep -Eq '^Pkg.Revision[[:space:]]*=[[:space:]]*36\.0\.0[[:space:]]*$' "$task_sdk/build-tools/36.0.0/source.properties"
}
if ! sdk_ready; then
  "$check_only" && fail 'Android SDK platform 36, build-tools 36.0.0, or platform-tools is missing.'
  "$accept_licenses" || fail 'Incomplete SDK: review Android SDK license, then rerun with --accept-android-licenses.'
  mkdir -p -- "$task_dev_root" "$task_sdk"
  [[ -n "$task_work" ]] || task_work="$(mktemp -d "$task_dev_root/setup.XXXXXXXX")"
  sdkmanager_path=''
  for candidate in "$task_sdk/cmdline-tools/23.0/bin/sdkmanager" "$task_sdk/cmdline-tools/latest/bin/sdkmanager"; do
    if [[ -x "$candidate" ]]; then sdkmanager_path="$candidate"; break; fi
  done
  if [[ -z "$sdkmanager_path" ]]; then
    curl --fail --silent --show-error --location --retry 3 --proto '=https' --proto-redir '=https' \
      https://dl.google.com/android/repository/repository2-1.xml -o "$task_work/repository.xml"
    python3 - "$task_work/repository.xml" > "$task_work/android-archive.txt" <<'PY'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
matches = []
for package in root:
    if package.get('path') != 'cmdline-tools;23.0':
        continue
    if package.find('channelRef').get('ref') != 'channel-0':
        raise SystemExit('Pinned command-line tools are not stable')
    for archive in package.findall('archives/archive'):
        if archive.findtext('host-os') == 'linux':
            name = archive.findtext('complete/url', '')
            checksum = archive.findtext('complete/checksum', '')
            if name != 'commandlinetools-linux-16111833_latest.zip' or not re.fullmatch(r'[a-f0-9]{40}', checksum):
                raise SystemExit('Unexpected Android archive metadata')
            matches.append((name, checksum))
if len(matches) != 1:
    raise SystemExit('Expected exactly one stable Linux archive')
print(*matches[0], sep='\n')
PY
    mapfile -t archive_info < "$task_work/android-archive.txt"
    android_archive="${archive_info[0]}"
    android_sha1="${archive_info[1]}"
    [[ "$android_sha1" == e025545c62a8e64c7559119566a569fb1dec5f60 ]] || fail 'Android metadata checksum changed; review the pinned archive before updating.'
    curl --fail --silent --show-error --location --retry 3 --proto '=https' --proto-redir '=https' \
      "https://dl.google.com/android/repository/$android_archive" -o "$task_work/$android_archive"
    (cd "$task_work" && printf '%s  %s\n' "$android_sha1" "$android_archive" | sha1sum -c -)
    unzip -q "$task_work/$android_archive" -d "$task_work/android-tools"
    [[ ! -e "$task_sdk/cmdline-tools/23.0" ]] || fail 'Incomplete command-line tools installation; select a fresh SDK directory.'
    mkdir -p -- "$task_sdk/cmdline-tools"
    mv -- "$task_work/android-tools/cmdline-tools" "$task_sdk/cmdline-tools/23.0"
    sdkmanager_path="$task_sdk/cmdline-tools/23.0/bin/sdkmanager"
  fi
  # The official 23.0 sdkmanager compatibility entry point remains documented.
  # Capture its status explicitly; yes may finish with SIGPIPE after the consumer exits.
  set +e
  yes | "$sdkmanager_path" --sdk_root="$task_sdk" --licenses
  license_status=${PIPESTATUS[1]}
  set -e
  ((license_status == 0)) || fail 'Android license step failed.'
  "$sdkmanager_path" --sdk_root="$task_sdk" 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0'
fi
sdk_ready || fail 'SDK installation is incomplete.'
export PATH="$task_node_bin:$JAVA_HOME/bin:$task_sdk/platform-tools:$task_sdk/build-tools/36.0.0:$PATH"
node --version
npm --version
"$JAVA_HOME/bin/javac" -version
"$task_sdk/build-tools/36.0.0/aapt2" version
"$task_sdk/build-tools/36.0.0/apksigner" version
"$task_sdk/platform-tools/adb" version
git --version
gh --version | head -n 1

if ! "$check_only"; then
  mkdir -p -- "$task_dev_root"
  # Only tool paths are persisted. Never copy the shell environment or credentials.
  {
    printf '# Generated TrackLog task development tool paths; source this in each new shell.\n'
    printf 'export JAVA_HOME=%q\n' "$JAVA_HOME"
    printf 'export ANDROID_HOME=%q\n' "$task_sdk"
    printf 'export ANDROID_SDK_ROOT=%q\n' "$task_sdk"
    printf 'export PATH=%q:"$PATH"\n' "$task_node_bin:$JAVA_HOME/bin:$task_sdk/platform-tools:$task_sdk/build-tools/36.0.0"
  } > "$task_env_file"
  (cd "$task_repo" && npm ci --no-audit --no-fund)
  printf 'New shell: source %q\n' "$task_env_file"
fi
printf '%s\n' 'TrackLog toolchain preflight passed. Android compilation and device behavior are NOT verified.'
printf '%s\n' 'Next: npm run build && npm run cap:sync:android; then cd android && bash ./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug'
