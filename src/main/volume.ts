import { app, ipcMain } from 'electron'
import { execFile } from 'child_process'

/**
 * System (OS) volume control for the alarm "max volume" option.
 *
 * When an alarm with `maxVolume` starts ringing, the renderer calls
 * `alarm:maxVolume`: the current level/mute state is pushed onto a stack and
 * the OS volume is cranked to 100% (unmuted). Each stop/snooze/disable pops
 * one entry via `alarm:restoreVolume` and puts the previous level back. The
 * stack keeps overlapping rings balanced; quitting drains whatever is left
 * best-effort so the user's volume is never stranded at max.
 */

export interface SystemVolumeState {
  /** Output level, 0-100. */
  volume: number
  muted: boolean
}

export interface VolumeResult {
  ok: boolean
  error?: string
}

function run(
  file: string,
  args: string[],
  timeoutMs = 15000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function clampVolume(volume: number): number {
  if (Number.isNaN(volume)) return 0
  return Math.min(100, Math.max(0, Math.round(volume)))
}

// ---------------------------------------------------------------- macOS ---

async function getMacVolume(): Promise<SystemVolumeState> {
  const { stdout } = await run('osascript', ['-e', 'get volume settings'])
  const volume = Number(/output volume:(\d+)/.exec(stdout)?.[1] ?? NaN)
  if (Number.isNaN(volume)) throw new Error(`Could not parse volume: ${stdout.trim()}`)
  return { volume, muted: /output muted:true/.test(stdout) }
}

async function setMacVolume(volume: number, muted: boolean): Promise<void> {
  await run('osascript', [
    '-e',
    `set volume output volume ${clampVolume(volume)} ${muted ? 'with' : 'without'} output muted`
  ])
}

// ---------------------------------------------------------------- Linux ---

async function getLinuxVolume(): Promise<SystemVolumeState> {
  // pactl first (PulseAudio/PipeWire), amixer as the ALSA fallback.
  try {
    const [{ stdout: volOut }, { stdout: muteOut }] = await Promise.all([
      run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']),
      run('pactl', ['get-sink-mute', '@DEFAULT_SINK@'])
    ])
    const pct = volOut.split('\n')[0]?.match(/(\d+)%/)
    const volume = pct ? Number(pct[1]) : NaN
    if (Number.isNaN(volume)) throw new Error(`Could not parse volume: ${volOut.trim()}`)
    return { volume: clampVolume(volume), muted: /\bMute:\s*yes/i.test(muteOut) }
  } catch (error) {
    const { stdout } = await run('amixer', ['-D', 'pulse', 'sget', 'Master']).catch(() =>
      run('amixer', ['sget', 'Master'])
    )
    const pct = stdout.match(/\[(\d+)%\]/)?.[1]
    const volume = pct ? Number(pct) : NaN
    if (Number.isNaN(volume)) {
      throw error instanceof Error ? error : new Error('Could not read system volume.')
    }
    return { volume: clampVolume(volume), muted: /\[(off|mute)\]/i.test(stdout) }
  }
}

async function setLinuxVolume(volume: number, muted: boolean): Promise<void> {
  const level = `${clampVolume(volume)}%`
  const mute = muted ? '1' : '0'
  try {
    await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', level])
    await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', mute])
  } catch {
    await run('amixer', ['-D', 'pulse', 'sset', 'Master', level]).catch(() =>
      run('amixer', ['sset', 'Master', level])
    )
    const toggle = muted ? 'mute' : 'unmute'
    await run('amixer', ['-D', 'pulse', 'sset', 'Master', toggle]).catch(() =>
      run('amixer', ['sset', 'Master', toggle])
    )
  }
}

// --------------------------------------------------------------- Windows ---

// Master endpoint volume via Core Audio (IAudioEndpointVolume). Runs inside
// powershell.exe; any failure (blocked execution policy, missing sink, …)
// throws, and the caller degrades to { ok: false }.
const WINDOWS_AUDIO_CS = `
using System;
using System.Runtime.InteropServices;
public static class LupinusSysVol {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumerator { }
  [Guid("A95664D2-9614-4F35-A746-DE8DB636B87A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    int SkipEnum();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice {
    int SkipActivate0();
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IAudioEndpointVolume ppInterface);
  }
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioEndpointVolume {
    int Skip0(); int Skip1(); int Skip2();
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute(bool bMute, ref Guid pguidEventContext);
    int GetMute(out bool pbMute);
  }
  private static IAudioEndpointVolume Endpoint() {
    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
    Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    IAudioEndpointVolume endpoint;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
    return endpoint;
  }
  public static string Get() {
    IAudioEndpointVolume endpoint = Endpoint();
    float level;
    Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out level));
    bool mute;
    Marshal.ThrowExceptionForHR(endpoint.GetMute(out mute));
    return ((int)Math.Round(level * 100.0f)).ToString() + "|" + (mute ? "1" : "0");
  }
  public static void Set(float level, bool mute) {
    IAudioEndpointVolume endpoint = Endpoint();
    Guid ctx = Guid.Empty;
    Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(level, ref ctx));
    Marshal.ThrowExceptionForHR(endpoint.SetMute(mute, ref ctx));
  }
}
`.trim()

async function runWindowsAudio(method: 'Get' | 'Set', level = 1, mute = false): Promise<string> {
  const call =
    method === 'Get'
      ? '[LupinusSysVol]::Get()'
      : `[LupinusSysVol]::Set(${level}, $${mute ? 'true' : 'false'})`
  const script = `${WINDOWS_AUDIO_CS}\n${call}`
  const { stdout } = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    20000
  )
  return stdout.trim()
}

