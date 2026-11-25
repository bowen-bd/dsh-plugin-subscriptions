import './css-hook.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DASHBOARD_PROVIDERS,
  LOCAL_PROVIDER,
  cacheSplitStats,
  isLocalProvider,
  unknownCacheTokens,
  type Translate,
} from '../src/client/usage-format.js'
import {
  initialUsageDashboardState,
  usageDashboardReducer,
  type ProviderFilter,
  type UsageDashboardState,
} from '../src/client/usage-dashboard-state.js'
import type { TrackedProvider } from '../src/usage/usage-schema.js'
import type {
  DashboardClearInfo,
  DashboardDailyBucket,
  DashboardProvider,
  TokenTotals,
  UsageDashboardResponse,
} from '../src/usage/usage-dashboard.js'
import { en } from '../src/client/locales.js'
import { UsageDashboardView } from '../src/client/UsageDashboard.js'
import { ClearUsageHistoryDialog } from '../src/client/ClearUsageHistoryDialog.js'

const t: Translate = (key, params) => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

const totals = (
  input: number, output: number, cacheRead: number, cacheWrite: number, cacheUnknown?: number,
): TokenTotals => ({
  totalTokens: input + output + cacheRead + cacheWrite,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  reasoningTokens: 0,
  ...(cacheUnknown === undefined || cacheUnknown <= 0 ? {} : { cacheUnknownPromptTokens: cacheUnknown }),
})

/** Local totals with a partial cache split: 600 of 1000 input tokens are unknown. */
const LOCAL_TOTALS = totals(1000, 200, 400, 100, 600)
const LOCAL_MODEL = 'DeepSeek Test Model'
const LOCAL_DAY: DashboardDailyBucket = {
  date: '2026-11-24',
  ...LOCAL_TOTALS,
  byProvider: { 'deepseek-local': LOCAL_TOTALS.totalTokens },
  byModel: [{ provider: 'deepseek-local', model: LOCAL_MODEL, ...LOCAL_TOTALS }],
}

const clearInfo = {
  codex: { provider: 'codex', accounts: 0, earlierHistory: false },
  claude: { provider: 'claude', accounts: 0, earlierHistory: false },
  grok: { provider: 'grok', accounts: 0, earlierHistory: false },
  antigravity: { provider: 'antigravity', accounts: 0, earlierHistory: false },
} satisfies Record<TrackedProvider, DashboardClearInfo>

function response(overrides: Partial<UsageDashboardResponse> = {}): UsageDashboardResponse {
  const provider = {
    provider: LOCAL_PROVIDER.id as DashboardProvider,
    totalTokens: LOCAL_TOTALS.totalTokens,
    accounts: [{
      key: 'deepseek-local:host',
      label: 'Example server',
      loggedIn: true,
      isDefault: true,
      totalTokens: LOCAL_TOTALS.totalTokens,
    }],
  }
  return {
    generatedAt: Date.UTC(2026, 10, 24, 12, 0, 0),
    range: '30d',
    filters: { provider: LOCAL_PROVIDER.id, account: 'all' },
    providers: [provider],
    summary: { ...LOCAL_TOTALS, activeModels: 1, activeDays: 1, activeAccounts: 1 },
    daily: [LOCAL_DAY],
    heatmap: [LOCAL_DAY],
    models: [{ provider: LOCAL_PROVIDER.id, model: LOCAL_MODEL, share: 1, ...LOCAL_TOTALS }],
    providerBreakdown: [{
      provider: LOCAL_PROVIDER.id,
      share: 1,
      activeModels: 1,
      activeAccounts: 1,
      ...LOCAL_TOTALS,
    }],
    activeWindows: [],
    quotaCycles: [],
    clearInfo,
    cleared: false,
    trackingStartedAt: Date.UTC(2026, 10, 1),
    errors: [],
    localUsage: { updatedAt: Date.UTC(2026, 10, 24, 11, 59, 0), incomplete: true },
    ...overrides,
  }
}

function stateOf(provider: ProviderFilter, payload: UsageDashboardResponse = response()): UsageDashboardState {
  return {
    phase: 'shown',
    request: { provider, account: 'all', range: '30d' },
    distributionMode: 'model',
    load: 1,
    response: payload,
    clearErrors: [],
  }
}

