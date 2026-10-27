import type { GithubStatus } from '../preload/github'
import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import { promisify } from 'util'
import { getVaultRoot } from './vault'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT = 120000
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

/** Run a command without a shell (no injection via args) and return stdout. */
async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: COMMAND_TIMEOUT })
    return stdout.trim()
  } catch (error) {
    const err = error as { stderr?: unknown; stdout?: unknown; message?: unknown }
    const detail = String(err.stderr ?? err.stdout ?? err.message ?? error).trim()
    throw new Error(detail || `${cmd} failed`)
  }
}

async function commandExists(cmd: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, ['--version'], { cwd, timeout: 15000 })
    return true
  } catch {
    return false
  }
}

async function isRepo(root: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: root, timeout: 15000 })
    return true
  } catch {
    return false
  }
}

async function hasCommits(root: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, timeout: 15000 })
    return true
  } catch {
    return false
  }
}

async function getRemote(root: string): Promise<string | null> {
  try {
    return await run('git', ['remote', 'get-url', 'origin'], root)
  } catch {
    return null
  }
}

export async function githubStatus(): Promise<GithubStatus> {
  const root = await getVaultRoot()
  const ghInstalled = await commandExists('gh', root)

  let authed = false
  let user: string | null = null
  if (ghInstalled) {
    try {
      await execFileAsync('gh', ['auth', 'status'], { cwd: root, timeout: 15000 })
      authed = true
      user = await run('gh', ['api', 'user', '--jq', '.login'], root)
    } catch {
      authed = false
      user = null
    }
  }

  const repo = await isRepo(root)
  const remoteUrl = repo ? await getRemote(root) : null

  let repoUrl: string | null = null
  if (ghInstalled && authed && remoteUrl) {
    try {
      repoUrl = await run('gh', ['repo', 'view', '--json', 'url', '--jq', '.url'], root)
    } catch {
      repoUrl = null
    }
  }

  let branch: string | null = null
  let clean = true
  if (repo) {
    try {
      branch = (await run('git', ['branch', '--show-current'], root)) || null
      clean = (await run('git', ['status', '--porcelain'], root)).length === 0
    } catch {
      // Leave defaults; status stays best-effort.
    }
  }

  return { ghInstalled, authed, user, isRepo: repo, remoteUrl, repoUrl, branch, clean }
}

/** Commits needs a name/email; borrow the GitHub identity locally if unset. */
async function ensureIdentity(root: string): Promise<void> {
  let name = ''
  try {
    name = await run('git', ['config', 'user.name'], root)
  } catch {
    name = ''
  }
  if (name) return
  const login = await run('gh', ['api', 'user', '--jq', '.login'], root)
  await run('git', ['config', 'user.name', login], root)
  await run('git', ['config', 'user.email', `${login}@users.noreply.github.com`], root)
}

/** Stage everything and commit. Returns false when there was nothing to do. */
async function commitAll(root: string, message: string): Promise<boolean> {
  await run('git', ['add', '-A'], root)
  const porcelain = await run('git', ['status', '--porcelain'], root)
  if (porcelain.length === 0 && (await hasCommits(root))) return false
  await run('git', ['commit', '--allow-empty', '-m', message], root)
  return true
}

export async function createRepo(
  name: string,
  isPrivate: boolean
): Promise<{ repoUrl: string; remoteUrl: string }> {
  if (!NAME_RE.test(name)) {
    throw new Error('Repo name may only contain letters, numbers, ., _ and - (max 100 chars).')
  }
  const root = await getVaultRoot()

  if (!(await commandExists('gh', root))) {
    throw new Error(
      'GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then retry.'
    )
  }
  try {
    await execFileAsync('gh', ['auth', 'status'], { cwd: root, timeout: 15000 })
  } catch {
    throw new Error('Not signed in to GitHub. Run `gh auth login` in a terminal, then retry.')
  }

  if (!(await isRepo(root))) {
    try {
      await run('git', ['init', '-b', 'main'], root)
    } catch {
      await run('git', ['init'], root)
    }
  }
  try {
    await run('git', ['branch', '-M', 'main'], root)
  } catch {
    // Ancient git or an unusual state; the explicit push below still works.
  }

  await ensureIdentity(root)
  await commitAll(root, 'Back up Lupinus notes')

  if (!(await getRemote(root))) {
    await run(
      'gh',
      [
        'repo',
        'create',
        name,
        isPrivate ? '--private' : '--public',
        '--source',
        '.',
        '--remote',
        'origin'
      ],
      root
    )
  }

  await run('git', ['push', '-u', 'origin', 'main'], root)

  let repoUrl: string | null = null
  try {
    repoUrl = await run('gh', ['repo', 'view', '--json', 'url', '--jq', '.url'], root)
  } catch {
    repoUrl = null
  }
  const remoteUrl = (await getRemote(root)) ?? ''
  return { repoUrl: repoUrl ?? remoteUrl, remoteUrl }
}

export async function syncNotes(message?: string): Promise<{ pushed: boolean; detail: string }> {
  const root = await getVaultRoot()
  if (!(await isRepo(root))) {
    throw new Error('This vault is not a git repo yet. Create the GitHub repo first.')
  }
  if (!(await getRemote(root))) {
    throw new Error('No `origin` remote. Create the GitHub repo first.')
  }
  const committed = await commitAll(
    root,
    message?.trim() || `Sync notes ${new Date().toISOString()}`
  )
  if (!committed) return { pushed: false, detail: 'Already up to date.' }
  try {
    await run('git', ['push'], root)
  } catch {
    await run('git', ['push', '-u', 'origin', 'main'], root)
  }
  return { pushed: true, detail: 'Notes pushed to GitHub.' }
}

/**
 * Permanently delete the linked GitHub repo and unlink the vault.
 * Local files and local git history are kept; only the remote is destroyed.
 */
export async function disconnectRepo(): Promise<{ deleted: string }> {
  const root = await getVaultRoot()
  if (!(await commandExists('gh', root))) {
    throw new Error(
      'GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then retry.'
    )
  }
  try {
    await execFileAsync('gh', ['auth', 'status'], { cwd: root, timeout: 15000 })
  } catch {
    throw new Error('Not signed in to GitHub. Run `gh auth login` in a terminal, then retry.')
  }
  if (!(await getRemote(root))) {
    throw new Error('No linked repo to disconnect.')
  }
  const nameWithOwner = await run(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    root
  )
  if (!nameWithOwner) throw new Error('Could not determine the linked repo.')
  await run('gh', ['repo', 'delete', nameWithOwner, '--yes'], root)
  try {
    await run('git', ['remote', 'remove', 'origin'], root)
  } catch {
    // Remote is gone server-side; a stale local ref is harmless.
  }
  return { deleted: nameWithOwner }
}

export function registerGithubHandlers(): void {
  ipcMain.handle('github:status', () => githubStatus())
  ipcMain.handle('github:create', (_event, name: unknown, isPrivate: unknown) => {
    if (typeof name !== 'string') throw new Error('Repo name must be a string.')
    return createRepo(name, isPrivate !== false)
  })
  ipcMain.handle('github:sync', (_event, message: unknown) =>
    syncNotes(typeof message === 'string' ? message : undefined)
  )
  ipcMain.handle('github:disconnect', () => disconnectRepo())
}
