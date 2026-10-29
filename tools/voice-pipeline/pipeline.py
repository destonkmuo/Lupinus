"""
Real-time local voice assistant — wake word + transcription with whisper.cpp,
spoken replies with Piper TTS (Alba voice).

Architecture:
  * A background thread continuously transcribes a rolling window of microphone
    audio with a *tiny* whisper model, purely to check whether the wake phrase
    ("hey lu") was said. Its output is never printed or merged anywhere.
  * The main thread captures audio and uses a tiny built-in energy gate (pure
    numpy, not an external model) to detect the end of the utterance.
  * The captured buffer is transcribed exactly once with a larger whisper model
    and the plain text is printed to stdout as the finished sentence.
  * A speaker thread reads {"speak": "..."} JSON commands from stdin, renders
    them with piper, and plays them via sounddevice. The mic is ducked while
    our own voice plays so we never transcribe ourselves.

Stdout carries ONLY finished transcripts (`Transcribed: ...`), one per line —
the Electron host parses every stdout line as a transcript. Everything else
goes to stderr.

Only whisper.cpp is used for the ML and only piper for TTS; there are no
other model downloads. The accompanying `start.sh` builds whisper.cpp,
downloads the piper binary, fetches all models, and installs the two tiny
Python packages for you — nothing is downloaded by hand.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from collections import deque

import numpy as np
import sounddevice as sd

# --------------------------------------------------------------------------- #
# Configuration (all overridable via environment variables)
# --------------------------------------------------------------------------- #

SAMPLE_RATE = 16000           # whisper.cpp + PortAudio target rate
CHUNK_SAMPLES = 1280          # 80 ms frames
CHANNELS = 1

WHISPER_CLI = os.environ.get("WHISPER_CLI", "whisper-cli")

# A tiny model for the always-on wake-word listener (fast on CPU).
WAKE_MODEL = os.environ.get("WHISPER_WAKE_MODEL", "models/ggml-tiny.bin")
# A larger model for the final command transcription.
TRANSCRIBE_MODEL = os.environ.get("WHISPER_MODEL", "models/ggml-base.bin")

# Wake-word listener tuning. Checked twice as often over a shorter window so
# "hey lu" trips detection fast: worst case ~0.5s scheduling delay plus one
# tiny-model pass over 3s of audio (well under a second on CPU).
WAKE_WINDOW_SECONDS = 3.0      # audio window fed to whisper each check
WAKE_INTERVAL = 0.5            # seconds between wake-word checks
# Whisper sometimes hears "jarvis" slightly differently; keep a small alias set.
WAKE_ALIASES = ("loo", "lupinus", "lupin", "lu", "lou")

# Endpointing via a simple RMS energy gate.
ENERGY_THRESHOLD = 0.012       # RMS in [0, 1]
MIN_SILENCE_MS = 600           # trailing silence that ends an utterance
MAX_UTTERANCE_SECONDS = 15.0   # hard cap on one command
NO_SPEECH_TIMEOUT = 4.0        # give up if nothing is said after the wake word
PRE_ROLL_SECONDS = 0.5         # keep a little audio before speech start

# Spoken replies via the piper Python module (Alba voice, files from start.sh).
# pip wheels bundle the native libs on every OS, so no system packages or
# downloaded binaries are needed — just `pip install -r requirements.txt`.
PIPER_VOICE = os.environ.get("PIPER_VOICE", "models/en_GB-alba-medium.onnx")
TTS_MAX_CHARS = 600            # bound synthesis latency per utterance
TTS_QUEUE_MAX = 3              # drop oldest if replies queue faster than realtime

# Set in main() once binaries/models are checked; the stdin thread consults it.
TTS_AVAILABLE = False


# --------------------------------------------------------------------------- #
# whisper.cpp helper
# --------------------------------------------------------------------------- #

def run_whisper(model_path: str, samples: np.ndarray) -> str:
    """Transcribe int16 samples with a whisper.cpp model and return plain text.

    This function is pure: it does not print, accumulate, or otherwise leak
    its result anywhere. Callers decide what to do with the returned text.
    """
    if samples.size == 0:
        return ""

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        with wave.open(tmp.name, "wb") as wav:
            wav.setnchannels(CHANNELS)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(samples.astype(np.int16).tobytes())

        proc = subprocess.run(
            [WHISPER_CLI, "-m", model_path, "-f", tmp.name, "-nt", "-np"],
            capture_output=True,
            text=True,
            timeout=120,
        )
    finally:
        os.unlink(tmp.name)

    if proc.returncode != 0:
        raise RuntimeError(f"whisper-cli failed: {proc.stderr.strip()}")

    text = " ".join(line.strip() for line in proc.stdout.splitlines() if line.strip())
    return text


def normalize(text: str) -> str:
    """Lowercase and strip punctuation so wake-word matching is forgiving."""
    return re.sub(r"[^a-z0-9 ]", "", text.lower())


def contains_wake_word(text: str) -> bool:
    return any(alias in text for alias in WAKE_ALIASES)


def is_blank(text: str) -> bool:
    """True for whisper's own placeholders like '[BLANK_AUDIO]' or silence."""
    text = text.strip()
    return not text or text.startswith(("(", "["))


