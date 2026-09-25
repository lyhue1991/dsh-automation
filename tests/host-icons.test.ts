import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { ArchiveIcon, CheckOutlineIcon, ChevronDownIcon, EllipsisIcon } from '../src/client/icons.tsx'

const clientDir = new URL('../src/client/', import.meta.url)
const HOST_PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
const PRIMITIVES_IMPORT = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*'${HOST_PRIMITIVES.replace('/', '\\/')}'`, 'g')

async function clientSources(): Promise<{ readonly name: string; readonly text: string }[]> {
  const names = (await readdir(clientDir)).filter(name => /\.tsx?$/.test(name))
  return await Promise.all(names.map(async (name) => ({
    name,
    text: await readFile(new URL(name, clientDir), 'utf8'),
  })))
}

/** 从宿主 primitives 的 import 语句里取出被导入的标识符。 */
function importedHostNames(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(PRIMITIVES_IMPORT)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? ''
      if (name !== '') names.push(name)
    }
  }
  return names
}

/**
 * DSH 0.1.7-rc.2 renamed every numbered primitive icon export
 * (`IconEllipsisOutline16` → `IconEllipsisOutlineRegular`). Importing one of the
 * old names yields `undefined`, React throws while rendering it, and the
 * supervised `sidebar.workspaces` single slot abdicates the whole registration —
 * which blanks the workspace region along with its project sessions. The plugin
 * must therefore keep its own copies instead of following host icon names.
 */
test('客户端不依赖宿主会改名的编号图标导出', async () => {
  const sources = await clientSources()
  assert.ok(sources.length > 0)
  for (const { name, text } of sources) {
    const numbered = importedHostNames(text).filter(imported => /Icon[A-Za-z]*Outline[0-9]+/.test(imported))
    assert.deepEqual(numbered, [], `${name} 仍在从宿主导入编号图标`)
  }
  const icons = sources.find(item => item.name === 'icons.tsx')
  assert.ok(icons !== undefined)
  for (const local of ['ChevronDownIcon', 'CheckOutlineIcon', 'EllipsisIcon', 'ArchiveIcon']) {
    assert.match(icons.text, new RegExp(`export function ${local}\\(`), `icons.tsx 缺少 ${local}`)
  }
})

test('本地图标都能渲染出元素类型', () => {
  for (const Icon of [ChevronDownIcon, CheckOutlineIcon, EllipsisIcon, ArchiveIcon]) {
    const element = Icon({ width: 16, height: 16 }) as { readonly type?: unknown; readonly props?: unknown }
    assert.ok(typeof element.type === 'string' || typeof element.type === 'function')
    assert.equal(typeof element.props, 'object')
  }
})

/**
 * 自动化页签顶掉的是宿主 `sidebar.workspaces` 单槽注册项：内部崩溃一旦冒泡，
 * DSH 会注销整条注册并留下空白区域。ScheduleRail 必须自己兜底回官方任务树。
 */
test('定时页签用自身边界兜底，不让崩溃冒泡到宿主单槽', async () => {
  const rail = await readFile(new URL('ScheduleRail.tsx', clientDir), 'utf8')
  assert.match(rail, /class AutomationShellGuard extends Component/)
  assert.match(rail, /<AutomationShellGuard fallback=\{nativeFallback\}>/)
  assert.match(rail, /const nativeFallback = /)
})
