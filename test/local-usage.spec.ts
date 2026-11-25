import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUsageDashboard } from '../src/usage/usage-dashboard.js'
import { Config } from '../src/index.js'
import { createLocalUsageReader, LOCAL_USAGE_ACCOUNT, LOCAL_USAGE_STALE_MS, parseLocalUsage } from '../src/usage/local-usage.js'

const NOW = Date.UTC(2026, 10, 25, 8)
const today = {
  date: '2026-11-25', inputTokens: 100, outputTokens: 20,
  cacheReadTokens: 80, cacheWriteTokens: 3, reasoningTokens: 7, cacheUnknownPromptTokens: 50,
}
const older = { ...today, date: '2026-11-02', cacheUnknownPromptTokens: 0 }
const feed = { updatedAt: NOW - 30_000, days: [older, today] }

test('local feed is opt-in and only accepts a valid port', () => {
  assert.equal(Config({}).selfHostedUsage, undefined)
  assert.equal(Config({ selfHostedUsage: { port: 43210 } }).selfHostedUsage?.port, 43210)
  assert.equal(Config({ selfHostedUsage: null }).selfHostedUsage, null)
  for (const invalid of [{ port: 0 }, { port: 1.5 }, { port: 65536 }]) {
    assert.throws(() => Config({ selfHostedUsage: invalid }))
  }
  const dashboard = buildUsageDashboard({ now: NOW, trackingStartedAt: NOW - 900_000, providers: [] }, { provider: 'deepseek-local' })
  assert.equal(dashboard.localUsage, undefined)
  assert.equal(dashboard.filters.provider, 'all')
  assert.ok(dashboard.providers.every(row => row.provider !== 'deepseek-local'))
})

test('local feed validation rejects ambiguous dates and inconsistent accounting', () => {
  assert.deepEqual(parseLocalUsage(feed, NOW), feed)
  const allPromptUnknown = { ...feed, days: [{ ...today, cacheUnknownPromptTokens: 183 }] }
  assert.deepEqual(parseLocalUsage(allPromptUnknown, NOW), allPromptUnknown)
  for (const bad of [
    { ...feed, updatedAt: NOW + 100_000 },
    { ...feed, days: [today, today] },
    { ...feed, days: [{ ...today, date: '2026-10-32' }] },
    { ...feed, days: [{ ...today, date: '2026-11-26' }] },
    { ...feed, days: [{ ...today, cacheUnknownPromptTokens: 184 }] },
    { ...feed, days: [{ ...today, reasoningTokens: 21 }] },
    { ...feed, days: [{ ...today, inputTokens: -1 }] },
  ]) assert.throws(() => parseLocalUsage(bad, NOW))
})

test('local feed coalesces, caches briefly, and retains measured data after failure', async () => {
  let calls = 0
  let now = NOW
  const read = createLocalUsageReader({ port: 43210 }, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:43210/api/subscriptions-usage')
    assert.equal(init?.redirect, 'error')
    ++calls
    if (calls === 1) return new Response(null, { status: 503 })
    if (calls === 2) return Response.json({ ...feed, incomplete: true })
    return Response.json({ unknown: 'schema' })
  }, () => now)
  assert.deepEqual(await read(), { days: [], unavailable: true })
  now += 5_001
  const [first, second] = await Promise.all([read(), read()])
  assert.deepEqual(first, { ...feed, incomplete: true })
  assert.equal(first, second)
  assert.equal(first, await read())
  assert.equal(calls, 2)
  now += 5_001
  assert.deepEqual(await read(), { ...feed, incomplete: true, unavailable: true })
  assert.equal(calls, 3)
})

test('the dashboard uses labels from host configuration, not from the feed', async () => {
  const read = createLocalUsageReader({ port: 43210, model: ' Example model ', accountLabel: ' Local GPU ' },
    async () => Response.json({ ...feed, model: 'feed model', accountLabel: 'feed account' }), () => NOW)
  const dashboard = buildUsageDashboard({ now: NOW, trackingStartedAt: NOW - 900_000, providers: [], localUsage: await read() },
    { provider: 'deepseek-local' })
  assert.deepEqual(dashboard.models.map(row => row.model), ['Example model'])
  assert.equal(dashboard.providers.find(row => row.provider === 'deepseek-local')?.accounts[0]?.label, 'Local GPU')
})

test('a reachable feed with a stalled scan is surfaced without discarding its totals', () => {
  const base = { now: NOW, trackingStartedAt: NOW - 900_000, providers: [], localUsage: feed }
  const query = { provider: 'deepseek-local', range: 'all' } as const
  const fresh = buildUsageDashboard(base, query)
  assert.deepEqual(fresh.localUsage, { updatedAt: feed.updatedAt })
  const stale = buildUsageDashboard({ ...base, now: feed.updatedAt + LOCAL_USAGE_STALE_MS }, query)
  assert.deepEqual(stale.localUsage, { updatedAt: feed.updatedAt, stale: true })
  assert.deepEqual(stale.summary, fresh.summary)
})

test('local rows are additive, scoped, and entirely outside subscription clear and quota', () => {
  const codex = {
    provider: 'codex' as const,
    entries: [{
      v: 1 as const, id: 'codex-weekly', provider: 'codex' as const, account: 'c',
      kind: 'weekly' as const, status: 'open' as const, startSource: 'nominal' as const,
      countedFrom: NOW - 900_000, models: { 'gpt-test': today },
      days: { [today.date]: { 'gpt-test': today } },
    }],
    loggedIn: [{ key: 'c' }], observed: () => [], preTracking: { state: 'unavailable' as const }, errors: [],
  }
  const base = { now: NOW, trackingStartedAt: NOW - 900_000, providers: [codex] }
  const input = { ...base, localUsage: { ...feed, incomplete: true } }
  const all = buildUsageDashboard(input, { range: 'all' })
  assert.equal(all.summary.totalTokens, 609)
  assert.equal(all.summary.cacheUnknownPromptTokens, 50)
  assert.equal(all.summary.reasoningTokens, 21)
  assert.equal(all.summary.activeAccounts, 2)
  assert.deepEqual(all.localUsage, { updatedAt: feed.updatedAt, incomplete: true })
  assert.ok(all.quotaCycles.every(row => row.provider === 'codex'))
  assert.equal(Object.hasOwn(all.clearInfo, 'deepseek-local'), false)
  const local = buildUsageDashboard(input, { range: '7d', provider: 'deepseek-local' })
  assert.equal(local.summary.totalTokens, 203)
  assert.deepEqual(local.models.map(row => row.model), ['Self-hosted DeepSeek'])
  assert.equal(local.daily.at(-1)?.byProvider['deepseek-local'], 203)
  assert.ok(local.heatmap.some(row => row.date === older.date && row.totalTokens === 203))
  assert.deepEqual(local.quotaCycles, [])
  assert.deepEqual(local.activeWindows, [])
  const byAccount = buildUsageDashboard(input, { range: 'all', account: LOCAL_USAGE_ACCOUNT })
  assert.equal(byAccount.summary.totalTokens, 406)
  assert.deepEqual(byAccount.errors, [])
  assert.deepEqual(byAccount.quotaCycles, [])
  const afterClear = buildUsageDashboard({ ...input, providers: [{ ...codex, clearedAt: NOW }] }, { range: 'all' })
  assert.equal(afterClear.summary.totalTokens, 406)
  assert.equal(afterClear.cleared, false)
  const cloud = buildUsageDashboard(input, { range: '7d', provider: 'codex' })
  assert.deepEqual(cloud.summary, buildUsageDashboard(base, { range: '7d', provider: 'codex' }).summary)
})