# --------------------------------------------------------------------------- #
# Wake-word listener (runs whisper in a background thread)
# --------------------------------------------------------------------------- #
# NOTE: this listener's job is *only* to flip `detected` when it hears the
# wake phrase. It never prints or accumulates a transcript — that avoids the
# stream of overlapping, half-finished fragments you'd otherwise get from
# re-transcribing a sliding window every second.

class WakeListener(threading.Thread):
    """Keeps a rolling audio window and periodically asks whisper for text."""

    def __init__(self) -> None:
        super().__init__(daemon=True)
        self._lock = threading.Lock()
        self._buffer: deque[np.ndarray] = deque()
        self._length = 0
        self._window = int(WAKE_WINDOW_SECONDS * SAMPLE_RATE)
        self._enabled = True
        self.detected = threading.Event()

    # -- audio bookkeeping (called from the main thread) ---------------------

    def add(self, chunk: np.ndarray) -> None:
        with self._lock:
            self._buffer.append(chunk)
            self._length += len(chunk)
            while self._length > self._window:
                self._length -= len(self._buffer.popleft())

    def recent(self, seconds: float) -> np.ndarray:
        """Return the last `seconds` of audio (used as pre-roll after a trigger)."""
        target = int(seconds * SAMPLE_RATE)
        with self._lock:
            chunks = list(self._buffer)
        if not chunks or target == 0:
            return np.array([], dtype=np.int16)
        tail: list[np.ndarray] = []
        count = 0
        for c in reversed(chunks):
            tail.append(c)
            count += len(c)
            if count >= target:
                break
        tail.reverse()
        return np.concatenate(tail)[-target:]

    def snapshot(self) -> np.ndarray | None:
        """Full window for whisper, or None if there isn't enough audio yet."""
        with self._lock:
            if self._length < SAMPLE_RATE:
                return None
            return np.concatenate(list(self._buffer))

    # -- lifecycle ------------------------------------------------------------

    def enable(self, enabled: bool) -> None:
        with self._lock:
            self._enabled = enabled

    def reset(self) -> None:
        with self._lock:
            self._buffer.clear()
            self._length = 0
        self.detected.clear()

    # -- worker loop -----------------------------------------------------------

    def run(self) -> None:
        while True:
            with self._lock:
                enabled = self._enabled
            if enabled:
                samples = self.snapshot()
                if samples is not None:
                    try:
                        text = normalize(run_whisper(WAKE_MODEL, samples))
                        if contains_wake_word(text):
                            self.detected.set()
                    except Exception as exc:  # noqa: BLE001
                        sys.stderr.write(f"[error] wake listener: {exc}\n")
            time.sleep(WAKE_INTERVAL)


# --------------------------------------------------------------------------- #
# Energy gate (endpointing) — pure numpy, no external model
# --------------------------------------------------------------------------- #

class EnergyGate:
    def __init__(self) -> None:
        self._threshold = ENERGY_THRESHOLD
        self._min_silence = int(SAMPLE_RATE * MIN_SILENCE_MS / 1000)
        self._silence_run = 0
        self._speaking = False
        self._clock = 0.0

    def __call__(self, chunk: np.ndarray) -> dict | None:
        rms = float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2)) / 32768.0)
        chunk_seconds = len(chunk) / SAMPLE_RATE
        self._clock += chunk_seconds

        if rms > self._threshold:
            self._silence_run = 0
            if not self._speaking:
                self._speaking = True
                return {"start": self._clock - chunk_seconds}
        elif self._speaking:
            self._silence_run += len(chunk)
            if self._silence_run >= self._min_silence:
                self._speaking = False
                self._silence_run = 0
                return {"end": self._clock}
        return None


