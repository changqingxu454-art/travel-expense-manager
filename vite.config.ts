/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoName = 'travel-expense-manager';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // GitHub Pages 项目站点通过 https://<user>.github.io/<repo>/ 访问，
  // 因此生产构建需要带上仓库名的 base 前缀；本地开发保持根路径。
  base: command === 'build' ? `/${repoName}/` : '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
}));
