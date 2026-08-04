export function resolveLocalPaths(text: string): string {
  return text
    // Bare /.pulsemind/tmp/ paths → local-file protocol
    .replace(/\/\.pulsemind\/tmp\//g, 'local-file:///.pulsemind/tmp/')
    // Standalone file:// → local-file (not inside local-file://)
    .replace(/(?<!local-)file:\/\//g, 'local-file://')
}
