#!/usr/bin/env bash
#
# Lupinus voice pipeline — one-command setup + launcher.
#
# This script fully bootstraps the "whisper-only" pipeline so the user never
# has to manually download or build anything:
#
#   1. installs any missing build tools (git, cmake, make, cc, python3, curl)
#      — on Windows (Git Bash) it skips the C++ toolchain and downloads a
#      prebuilt whisper.cpp binary instead
#   2. clones + builds whisper.cpp (macOS / Linux) or downloads the prebuilt
#      whisper-cli.exe (Windows)
#   3. downloads the whisper models (tiny for the wake word, base for commands)
#   3b. downloads the Piper voice (Alba, medium quality) for spoken replies
#      (the piper engine itself arrives via pip — no binary download needed)
#   4. creates a Python virtualenv and installs numpy + sounddevice + piper-tts
#   5. launches pipeline.py
#
# Usage:
#   ./start.sh          (everything is idempotent — safe to re-run)
#
# Windows notes:
#   * Run this from Git Bash (ships with https://git-scm.com/downloads).
#     Plain CMD / PowerShell cannot run .sh files — use start.ps1 there.
#   * Requires: git, python (3.10+) and either curl or python for downloads.
#     Install via: winget install Git.Python.Python.3.12
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="$ROOT/vendor"
WHISPER_DIR="$VENDOR_DIR/whisper.cpp"
WHISPER_BIN_DIR="$VENDOR_DIR/whisper-bin"
PIPER_VOICE_NAME="en_GB-alba-medium"
MODEL_DIR="$ROOT/models"
VENV_DIR="$ROOT/.venv"

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*"; exit 1; }

# --------------------------------------------------------------------------- #
# 0. Detect OS (including Windows shells: Git Bash / MSYS2 / Cygwin)
# --------------------------------------------------------------------------- #
OS="unknown"
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*|Windows*|WIN*) OS="windows" ;;
  *) err "unsupported OS: $(uname -s)" ;;
esac
log "detected OS: $OS ($(uname -s))"

# Pick a python interpreter: `python3` on macOS/Linux, `python3` or `python`
# on Windows (Git Bash usually only has `python`).
PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

# --------------------------------------------------------------------------- #
# 1. Ensure build tools are present
# --------------------------------------------------------------------------- #
if [ "$OS" = "windows" ]; then
  # No C++ toolchain needed — we download a prebuilt whisper-cli.exe.
  MISSING_TOOLS=()
  command -v git >/dev/null 2>&1 || MISSING_TOOLS+=("git")
  if [ -z "$PYTHON_BIN" ]; then
    MISSING_TOOLS+=("python")
  fi
  if [ "${#MISSING_TOOLS[@]}" -gt 0 ]; then
    err "missing tools: ${MISSING_TOOLS[*]} — install Git from https://git-scm.com/downloads and Python 3.10+ from https://www.python.org/downloads (or: winget install Git.Git Python.Python.3.12), then re-run ./start.sh from Git Bash"
  fi
  # curl is preferred for downloads but python+urllib works as a fallback.
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not found — downloads will fall back to python urllib"
  fi
else
  MISSING_TOOLS=()
  for tool in git cmake make curl; do
    command -v "$tool" >/dev/null 2>&1 || MISSING_TOOLS+=("$tool")
  done
  if [ -z "$PYTHON_BIN" ]; then
    MISSING_TOOLS+=("python3")
  fi
  if ! command -v cc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
    MISSING_TOOLS+=("compiler")
  fi

  if [ "${#MISSING_TOOLS[@]}" -gt 0 ]; then
    warn "missing tools: ${MISSING_TOOLS[*]}"
    if [ "$OS" = "macos" ]; then
      command -v brew >/dev/null 2>&1 || err "install Homebrew first: https://brew.sh"
      for tool in "${MISSING_TOOLS[@]}"; do
        if [ "$tool" = "compiler" ]; then
          warn "installing Xcode Command Line Tools (a popup may appear)..."
          xcode-select --install || true
          err "re-run ./start.sh after the Command Line Tools finish installing"
        else
          brew install "$tool" || err "brew install $tool failed"
        fi
      done
    else
      sudo apt-get update -y
      sudo apt-get install -y git cmake make build-essential python3 python3-venv curl \
        || err "apt install failed"
    fi
  fi
