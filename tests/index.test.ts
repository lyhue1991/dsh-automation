import assert from 'node:assert/strict'
import test from 'node:test'
import {
  humanApprovalReason,
  mountAutomationRpc,
  needsHumanApproval,
  sessionApprovalPolicy,
} from '../src/index.ts'

test('Full access 的 never 策略不强制 ask，避免静默拒绝', () => {
  const signal = new AbortController().signal
  assert.equal(needsHumanApproval({ name: 'automation_create', signal }, true, 'never'), false)
  assert.equal(needsHumanApproval({ name: 'automation_manage', arguments: { id: 'a', action: 'delete' }, signal }, true, 'never'), false)
  assert.equal(needsHumanApproval({ name: 'automation_manage', arguments: { id: 'a', action: 'run_now' }, signal }, true), false)
})

test('Read Only / Workspace Write 的 ask 策略会走官方授权', () => {
  const signal = new AbortController().signal
  assert.equal(needsHumanApproval({ name: 'automation_create', signal }, true, 'ask'), true)
  assert.equal(needsHumanApproval({ name: 'automation_manage', arguments: { id: 'a', action: 'delete' }, signal }, true, 'ask'), true)
  assert.equal(needsHumanApproval({ name: 'automation_manage', arguments: { id: 'a', action: 'run_now' }, signal }, true, 'ask'), true)
  assert.equal(needsHumanApproval({
    name: 'automation_manage',
    arguments: { id: 'automation-1', action: 'pause' },
    signal,
  }, true, 'ask'), false)
  assert.equal(needsHumanApproval({
    name: 'automation_manage',
    arguments: { id: 'automation-1', action: 'update', name: '新名称' },
    signal,
  }, true, 'ask'), true)
  assert.equal(needsHumanApproval({ name: 'automation_get', signal }, true, 'ask'), false)
  assert.match(humanApprovalReason('automation_manage', { action: 'delete' }), /permanently deletes the automation definition/)
})

test('会话策略优先读 override，否则回退配置默认值', () => {
  assert.equal(sessionApprovalPolicy({
    overrideOf: () => 'never',
    config: { policy: 'ask' },
  }, {}), 'never')
  assert.equal(sessionApprovalPolicy({
    overrideOf: () => undefined,
    config: { policy: 'ask' },
  }, {}), 'ask')
  assert.equal(sessionApprovalPolicy(undefined, {}), undefined)
})

test('Web RPC 依赖 webServer 后再注册，兼容新版 DSH', () => {
  const channels: string[] = []
  const routes: string[] = []
  const injects: string[][] = []
  const effects: string[] = []
  const ctx = {
    inject(services: string[], callback: (webContext: unknown) => void): void {
      injects.push([...services])
      callback({
        effect(register: () => unknown, label: string): void {
          register()
          effects.push(label)
        },
        connection: {
          rpc: {
            handle(channel: string): () => Promise<void> {
              channels.push(channel)
              return async () => {}
            },
          },
        },
      })
    },
  }

  mountAutomationRpc(ctx as never, {} as never)

  assert.deepEqual(injects, [['webServer']])
  assert.deepEqual(channels, ['/dsh-automation'])
  assert.deepEqual(effects, ['dsh-automation: Web RPC'])

  const fallbackCtx = {
    inject(services: string[], callback: (webContext: unknown) => void): void {
      injects.push([...services])
      callback({
        effect(register: () => unknown, label: string): void {
          register()
          effects.push(label)
        },
        connection: {
          requestRejection: () => undefined,
          rpc: {
            handle(): () => Promise<void> {
              throw new Error('cannot get property "webServer" without inject')
            },
          },
        },
        webServer: {
          register(route: { path: string }): () => void {
            routes.push(route.path)
            return () => {}
          },
        },
      })
    },
  }

  mountAutomationRpc(fallbackCtx as never, {} as never)

  assert.deepEqual(routes, ['/dsh-automation'])
  assert.deepEqual(injects, [['webServer'], ['webServer']])
})
