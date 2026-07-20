import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react({ include: '**/*.{js,jsx}' })],
  // Components live in .js files (the project is JavaScript per the spec, not
  // TypeScript). Vite's oxc transform excludes .js from JSX parsing by
  // default, so it must be told that .js may contain JSX. Next's own compiler
  // already assumes this; only the test runner needs telling.
  oxc: {
    include: /\.(m?ts|[jt]sx?)$/,
    exclude: /node_modules/,
    lang: 'jsx',
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
    restoreMocks: true,
  },
});
