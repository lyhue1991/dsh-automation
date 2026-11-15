import assert from 'node:assert/strict'
import test from 'node:test'
import type { ComponentType } from 'react'
import type { SlotRegisterOptions } from '../src/client/contracts.ts'
import { apply } from '../src/client/index.ts'

test('全局插件入口移除但设置入口仍保留', () => {
  const entries: Array<{ options: SlotRegisterOptions; component: ComponentType<any> }> = []
  const ctx = {
    effect: () => undefined,
    connection: { rpc: { call: async (_channel: string, endpoint: string) => ({ ok: true, value: endpoint === 'resume-session' ? { resumed: true } : {} }) } },
    sessions: {
      list: { getSnapshot: () => ({ byId: {} }) },
    },
    uiWorkspace: {},
    locale: {
      bind: () => (key: string) => key,
    },
    slots: {
      inject(name: string, register: () => void | (() => void)) {
        if (name === 'main' || name === 'sidebar.panellist' || name === 'sidebar.schedule' || name === 'settings.section') register()
      },
      register(options: SlotRegisterOptions, component: ComponentType<any>) {
        entries.push({ options, component })
        return () => undefined
      },
    },
  }

  apply(ctx as never)

  assert.equal(entries.some(entry => entry.options.name === 'main'), false)
  assert.equal(entries.some(entry => entry.options.name === 'sidebar.panellist'), false)
  assert.equal(entries.some(entry => entry.options.name === 'sidebar.schedule'), false)
  assert.equal(entries.some(entry => entry.options.name === 'settings.section'), true)
})
