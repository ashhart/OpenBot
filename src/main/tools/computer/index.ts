/**
 * Provider resolution for computer use.
 *
 * A bot drives this Mac, its own browser, or its own VM. All three satisfy
 * `ComputerProvider`, so every tool handler is target-agnostic. Instances are
 * cached per target because providers hold the coordinate space of their last
 * screenshot — and, for a browser, a running Chrome process.
 */

import type { ComputerProvider, ComputerTarget } from '../../../shared/types'
import { browserFor } from './browser'
import { LocalComputerProvider } from './localProvider'
import { VmComputerProvider } from './vmProvider'
import { vmToken } from '../../store/vmSecrets'

export { LocalComputerProvider } from './localProvider'
export { VmComputerProvider } from './vmProvider'
export {
  BrowserComputerProvider,
  browserFor,
  getBrowser,
  listBrowsers,
  removeBrowser,
  stopAllBrowsers,
  APP_CATALOG
} from './browser'

const providers = new Map<string, ComputerProvider>()

export const LOCAL_TARGET: ComputerTarget = { kind: 'local' }

export interface ProviderOptions {
  /**
   * Root for durable per-target state — Electron's `app.getPath('userData')`, or
   * `OPENBOT_DATA_DIR`. A browser's profile lives under it. Derived at runtime
   * when omitted.
   */
  dataDir?: string
  /** Owning bot, used for credentials and targeted lifecycle cleanup. */
  botId?: string
}

function keyOf(target: ComputerTarget, botId = ''): string {
  switch (target.kind) {
    case 'local':
      return 'local'
    case 'browser':
      return `browser:${target.botId}`
    case 'vm':
      return `vm:${botId}:${target.vmId}:${target.endpoint}`
  }
}

/** The provider for a target, created once and reused. Defaults to this Mac. */
export function getComputerProvider(
  target: ComputerTarget = LOCAL_TARGET,
  options: ProviderOptions = {}
): ComputerProvider {
  const key = keyOf(target, options.botId)
  const existing = providers.get(key)
  if (existing) return existing

  // Keep direct tool calls on the same root as the store when the app uses its
  // portable/test data-directory override.
  const browserDataDir = options.dataDir ?? (process.env['OPENBOT_DATA_DIR'] || undefined)

  const created: ComputerProvider =
    target.kind === 'vm'
      ? new VmComputerProvider(target, { token: () => (options.botId ? vmToken(options.botId) : target.token) })
      : target.kind === 'browser'
        ? browserFor(target.botId, { userDataDir: browserDataDir })
        : new LocalComputerProvider()

  providers.set(key, created)
  return created
}

/** Drop cached providers (target reconfigured, VM restarted, tests). */
export function resetComputerProviders(): void {
  providers.clear()
}

/** Stop and forget every cached provider owned by one bot. */
export async function releaseComputerProvidersForBot(botId: string): Promise<void> {
  const prefixBrowser = `browser:${botId}`
  const prefixVm = `vm:${botId}:`
  const stopped = new Set<ComputerProvider>()
  for (const [key, provider] of [...providers]) {
    if (key !== prefixBrowser && !key.startsWith(prefixVm)) continue
    providers.delete(key)
    stopped.add(provider)
  }
  for (const provider of stopped) {
    const stop = (provider as ComputerProvider & { stop?: () => Promise<void> }).stop
    if (typeof stop === 'function') await stop.call(provider).catch(() => undefined)
  }
}

/** Human-readable target name for prompts and errors. */
export function describeTarget(target: ComputerTarget = LOCAL_TARGET): string {
  switch (target.kind) {
    case 'local':
      return 'this Mac'
    case 'browser':
      return `this bot's browser`
    case 'vm':
      return `VM ${target.vmId} (${target.endpoint})`
  }
}
