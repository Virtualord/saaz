import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Explicitly anchored: without this, vitest inherits Vite's `root: web/`
    // and reports "no test files found" while silently testing nothing.
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