function render(provider: ProviderFilter, payload: UsageDashboardResponse = response()): string {
  return renderToStaticMarkup(createElement(UsageDashboardView, {
    state: stateOf(provider, { ...payload, filters: { ...payload.filters, provider } }),
    t,
    onAction: () => {},
    onOpenClear: () => {},
  }))
}

test('local provider metadata and palette keep the self-hosted row distinct', () => {
  assert.deepEqual(DASHBOARD_PROVIDERS.map(entry => entry.id), ['codex', 'claude', 'grok', 'antigravity', 'deepseek-local'])
  assert.equal(new Set(DASHBOARD_PROVIDERS.map(entry => entry.colorVar)).size, DASHBOARD_PROVIDERS.length)
  assert.equal(LOCAL_PROVIDER.name, 'Self-hosted DeepSeek')
  assert.ok(isLocalProvider('deepseek-local'))
  assert.ok(!isLocalProvider('all'))
  assert.ok(!isLocalProvider('codex'))
  assert.equal(unknownCacheTokens({}), 0)
  assert.equal(unknownCacheTokens({ cacheUnknownPromptTokens: 42 }), 42)
})

test('selecting the local provider renders its pill, synthetic account, and no quota section', () => {
  const html = render('deepseek-local')
  // Provider pill and badge.
  assert.ok(html.includes('Self-hosted DeepSeek'))
  assert.ok(html.includes(`title="${en.usageLocalProviderHint}"`))
  // The synthetic account is offered in the account selector.
  assert.ok(html.includes('Example server'))
  // No quota cycles for self-hosted usage.
  assert.ok(!html.includes(en.usageActiveWindowsTitle))

  const cloudHtml = render('all', response({ providers: [] }))
  assert.ok(cloudHtml.includes(en.usageActiveWindowsTitle))
})

test('cache split uses the full prompt denominator and bounds an ambiguous read share', () => {
  const overInput = cacheSplitStats({
    inputTokens: 100,
    cacheReadTokens: 700,
    cacheWriteTokens: 0,
    cacheUnknownPromptTokens: 400,
  })
  assert.equal(overInput.promptTokens, 800)
  assert.equal(overInput.knownPromptTokens, 400)
  assert.equal(overInput.unknownPromptTokens, 400)
  assert.equal(overInput.coverage, 0.5)
  assert.equal(overInput.metering, 'partial')
  // Unknown tokens leave the denominator instead of becoming misses: 700/400.
  assert.equal(overInput.hitRate, 1.75)
  assert.equal(overInput.knownReadMin, 300)
  assert.equal(overInput.knownReadMax, 400)

  const noKnownSplit = cacheSplitStats({
    inputTokens: 100,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    cacheUnknownPromptTokens: 1000,
  })
  assert.equal(noKnownSplit.knownPromptTokens, 0)
  assert.equal(noKnownSplit.coverage, 0)
  assert.equal(noKnownSplit.metering, 'unknown')
  assert.equal(noKnownSplit.hitRate, null)

  const empty = cacheSplitStats({})
  assert.equal(empty.promptTokens, 0)
  assert.equal(empty.coverage, 1)
  assert.equal(empty.hitRate, 0)
  assert.equal(empty.metering, 'known')
})

test('a read share above 100% renders as a known-read range, never a bogus percentage', () => {
  const ambiguous = totals(100, 200, 700, 0, 400)
  const payload = response({
    summary: { ...ambiguous, activeModels: 1, activeDays: 1, activeAccounts: 1 },
  })
  const html = render('deepseek-local', payload)
  assert.ok(html.includes(t('usageKpiCacheHitKnownRange', { min: 75, max: 100 })))
  assert.ok(!html.includes('175%'))
  assert.ok(html.includes(t('usageKpiCacheCoverage', { percent: 50 })))
  assert.ok(html.includes(en.usageKpiCacheReadUpperBound))
  assert.ok(html.includes(t('usageKpiCacheUnknown', { count: 400 })))

  // All measured reads lie in the unknown share: the exact known contribution
  // is 100%, and it must not be rendered as a degenerate 100–100% range.
  const exactReads = totals(0, 100, 700, 0, 500)
  const exactHtml = render('deepseek-local', response({
    summary: { ...exactReads, activeModels: 1, activeDays: 1, activeAccounts: 1 },
  }))
  assert.ok(exactHtml.includes(t('usageKpiCacheHitKnown', { percent: 100 })))
  assert.ok(!exactHtml.includes('100–100%'))
})

