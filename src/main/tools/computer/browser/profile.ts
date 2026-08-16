/**
 * Where a bot's browser keeps its persistent state, and whether that state is
 * currently in use.
 *
 * The profile directory is the entire point of a browser target: the user signs
 * the bot into a service once, by typing the credentials into the live view
 * themselves, and the cookies in this directory keep it signed in on every
 * later run.
 *
 * Locations are always derived at runtime. The host passes Electron's
 * `app.getPath('userData')`; when it does not, the same platform convention is
 * rebuilt from the current user's home directory. No path is ever hardcoded.
 */

import { readlink, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ProfileLayout {
  /** `<userData>/computers/<botId>` */
  root: string
  /** Chrome's `--user-data-dir`. */
  profileDir: string
  /** Installed web apps for this bot's dock. */
  appsFile: string
}

/** Default userData location, matching what Electron would report. */
export function defaultUserDataDir(appName = 'OpenBOT'): string {
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', appName)
  if (process.platform === 'win32') return join(home, 'AppData', 'Roaming', appName)
  return join(process.env['XDG_CONFIG_HOME'] || join(home, '.config'), appName)
}

export function profileLayout(botId: string, userDataDir?: string): ProfileLayout {
  const safeId = botId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default'
  const root = join(userDataDir ?? defaultUserDataDir(), 'computers', safeId)
  return { root, profileDir: join(root, 'profile'), appsFile: join(root, 'apps.json') }
}

/** Delete one bot's entire browser state after its Chrome process has stopped. */
export async function deleteProfile(botId: string, userDataDir?: string): Promise<void> {
  const layout = profileLayout(botId, userDataDir)
  await rm(layout.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

export type ProfileLock =
  | { locked: false }
  /** Held by a live process — almost always another OpenBOT window or a crash-survivor. */
  | { locked: true; pid: number; stale: false }
  /** Left behind by a process that died; safe to clear. */
  | { locked: true; pid: number | undefined; stale: true }

/**
 * Chrome guards a profile with `SingletonLock`, a symlink whose target is
 * `<hostname>-<pid>`. A second Chrome on the same profile exits immediately, so
 * this is checked before launching in order to explain *why* rather than
 * reporting a bare startup failure.
 */
export async function inspectProfileLock(profileDir: string): Promise<ProfileLock> {
  const lockPath = join(profileDir, 'SingletonLock')
  let target: string
  try {
    target = await readlink(lockPath)
  } catch {
    // No symlink. A plain file may still be left over on some filesystems.
    try {
      await stat(lockPath)
      return { locked: true, pid: undefined, stale: true }
    } catch {
      return { locked: false }
    }
  }

  const pid = Number(target.split('-').pop())
  if (!Number.isInteger(pid) || pid <= 0) return { locked: true, pid: undefined, stale: true }
  return processAlive(pid) ? { locked: true, pid, stale: false } : { locked: true, pid, stale: true }
}

/** Remove a lock whose owner is gone. Never removes a live one. */
export async function clearStaleLock(profileDir: string): Promise<boolean> {
  const lock = await inspectProfileLock(profileDir)
  if (!lock.locked || !lock.stale) return false
  await rm(join(profileDir, 'SingletonLock'), { force: true })
  return true
}

/**
 * Chrome leaves `DevToolsActivePort` behind on exit. Reading a previous run's
 * file would hand us a dead port and we would connect to nothing, so it is
 * removed before launching: the only port we ever read is the one this launch
 * writes.
 */
export async function clearStalePortFile(profileDir: string): Promise<void> {
  await rm(join(profileDir, 'DevToolsActivePort'), { force: true })
}

export function portFilePath(profileDir: string): string {
  return join(profileDir, 'DevToolsActivePort')
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