# --------------------------------------------------------------------------- #
# Text-to-speech — piper binary + Alba voice, driven over stdin
# --------------------------------------------------------------------------- #
# The Electron host sends one JSON object per line, e.g. {"speak": "hello"}.
# Only finished transcripts go to stdout (the host parses every stdout line
# as a transcript), so all TTS chatter uses stderr.

tts_queue: queue.Queue[str] = queue.Queue(maxsize=TTS_QUEUE_MAX)
tts_playing = threading.Event()


def clean_for_speech(text: str) -> str:
    """Strip markdown/formatting so Piper reads plain prose, then cap length."""
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)  # fenced code
    text = re.sub(r"`([^`]*)`", r"\1", text)                 # inline code
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)    # images -> alt text
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)     # links -> text
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)           # bold
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\1", text)  # italic
    text = re.sub(r"~~([^~]+)~~", r"\1", text)               # strikethrough
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"<[^>]+>", " ", text)                     # stray html tags
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > TTS_MAX_CHARS:
        cut = text.rfind(" ", 0, TTS_MAX_CHARS)
        text = text[: cut if cut > 0 else TTS_MAX_CHARS].rstrip()
    return text


def speak_text(text: str) -> None:
    """Queue cleaned text for speech; drop oldest when falling behind."""
    cleaned = clean_for_speech(text)
    if not cleaned:
        return
    try:
        tts_queue.put_nowait(cleaned)
    except queue.Full:
        try:
            tts_queue.get_nowait()  # drop oldest, stay live
        except queue.Empty:
            pass
        tts_queue.put_nowait(cleaned)
    sys.stderr.write(f"[tts] queued {len(cleaned)} chars\n")


def synthesize_speech(text: str, out_path: str) -> None:
    """Render text to a wav file with piper (same interpreter, text via stdin)."""
    proc = subprocess.run(
        [sys.executable, "-m", "piper", "--model", PIPER_VOICE, "--output_file", out_path],
        input=text,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"piper failed: {proc.stderr.strip()}")


def read_wav_mono16(path: str) -> tuple[np.ndarray, int]:
    """Load a 16-bit mono wav (piper's native output) with its sample rate."""
    with wave.open(path, "rb") as wav:
        if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
            raise RuntimeError("unexpected piper wav format (want 16-bit mono)")
        rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())
    if not frames:
        raise RuntimeError("piper produced empty audio")
    return np.frombuffer(frames, dtype=np.int16).copy(), rate


class Speaker(threading.Thread):
    """Serializes TTS: synthesize, duck the mic, play, re-arm the mic."""

    def __init__(self, listener: WakeListener) -> None:
        super().__init__(daemon=True)
        self._listener = listener

    def run(self) -> None:
        while True:
            text = tts_queue.get()
            try:
                tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                tmp.close()
                try:
                    synthesize_speech(text, tmp.name)
                    samples, rate = read_wav_mono16(tmp.name)
                finally:
                    os.unlink(tmp.name)

                # Duck the mic so we never transcribe our own voice. The main
                # loop drains (but ignores) mic chunks while this is set.
                self._listener.enable(False)
                tts_playing.set()
                try:
                    sd.play(samples, samplerate=rate)
                    sd.wait()
                finally:
                    tts_playing.clear()
                    self._listener.reset()
                    self._listener.enable(True)
                sys.stderr.write("[tts] done\n")
            except Exception as exc:  # noqa: BLE001
                tts_playing.clear()
                self._listener.enable(True)
                sys.stderr.write(f"[error] tts failed: {exc}\n")


