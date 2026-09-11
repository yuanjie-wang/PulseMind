// ── Tool bridge SDK (PLAN-0.4.0 M6.2) ──
// Injected into every tool page before it lands in the sandboxed iframe.
// Exposes `window.pulsemind.*` over postMessage; every call returns a Promise.
// The SDK holds no trusted state — the host validates everything.

export const TOOL_SDK_SCRIPT = `
<script>
(function () {
  'use strict'
  var seq = 0
  var pending = new Map()
  var TIMEOUT_MS = 30000

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = 'c' + (++seq) + '_' + Date.now()
      var timer = setTimeout(function () {
        pending.delete(id)
        reject(new Error('bridge timeout'))
      }, TIMEOUT_MS)
      pending.set(id, { resolve: resolve, reject: reject, timer: timer })
      window.parent.postMessage({
        source: 'pulsemind-tool', id: id, method: method, params: params || {},
        toolId: window.name || undefined,
      }, '*')
    })
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.source !== 'pulsemind-tool-host' || !pending.has(data.id)) return
    var entry = pending.get(data.id)
    pending.delete(data.id)
    clearTimeout(entry.timer)
    if (data.ok) entry.resolve(data.result)
    else {
      var err = new Error((data.error && data.error.message) || 'bridge error')
      err.code = data.error && data.error.code
      entry.reject(err)
    }
  })

  function guard(fn) {
    return function (params) { return call(fn, params) }
  }

  window.pulsemind = {
    http: {
      request: guard('http.request'),
    },
    fs: {
      readText: guard('fs.readText'),
      writeText: guard('fs.writeText'),
      list: guard('fs.list'),
      exists: guard('fs.exists'),
    },
    storage: {
      get: function (key) { return call('storage.get', { key: key }) },
      set: function (key, value) { return call('storage.set', { key: key, value: value }) },
      remove: function (key) { return call('storage.remove', { key: key }) },
      keys: function () { return call('storage.keys', {}) },
    },
    system: {
      clipboard: {
        writeText: function (text) { return call('system.clipboard.write', { text: text }) },
        readText: function () { return call('system.clipboard.read', {}) },
      },
      notify: function (opts) { return call('system.notify', opts || {}) },
      openExternal: function (url) { return call('system.openExternal', { url: url }) },
    },
    meta: { bridgeVersion: 1 },
  }
})()
</script>`