fi

# Shared downloader: curl preferred, python urllib fallback (curl isn't
# guaranteed on Windows Git Bash).
download_file() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail -o "$dest" "$url"
  else
    "$PYTHON_BIN" -c "import urllib.request, sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" \
      "$url" "$dest"
  fi
}

# --------------------------------------------------------------------------- #
# 2. Clone + build whisper.cpp (macOS/Linux) or download prebuilt (Windows)
# --------------------------------------------------------------------------- #
WHISPER_CLI=""

if [ "$OS" = "windows" ]; then
  # Reuse an already-downloaded binary if present.
  for candidate in \
    "$WHISPER_BIN_DIR/whisper-cli.exe" \
    "$WHISPER_DIR/build/bin/Release/whisper-cli.exe" \
    "$WHISPER_DIR/build/bin/whisper-cli.exe"; do
    if [ -f "$candidate" ]; then
      WHISPER_CLI="$candidate"
      break
    fi
  done

  if [ -z "$WHISPER_CLI" ]; then
    # Prebuilt CPU binary from the whisper.cpp GitHub releases. Building from
    # source on Windows requires MSVC/CMake setup, so prefer this.
    #
    # NOTE: the `latest` release frequently ships zero binaries, and the repo
    # moved from ggerganov/whisper.cpp to ggml-org/whisper.cpp, so resolve the
    # real asset URL via the GitHub API instead of hardcoding
    # `.../releases/latest/download/...`. Pinned fallbacks cover the case
    # where the API is unreachable (rate limit / proxy).
    WHISPER_ZIP="$VENDOR_DIR/whisper-bin-x64.zip"
    mkdir -p "$VENDOR_DIR" "$WHISPER_BIN_DIR"

    resolve_whisper_zip_urls() {
      "$PYTHON_BIN" - <<'PYEOF'
import json
import sys
import urllib.request

API = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20"
FALLBACKS = [
    "https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip",
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip",
]

found = None
try:
    req = urllib.request.Request(
        API,
        headers={"User-Agent": "Lupinus-setup", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        releases = json.load(resp)
    for rel in releases:
        for asset in rel.get("assets", []):
            if asset.get("name") == "whisper-bin-x64.zip" and asset.get("browser_download_url"):
                found = asset["browser_download_url"]
                break
        if found:
            break
except Exception as exc:  # API unreachable / rate-limited — fallbacks cover it
    sys.stderr.write(f"[setup] github api lookup failed ({exc}), using pinned fallbacks\n")

if found:
    print(found)
for url in FALLBACKS:
    if url != found:
        print(url)
PYEOF
    }

    log "resolving prebuilt whisper.cpp binary for Windows"
    # NOTE: Windows Python writes stdout with CRLF, so every captured URL
    # would carry a trailing CR and curl rejects it with "error 3: URL
    # rejected". Strip carriage returns before use.
    mapfile -t ZIP_URLS < <(resolve_whisper_zip_urls | tr -d '\r')
    DOWNLOADED=""
    for url in "${ZIP_URLS[@]}"; do
      [ -n "$url" ] || continue
      log "trying $url"
      if download_file "$url" "$WHISPER_ZIP"; then
        DOWNLOADED=1
        break
      else
        warn "download failed: $url"
        rm -f "$WHISPER_ZIP"
      fi
    done
    [ -n "$DOWNLOADED" ] || err "could not download a prebuilt whisper.cpp binary — check your network, or manually place whisper-cli.exe in $WHISPER_BIN_DIR (see https://github.com/ggml-org/whisper.cpp/releases)"
    log "extracting whisper-bin-x64.zip"
    "$PYTHON_BIN" -c "import zipfile, sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" \
      "$WHISPER_ZIP" "$WHISPER_BIN_DIR" \
      || err "failed to extract whisper-bin-x64.zip"

    # The zip layout has changed across releases — search for the binary.
    FOUND_EXE="$(find "$WHISPER_BIN_DIR" -iname 'whisper-cli.exe' -print -quit)"
    if [ -z "$FOUND_EXE" ]; then
      # Very old zips shipped `main.exe` instead of `whisper-cli.exe`.
      FOUND_EXE="$(find "$WHISPER_BIN_DIR" -iname 'main.exe' -print -quit)"
    fi
    [ -n "$FOUND_EXE" ] || err "whisper-cli.exe not found after extracting whisper-bin-x64.zip"
    WHISPER_CLI="$FOUND_EXE"
    log "found whisper binary: $WHISPER_CLI"
  fi
else
  if [ -x "$WHISPER_DIR/build/bin/whisper-cli" ]; then
    WHISPER_CLI="$WHISPER_DIR/build/bin/whisper-cli"
  elif [ -x "$WHISPER_DIR/build/bin/Release/whisper-cli" ]; then
    WHISPER_CLI="$WHISPER_DIR/build/bin/Release/whisper-cli"
  fi

  if [ -z "$WHISPER_CLI" ]; then
    if [ ! -d "$WHISPER_DIR" ]; then
      log "cloning whisper.cpp"
      git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
    fi
    log "building whisper.cpp (this takes a few minutes)"
    cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DCMAKE_BUILD_TYPE=Release
    cmake --build "$WHISPER_DIR/build" -j

    if [ -x "$WHISPER_DIR/build/bin/whisper-cli" ]; then
      WHISPER_CLI="$WHISPER_DIR/build/bin/whisper-cli"
    elif [ -x "$WHISPER_DIR/build/bin/Release/whisper-cli" ]; then
      WHISPER_CLI="$WHISPER_DIR/build/bin/Release/whisper-cli"
    else
      err "whisper-cli binary not found after build"
    fi
  fi
fi
log "whisper-cli: $WHISPER_CLI"

# macOS bakes the build directory into each binary's LC_RPATH, so moving or
# renaming the project afterwards leaves whisper-cli unable to find
# libwhisper.dylib ("Library not loaded: @rpath/libwhisper.1.dylib"). Rewrite
# absolute rpaths to @loader_path so the tree is self-relative; this also
# repairs an already-built tree, so re-running start.sh is enough after a move.
if [ "$OS" = "macos" ] && [ -n "$WHISPER_CLI" ]; then
  WHISPER_BIN_DIR_BUILT="$(cd "$(dirname "$WHISPER_CLI")" && pwd)"
  find "$WHISPER_BIN_DIR_BUILT" -maxdepth 1 -type f | while IFS= read -r bin; do
    file -b "$bin" | grep -q 'Mach-O' || continue
    changed=0
    while IFS= read -r rpath; do
      [ -n "$rpath" ] || continue
      case "$rpath" in
        @*) continue ;;
      esac
      install_name_tool -delete_rpath "$rpath" "$bin" >/dev/null 2>&1 && changed=1
    done < <(otool -l "$bin" | awk '/LC_RPATH/ { getline; getline; sub(/^[[:space:]]*path /, ""); sub(/ \(offset.*/, ""); print }')
    if ! otool -l "$bin" | grep -q '@loader_path'; then
      install_name_tool -add_rpath '@loader_path' "$bin" >/dev/null 2>&1 && changed=1
    fi
    # Editing a Mach-O invalidates its code signature; arm64 refuses to run
    # binaries without one, so re-sign ad-hoc when anything changed.
    if [ "$changed" = 1 ]; then
      codesign --force --sign - "$bin" >/dev/null 2>&1 || true
    fi
  done
fi

# NOTE: piper TTS needs no binary download — `pip install piper-tts` in
# section 4 ships the native libs for every OS. Only the voice model below
# is fetched here.

# --------------------------------------------------------------------------- #
# 3. Download whisper models (curl preferred, python urllib fallback for Win)
# --------------------------------------------------------------------------- #
mkdir -p "$MODEL_DIR"

download_model() {
  local name="$1" size="$2"
  local dest="$MODEL_DIR/ggml-$name.bin"
  if [ -f "$dest" ]; then
    log "model ggml-$name.bin already present"
    return
  fi
  log "downloading ggml-$name.bin (~${size}MB)"
  download_file \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$name.bin" \
    "$dest" \
    || err "failed to download ggml-$name.bin"
}

download_model tiny 75
download_model base 142

# --------------------------------------------------------------------------- #
# 3b. Download the Piper voice for spoken replies (Alba, medium quality)
# --------------------------------------------------------------------------- #
PIPER_VOICE_ONNX="$MODEL_DIR/$PIPER_VOICE_NAME.onnx"
PIPER_VOICE_JSON="$MODEL_DIR/$PIPER_VOICE_NAME.onnx.json"

for voice_file in "$PIPER_VOICE_ONNX" "$PIPER_VOICE_JSON"; do
  if [ -f "$voice_file" ]; then
    log "voice file $(basename "$voice_file") already present"
    continue
  fi
  log "downloading $(basename "$voice_file")"
  download_file \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/$(basename "$voice_file")" \
    "$voice_file" \
    || err "failed to download $(basename "$voice_file")"
done

# --------------------------------------------------------------------------- #
# 4. Python virtualenv + deps (venv layout differs on Windows)
# --------------------------------------------------------------------------- #
if [ "$OS" = "windows" ]; then
  VENV_PYTHON="$VENV_DIR/Scripts/python.exe"
  VENV_PIP="$VENV_DIR/Scripts/pip.exe"
else
  VENV_PYTHON="$VENV_DIR/bin/python"
  VENV_PIP="$VENV_DIR/bin/pip"
fi

if [ ! -d "$VENV_DIR" ]; then
  log "creating python virtualenv ($PYTHON_BIN -m venv)"
  "$PYTHON_BIN" -m venv "$VENV_DIR" \
    || err "failed to create virtualenv — on Windows install Python from python.org with 'Add to PATH' checked"
fi
log "installing python dependencies (numpy, sounddevice, piper-tts)"
"$VENV_PIP" install -q --disable-pip-version-check -r "$ROOT/requirements.txt" \
  || err "pip install failed"

# --------------------------------------------------------------------------- #
# 5. Launch
# --------------------------------------------------------------------------- #
if [ "$OS" = "windows" ]; then
  # The venv python is a native Windows exe: it cannot resolve MSYS paths
  # like /c/Users/... passed via env vars (only argv gets auto-converted),
  # so export real Windows paths here.
  command -v cygpath >/dev/null 2>&1 || err "cygpath not found — run this script from Git Bash (https://git-scm.com/downloads)"
  WHISPER_CLI="$(cygpath -w "$WHISPER_CLI")"
  MODEL_DIR="$(cygpath -w "$MODEL_DIR")"
fi
log "starting voice pipeline — say 'hey jarvis' then your command (Ctrl+C to stop)"
exec env \
  WHISPER_CLI="$WHISPER_CLI" \
  WHISPER_WAKE_MODEL="$MODEL_DIR/ggml-tiny.bin" \
  WHISPER_MODEL="$MODEL_DIR/ggml-base.bin" \
  PIPER_VOICE="$MODEL_DIR/$PIPER_VOICE_NAME.onnx" \
  "$VENV_PYTHON" "$ROOT/pipeline.py"
