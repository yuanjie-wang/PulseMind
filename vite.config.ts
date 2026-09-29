import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  resolve: {
    alias: [
      // 锚定裸说明符（正则带 $）：react-syntax-highlighter 的根入口把
      // highlight.js 的全量语言表（1.54MB）和 PrismLight 一起 re-export，图内
      // 全部导入方（我们的 CodeHighlight 与 @ant-design/x 的 mermaid 链）只要
      // PrismLight —— 指到深路径后那 1.54MB 与 ~190 个语言 chunk 不再进包。
      // 深路径样式导入（…/styles/prism/oneLight）不经此条，原样解析。
      {
        find: /^react-syntax-highlighter$/,
        replacement: resolve(__dirname, 'src/renderer/src/vendor/react-syntax-highlighter-prism-light.ts'),
      },
      { find: '@', replacement: resolve(__dirname, 'src/renderer/src') },
      { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
    ],
  },
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'antd'],
        },
      },
    },
  },
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
})
