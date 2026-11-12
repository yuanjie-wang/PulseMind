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
        setActiveBackend: {
          signature: "setActiveBackend('managed' | 'app-view'): Promise<Descriptor>",
          summary: "Switch this conversation's backend — ONE choice per task (workflow §1)",
        },
        open: {
          signature: "open(url): Promise<Tab & { opened: 'new' | 'reused'; note: string }>",
          summary:
            'Open a URL — reuses a same-site tab (exact > same-origin > same-host) and navigates it in place. The handle SAYS which happened (`opened` + `note`): a repeat is not a retry, it is the same tab reloaded — calling open() again never creates a second tab',
        },
        downloads: {
          signature: 'downloads(): Promise<Array<{name, path, size, savedAt}>>',
          summary: 'Newest first — files a page downloaded land in this conversation\u2019s workspace; read/upload them via the file tools',
        },
        favorites: {
          signature: 'favorites: { list(): Promise<Array<{url, title}>>, add(url, title?): Promise<{url, title?, added}>, remove(url): Promise<boolean> }',
          summary: 'The user’s saved sites (收藏). list() on demand — when the user mentions a saved site, match by title/host here, NEVER reconstruct the URL from memory. add is idempotent (added:’already’ means it existed)',
        },
        documentation: {
          signature: 'documentation(): Promise<string>',
          summary: 'The full readout (effective API + workflow docs) — the same object as agent.documentation',
        },
      },
    },
    'agent.browsers.tabs': {
      summary: 'Tab registry of THIS conversation. Other conversations are invisible.',
      members: {
        list: { signature: 'list(): Promise<Array<{id, url, title}>>', summary: 'Rebind protocol step 1 — list before every logical batch' },
        get: { signature: 'get(id): Promise<Tab>', summary: 'Rebind protocol step 2 — fails loudly for a closed/foreign id' },
        new: {
          signature: "new({ url }?): Promise<Tab & { opened: 'new'; note: string }>",
          summary: 'ALWAYS creates a tab (never reuses); the note names it and says whether it is about:blank',
        },
      },
    },
    'agent.browsers.favorites': {
      summary:
        "The user's curated sites (收藏) — where they WANT to go; history is where they went. Store-backed, same on every backend.",
      members: {
        list: {
          signature: 'list(): Promise<Array<{url, title, createdAt, updatedAt}>>',
          summary: 'Newest first — when the user names a saved site (「打开我收藏的知乎」), match by title/host here and open() the STORED url, never a reconstructed one',
        },
        add: {
          signature: "add(url, title?): Promise<{url, title, added: true | 'already'}>",
          summary:
            "Save a site on the user's explicit ask only (「收藏一下」) — navigating never auto-populates; 'already' means it was saved before, tell the user",
        },
        remove: { signature: 'remove(url): Promise<boolean>', summary: '取消收藏; false = that url was not saved' },
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
        domSnapshot: {
          signature: 'domSnapshot(): Promise<string>',
          summary: 'Numbered interactive elements ([N]) first, then the AI/ARIA tree — the default and primary observation',
        },
        readText: {
          signature: 'readText({ selector?, budget?, offset? }?): Promise<{text, totalChars, truncated, strategy}>',
          summary:
            'PLAIN TEXT reading channel — the cheap complement to domSnapshot (which is for ADDRESSING actions): no argument reads the auto-detected MAIN content (article/[role=main] → largest text block → body); {selector} reads one container\u2019s text (a result list: \'.b_results\'); budget/offset page through long text. Read with this, act with domSnapshot',
        },
        screenshot: {
          signature: 'screenshot({ fullPage?, selector?, save? }?): Promise<{emitted, path?}>',
          summary:
            "Screenshot emitted inline in the same call — never returned as bytes; save: true (or a bare filename) writes an auto-named/named PNG to Downloads, while any path — ~/Desktop/名称.png, absolute, or a portable desktop/ documents/ downloads/ pictures/ token — writes exactly there. Missing folders are created, existing files are never overwritten; returns the absolute path",
        },
        evaluate: { signature: 'evaluate(expression): Promise<unknown>', summary: 'Run JS in the page (page context, not the kernel)' },
        playwright: {
          signature: "playwright(ref | selector | locator, op, arg?, { timeoutMs }?): Promise<unknown>",
          summary:
            "THE selector engine (this is the executor; `agent.playwright` only BUILDS locators): one op — click/fill/count/textContent/… A bare number N addresses snapshot ref [N]. State-changing ops answer with a change signal: 「未检测到本页变化」 means the page did not react — check tabs.list() for a popup, then re-snapshot; never retry the old ref",
        },
        waitForTimeout: { signature: 'waitForTimeout(ms): Promise<void>', summary: 'Bounded sleep (≤30s). Prefer tab.waitFor over fixed sleeps' },
        waitFor: {
          signature: "waitFor({ selector? | url? | js? | loadState?, timeoutMs? }): Promise<{met, waitedFor, elapsedMs, note?}>",
          summary:
            'CONDITIONAL wait, exactly ONE trigger: selector becomes visible; url matches — Playwright EXACT/glob match, NOT a substring (\'**/results*\' works, bare \'results\' never matches); js predicate turns true (e.g. () => document.querySelectorAll(\'.item\').length >= 10); loadState: \'domcontentloaded\'/\'load\'/\'networkidle\' (one-shot only, never a navigation default). met:false on timeout — re-snapshot instead of retrying the same condition',
        },
        mouse: {
          signature:
            'mouse: { click(x, y, { button?, clickCount?, delayMs? }?), move(x, y), wheel(deltaX, deltaY), drag({x,y}, {x,y}, { steps? }), down({ button? }), up({ button? }) }',
          summary:
            'REAL pointer input at viewport coordinates — trusted events, no locator, no focus needed. The one channel for canvas / custom-drawn apps (在线表格、白板：domSnapshot 只有工具栏壳，值在像素里). drag takes TWO POINT OBJECTS (never bare numbers); down()/up() are the press/release primitives for drag chains drag() cannot express. Derive coordinates from DOM anchors (evaluate + getBoundingClientRect), NEVER guess; right-click = click(x, y, { button: \'right\' }) — the menu it pops IS in the DOM; double-click = clickCount: 2. Returns VOID with no success signal: a click at empty pixels lands nowhere and still reports ok — verify the DOM effect before building on it',
        },
        keyboard: {
          signature: "keyboard: { press('Control+a' | 'Enter' | 'ArrowDown' | …), type(text, { delayMs? }?), down(key), up(key) }",
          summary:
            'REAL keyboard to whatever HAS FOCUS — reaches canvas editors that locator fill/press cannot (fill sets a value the canvas ignores; measured: it looks done and nothing happened). Click the target first, then type; Playwright key names, \'+\' composes modifiers. down()/up() hold/release WITHOUT typing — press → act → release chains press() cannot express; balance every down with an up. Returns VOID with no success signal: typing without focus lands nowhere and still reports ok — read the value back before building on it',
        },
        clipboard: {
          signature: 'clipboard: { read(): Promise<string>, write(text): Promise<void> }',
          summary:
            'System clipboard via the main process — THE read-back channel for canvas apps: select → press(\'Control+c\') → read() the TSV; write(text) + press(\'Control+v\') pastes into grid editors. read() sees the USER\u2019s system clipboard — call it only right after your own copy keystroke; every read is audited',
        },
      },
    },
    'agent.playwright': {
      summary: 'Locator FACTORY — getBy* chains serialize to Playwright internal selectors. It does NOT act: hand a locator to `tab.playwright(locator, op)`, or address by snapshot number `tab.playwright(3, \'click\')`.',
      members: {
        getByRole: { signature: 'getByRole(role, { name?, exact?, checked?, disabled?, level? })', summary: 'ARIA role locator' },
        getByText: { signature: 'getByText(text, { exact? })', summary: 'Text content locator' },
        getByLabel: { signature: 'getByLabel(text, { exact? })', summary: 'Form label locator' },
        getByPlaceholder: { signature: 'getByPlaceholder(text, { exact? })', summary: 'Input placeholder locator' },
        getByTestId: { signature: 'getByTestId(id)', summary: 'Test id locator' },
        ref: { signature: 'ref(n)', summary: 'Snapshot ref locator: the [N] from this tab\u2019s latest domSnapshot()' },
        selector: { signature: 'selector(raw)', summary: 'Raw CSS/XPath escape hatch' },
        chain: { signature: '.getBy*(...) .first() .last() .nth(i)', summary: 'Narrow within a locator' },
      },
    },
    'agent.documentation': {
      summary: 'Callable: `documentation()` prints everything (effective API + workflow). Its `.list()` / `.get(name)` fetch one lookup document. Same object as `agent.browsers.documentation`.',
      members: {
        list: { signature: 'list(): Promise<Array<{name, mode, title}>>', summary: 'Available documents' },
        get: { signature: 'get(name): Promise<string>', summary: 'Fetch one document (lookup: screenshots/app-view/real-input/troubleshooting)' },
      },
    },
    'agent.browsers.user': {
      summary: 'Pane surfaces (A-M5): the pane is bound to this conversation; user tabs share the tabs registry.',
      members: {
        openTabs: {
          signature: 'openTabs(): Promise<Array<{id, url, title}>>',
          summary: 'This conversation\u2019s pane tabs (user-created ones included)',
        },
        claimTab: {
          signature: 'claimTab(id): Promise<Tab>',
          summary: 'Validate a pane tab belongs to this conversation — user tabs are already in tabs.list()',
        },
      },
      // Requires the in-app view backend (M3) — hidden entirely on managed.
      unsupportedByDefaultIn: ['managed'],
    },
  },
}
