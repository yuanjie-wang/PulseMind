/** The panel's stylesheet is bundled as text (esbuild `loader: {'.css':'text'}`)
 *  and injected into the Shadow Root, so importing it yields a string. */
declare module '*.css' {
  const css: string
  export default css
}