test('an entirely unknown cache split has no hit rate instead of a zero rate', () => {
  const allUnknown = totals(1000, 100, 0, 0, 1000)
  const payload = response({
    summary: { ...allUnknown, activeModels: 1, activeDays: 1, activeAccounts: 1 },
  })
  const html = render('deepseek-local', payload)
  assert.ok(html.includes(en.usageKpiCacheNoRate))
  assert.ok(html.includes(t('usageKpiCacheCoverage', { percent: 0 })))
  assert.ok(!html.includes(t('usageKpiCacheHit', { percent: 0 })))
  assert.ok(!html.includes(t('usageKpiCacheHitKnown', { percent: 0 })))
})

test('a partial local scan says so and never turns unknown cache tokens into misses', () => {
  const html = render('deepseek-local')
  assert.ok(html.includes(en.usageLocalIncomplete))
  assert.ok(html.includes('Local logs updated'))
  // Prompt = 1000 input + 400 read + 100 write; 600 are unknown, so the known
  // denominator is 900 and 400/900 rounds to a 44% read share over 60% coverage.
  assert.ok(html.includes(t('usageKpiCacheHitKnown', { percent: 44 })))
  assert.ok(html.includes(t('usageKpiCacheCoverage', { percent: 60 })))
  assert.ok(html.includes(t('usageKpiCacheUnknown', { count: 600 })))
  assert.ok(!html.includes(en.usageKpiCacheReadUpperBound))
  assert.ok(!html.includes(`${en.usageKpiCacheReadShort} 0 · ${en.usageKpiCacheWriteShort} 0`))
})

