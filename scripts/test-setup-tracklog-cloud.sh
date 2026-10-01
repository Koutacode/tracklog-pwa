#!/usr/bin/env bash
set -euo pipefail
base="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fixture_root="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
fixture="$(mktemp -d "$fixture_root/tracklog-cloud-setup-test.XXXXXXXX")"
cleanup() {
  if [[ -d "$fixture" && ! -L "$fixture" ]]; then
    local resolved
    resolved="$(cd -- "$fixture" && pwd -P)" || return 1
    case "$resolved" in
      "$fixture_root"/tracklog-cloud-setup-test.*)
        [[ "$resolved" == "$fixture" ]] || return 1
        rm -rf -- "$resolved" ;;
      *) printf 'Refusing cleanup outside the test fixture root.\n' >&2; return 1 ;;
    esac
  fi
}
trap cleanup EXIT
script="$base/setup-tracklog-cloud.sh"
mkdir -p "$fixture/bin" "$fixture/jdk/bin" "$fixture/repo/android" \
  "$fixture/sdk/platforms/android-36" "$fixture/sdk/build-tools/36.0.0" "$fixture/sdk/platform-tools" "$fixture/sdk/licenses"
touch "$fixture/repo/package-lock.json" "$fixture/repo/android/gradlew" \
  "$fixture/sdk/platforms/android-36/android.jar" "$fixture/sdk/platforms/android-36/source.properties"
printf 'AndroidVersion.ApiLevel=36\n' > "$fixture/sdk/platforms/android-36/source.properties"
printf 'Pkg.Revision=36.0.0\n' > "$fixture/sdk/build-tools/36.0.0/source.properties"
printf 'fake-accepted-license\n' > "$fixture/sdk/licenses/android-sdk-license"
cat > "$fixture/bin/uname" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in -s) echo Linux;; -m) echo x86_64;; *) exit 1;; esac
SH
cat > "$fixture/bin/node" <<'SH'
#!/usr/bin/env bash
echo "v${FAKE_NODE_MAJOR:-22}.23.3"
SH
cat > "$fixture/bin/npm" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo 10.9.4; else
  [[ "$*" == 'ci --no-audit --no-fund' ]] || exit 1
  printf 'npm ci\n' >> "$FIXTURE_ACTIONS"
  exit "${FAKE_NPM_EXIT:-0}"
fi
SH
cat > "$fixture/jdk/bin/javac" <<'SH'
#!/usr/bin/env bash
echo "javac ${FAKE_JDK_MAJOR:-21}.0.8"
SH
cat > "$fixture/jdk/bin/java" <<'SH'
#!/usr/bin/env bash
echo "openjdk version \"${FAKE_JDK_MAJOR:-21}.0.8\"" >&2
SH
for name in curl unzip git gh python3 tar xz sha256sum sha1sum; do
  printf '#!/usr/bin/env bash\ncase "${1:-}" in --version) echo "fixture tool";; *) echo "unexpected tool action" >&2; exit 90;; esac\n' > "$fixture/bin/$name"
done
for path in build-tools/36.0.0/aapt build-tools/36.0.0/aapt2 build-tools/36.0.0/apksigner build-tools/36.0.0/zipalign platform-tools/adb; do
  printf '#!/usr/bin/env bash\necho "fixture android tool"\n' > "$fixture/sdk/$path"
done
chmod +x "$fixture/bin/"* "$fixture/jdk/bin/"* "$fixture/sdk/build-tools/36.0.0/"* "$fixture/sdk/platform-tools/adb"
export PATH="$fixture/bin:/usr/bin:/bin"
export JAVA_HOME="$fixture/jdk" ANDROID_HOME="$fixture/sdk" ANDROID_SDK_ROOT="$fixture/sdk"
export TRACKLOG_CLOUD_DEV_ROOT="$fixture/dev" FIXTURE_ACTIONS="$fixture/actions"

bash "$script" --repo "$fixture/repo" --check > "$fixture/pass.log" 2>&1
[[ ! -e "$fixture/dev" && ! -e "$fixture/actions" ]]
echo 'PASS complete toolchain --check has no writes/install/npm ci'

if FAKE_NODE_MAJOR=20 bash "$script" --repo "$fixture/repo" --check > "$fixture/node-failure.log" 2>&1; then exit 1; fi
grep -q 'Node.js 22' "$fixture/node-failure.log"
echo 'PASS wrong Node version fails preflight'

if FAKE_JDK_MAJOR=17 bash "$script" --repo "$fixture/repo" --check > "$fixture/java-failure.log" 2>&1; then exit 1; fi
grep -q 'Full JDK 21' "$fixture/java-failure.log"
echo 'PASS wrong JDK version fails preflight'

mv "$fixture/jdk/bin/javac" "$fixture/jdk/bin/javac.saved"
if bash "$script" --repo "$fixture/repo" --check > "$fixture/jre-failure.log" 2>&1; then exit 1; fi
grep -q 'Full JDK 21' "$fixture/jre-failure.log"
mv "$fixture/jdk/bin/javac.saved" "$fixture/jdk/bin/javac"
echo 'PASS Java-only JRE fails preflight'

mv "$fixture/sdk/build-tools/36.0.0/aapt" "$fixture/sdk/build-tools/36.0.0/aapt.saved"
if bash "$script" --repo "$fixture/repo" --check > "$fixture/aapt-failure.log" 2>&1; then exit 1; fi
grep -q 'SDK platform 36' "$fixture/aapt-failure.log"
mv "$fixture/sdk/build-tools/36.0.0/aapt.saved" "$fixture/sdk/build-tools/36.0.0/aapt"
mv "$fixture/sdk/platforms/android-36/android.jar" "$fixture/sdk/platforms/android-36/android.jar.saved"
if bash "$script" --repo "$fixture/repo" --check > "$fixture/sdk-failure.log" 2>&1; then exit 1; fi
grep -q 'SDK platform 36' "$fixture/sdk-failure.log"
if bash "$script" --repo "$fixture/repo" > "$fixture/license-failure.log" 2>&1; then exit 1; fi
grep -q -- '--accept-android-licenses' "$fixture/license-failure.log"
mv "$fixture/sdk/platforms/android-36/android.jar.saved" "$fixture/sdk/platforms/android-36/android.jar"
echo 'PASS missing aapt/SDK fails preflight and installation requires explicit license flag'

bash "$script" --repo "$fixture/repo" > "$fixture/setup-pass.log" 2>&1
[[ "$(cat "$fixture/actions")" == 'npm ci' ]]
[[ -f "$fixture/dev/taskdev-env.sh" ]]
bash -c 'unset JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT; source "$1"; [[ -x "$JAVA_HOME/bin/javac" && -f "$ANDROID_HOME/platforms/android-36/android.jar" && "$ANDROID_HOME" == "$ANDROID_SDK_ROOT" ]]' _ "$fixture/dev/taskdev-env.sh"
echo 'PASS existing environment reused; npm ci called; generated env works in a new shell'

if FAKE_NPM_EXIT=42 bash "$script" --repo "$fixture/repo" > "$fixture/npm-failure.log" 2>&1; then exit 1; fi
grep -q 'Android build is NOT verified' "$fixture/npm-failure.log"
if grep -q 'preflight passed' "$fixture/npm-failure.log"; then exit 1; fi
echo 'PASS npm ci failure exits nonzero and never prints success'

echo 'Offline branch fixtures passed. No Linux, apt, SDK download, or Gradle build was executed.'
