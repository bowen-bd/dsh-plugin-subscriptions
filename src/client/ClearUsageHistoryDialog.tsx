import { useEffect, useId, useRef } from 'react'
import type { TrackedProvider } from '../usage/usage-schema.js'
import type { DashboardClearInfo } from '../usage/usage-dashboard.js'
import type { ClearConfirmState, ClearTarget } from './usage-dashboard-state.js'
import { formatInstant, providerDisplayName, TRACKED_PROVIDERS, type Translate } from './usage-format.js'
import { dialogLayout, providerSettingsCss } from './provider-settings-styles.js'

interface Props {
  /** Cloud-only scope: the self-hosted route has no clearable history. */
  target: ClearTarget
  clearInfo: Readonly<Partial<Record<TrackedProvider, DashboardClearInfo>>>
  /** Whether the dashboard response also contains self-hosted usage. */
  hasLocalUsage: boolean
  state: ClearConfirmState
  t: Translate
  onTargetChange: (target: ClearTarget) => void
  onCancel: () => void
  onConfirm: () => void
}

const { border, stack, actions } = dialogLayout

function summarizeTarget(
  target: ClearTarget,
  clearInfo: Readonly<Partial<Record<TrackedProvider, DashboardClearInfo>>>,
): { accounts: number; from?: number; to?: number; earlierHistory: boolean } {
  const list = target === 'all'
    ? TRACKED_PROVIDERS.map(p => clearInfo[p.id]).filter((info): info is DashboardClearInfo => info !== undefined)
    : clearInfo[target] ? [clearInfo[target]] : []

  let accounts = 0
  let from: number | undefined
  let to: number | undefined
  let earlierHistory = false
  for (const info of list) {
    accounts += info.accounts
    if (info.from !== undefined && (from === undefined || info.from < from)) from = info.from
    if (info.to !== undefined && (to === undefined || info.to > to)) to = info.to
    if (info.earlierHistory) earlierHistory = true
  }
  return {
    accounts,
    ...from === undefined ? {} : { from },
    ...to === undefined ? {} : { to },
    earlierHistory,
  }
}

/**
 * Confirmation modal for clearing stored usage history for one cloud provider or all of them.
 * The self-hosted DeepSeek route is never a target: it has no stored window history.
 * Opened directly from the Usage Dashboard page (never nested inside another dialog).
 */
export function ClearUsageHistoryDialog({
  target, clearInfo, hasLocalUsage, state, t, onTargetChange, onCancel, onConfirm,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const title = useId()
  const description = useId()
  const clearing = state.phase === 'clearing'

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const previous = document.activeElement
    element.showModal()
    // Ensure initial focus lands on Cancel even though the scope <select> precedes it in DOM order.
    cancelButton.current?.focus()
    return () => {
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  // When self-hosted usage is in the view, "All" explicitly means all cloud
  // providers, so nobody expects the local logs to be removed here.
  const providers = TRACKED_PROVIDERS.filter(entry => clearInfo[entry.id] !== undefined)
  const allLabel = providers.length < TRACKED_PROVIDERS.length
    ? t('usageClearVisibleProviders')
    : hasLocalUsage ? t('usageClearAllCloudProviders') : t('usageClearAllProviders')
  const targetName = target === 'all' ? allLabel : providerDisplayName(target)
  const stored = summarizeTarget(target, clearInfo)
  const nothing = stored.accounts === 0 && !stored.earlierHistory

  return (
    <dialog
      className="dsh-subscription-manager"
      ref={dialog}
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={event => {
        event.preventDefault()
        if (!clearing) onCancel()
      }}
      style={{ width: 480, maxWidth: 'calc(100vw - 32px)' }}
    >
      <style>{providerSettingsCss}</style>
      <div style={{ ...stack, padding: 20 }}>
        <h2 id={title} style={{ margin: 0 }}>{t('usageClearTitle', { provider: targetName })}</h2>

        <label style={{ ...stack, gap: 4 }}>
          <span className="dsh-subscription-label">{t('usageClearScopeLabel')}</span>
          <select
            value={target}
            disabled={clearing}
            onChange={event => onTargetChange(event.target.value as ClearTarget)}
          >
            <option value="all">{allLabel}</option>
            {providers.map(entry => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
        </label>

        <section id={description} style={{ ...stack, gap: 6 }}>
          <strong>{t('usageClearRemoved')}</strong>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {nothing && <li>{t('usageClearNothingStored')}</li>}
            {stored.accounts > 0 && stored.from !== undefined && stored.to !== undefined && (
              <li>
                {t('usageClearRemovedWindows', {
                  count: stored.accounts,
                  from: formatInstant(stored.from),
                  to: formatInstant(stored.to),
                })}
              </li>
            )}
            {stored.earlierHistory && <li>{t('usageClearRemovedEarlier')}</li>}
          </ul>
          <strong>{t('usageClearKept')}</strong>
          <p className="dsh-subscription-hint" style={{ margin: 0 }}>{t('usageClearKeptList')}</p>
          {hasLocalUsage && <p className="dsh-subscription-hint" style={{ margin: 0 }}>{t('usageClearLocalKept')}</p>}
          <p style={{ margin: 0 }}>{t('usageClearIrreversible')}</p>
        </section>

        {state.phase === 'failed' && <p role="alert">{t('usageClearFailed', { message: state.error ?? '' })}</p>}

        <footer style={{ ...actions, justifyContent: 'flex-end', borderTop: border, paddingTop: 12 }}>
          <button ref={cancelButton} type="button" autoFocus disabled={clearing} onClick={onCancel}>{t('cancel')}</button>
          <button type="button" className="dsh-subscription-primary" disabled={clearing} onClick={onConfirm}>
            {clearing ? t('usageClearing') : t('usageClearConfirm')}
          </button>
        </footer>
      </div>
    </dialog>
  )
}
