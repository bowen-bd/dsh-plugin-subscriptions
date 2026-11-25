import { useEffect, useReducer, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClearResult } from '../usage/service.js'
import type { DashboardProvider, DashboardRange, UsageDashboardResponse } from '../usage/usage-dashboard.js'
import { en, type SubscriptionsKey } from './locales.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { usageDashboardCss } from './usage-dashboard-styles.js'
import {
  CLEAR_CONFIRM_OPEN,
  clearConfirmReducer,
  initialUsageDashboardState,
  usageDashboardReducer,
  type ClearConfirmState,
  type ClearTarget,
  type UsageDashboardAction,
  type UsageDashboardState,
} from './usage-dashboard-state.js'
import {
  DASHBOARD_PROVIDERS,
  LOCAL_PROVIDER,
  cacheSplitStats,
  formatCompactTokens,
  formatTokens,
  isLocalProvider,
  providerDisplayName,
  type Translate,
} from './usage-format.js'
import { UsageHeatmap } from './UsageHeatmap.js'
import { UsageCharts } from './UsageCharts.js'
import { ActiveWindowsPanel } from './ActiveWindowsPanel.js'
import { ClearUsageHistoryDialog } from './ClearUsageHistoryDialog.js'

/** Injected dependencies of {@link UsageDashboard} (slot `main` inject). */
export interface UsageDashboardInjected {
  rpc: ConnectionHandle['rpc']
  t: Translate
}

export type UsageDashboardProps = Partial<UsageDashboardInjected> & {
  /** Omit outer full-viewport scroll container and padding when hosted inside SubscriptionsPage. */
  embedded?: boolean
  /** Incremented by a parent tab container to trigger a silent background refresh. */
  refreshKey?: number
}

const RANGES: readonly { id: DashboardRange; key: SubscriptionsKey }[] = [
  { id: '7d', key: 'usageRange7d' },
  { id: '30d', key: 'usageRange30d' },
  { id: '90d', key: 'usageRange90d' },
  { id: 'all', key: 'usageRangeAll' },
]

