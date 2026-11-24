/**
 * Argument validation shared by the five MCP tools.
 *
 * MCP clients are external processes, so everything crossing this boundary is
 * treated as untrusted input. Validation failures are reported as JSON-RPC
 * `-32602` errors (the call itself was malformed) rather than as tool errors.
 * A rejected argument never reaches `ctx.sessionController`.
 */

import { isAbsolute, win32 } from 'node:path'

import { McpError, RpcErrorCode, isObject } from '../protocol.js'

/** A signal that is never aborted, for direct tool calls outside HTTP. */
const NEVER_ABORTED = new AbortController().signal

/**
 * @param {{ signal?: AbortSignal } | undefined} context
 * @returns {AbortSignal}
 */
export function signalOf(context) {
  return context?.signal ?? NEVER_ABORTED
}

/**
 * @param {string} message
 * @returns {McpError}
 */
export function invalidArgument(message) {
  return new McpError(RpcErrorCode.INVALID_PARAMS, `Invalid arguments: ${message}`)
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function argumentsOf(value) {
  if (!isObject(value)) throw invalidArgument('tool arguments must be an object')
  return value
}

/**
 * Reject misspelled or unsupported keys instead of silently ignoring them.
 *
 * @param {Record<string, unknown>} args
 * @param {readonly string[]} allowed
 * @returns {void}
 */
export function assertAllowedKeys(args, allowed) {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw invalidArgument(`unknown argument(s): ${unknown.join(', ')}`)
  }
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @param {{ required?: boolean, minLength?: number, maxLength?: number, allowEmpty?: boolean }} [options]
 * @returns {string | undefined}
 */
export function readString(args, name, options = {}) {
  const value = args[name]
  if (value === undefined || value === null) {
    if (options.required === true) throw invalidArgument(`"${name}" is required`)
    return undefined
  }
  if (typeof value !== 'string') throw invalidArgument(`"${name}" must be a string`)
  const trimmed = value.trim()
  const minLength = options.minLength ?? (options.allowEmpty === true ? 0 : 1)
  if (trimmed.length < minLength) throw invalidArgument(`"${name}" must be a non-empty string`)
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw invalidArgument(`"${name}" is longer than ${String(options.maxLength)} characters`)
  }
  return trimmed
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @param {{ required?: boolean, minLength?: number, maxLength?: number, allowEmpty?: boolean }} [options]
 * @returns {string | undefined}
 */
export function readOptionalString(args, name, options = {}) {
  return readString(args, name, { ...options, required: false })
}

/**
 * Read a non-blank prompt while preserving its internal whitespace and
 * line breaks; only the surrounding whitespace is trimmed.
 *
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @param {{ required?: boolean, maxLength?: number }} [options]
 * @returns {string | undefined}
 */
export function readText(args, name, options = {}) {
  return readString(args, name, {
    required: options.required,
    maxLength: options.maxLength ?? 200_000,
  })
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @param {{ defaultValue?: number, min?: number, max?: number, required?: boolean }} [options]
 * @returns {number | undefined}
 */
export function readInteger(args, name, options = {}) {
  const value = args[name]
  if (value === undefined || value === null) {
    if (options.required === true) throw invalidArgument(`"${name}" is required`)
    return options.defaultValue
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalidArgument(`"${name}" must be an integer`)
  }
  if (options.min !== undefined && value < options.min) {
    throw invalidArgument(`"${name}" must be at least ${String(options.min)}`)
  }
  if (options.max !== undefined && value > options.max) {
    throw invalidArgument(`"${name}" must be at most ${String(options.max)}`)
  }
  return value
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @param {readonly string[]} values
 * @param {{ defaultValue?: string, required?: boolean }} [options]
 * @returns {string | undefined}
 */
export function readEnum(args, name, values, options = {}) {
  const value = args[name]
  if (value === undefined || value === null) {
    if (options.required === true) throw invalidArgument(`"${name}" is required`)
    return options.defaultValue
  }
  if (typeof value !== 'string' || !values.includes(value)) {
    throw invalidArgument(`"${name}" must be one of: ${values.join(', ')}`)
  }
  return value
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @param {boolean} [defaultValue]
 * @returns {boolean}
 */
export function readBoolean(args, name, defaultValue = false) {
  const value = args[name]
  if (value === undefined || value === null) return defaultValue
  if (typeof value !== 'boolean') throw invalidArgument(`"${name}" must be a boolean`)
  return value
}

/**
 * Ensure a path is relative to the session working directory and cannot walk
 * upward. The returned form uses `/` separators so git receives one spelling
 * of the path on every platform.
 *
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @returns {string | undefined}
 */
export function readRelativePath(args, name) {
  const raw = readString(args, name, { maxLength: 4096 })
  if (raw === undefined) return undefined
  if (raw.includes('\0')) throw invalidArgument(`"${name}" must not contain NUL bytes`)
  const normalized = raw.replaceAll('\\', '/')
  if (isAbsolute(raw) || win32.isAbsolute(raw)) {
    throw invalidArgument(`"${name}" must be relative to the session working directory`)
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw invalidArgument(`"${name}" must be relative to the session working directory`)
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) throw invalidArgument(`"${name}" must name a file`)
  if (segments.includes('..')) {
    throw invalidArgument(`"${name}" must not contain ".." path segments`)
  }
  return segments.join('/')
}
