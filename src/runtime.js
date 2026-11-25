/**
 * Zero-configuration token persistence and runtime discovery for local clients.
 *
 * When `dsh Desktop` boots, it binds an OS-assigned loopback port that changes
 * on every restart. Rather than asking the user to hand-edit `webserver` port
 * overrides and copy random tokens into every MCP client:
 *
 * - when no explicit token is supplied (and `autoToken` is enabled), this
 *   plugin generates a 32-byte random token once and persists it under
 *   `<DSH_HOME>/antidsh-token` (mode 0600);
 * - when `publishRuntimeFile` is enabled, this plugin atomically writes the
 *   bound endpoint URL, token, and PID to `<DSH_HOME>/antidsh-runtime.json`
 *   (mode 0600) and cleans it up on disposal only if it still owns the file.
 *
 * Everything uses Node built-ins only so the plugin remains dependency-free.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const TOKEN_FILE_NAME = 'antidsh-token'
export const RUNTIME_FILE_NAME = 'antidsh-runtime.json'

/**
 * Resolve the active DSH home directory (`$DSH_HOME` or `~/.dsh`).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/**
 * Resolve the path to the persisted auto-generated Bearer token file.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function tokenFilePath(env = process.env) {
  return join(resolveDshHome(env), TOKEN_FILE_NAME)
}

/**
 * Resolve the path to the live runtime discovery file.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function runtimeFilePath(env = process.env) {
  const override = typeof env?.ANTIDSH_RUNTIME_FILE === 'string' ? env.ANTIDSH_RUNTIME_FILE.trim() : ''
  return override.length > 0 ? override : join(resolveDshHome(env), RUNTIME_FILE_NAME)
}

/**
 * Load an existing auto-generated token from disk, or generate and persist a
 * new 32-byte base64url token atomically.
 *
 * @param {{ filePath?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ token: string, filePath: string, created: boolean }}
 */
export function loadOrCreateAutoToken(options = {}) {
  const filePath = options.filePath ?? tokenFilePath(options.env)
  try {
    const existing = readFileSync(filePath, 'utf8').trim()
    if (existing.length > 0) {
      return { token: existing, filePath, created: false }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const token = randomBytes(32).toString('base64url')
  writeFileAtomic(filePath, `${token}\n`)
  return { token, filePath, created: true }
}

/**
 * Publish the live MCP endpoint metadata to disk for zero-config local bridges.
 *
 * Returns a disposer that removes the file only if it still points to this
 * process and endpoint URL, so a newer dsh instance's discovery record is
 * never clobbered during restart or HMR teardown.
 *
 * @param {{
 *   origin: string,
 *   path: string,
 *   token: string | null,
 *   auth: 'bearer' | 'unauthenticated-loopback' | 'unconfigured',
 *   pid?: number,
 *   filePath?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} options
 * @returns {{ filePath: string, payload: Record<string, unknown>, dispose: () => void }}
 */
export function publishRuntimeDiscovery(options) {
  const filePath = options.filePath ?? runtimeFilePath(options.env)
  const pid = options.pid ?? process.pid
  const url = `${options.origin}${options.path}`
  const payload = {
    version: 1,
    url,
    origin: options.origin,
    path: options.path,
    token: options.token,
    auth: options.auth,
    pid,
    updatedAt: new Date().toISOString(),
  }

  writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`)

  const dispose = () => {
    try {
      const current = JSON.parse(readFileSync(filePath, 'utf8'))
      if (current?.pid === pid && current?.url === url) {
        rmSync(filePath, { force: true })
      }
    } catch {
      // File already removed, replaced, or unreadable — nothing to clean up.
    }
  }

  return { filePath, payload, dispose }
}

/**
 * Write UTF-8 text atomically via a same-directory temp file with restrictive
 * permissions (`0600` on POSIX; inherited user profile ACL on Windows).
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function writeFileAtomic(filePath, content) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw error
  }
}
