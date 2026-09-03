import { defineConfig } from 'vitest/config';

// Core-math tests (P0.5) run in plain node — no plugins, so no vite/vitest plugin
// type clash. The app's vite.config.ts stays dedicated to dev/build.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