async function getWindowsVolume(): Promise<SystemVolumeState> {
  const out = await runWindowsAudio('Get')
  const match = /^(\d+)\|([01])$/.exec(out.split('\n').pop() ?? '')
  if (!match) throw new Error(`Could not parse volume: ${out}`)
  return { volume: clampVolume(Number(match[1])), muted: match[2] === '1' }
}

async function setWindowsVolume(volume: number, muted: boolean): Promise<void> {
  await runWindowsAudio('Set', clampVolume(volume) / 100, muted)
}

// ----------------------------------------------------------------- core ---

async function getSystemVolume(): Promise<SystemVolumeState> {
  if (process.platform === 'darwin') return getMacVolume()
  if (process.platform === 'win32') return getWindowsVolume()
  if (process.platform === 'linux') return getLinuxVolume()
  throw new Error(`System volume is not supported on ${process.platform}.`)
}

async function setSystemVolume(volume: number, muted: boolean): Promise<void> {
  if (process.platform === 'darwin') return setMacVolume(volume, muted)
  if (process.platform === 'win32') return setWindowsVolume(volume, muted)
  if (process.platform === 'linux') return setLinuxVolume(volume, muted)
  throw new Error(`System volume is not supported on ${process.platform}.`)
}

/** Saved levels, one entry per active max-out (overlapping rings balance). */
const savedStack: SystemVolumeState[] = []

/** Remember the current level, then crank the OS volume to max (unmuted). */
async function maxOutVolume(): Promise<VolumeResult> {
  let current: SystemVolumeState
  try {
    current = await getSystemVolume()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  savedStack.push(current)
  try {
    await setSystemVolume(100, false)
    return { ok: true }
  } catch (error) {
    // A failed write drops the entry so a later restore can't resurrect a
    // stale pre-max level.
    savedStack.pop()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Pop one saved level and put it back; no-op when nothing was maxed. */
async function restoreOneVolume(): Promise<VolumeResult> {
  const prev = savedStack.pop()
  if (!prev) return { ok: true }
  try {
    await setSystemVolume(prev.volume, prev.muted)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Drain the whole stack (quit path): best-effort, last saved wins. */
async function restoreAllVolume(): Promise<void> {
  while (savedStack.length > 0) {
    await restoreOneVolume()
  }
}

export function registerVolumeHandlers(): void {
  ipcMain.handle('alarm:maxVolume', () => maxOutVolume())
  ipcMain.handle('alarm:restoreVolume', () => restoreOneVolume())
  // Quitting mid-ring must not strand the OS at full blast.
  app.on('will-quit', () => {
    void restoreAllVolume()
  })
}
