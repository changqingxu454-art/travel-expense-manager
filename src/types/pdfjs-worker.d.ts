/**
 * pdfjs-dist 未为 worker 模块提供类型声明。
 *
 * 该模块只在测试中被直接 import（jsdom 无 Web Worker，需要让 PDF.js
 * 使用主线程 worker），生产代码通过 Vite 的 `?url` 资源引用它，因此这里
 * 仅补充最小声明，不产生任何运行时依赖。
 */
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