function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatClockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatScanTime(ts: number): string {
  return new Date(ts).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export interface UsageDashboardViewProps {
  state: UsageDashboardState
  t: Translate
  onAction: (action: UsageDashboardAction) => void
  onOpenClear: () => void
  embedded?: boolean
}

/** Presentational dashboard view (pure & SSR-testable without RPC or browser DOM). */
export function UsageDashboardView({ state, t, onAction, onOpenClear, embedded = false }: UsageDashboardViewProps) {
  const { response, request, phase } = state
  const busy = phase === 'loading'
  const matchesScope = response?.filters.provider === request.provider && response.filters.account === request.account
  const scopedResponse = matchesScope ? response : undefined
  const scopeProviderLabel = request.provider === 'all' ? t('usageHeatmapAllModels') : providerDisplayName(request.provider)
  const scopeAccount = request.account === 'all' ? undefined : scopedResponse?.providers
    .filter(p => request.provider === 'all' || p.provider === request.provider)
    .flatMap(p => p.accounts).find(account => account.key === request.account)
  const heatmapScopeLabel = scopeAccount === undefined ? scopeProviderLabel : `${scopeProviderLabel} · ${scopeAccount.label ?? scopeAccount.key}`

  const providerTotals = new Map<DashboardProvider, number>()
  for (const entry of response?.providers ?? []) {
    providerTotals.set(entry.provider, entry.totalTokens)
  }

  const allProviderTotal = (response?.providers ?? []).reduce((sum, p) => sum + p.totalTokens, 0)
  const selectedProviderInfo = request.provider === 'all'
    ? undefined
    : response?.providers.find(p => p.provider === request.provider)
  const localUsage = response?.localUsage
  const localUnavailable = localUsage?.unavailable === true
  const localIncomplete = !localUnavailable && localUsage?.incomplete === true
  const localStale = !localUnavailable && localUsage?.stale === true
  const localUpdated = localUsage?.updatedAt
  const localSelected = isLocalProvider(request.provider)
  // A failed first read has neither totals nor a timestamp: hide the local pill
  // then, instead of rendering an empty filter. A previous snapshot, any local
  // totals, or an explicit selection keeps it visible.
  const localProviderIncluded = localSelected
    || localUpdated !== undefined
    || (response?.providers ?? []).some(p => p.provider === LOCAL_PROVIDER.id && p.totalTokens > 0)
  const visibleProviders = DASHBOARD_PROVIDERS.filter(entry => entry.id === LOCAL_PROVIDER.id
    ? localProviderIncluded : providerTotals.has(entry.id))
  const canClear = response !== undefined && Object.keys(response.clearInfo).length > 0 && !localSelected
  const localInScope = localSelected || (request.provider === 'all' && request.account === 'all')
  const showLocalNotice = localInScope && (localUnavailable || localIncomplete || localStale)

  const accountText = (provider: DashboardProvider, account: { key: string; label?: string; loggedIn: boolean }): string => (
    isLocalProvider(provider)
      ? account.label ?? t('usageLocalAccountFallback')
      : account.loggedIn
        ? account.label ?? account.key
        : t('usageAccountLoggedOut', { account: account.label ?? account.key })
  )

  const accountSelectValue = request.account === 'all'
    ? 'all'
    : request.provider === 'all'
      ? request.account
      : `${request.provider}\u0000${request.account}`

  const handleAccountSelect = (raw: string) => {
    if (raw === 'all') {
      onAction({ type: 'account', account: 'all' })
      return
    }
    const sep = raw.indexOf('\u0000')
    if (sep > 0) {
      const provider = raw.slice(0, sep) as DashboardProvider
      const account = raw.slice(sep + 1)
      if (request.provider === 'all') {
        onAction({ type: 'providerAccount', provider, account })
      } else {
        onAction({ type: 'account', account })
      }
      return
    }
    onAction({ type: 'account', account: raw })
  }

  const summary = scopedResponse?.summary
  const hasVisibleUsage = scopedResponse !== undefined && (
    scopedResponse.summary.totalTokens > 0
    || scopedResponse.heatmap.some(d => d.totalTokens > 0)
    || scopedResponse.quotaCycles.length > 0
    || scopedResponse.activeWindows.length > 0
  )
  const hasAnyGlobalUsage = allProviderTotal > 0
  const isFiltered = request.provider !== 'all' || request.account !== 'all' || request.range !== 'all'

  const ioTotal = (summary?.inputTokens ?? 0) + (summary?.outputTokens ?? 0)
  const inputPct = ioTotal > 0 ? ((summary?.inputTokens ?? 0) / ioTotal) * 100 : 50
  // Cache split stats use the contract's prompt denominator
  // (input + read + write), not input alone: the unknown share can exceed input
  // because it is a subset of the whole prompt. Unknown tokens stay out of the
  // denominator and are never counted as misses. When the unknown share may
  // absorb reported reads, the read contribution is only bounded, so an
  // over-100% contract rate is rendered as a known-read range instead.
  const cache = cacheSplitStats({
    inputTokens: summary?.inputTokens ?? 0,
    cacheReadTokens: summary?.cacheReadTokens ?? 0,
    cacheWriteTokens: summary?.cacheWriteTokens ?? 0,
    cacheUnknownPromptTokens: summary?.cacheUnknownPromptTokens ?? 0,
  })
  const cacheHitPct = cache.hitRate === null ? 0 : Math.round(cache.hitRate * 100)
  const cacheBarPct = Math.min(100, Math.max(0, cacheHitPct))
  const cachePartial = cache.metering !== 'known'
  const cacheCoveragePct = Math.round(cache.coverage * 100)
  // A contract rate above 100% means measured reads outnumber the known prompt,
  // so part of the read count must sit in the unknown split. Show the share of
  // reads that are certainly known (a range when the unknown share could hold
  // some of them) instead of a percentage that cannot be true.
  const cacheReadsOverAttributed = cache.hitRate !== null && cache.hitRate > 1
  const cacheKnownReadPct = cacheReadsOverAttributed
    ? Math.round((cache.knownReadMin / cache.knownPromptTokens) * 100)
    : cacheHitPct
  const cacheReadRange = cacheReadsOverAttributed && cache.knownReadMin < cache.knownReadMax
    ? {
        min: Math.round((cache.knownReadMin / cache.knownPromptTokens) * 100),
        max: Math.round((cache.knownReadMax / cache.knownPromptTokens) * 100),
      }
    : undefined

  return (
    <div className={embedded ? 'dsh-usage-dashboard dsh-usage-dashboard-embedded' : 'dsh-usage-dashboard'}>
      {!embedded && <style>{usageDashboardCss}</style>}
      <div className="dsh-usage-container">
        {/* Header */}
        <header className="dsh-usage-header">
          <div className="dsh-usage-title-group">
            <h1 className="dsh-usage-title">{t('usageDashboardTitle')}</h1>
            <p className="dsh-usage-subtitle">{t('usageDashboardSubtitle')}</p>
          </div>
          <div className="dsh-usage-header-actions">
            {response !== undefined && (
              <span className="dsh-usage-updated">
                {t('usageLastUpdated', { time: formatClockTime(response.generatedAt) })}
              </span>
            )}
            <button
              type="button"
              className="dsh-usage-btn"
              disabled={busy}
              onClick={() => onAction({ type: 'refresh' })}
            >
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
              {busy ? t('usageViewLoading') : t('usageRefresh')}
            </button>
            {localSelected && (
              <span className="dsh-usage-updated">{t('usageClearLocalOnly')}</span>
            )}
            <button
              type="button"
              className="dsh-usage-btn dsh-usage-btn-danger"
              aria-haspopup="dialog"
              disabled={busy || !canClear}
              onClick={onOpenClear}
            >
              {t('usageClearOpen')}
            </button>
          </div>
        </header>

        {/* Filter Bar */}
        <nav className="dsh-usage-filters" aria-label={t('providerTabs')}>
          <div className="dsh-usage-segmented dsh-usage-provider-pills" role="group" aria-label={t('providerTabs')}>
            <button
              type="button"
              className="dsh-usage-pill"
              aria-pressed={request.provider === 'all'}
              disabled={busy}
              onClick={() => onAction({ type: 'provider', provider: 'all' })}
            >
              <span>{t('usageProviderAll')}</span>
              {allProviderTotal > 0 && (
                <span className="dsh-usage-pill-badge">{formatCompactTokens(allProviderTotal)}</span>
              )}
            </button>
            {visibleProviders.map(entry => {
              const total = providerTotals.get(entry.id) ?? 0
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="dsh-usage-pill"
                  aria-pressed={request.provider === entry.id}
                  disabled={busy}
                  title={isLocalProvider(entry.id) ? t('usageLocalProviderHint') : undefined}
                  onClick={() => onAction({ type: 'provider', provider: entry.id })}
                >
                  <span className="dsh-usage-dot" style={{ background: entry.colorVar }} />
                  <span>{entry.name}</span>
                  {total > 0 && (
                    <span className="dsh-usage-pill-badge">{formatCompactTokens(total)}</span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="dsh-usage-filter-right">
            <select
              className="dsh-usage-select"
              aria-label={t('usageAccount')}
              value={accountSelectValue}
              disabled={busy || response === undefined}
              onChange={event => handleAccountSelect(event.target.value)}
            >
              <option value="all">{t('usageAccountAll')}</option>
              {selectedProviderInfo !== undefined
                ? selectedProviderInfo.accounts.map(acct => (
                    <option key={acct.key} value={`${selectedProviderInfo.provider}\u0000${acct.key}`}>
                      {accountText(selectedProviderInfo.provider, acct)}
                    </option>
                  ))
                : (response?.providers ?? [])
                    .filter(p => p.accounts.length > 0)
                    .map(p => (
                      <optgroup key={p.provider} label={providerDisplayName(p.provider)}>
                        {p.accounts.map(acct => (
                          <option key={`${p.provider}:${acct.key}`} value={`${p.provider}\u0000${acct.key}`}>
                            {accountText(p.provider, acct)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
            </select>

            <div className="dsh-usage-segmented" role="group" aria-label={t('usageKind')}>
              {RANGES.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className="dsh-usage-pill"
                  aria-pressed={request.range === item.id}
                  disabled={busy}
                  onClick={() => onAction({ type: 'range', range: item.id })}
                >
                  {t(item.key)}
                </button>
              ))}
            </div>
          </div>
        </nav>

        {/* Self-hosted coverage notice: never present a partial local scan as complete */}
        {showLocalNotice && (
          <div
            className={`dsh-usage-banner ${localUnavailable && localUpdated === undefined ? 'dsh-usage-banner-error' : 'dsh-usage-banner-warn'}`}
            role="status"
          >
            <span>
              {localUnavailable
                ? t(localUpdated === undefined ? 'usageLocalUnavailable' : 'usageLocalStale')
                : localStale
                  ? t('usageLocalOutdated')
                  : t('usageLocalIncomplete')}
              {localStale && localIncomplete && <> {t('usageLocalIncomplete')}</>}
              {localUpdated !== undefined && <> {t('usageLocalUpdated', { time: formatScanTime(localUpdated) })}</>}
            </span>
          </div>
        )}

        {/* Error & Partial Notices */}
        {phase === 'error' && (
          <div className="dsh-usage-banner dsh-usage-banner-error" role="alert">
            <span>{t('usageViewFailed', { message: state.error ?? '' })}</span>
            <button type="button" className="dsh-usage-btn" onClick={() => onAction({ type: 'retry' })}>
              {t('usageRetry')}
            </button>
          </div>
        )}
        {scopedResponse !== undefined && scopedResponse.errors.length > 0 && (
          <div className="dsh-usage-banner dsh-usage-banner-warn" role="status">
            <span>{t('usageDataErrors', { list: scopedResponse.errors.join('; ') })}</span>
          </div>
        )}
        {state.clearErrors.length > 0 && (
          <div className="dsh-usage-banner dsh-usage-banner-warn" role="alert">
            <span>{t('usageClearPartial', { list: state.clearErrors.join('; ') })}</span>
          </div>
        )}

        {/* Don't present the previous provider or account's totals under a new filter. */}
        {scopedResponse === undefined && busy && (
          <div className="dsh-usage-empty" role="status">
            <p className="dsh-usage-empty-desc">{t('usageViewLoading')}</p>
          </div>
        )}

        {/* Empty states */}
        {scopedResponse !== undefined && !hasVisibleUsage && (
          <div className="dsh-usage-empty">
            <h2 className="dsh-usage-empty-title">
              {hasAnyGlobalUsage && isFiltered
                ? t('usageEmptyFilter')
                : t('usageEmptyDashboard')}
            </h2>
            <p className="dsh-usage-empty-desc">
              {hasAnyGlobalUsage && isFiltered
                ? t('usageDashboardSubtitle')
                : scopedResponse.cleared
                  ? t('usageEmptyDashboardCleared')
                  : t('usageEmptyDashboardHint')}
            </p>
            {hasAnyGlobalUsage && isFiltered && (
              <button
                type="button"
                className="dsh-usage-btn"
                style={{ marginTop: 6 }}
                onClick={() => onAction({ type: 'resetFilters' })}
              >
                {t('usageEmptyResetFilter')}
              </button>
            )}
          </div>
        )}

        {/* Main Dashboard Visualizations */}
        {summary !== undefined && hasVisibleUsage && (
            <section className="dsh-usage-kpi-grid" aria-label={t('usageDashboardTitle')}>
              <article className="dsh-usage-kpi-card">
                <span className="dsh-usage-kpi-label">{t('usageKpiTotal')}</span>
                <span className="dsh-usage-kpi-value" title={formatTokens(summary.totalTokens)}>
                  {formatCompactTokens(summary.totalTokens)}
                </span>
                <div className="dsh-usage-kpi-sub">
                  <span>{t('usageKpiExact', { count: formatTokens(summary.totalTokens) })}</span>
                </div>
              </article>

              <article className="dsh-usage-kpi-card">
                <span className="dsh-usage-kpi-label">{t('usageKpiInputOutput')}</span>
                <span className="dsh-usage-kpi-value" style={{ fontSize: 19 }}>
                  {formatCompactTokens(summary.inputTokens)} / {formatCompactTokens(summary.outputTokens)}
                </span>
                <div className="dsh-usage-split-bar" aria-hidden="true">
                  <div style={{ width: `${inputPct}%`, background: 'var(--dsh-tok-input)' }} />
                  <div style={{ width: `${100 - inputPct}%`, background: 'var(--dsh-tok-output)' }} />
                </div>
                <div className="dsh-usage-kpi-sub">
                  <span>{t('usageKpiInputShort')} {formatCompactTokens(summary.inputTokens)}</span>
                  <span>{t('usageKpiOutputShort')} {formatCompactTokens(summary.outputTokens)}</span>
                  {summary.reasoningTokens > 0 && (
                    <span>{t('usageKpiReasoning', { count: formatCompactTokens(summary.reasoningTokens) })}</span>
                  )}
                </div>
              </article>

              <article className="dsh-usage-kpi-card">
                <span className="dsh-usage-kpi-label">{t('usageKpiCache')}</span>
                <span className="dsh-usage-kpi-value" style={{ fontSize: 19 }}>
                  {formatCompactTokens(summary.cacheReadTokens)} / {formatCompactTokens(summary.cacheWriteTokens)}
                </span>
                <div className="dsh-usage-split-bar" aria-hidden="true">
                  <div
                    style={{
                      width: `${cacheBarPct}%`,
                      background: 'var(--dsh-tok-cache-read)',
                    }}
                  />
                  <div
                    style={{
                      width: `${Math.max(0, 100 - cacheBarPct)}%`,
                      background: 'var(--dsh-tok-cache-write)',
                      opacity: summary.cacheWriteTokens > 0 ? 0.85 : 0.15,
                    }}
                  />
                </div>
                <div className="dsh-usage-kpi-sub">
                  {cache.promptTokens === 0 ? (
                    <span>
                      {t('usageKpiCacheReadShort')} 0 · {t('usageKpiCacheWriteShort')} 0
                    </span>
                  ) : cache.hitRate === null ? (
                    <span>{t('usageKpiCacheNoRate')}</span>
                  ) : (
                    <span>
                      {cacheReadRange === undefined
                        ? t(cachePartial ? 'usageKpiCacheHitKnown' : 'usageKpiCacheHit', { percent: cacheKnownReadPct })
                        : t('usageKpiCacheHitKnownRange', cacheReadRange)}
                    </span>
                  )}
                  {cachePartial && cache.promptTokens > 0 && (
                    <span>{t('usageKpiCacheCoverage', { percent: cacheCoveragePct })}</span>
                  )}
                  {cacheReadsOverAttributed && (
                    <span>{t('usageKpiCacheReadUpperBound')}</span>
                  )}
                  {cache.unknownPromptTokens > 0 && (
                    <span>{t('usageKpiCacheUnknown', { count: formatCompactTokens(cache.unknownPromptTokens) })}</span>
                  )}
                </div>
              </article>

              <article className="dsh-usage-kpi-card">
                <span className="dsh-usage-kpi-label">{t('usageKpiActivity')}</span>
                <span className="dsh-usage-kpi-value">
                  {t('usageKpiModelsCount', { count: summary.activeModels })}
                </span>
                <div className="dsh-usage-kpi-sub">
                  <span>{t('usageKpiDaysCount', { days: summary.activeDays })}</span>
                  <span>·</span>
                  <span>{t('usageKpiAccountsCount', { accounts: summary.activeAccounts })}</span>
                </div>
              </article>
            </section>

        )}

        {/* Keep the scoped calendar available even for providers without activity. */}
        {scopedResponse !== undefined && scopedResponse.heatmap.length > 0 && (
          <UsageHeatmap
            scopeLabel={heatmapScopeLabel}
            days={scopedResponse.heatmap}
            {...state.selectedDate === undefined ? {} : { selectedDate: state.selectedDate }}
            onSelectDate={date => onAction(date === undefined ? { type: 'selectDate' } : { type: 'selectDate', date })}
            t={t}
          />
        )}

        {scopedResponse !== undefined && hasVisibleUsage && (
          <>
            {/* Daily Stacked Bar Trend + Model/Provider Distribution */}
            <UsageCharts
              daily={scopedResponse.daily}
              models={scopedResponse.models}
              providerBreakdown={scopedResponse.providerBreakdown}
              distributionMode={state.distributionMode}
              onDistributionMode={mode => onAction({ type: 'distribution', mode })}
              onSelectDate={date => onAction({ type: 'selectDate', date })}
              t={t}
            />

            {/* Current & Recent Quota Cycles — cloud-only; self-hosted usage has no quota */}
            {!localSelected && (
              <ActiveWindowsPanel
                windows={scopedResponse.quotaCycles.length > 0 ? scopedResponse.quotaCycles : scopedResponse.activeWindows}
                now={scopedResponse.generatedAt}
                t={t}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Sidebar plugin home page for Subscription Usage. */
export function UsageDashboard(props: UsageDashboardProps) {
  const { rpc, embedded = false, refreshKey = 0 } = props
  const t = props.t ?? fallbackTranslate
  const [state, dispatch] = useReducer(usageDashboardReducer, undefined, initialUsageDashboardState)
  const [clearTarget, setClearTarget] = useState<ClearTarget | undefined>(undefined)
  const [clearConfirm, setClearConfirm] = useState<ClearConfirmState | undefined>(undefined)
  const aliveRef = useRef(true)
  const lastRefreshKey = useRef(refreshKey)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    if (refreshKey !== lastRefreshKey.current) {
      lastRefreshKey.current = refreshKey
      dispatch({ type: 'refresh' })
    }
  }, [refreshKey])

  useEffect(() => {
    if (rpc === undefined) return
    let active = true
    void callSubscriptionsAuth<UsageDashboardResponse>(rpc, 'usageDashboard', {
      provider: state.request.provider,
      account: state.request.account,
      range: state.request.range,
    })
      .then(response => {
        if (active) dispatch({ type: 'loaded', response })
      })
      .catch(error => {
        if (active) dispatch({ type: 'failed', message: messageOf(error) })
      })
    return () => { active = false }
  }, [rpc, state.load, state.request.provider, state.request.account, state.request.range])

  async function runClear(): Promise<void> {
    if (rpc === undefined || clearTarget === undefined || clearConfirm?.phase === 'clearing') return
    setClearConfirm(clearConfirmReducer(clearConfirm ?? CLEAR_CONFIRM_OPEN, { type: 'confirm' }))
    try {
      const result = await callSubscriptionsAuth<ClearResult>(rpc, 'clearUsageHistory', {
        provider: clearTarget,
        confirm: true,
      })
      if (!aliveRef.current) return
      setClearConfirm(undefined)
      setClearTarget(undefined)
      dispatch({ type: 'cleared', clearErrors: result.errors })
    } catch (error) {
      if (!aliveRef.current) return
      setClearConfirm(current => clearConfirmReducer(current ?? CLEAR_CONFIRM_OPEN, { type: 'failed', message: messageOf(error) }))
      dispatch({ type: 'refresh' })
    }
  }

  if (rpc === undefined) {
    return (
      <div className={embedded ? 'dsh-usage-dashboard dsh-usage-dashboard-embedded' : 'dsh-usage-dashboard'}>
        {!embedded && <style>{usageDashboardCss}</style>}
        <div className="dsh-usage-container">
          <div className="dsh-usage-empty">
            <p className="dsh-usage-empty-desc">{t('usageDashboardUnavailable')}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <UsageDashboardView
        state={state}
        t={t}
        embedded={embedded}
        onAction={dispatch}
        onOpenClear={() => {
          // Clearing is cloud-only: when the self-hosted route is selected the
          // button is disabled, but keep this defensive fallback cloud-safe.
          setClearTarget(isLocalProvider(state.request.provider) ? 'all' : state.request.provider)
          setClearConfirm(CLEAR_CONFIRM_OPEN)
        }}
      />
      {clearConfirm !== undefined && clearTarget !== undefined && state.response !== undefined && (
        <ClearUsageHistoryDialog
          target={clearTarget}
          clearInfo={state.response.clearInfo}
          hasLocalUsage={state.response.localUsage !== undefined
            || state.response.providers.some(p => p.provider === LOCAL_PROVIDER.id)}
          state={clearConfirm}
          t={t}
          onTargetChange={setClearTarget}
          onCancel={() => {
            setClearConfirm(undefined)
            setClearTarget(undefined)
          }}
          onConfirm={() => { void runClear() }}
        />
      )}
    </>
  )
}
