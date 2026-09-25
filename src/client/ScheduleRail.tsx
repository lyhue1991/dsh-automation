import { Component, createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { SessionSelector, Translate, WorkspaceSelector } from './contracts.js'
import { ClockIcon, RunningStateDot } from './icons.js'
import type { AutomationRuntime } from './runtime.js'
import {
  filterTaskSessionState,
  collectScheduledSessionIds,
  filterWorkspaceListState,
  groupNativeTaskSessions,
  groupScheduledSessions,
  NATIVE_SIDEBAR_TAB_KEY,
  ownedSidebarTabIds,
  readNativeSidebarTab,
  resolveVisibleSidebarTab,
  shouldFollowSessionTab,
  tabForSessionId,
  type NativeSessionLike,
  type NativeSidebarTab,
  type NativeWorkspaceLike,
} from './schedule-rail-model.js'
import { NativeScheduleSessionList } from './native-session-list.js'
import type { NativeSidebarTab as ExtraSidebarTab, NativeTabRegistry } from './native-tabs.js'

const EMPTY_EXTRA_TABS: ExtraSidebarTab[] = []
const noopSubscribe = (_listener: () => void): (() => void) => () => undefined

class OfficialTreeGuard extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override componentDidCatch(error: unknown): void {
    console.warn('[dsh-automation] official workspace tree crashed', error)
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * 定时页签自身的兜底边界。包裹层顶掉的是宿主 `sidebar.workspaces` 单槽注册项：
 * 这里一旦让错误冒泡，DSH 会注销整条注册（单槽 abdication），工作区与项目会话会
 * 一起变空白。所以自动化 UI 内部崩溃只回退到官方任务树。
 */
class AutomationShellGuard extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override componentDidCatch(error: unknown): void {
    console.warn('[dsh-automation] scheduled sidebar crashed; falling back to the native workspace tree', error)
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function ScheduleRail({
  t,
  runtime,
  openSession,
}: {
  readonly t: Translate
  readonly runtime: AutomationRuntime
  readonly openSession?: (sessionId: string) => void
}): JSX.Element {
  const state = useSyncExternalStore(runtime.source.subscribe, runtime.source.getSnapshot, runtime.source.getSnapshot)
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const snapshot = state.snapshot

  const groups = useMemo(() => {
    if (snapshot === undefined) return []
    return groupScheduledSessions(snapshot.automations, snapshot.runs, false)
  }, [snapshot])

  return (
    <div className="dsh-st-rail">
      <>
            {state.phase === 'loading' && groups.length === 0 && <div className="dsh-st-rail-empty">{t('loading')}</div>}
            {groups.length === 0 && state.phase !== 'loading' && <div className="dsh-st-rail-empty">{t('sidebar.empty')}</div>}
            {groups.map(group => (
              <section key={group.id} className="dsh-st-rail-group">
                <button
                  type="button"
                  className="dsh-st-rail-head"
                  title={group.name}
                  onClick={() => setFolded(current => ({ ...current, [group.id]: !current[group.id] }))}
                >
                  <span className="dsh-st-rail-folder"><ClockIcon width={16} height={16} /></span>
                  <span className="dsh-st-rail-title">{group.name}</span>
                </button>
                {folded[group.id] !== true && group.sessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    className="dsh-st-rail-session"
                    onClick={() => openSession?.(session.id)}
                  >
                    <span>{session.label}</span>
                    {session.running && <RunningStateDot />}
                  </button>
                ))}
              </section>
            ))}
          </>
    </div>
  )
}

export function NativeScheduleShell({
  t,
  runtime,
  officialTree,
  hostProps,
  openSession,
  useSessions,
  useWorkspaces,
  renderSlot,
  hasChannels,
  subscribeChannels,
  tabRegistry,
  wide,
}: {
  readonly t: Translate
  readonly runtime: AutomationRuntime
  readonly officialTree?: ComponentType<any>
  readonly hostProps?: Record<string, unknown>
  readonly openSession?: (sessionId: string) => void
  readonly useSessions?: SessionSelector
  readonly useWorkspaces?: WorkspaceSelector
  readonly renderSlot?: (name: string, props?: Record<string, unknown>) => ReactNode
  readonly hasChannels?: () => boolean
  readonly subscribeChannels?: (listener: () => void) => () => void
  readonly tabRegistry?: NativeTabRegistry
  readonly wide?: boolean
}): JSX.Element | null {
  const Official = officialTree
  const [tab, setTab] = useState<string>(() => {
    try { return readNativeSidebarTab(window.localStorage.getItem(NATIVE_SIDEBAR_TAB_KEY)) }
    catch { return 'tasks' }
  })
  const extraTabs = useSyncExternalStore(
    tabRegistry?.subscribe ?? noopSubscribe,
    () => tabRegistry?.getTabs() ?? EMPTY_EXTRA_TABS,
    () => EMPTY_EXTRA_TABS,
  )
  const channelsReady = useSyncExternalStore(
    subscribeChannels ?? noopSubscribe,
    () => {
      try { return hasChannels?.() === true } catch { return false }
    },
    () => false,
  )
  const currentId = useSessions?.((state) => state?.current ?? null)
  const automationState = useSyncExternalStore(runtime.source.subscribe, runtime.source.getSnapshot, runtime.source.getSnapshot)
  const scheduledIds = useMemo(() => collectScheduledSessionIds(automationState.snapshot?.runs), [automationState.snapshot])
  const useFilteredSessions = useCallback<SessionSelector>((selector, eq) => {
    if (useSessions === undefined) return selector({ ids: [], byId: {}, current: null })
    return useSessions(state => selector(filterTaskSessionState(state, scheduledIds)), eq)
  }, [useSessions, scheduledIds])
  const useFilteredWorkspaces = useCallback<WorkspaceSelector>((selector, eq) => {
    if (useWorkspaces === undefined) return selector({ items: [], archivedSessionIds: [] })
    return useWorkspaces(state => selector(filterWorkspaceListState(state, scheduledIds)), eq)
  }, [useWorkspaces, scheduledIds])

  useEffect(() => {
    try { window.localStorage.setItem(NATIVE_SIDEBAR_TAB_KEY, tab) }
    catch { /* 隐私模式或禁用存储时忽略 */ }
  }, [tab])

  const previousCurrentId = useRef(currentId)
  const tabFollowReady = useRef(false)
  useEffect(() => {
    if (!tabFollowReady.current) {
      tabFollowReady.current = true
      previousCurrentId.current = currentId
      return
    }
    const previous = previousCurrentId.current
    previousCurrentId.current = currentId
    if (!shouldFollowSessionTab(previous, currentId)) return
    const next = tabForSessionId(currentId ?? undefined, scheduledIds)
    const extraIds = extraTabs.map(item => item.id)
    if (next === 'channels' && (channelsReady || extraIds.includes('channels'))) setTab('channels')
    const matched = extraTabs.find(item => currentId !== undefined && currentId !== null && item.matchSession?.(String(currentId)) === true)
    if (matched !== undefined && matched.id !== 'schedule') setTab(matched.id)
  }, [currentId, channelsReady, extraTabs, scheduledIds])

  const rawOfficialProps = { ...(hostProps ?? {}), ...(wide === undefined ? {} : { wide }) }
  const filteredOfficialProps = {
    ...rawOfficialProps,
    ...(useSessions === undefined ? {} : { useSessions: useFilteredSessions }),
    ...(useWorkspaces === undefined ? {} : { useWorkspaces: useFilteredWorkspaces }),
  }
  const renderOfficial = (props: Record<string, unknown>): ReactNode => {
    if (Official === undefined) {
      return <NativeTaskRail t={t} {...(openSession === undefined ? {} : { openSession })} {...(useSessions === undefined ? {} : { useSessions: useFilteredSessions })} {...(useWorkspaces === undefined ? {} : { useWorkspaces })} />
    }
    return (
      <OfficialTreeGuard fallback={createElement(Official, rawOfficialProps)}>
        {createElement(Official, props)}
      </OfficialTreeGuard>
    )
  }
  /**
   * 宿主 slot 只能渲染本注册项声明过的子槽；未声明时 `renderSlot` 会同步抛错，
   * 之前这类错误会顺着边界冒泡注销整条工作区注册。渲染失败只让该页签留空。
   */
  const renderHostSlot = (name: string, props: Record<string, unknown>): ReactNode => {
    if (renderSlot === undefined) return null
    try {
      return renderSlot(name, props)
    } catch (error) {
      console.warn(`[dsh-automation] sidebar slot '${name}' is not renderable by this host`, error)
      return null
    }
  }

  if (wide === false) {
    // 收起态只有官方任务树；过滤后的 props 让宿主树崩溃时，退回未过滤 props 而不是注销整条注册。
    return (
      <AutomationShellGuard fallback={renderOfficial(rawOfficialProps)}>
        {renderOfficial(filteredOfficialProps)}
      </AutomationShellGuard>
    )
  }

  const foreignTabs = extraTabs.filter(item => item.id !== 'schedule')
  const visibleTab = resolveVisibleSidebarTab({
    tab,
    channelsReady,
    extraTabIds: ownedSidebarTabIds({ extraTabIds: foreignTabs.map(item => item.id), channelsReady }),
  })
  const hostedSchedule = extraTabs.find(item => item.id === 'schedule')
  const scheduleBody = hostedSchedule === undefined
    ? <NativeScheduleSessionList t={t} runtime={runtime} {...(openSession === undefined ? {} : { openSession })} {...(useSessions === undefined ? {} : { useSessions })} {...(useWorkspaces === undefined ? {} : { useWorkspaces })} />
    : hostedSchedule.render({ ...(hostProps ?? {}), openSession, open: openSession, useSessions, wide: true }) as ReactNode
  // 自动化页签崩溃时退回官方任务树（未过滤 props），保持工作区可用。
  const nativeFallback = <div className="dsh-st-official-tree">{renderOfficial(rawOfficialProps)}</div>
  return (
    <AutomationShellGuard fallback={nativeFallback}>
      <div className="dsh-st-shell-rail">
        <div className="dsh-st-shell-tabs" role="tablist" aria-label={t('sidebar.tabs')}>
          <button type="button" role="tab" aria-selected={visibleTab === 'tasks'} className={visibleTab === 'tasks' ? 'is-on' : undefined} onClick={() => setTab('tasks')}>
            {t('sidebar.tasksTab')}
          </button>
          {foreignTabs.map(item => (
            <button key={item.id} type="button" role="tab" aria-selected={visibleTab === item.id} className={visibleTab === item.id ? 'is-on' : undefined} onClick={() => setTab(item.id)}>
              {item.label}
            </button>
          ))}
          {channelsReady && foreignTabs.every(item => item.id !== 'channels') && (
            <button type="button" role="tab" aria-selected={visibleTab === 'channels'} className={visibleTab === 'channels' ? 'is-on' : undefined} onClick={() => setTab('channels')}>
              {t('sidebar.channelsTab')}
            </button>
          )}
          <button type="button" role="tab" aria-selected={visibleTab === 'schedule'} className={visibleTab === 'schedule' ? 'is-on' : undefined} onClick={() => setTab('schedule')}>
            {t('sidebar.tab')}
          </button>
        </div>
        {visibleTab === 'schedule'
          ? <div className="dsh-st-shell-body">{scheduleBody}</div>
          : foreignTabs.find(item => item.id === visibleTab) !== undefined
            ? <div className="dsh-st-shell-body">{foreignTabs.find(item => item.id === visibleTab)?.render({ ...(hostProps ?? {}), openSession, open: openSession, useSessions, wide: true }) as ReactNode}</div>
            : visibleTab === 'channels'
              ? <div className="dsh-st-shell-body">{renderHostSlot('sidebar.channels', { ...(hostProps ?? {}), openSession, open: openSession, useSessions, wide: true, skin: 'native' })}</div>
              : <div className="dsh-st-official-tree">{renderOfficial(filteredOfficialProps)}</div>}
      </div>
    </AutomationShellGuard>
  )
}

function NativeTaskRail({
  t,
  openSession,
  useSessions,
  useWorkspaces,
}: {
  readonly t: Translate
  readonly openSession?: (sessionId: string) => void
  readonly useSessions?: SessionSelector
  readonly useWorkspaces?: WorkspaceSelector
}): JSX.Element {
  const snap = useSessions === undefined
    ? { ids: [] as string[], byId: {} as Record<string, NativeSessionLike>, current: null as string | null }
    : useSessions(state => state ?? { ids: [], byId: {}, current: null })
  const workspaces = useWorkspaces === undefined
    ? undefined
    : useWorkspaces(state => state ?? { items: [], archivedSessionIds: [] })
  const groups = groupNativeTaskSessions(snap, workspaces, t('sidebar.ungrouped'))
  if (groups.length === 0) return <div className="dsh-st-rail-empty">{t('sidebar.tasksEmpty')}</div>
  return (
    <div className="dsh-st-rail">
      {groups.map(group => (
        <section key={group.id || 'ungrouped'} className="dsh-st-rail-group">
          <div className="dsh-st-rail-head is-static">
            <span className="dsh-st-rail-title">{group.label}</span>
          </div>
          {group.sessions.map(item => (
            <button
              key={item.id}
              type="button"
              className={`dsh-st-rail-session${snap.current === item.id ? ' is-on' : ''}`}
              onClick={() => { if (item.id !== undefined) openSession?.(item.id) }}
            >
              <span>{item.title || item.id}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}
