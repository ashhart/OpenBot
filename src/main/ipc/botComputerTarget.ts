/**
 * A bot's computer target: validating one that arrived from the renderer, and
 * finding out whether it is actually usable.
 *
 * Both halves are the border between an untrusted argument and a real endpoint,
 * so they live together and are the only way the bot channels reach a VM:
 * `asComputerTarget` decides what shape may be stored at all, and `probeTarget`
 * is what the rest of the app treats as proof that a VM is isolated and ready.
 */

import type { ComputerProbeResult, ComputerTarget } from '../../shared/types'
import { dataRoot } from '../store/paths'
import { vmToken } from '../store/vmSecrets'
import { getComputerProvider } from '../tools/computer'
import { VmComputerProvider } from '../tools/computer/vmProvider'
import {
  destroyAppleVm,
  provisionalAppleVmToken,
  startAppleVm
} from '../vm/appleVmSupervisor'
import { asString } from './validate'

export function asComputerTarget(value: unknown): ComputerTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('expected a computer target')
  }
  const target = value as Record<string, unknown>
  if (target['kind'] === 'local') return { kind: 'local' }
  if (target['kind'] === 'browser') {
    return { kind: 'browser', botId: asString(target['botId'], 128).trim() }
  }
  if (target['kind'] !== 'vm') throw new TypeError('unknown computer target')
  const vmId = asString(target['vmId'], 128).trim()
  const endpoint = asString(target['endpoint'], 2048).trim()
  if (!vmId || !endpoint) throw new TypeError('a VM id and endpoint are required')
  const token = target['token'] === undefined ? undefined : asString(target['token'], 4096)
  const capabilities = Array.isArray(target['capabilities'])
    ? target['capabilities']
        .filter((entry): entry is string => typeof entry === 'string' && entry.length <= 100)
        .slice(0, 32)
    : undefined
  return {
    kind: 'vm',
    vmId,
    endpoint,
    ...(token !== undefined ? { token } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(target['managed'] === 'apple-vm' ? { managed: 'apple-vm' as const } : {})
  }
}

export async function probeTarget(
  target: ComputerTarget,
  botId?: string,
  signal?: AbortSignal
): Promise<ComputerProbeResult> {
  if (target.kind === 'local') {
    return { ok: true, detail: 'This Mac is selected.', isolatedExecution: true }
  }
  if (target.kind === 'browser') {
    return getComputerProvider(target, { botId, dataDir: dataRoot() }).probe(signal)
  }
  const controlToken = (): string | undefined =>
    target.token?.trim() ||
    (target.managed === 'apple-vm' ? provisionalAppleVmToken(target.vmId) : undefined) ||
    (botId ? vmToken(botId) : undefined)
  if (!controlToken()) {
    return {
      ok: false,
      detail: 'A per-VM control token is required. OpenBOT will store it in the OS credential store.'
    }
  }
  if (target.managed === 'apple-vm') {
    try {
      await startAppleVm(target, signal, controlToken())
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }
  const provider = new VmComputerProvider(target, {
    token: controlToken
  })
  const deadline = Date.now() + (target.managed === 'apple-vm' ? 45_000 : 0)
  do {
    const result = await provider.probe(signal)
    const managedReady =
      target.managed !== 'apple-vm' ||
      (result.isolatedExecution === true && result.capabilities?.includes('computer-v1') === true)
    if (result.ok && managedReady) return result
    if (signal?.aborted) return { ok: false, detail: 'VM readiness check cancelled.' }
    if (Date.now() >= deadline) {
      return {
        ...result,
        ok: false,
        detail: `${result.detail ?? 'The managed VM did not become ready.'}\nA managed VM requires isolated files/processes and its Linux desktop.`
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (true)
}

export async function destroyVm(
  botId: string,
  target: Extract<ComputerTarget, { kind: 'vm' }>
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('VM cleanup timed out', 'TimeoutError')),
    target.managed === 'apple-vm' ? 60_000 : 5_000
  )
  try {
    if (target.managed === 'apple-vm') await destroyAppleVm(target, controller.signal)
    else await new VmComputerProvider(target, { token: () => vmToken(botId) }).destroy(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
