export function resolveLocalPaths(text: string): string {
  return text
    // App-config tmp paths → local-file protocol. Two token-start shapes — the
    // `~/…` form the offload notes emit, and a bare path whose `/.pulsemind`
    // begins the token. The anchoring is load-bearing: workspaces keep their
    // own .pulsemind/tmp/ (2026-10-01 scratch convention), and a project path
    // like /Users/x/proj/.pulsemind/tmp/f.txt must pass through untouched — a
    // bare-substring rewrite would serve it from the config dir instead.
    .replace(/~\/\.pulsemind\/tmp\//g, 'local-file:///.pulsemind/tmp/')
    .replace(/(^|[\s"'(（【])\/\.pulsemind\/tmp\//g, '$1local-file:///.pulsemind/tmp/')
    // Standalone file:// → local-file (not inside local-file://)
    .replace(/(?<!local-)file:\/\//g, 'local-file://')
}
