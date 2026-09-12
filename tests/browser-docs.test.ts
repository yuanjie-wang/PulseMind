import { describe, it, expect } from 'vitest'
import { BROWSER_API_MANIFEST } from '../src/shared/browser-client/manifest'
import { effectiveMembers, memberSupported, objectVisible } from '../src/shared/browser-client/api-policy'
import { documentationText, effectiveApiText, getDocument, listDocuments } from '../src/shared/browser-client/documentation'
import type { BackendDescriptor } from '../src/shared/browser-client/protocol'

const managed: BackendDescriptor = { id: 'managed', type: 'managed', capabilities: { browser: ['open', 'tabs'], tab: ['navigate', 'snapshot'] } }
const appView: BackendDescriptor = { id: 'app-view', type: 'app-view', capabilities: { browser: ['open', 'tabs', 'user'], tab: ['navigate', 'snapshot', 'recording'] } }

describe('api-policy', () => {
  it('shows user.openTabs/claimTab only on app-view', () => {
    const onManaged = effectiveMembers(BROWSER_API_MANIFEST, 'tab.user', managed)
    const onAppView = effectiveMembers(BROWSER_API_MANIFEST, 'tab.user', appView)
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
    expect(objectVisible(BROWSER_API_MANIFEST, 'tab.user', managed)).toBe(false)
    expect(objectVisible(BROWSER_API_MANIFEST, 'tab.user', appView)).toBe(true)
    expect(objectVisible(BROWSER_API_MANIFEST, 'tab', managed)).toBe(true)
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
    expect(getDocument('recording', managed)).toBeNull()
    expect(getDocument('recording', appView)).toContain('.webm')
    expect(getDocument('no-such-doc', appView)).toBeNull()
  })
  it('effectiveApiText lists tab members with signatures', () => {
    const text = effectiveApiText(managed)
    expect(text).toContain('### tab ')
    expect(text).toContain('playwright(selector, op')
  })
})
