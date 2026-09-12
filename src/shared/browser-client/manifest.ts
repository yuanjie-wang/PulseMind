// ── API manifest (A-M2) ──
// Every object and member the facade exposes, declared as data — the same
// negotiation shape as ZCode's api.json. `unsupportedByDefaultIn` hides a
// member from backends that don't implement it yet: documentation, callable
// surface and runtime stay consistent (调了才发现不支持 is impossible).

export interface ManifestMember {
  /** Signature line shown in documentation(). */
  signature: string
  /** One-line purpose. */
  summary: string
  /** Backend types where the member is hidden by default. */
  unsupportedByDefaultIn?: Array<'managed' | 'app-view'>
  /** Extra capability names required beyond the object level. */
  requiresCapabilities?: string[]
}

export interface ManifestObject {
  summary: string
  members: Record<string, ManifestMember>
  /** Backend types where the WHOLE object is hidden (e.g. app-view-only surfaces). */
  unsupportedByDefaultIn?: Array<'managed' | 'app-view'>
}

export interface BrowserApiManifest {
  objects: Record<string, ManifestObject>
}

export const BROWSER_API_MANIFEST: BrowserApiManifest = {
  objects: {
    'agent.browsers': {
      summary: 'Entry point: pick a browser backend, open URLs, manage tabs.',
      members: {
        descriptor: { signature: 'descriptor(): Promise<Descriptor>', summary: 'Current backend id/type/capabilities' },
        open: { signature: 'open(url): Promise<Tab>', summary: 'Open a URL — reuses a same-site tab (exact > same-origin > same-host), else creates one' },
      },
    },
    'agent.browsers.tabs': {
      summary: 'Tab registry of THIS conversation. Other conversations are invisible.',
      members: {
        list: { signature: 'list(): Promise<Array<{id, url, title}>>', summary: 'Rebind protocol step 1 — list before every logical batch' },
        get: { signature: 'get(id): Promise<Tab>', summary: 'Rebind protocol step 2 — fails loudly for a closed/foreign id' },
        new: { signature: 'new({ url }?): Promise<Tab>', summary: 'Create a tab' },
      },
    },
    tab: {
      summary: 'One live tab. Created fresh per tabs.get()/open() call.',
      members: {
        id: { signature: 'id: string', summary: 'Stable id' },
        url: { signature: 'url(): Promise<string>', summary: 'Current URL' },
        title: { signature: 'title(): Promise<string>', summary: 'Current title' },
        navigate: { signature: 'navigate(url): Promise<{url, title}>', summary: 'In-place navigation (domcontentloaded)' },
        back: { signature: 'back(): Promise<void>', summary: 'History back' },
        forward: { signature: 'forward(): Promise<void>', summary: 'History forward' },
        reload: { signature: 'reload(): Promise<void>', summary: 'Reload (domcontentloaded)' },
        close: { signature: 'close(): Promise<void>', summary: 'Close the tab; after this the id is dead' },
        domSnapshot: { signature: 'domSnapshot(): Promise<string>', summary: 'AI/ARIA tree — the default and primary observation' },
        screenshot: { signature: 'screenshot({ fullPage?, selector? }?): Promise<{emitted}>', summary: 'Screenshot emitted inline in the same call — never returned as bytes' },
        evaluate: { signature: 'evaluate(expression): Promise<unknown>', summary: 'Run JS in the page (page context, not the kernel)' },
        playwright: { signature: 'playwright(selector, op, arg?, { timeoutMs }?): Promise<unknown>', summary: 'The selector engine: one locator op — click/fill/count/textContent/…' },
        waitForTimeout: { signature: 'waitForTimeout(ms): Promise<void>', summary: 'Bounded sleep (≤30s). Prefer domSnapshot re-checks over waiting' },
      },
    },
    'agent.playwright': {
      summary: 'Locator sugar: getBy* chains serialize to Playwright internal selectors.',
      members: {
        getByRole: { signature: "getByRole(role, { name?, exact?, checked?, disabled?, level? })", summary: 'ARIA role locator' },
        getByText: { signature: 'getByText(text, { exact? })', summary: 'Text content locator' },
        getByLabel: { signature: 'getByLabel(text, { exact? })', summary: 'Form label locator' },
        getByPlaceholder: { signature: 'getByPlaceholder(text, { exact? })', summary: 'Input placeholder locator' },
        getByTestId: { signature: 'getByTestId(id)', summary: 'Test id locator' },
        selector: { signature: 'selector(raw)', summary: 'Raw CSS/XPath escape hatch' },
        chain: { signature: '.getBy*(...) .first() .last() .nth(i)', summary: 'Narrow within a locator' },
      },
    },
    'agent.documentation': {
      summary: 'Bundled workflow documents. Included ones ride with documentation(); lookup ones cost a call.',
      members: {
        list: { signature: 'list(): Promise<Array<{name, mode, title}>>', summary: 'Available documents' },
        get: { signature: 'get(name): Promise<string>', summary: 'Fetch one document (lookup: screenshots/recording/troubleshooting)' },
      },
    },
    'tab.user': {
      summary: 'User-facing browser surfaces: see and adopt the tabs shown in the app pane.',
      members: {
        openTabs: { signature: 'user.openTabs(): Promise<Array<{id, url, title}>>', summary: 'Tabs the user can see in the app pane' },
        claimTab: { signature: 'claimTab(id): Promise<Tab>', summary: 'Adopt a user-visible tab as controlled' },
      },
      // Requires the in-app view backend (M3) — hidden entirely on managed.
      unsupportedByDefaultIn: ['managed'],
    },
    'recording': {
      summary: 'Session recording to a workspace .webm.',
      members: {
        start: { signature: 'tab.record(): Promise<void>', summary: 'Record the tab (app-view only)' },
      },
      unsupportedByDefaultIn: ['managed'],
    },
  },
}
