import { describe, it, expect } from 'vitest'
import { BROWSER_API_MANIFEST } from '../src/shared/browser-client/manifest'
import { effectiveMembers, memberSupported, objectVisible } from '../src/shared/browser-client/api-policy'
import { documentationText, effectiveApiText, getDocument, listDocuments } from '../src/shared/browser-client/documentation'
import { createBrowserFacade } from '../src/shared/browser-client/facade'
import type { BackendDescriptor } from '../src/shared/browser-client/protocol'

const managed: BackendDescriptor = { id: 'managed', type: 'managed', capabilities: { browser: ['open', 'tabs'], tab: ['navigate', 'snapshot'] } }
const appView: BackendDescriptor = { id: 'app-view', type: 'app-view', capabilities: { browser: ['open', 'tabs', 'user'], tab: ['navigate', 'snapshot', 'recording'] } }

describe('api-policy', () => {
  it('shows user.openTabs/claimTab only on app-view', () => {
    const onManaged = effectiveMembers(BROWSER_API_MANIFEST, 'agent.browsers.user', managed)
    const onAppView = effectiveMembers(BROWSER_API_MANIFEST, 'agent.browsers.user', appView)
    expect(onManaged).toEqual([])
    expect(onAppView.map(([name]) => name)).toEqual(['openTabs', 'claimTab'])
  })
  it('memberSupported honors requiresCapabilities', () => {
    expect(memberSupported(
      { signature: 'x', summary: '', requiresCapabilities: ['recording'] },
      appView,
    )).toBe(true)
    expect(memberSupported(
      { signature: 'x', summary: '', requiresCapabilities: ['recording'] },
      managed,
    )).toBe(false)
  })
  it('an object with every member hidden is itself hidden', () => {
    expect(objectVisible(BROWSER_API_MANIFEST, 'agent.browsers.user', managed)).toBe(false)
    expect(objectVisible(BROWSER_API_MANIFEST, 'agent.browsers.user', appView)).toBe(true)
    expect(objectVisible(BROWSER_API_MANIFEST, 'tab', managed)).toBe(true)
  })
  it('every manifest object name resolves on the REAL facade', async () => {
    // Two names used to be wrong (`tab.user`, `agent.downloads`): the model
    // copies a path out of the docs and gets a TypeError instead. The guard
    // throws for anything the facade does not have, so walking the path IS the
    // assertion — and it cannot go stale, because it starts at the real root.
    const facade = createBrowserFacade({
      execute: async (cmd) =>
        cmd.method === 'listTabs' || cmd.method === 'newTab'
          ? { ok: true, value: { id: 't1', url: 'https://a.com/' } }
          : { ok: true },
      emitImage: () => {},
    })
    const tab = await facade.agent.browsers.tabs.new()
    for (const [name, object] of Object.entries(BROWSER_API_MANIFEST.objects)) {
      let node: unknown = name === 'tab' ? tab : ({ agent: facade.agent } as Record<string, unknown>)
      const segments = name === 'tab' ? [] : name.split('.')
      for (const segment of segments) node = (node as Record<string, unknown>)[segment]
      expect(node, `manifest object ${name} is not a real facade path`).toBeDefined()
      for (const member of Object.keys(object.members)) {
        // `chain` is the one documented pseudo-member (a chain shape, not a key)
        if (member === 'chain') continue
        expect((node as Record<string, unknown>)[member], `${name}.${member}`).toBeDefined()
      }
    }
  })
})

describe('documentation', () => {
  it('documentationText includes the workflow protocol and effective API', () => {
    const text = documentationText(managed)
    expect(text).toContain('backend: managed (managed)')
    expect(text).toContain('## Workflow protocol')
    expect(text).toContain('domSnapshot')
  })
  it('app-view members never appear in managed documentation', () => {
    const text = documentationText(managed)
    expect(text).not.toContain('claimTab')
    expect(text).not.toContain('user.openTabs')
  })
  it('lookup docs are listed but not inlined; when-filtered docs are hidden entirely', () => {
    const managedList = listDocuments(managed)
    expect(managedList.map((d) => d.name)).toContain('screenshots')
    expect(managedList.map((d) => d.name)).not.toContain('app-view')
    expect(documentationText(managed)).not.toContain('## Screenshots (lookup)')
    expect(getDocument('screenshots', managed)).toContain('screenshot()')
    expect(getDocument('downloads', managed)).toContain('workspace')
    expect(getDocument('no-such-doc', appView)).toBeNull()
  })
  it('effectiveApiText lists tab members with signatures', () => {
    const text = effectiveApiText(managed)
    expect(text).toContain('### tab ')
    expect(text).toContain('playwright(ref | selector | locator, op')
  })
  it('the docs separate the two same-named playwright surfaces and the open() semantics', () => {
    const text = documentationText(managed)
    // executor vs factory, said as two different things
    expect(text).toContain("tab.playwright(3, 'click')")
    expect(text).toContain('agent.playwright.getByRole')
    expect(text).toContain('There is no `tab.playwright.getByRole`')
    // open() says what it did, and a repeat is not a retry
    expect(text).toContain('opened')
    expect(text).toContain('a repeat is not a retry')
    // the change signal is explained where the action rule lives
    expect(text).toContain('未检测到本页变化')
    expect(text).toContain('tabs.list()')
  })
  it('included docs call out the no-timer rule and the list/get data-vs-handle asymmetry', () => {
    const text = documentationText(managed)
    expect(text).toContain('setTimeout')
    expect(text).toContain('await tab.waitForTimeout(ms)')
    expect(text).toContain('list() items are plain DATA')
    expect(text).toContain('await tab.url()')
  })
  it('troubleshooting answers both new failure shapes', () => {
    const text = getDocument('troubleshooting', managed) ?? ''
    expect(text).toContain('未知成员')
    expect(text).toContain('menu')
    expect(text).toContain('Repeating the same number is the one wrong move')
  })
})