def stdin_commands() -> None:
    """Consume {"speak": "..."} JSON lines from stdin (Electron host)."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            sys.stderr.write(f"[warn] ignoring non-JSON stdin line: {line[:80]}\n")
            continue
        if isinstance(cmd, dict) and isinstance(cmd.get("speak"), str):
            if TTS_AVAILABLE:
                speak_text(cmd["speak"])
            else:
                sys.stderr.write("[warn] TTS unavailable, speak request ignored\n")


def tts_available() -> bool:
    """True when the piper module is installed and the Alba voice resolves."""
    import importlib.util

    if importlib.util.find_spec("piper") is None:
        return False
    return os.path.exists(PIPER_VOICE)


# --------------------------------------------------------------------------- #
# Main pipeline
# --------------------------------------------------------------------------- #

def main() -> None:
    if shutil.which(WHISPER_CLI) is None and not os.path.exists(WHISPER_CLI):
        sys.stderr.write(
            f"[error] whisper binary '{WHISPER_CLI}' not found — "
            "run tools/voice-pipeline/start.sh (or start.ps1 on Windows) to download it\n"
        )
        sys.exit(1)

    for path, name in ((WAKE_MODEL, "wake"), (TRANSCRIBE_MODEL, "transcribe")):
        if not os.path.exists(path):
            sys.stderr.write(
                f"[error] missing {name} model '{path}' — run start.sh to download it\n"
            )
            sys.exit(1)

    global TTS_AVAILABLE
    TTS_AVAILABLE = tts_available()

    listener = WakeListener()
    listener.start()

    if TTS_AVAILABLE:
        sys.stderr.write("[info] TTS ready (piper + alba-medium voice)\n")
        threading.Thread(target=stdin_commands, daemon=True, name="stdin").start()
        Speaker(listener).start()
    else:
        sys.stderr.write(
            f"[warn] TTS disabled — piper module or voice missing "
            f"(PIPER_VOICE={PIPER_VOICE}); run start.sh\n"
        )

    sys.stderr.write("[info] listening for 'hey lu'... (speak to interact)\n")

    state = "LISTEN"
    gate = EnergyGate()
    speech_chunks: list[np.ndarray] = []
    speech_start_sec: float | None = None
    captured_seconds = 0.0
    silence_since_wake = 0.0

    def transcribe_and_reset() -> None:
        nonlocal state
        samples = np.concatenate(speech_chunks)
        if speech_start_sec is not None:
            keep_from = max(0, int((speech_start_sec - PRE_ROLL_SECONDS) * SAMPLE_RATE))
            samples = samples[keep_from:]

        if samples.size < SAMPLE_RATE * 0.2:
            sys.stderr.write("[wake] utterance too short, ignored\n")
        else:
            try:
                # Single whisper call on the whole captured utterance. This is
                # the only place a transcript gets printed — once, in full.
                text = run_whisper(TRANSCRIBE_MODEL, samples)
                if not is_blank(text):
                    print(f"Transcribed: {text.strip()}", flush=True)
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(f"[error] transcription failed: {exc}\n")

        listener.reset()
        listener.enable(True)
        state = "LISTEN"

    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="int16",
        blocksize=CHUNK_SAMPLES,
    ) as stream:
        while True:
            block, _overflowed = stream.read(CHUNK_SAMPLES)
            chunk = block.flatten()

            if tts_playing.is_set():
                # Our own voice is on the speaker — drain the mic without
                # feeding the wake listener or the capture state machine.
                continue

            if state == "LISTEN":
                listener.add(chunk)

                if listener.detected.is_set():
                    sys.stderr.write("[wake] wake word detected\n")
                    listener.enable(False)
                    speech_chunks = [listener.recent(PRE_ROLL_SECONDS)]
                    gate = EnergyGate()
                    speech_start_sec = None
                    captured_seconds = len(speech_chunks[0]) / SAMPLE_RATE
                    silence_since_wake = 0.0
                    state = "CAPTURE"
                    continue

            elif state == "CAPTURE":
                speech_chunks.append(chunk)
                captured_seconds += len(chunk) / SAMPLE_RATE

                result = gate(chunk)
                if result is not None:
                    if "start" in result and speech_start_sec is None:
                        speech_start_sec = result["start"]
                    elif "end" in result and speech_start_sec is not None:
                        transcribe_and_reset()
                        continue

                if speech_start_sec is None:
                    silence_since_wake += len(chunk) / SAMPLE_RATE
                    if silence_since_wake >= NO_SPEECH_TIMEOUT:
                        sys.stderr.write("[wake] no speech, back to listening\n")
                        listener.reset()
                        listener.enable(True)
                        state = "LISTEN"
                        continue

                if captured_seconds >= MAX_UTTERANCE_SECONDS:
                    transcribe_and_reset()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.stderr.write("\n[info] stopped\n")