test('an unavailable local feed distinguishes last available totals from missing data', () => {
  const updatedAt = Date.UTC(2026, 10, 24, 11, 59, 0)
  const stale = response({ localUsage: { updatedAt, unavailable: true } })
  const html = render('all', stale)
  assert.ok(html.includes(en.usageLocalStale))
  assert.ok(html.includes(t('usageLocalUpdated', {
    time: new Date(updatedAt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  })))
  assert.ok(!html.includes(en.usageLocalUnavailable))
  assert.ok(!html.includes(en.usageLocalIncomplete))
  assert.ok(!html.includes(en.usageLocalOutdated))
  assert.ok(!render('codex', stale).includes(en.usageLocalStale))
  assert.ok(render('deepseek-local', response({ localUsage: { unavailable: true } })).includes(en.usageLocalUnavailable))
})

test('an outdated local snapshot is called out with its timestamp and stays scoped', () => {
  const updatedAt = Date.UTC(2026, 10, 24, 11, 59, 0)
  const time = new Date(updatedAt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const outdated = response({ localUsage: { updatedAt, incomplete: true, stale: true } })
  const html = render('all', outdated)
  assert.ok(html.includes(en.usageLocalOutdated))
  assert.ok(html.includes(en.usageLocalIncomplete))
  assert.ok(html.includes(t('usageLocalUpdated', { time })))
  assert.ok(!render('codex', outdated).includes(en.usageLocalOutdated))
  assert.ok(render('deepseek-local', outdated).includes(en.usageLocalOutdated))

  const fresh = response({ localUsage: { updatedAt, incomplete: true } })
  assert.ok(!render('all', fresh).includes(en.usageLocalOutdated))
})

test('a first local read failure hides the empty local pill but keeps its notice', () => {
  const firstRead = response({
    providers: [],
    summary: { ...totals(0, 0, 0, 0), activeModels: 0, activeDays: 0, activeAccounts: 0 },
    daily: [],
    heatmap: [],
    models: [],
    providerBreakdown: [],
    localUsage: { unavailable: true },
  })
  const html = render('all', firstRead)
  assert.ok(!html.includes(`title="${en.usageLocalProviderHint}"`))
  assert.ok(html.includes(en.usageLocalUnavailable))
  assert.ok(render('deepseek-local', firstRead).includes(`title="${en.usageLocalProviderHint}"`))

  // A previously stored snapshot keeps the pill visible even when the latest
  // scan failed and the provider row is empty.
  const withSnapshot = response({
    providers: [],
    localUsage: { updatedAt: Date.UTC(2026, 10, 24, 11, 59, 0), unavailable: true },
  })
  assert.ok(render('all', withSnapshot).includes(`title="${en.usageLocalProviderHint}"`))
})

test('cloud clear stays available and enabled while local clear is disabled', () => {
  const localHtml = render('deepseek-local')
  assert.ok(localHtml.includes('aria-haspopup="dialog" disabled=""'))
  assert.ok(localHtml.includes(en.usageClearLocalOnly))

  const cloudHtml = render('all', response({ providers: [] }))
  assert.ok(!cloudHtml.includes('aria-haspopup="dialog" disabled=""'))
  assert.ok(!cloudHtml.includes(en.usageClearLocalOnly))
})

test('clear dialog targets cloud providers only and names all as cloud when local is present', () => {
  const html = renderToStaticMarkup(createElement(ClearUsageHistoryDialog, {
    target: 'all',
    clearInfo,
    hasLocalUsage: true,
    state: { phase: 'open' },
    t,
    onTargetChange: () => {},
    onCancel: () => {},
    onConfirm: () => {},
  }))
  assert.ok(html.includes(en.usageClearAllCloudProviders))
  assert.ok(html.includes(en.usageClearLocalKept))
  assert.ok(!html.includes(`value="deepseek-local"`))
  assert.ok(!html.includes(`value="ALL"`))
})

test('heatmap waits for the selected scope and resets its day inspector only when scope changes', () => {
  const all = stateOf('all', response({ filters: { provider: 'all', account: 'all' } }))
  all.selectedDate = LOCAL_DAY.date
  const renderState = (state: UsageDashboardState) => renderToStaticMarkup(createElement(UsageDashboardView, {
    state, t, onAction: () => {}, onOpenClear: () => {},
  }))
  const allHtml = renderState(all)
  assert.match(allHtml, /All models · Last 26 weeks/)
  assert.doesNotMatch(allHtml, />Grok</)
  const switching = usageDashboardReducer(all, { type: 'provider', provider: 'codex' })
  assert.equal(switching.selectedDate, undefined)
  assert.doesNotMatch(renderState(switching), /Last 26 weeks/)
  const codex = usageDashboardReducer(switching, { type: 'loaded', response: response({
    filters: { provider: 'codex', account: 'all' },
    heatmap: [{ ...LOCAL_DAY, ...totals(0, 0, 0, 0), byProvider: {}, byModel: [] }],
  }) })
  assert.match(renderState(codex), /Codex · Last 26 weeks/)
  assert.equal(usageDashboardReducer(all, { type: 'range', range: '7d' }).selectedDate, LOCAL_DAY.date)
  assert.equal(usageDashboardReducer(all, { type: 'account', account: 'deepseek-local:host' }).selectedDate, undefined)
  const normalized = usageDashboardReducer(switching, { type: 'loaded', response: all.response! })
  assert.equal(normalized.request.provider, 'all')
  assert.match(renderState(normalized), /All models · Last 26 weeks/)
})

test('clear dialog omits providers excluded by the server', () => {
  const { grok: _hidden, ...visible } = clearInfo
  const html = renderToStaticMarkup(createElement(ClearUsageHistoryDialog, {
    target: 'all', clearInfo: visible, hasLocalUsage: true, state: { phase: 'open' }, t,
    onTargetChange: () => {}, onCancel: () => {}, onConfirm: () => {},
  }))
  assert.match(html, /value="codex"/)
  assert.doesNotMatch(html, /value="grok"/)
  assert.ok(html.includes(en.usageClearVisibleProviders))
})

test('the reducer accepts the local provider and resets the account filter', () => {
  const initial = initialUsageDashboardState()
  const selected = usageDashboardReducer(
    { ...initial, request: { provider: 'codex', account: 'codex:one', range: '30d' } },
    { type: 'provider', provider: 'deepseek-local' },
  )
  assert.equal(selected.request.provider, 'deepseek-local')
  assert.equal(selected.request.account, 'all')
  assert.equal(selected.load, 1)

  const accountSelected = usageDashboardReducer(selected, {
    type: 'providerAccount',
    provider: 'deepseek-local',
    account: 'deepseek-local:host',
  })
  assert.equal(accountSelected.request.account, 'deepseek-local:host')
})
