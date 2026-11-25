import type { TokenCounts } from './window-tracker.js'

export const LOCAL_USAGE_PROVIDER = 'deepseek-local'
export const LOCAL_USAGE_ACCOUNT = 'deepseek-local:host'
export const DEFAULT_LOCAL_USAGE_MODEL = 'Self-hosted DeepSeek'
export const DEFAULT_LOCAL_USAGE_ACCOUNT_LABEL = 'Local server'

const READ_TTL_MS = 5_000
const READ_TIMEOUT_MS = 2_000
export const LOCAL_USAGE_STALE_MS = 3 * 60_000

export interface LocalUsageConfig {
  port: number
  model?: string
  accountLabel?: string
}

export interface LocalUsageDay extends TokenCounts {
  date: string
  cacheUnknownPromptTokens: number
}

export interface LocalUsageStatus {
  updatedAt?: number
  unavailable?: boolean
  incomplete?: boolean
  stale?: boolean
}

export interface LocalUsageSnapshot extends Omit<LocalUsageStatus, 'stale'> {
  days: readonly LocalUsageDay[]
  // These labels come from the host config, never from the feed.
  model?: string
  accountLabel?: string
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid local usage object')
  return value as Record<string, unknown>
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid local usage count')
  return value
}

export function parseLocalUsage(value: unknown, now: number): LocalUsageSnapshot {
  const feed = object(value)
  const updatedAt = count(feed.updatedAt)
  if (updatedAt <= 0 || updatedAt > now + 5_000 || !Array.isArray(feed.days) || feed.days.length > 10_000
    || (feed.incomplete !== undefined && typeof feed.incomplete !== 'boolean')) throw new Error('invalid local usage feed')
  const maxDay = new Date(updatedAt).toISOString().slice(0, 10)
  const seen = new Set<string>()
  const days = feed.days.map(value => {
    const row = object(value)
    const { date } = row
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '2000-01-01'
      || date > maxDay || seen.has(date)) throw new Error('invalid local usage day')
    const when = Date.parse(`${date}T00:00:00Z`)
    if (!Number.isFinite(when) || new Date(when).toISOString().slice(0, 10) !== date) throw new Error('invalid local usage day')
    seen.add(date)
    const inputTokens = count(row.inputTokens)
    const outputTokens = count(row.outputTokens)
    const cacheReadTokens = count(row.cacheReadTokens)
    const cacheWriteTokens = count(row.cacheWriteTokens)
    const reasoningTokens = count(row.reasoningTokens)
    const cacheUnknownPromptTokens = count(row.cacheUnknownPromptTokens)
    const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
    if (cacheUnknownPromptTokens > promptTokens || reasoningTokens > outputTokens
      || !Number.isSafeInteger(promptTokens + outputTokens)) {
      throw new Error('inconsistent local usage counts')
    }
    return { date, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, cacheUnknownPromptTokens }
  })
  return { updatedAt, days, ...(feed.incomplete === true ? { incomplete: true } : {}) }
}

/** Coalesce simultaneous dashboard reads and show the last valid snapshot if the feed fails. */
export function createLocalUsageReader(config: LocalUsageConfig, request: typeof fetch = fetch, now: () => number = Date.now): () => Promise<LocalUsageSnapshot> {
  const { port, model, accountLabel } = config
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid local usage port')
  const labels = {
    ...(model?.trim() ? { model: model.trim() } : {}),
    ...(accountLabel?.trim() ? { accountLabel: accountLabel.trim() } : {}),
  }
  // Only the port is configurable by the host. No URL from the configuration,
  // a client request, or a session record can change the origin or path.
  const feedUrl = `http://127.0.0.1:${port}/api/subscriptions-usage`
  let last: LocalUsageSnapshot = { days: [], ...labels }
  let cached: LocalUsageSnapshot = last
  let expires = 0
  let pending: Promise<LocalUsageSnapshot> | undefined
  return async () => {
    if (pending !== undefined) return pending
    if (now() < expires) return cached
    pending = (async () => {
      try {
        const response = await request(feedUrl, { redirect: 'error', signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
        if (!response.ok) throw new Error('local usage feed unavailable')
        last = { ...parseLocalUsage(await response.json(), now()), ...labels }
        return last
      } catch {
        // Do not report a failed read of the source as zero usage or reset its observation time.
        return { ...last, unavailable: true }
      }
    })()
    try {
      cached = await pending
      expires = now() + READ_TTL_MS
      return cached
    } finally {
      pending = undefined
    }
  }
}
