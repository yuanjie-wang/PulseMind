// Self-healing Vite dev server wrapper.
//
// Dev mode runs Vite + Electron under `concurrently -k`. When Vite dies for any
// reason (an external SIGTERM, an unhandled error), the `-k` flag tears down the
// whole tree — including Electron — which the user experiences as a crash.
//
// This wrapper keeps the renderer alive: Vite is respawned on any exit that
// wasn't triggered by a signal this process itself received. Since `concurrently`
// only tracks the wrapper's PID, a Vite restart no longer cascades into Electron
// being killed. Electron's HMR WebSocket reconnects to the revived server and the
// app recovers instead of quitting.
//
// Intentional teardown still works: Ctrl+C (SIGINT) or a signal sent to the whole
// process group reaches the wrapper, is forwarded to Vite, and the wrapper exits.

const { spawn } = require('node:child_process')
const path = require('node:path')

// Resolve Vite's CLI entry so we don't depend on how `npm run` resolves `vite`.
// `vite/bin/vite.js` is not in Vite's "exports" map, so resolve the package
// root via package.json (which is exported) and join its bin path instead.
const vitePkgPath = require.resolve('vite/package.json')
const viteBin = path.join(path.dirname(vitePkgPath), require(vitePkgPath).bin.vite)

let child = null
let stopping = false

function forwardSignals() {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => {
      if (stopping) return
      stopping = true
      console.log(`[dev-renderer] received ${sig} — shutting down`)
      if (child) child.kill(sig)
    })
  }
}

function startVite() {
  child = spawn(process.execPath, [viteBin], {
    stdio: 'inherit',
    env: process.env,
  })

  child.on('exit', (code, signal) => {
    child = null
    console.log(`[dev-renderer] vite exited (code=${code}, signal=${signal})`)

    if (stopping) {
      console.log('[dev-renderer] teardown complete — exiting')
      process.exit(code == null ? 0 : code)
    }

    // Unexpected Vite death: bring it back. The 1s pause lets the old port
    // release before the new server binds to it.
    console.log('[dev-renderer] unexpected exit — restarting vite in 1s')
    setTimeout(startVite, 1000)
  })
}

forwardSignals()
startVite()
