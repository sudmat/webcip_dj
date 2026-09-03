import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VTK.js ships ES modules and works with Vite out of the box. We import only the
// modules we use (tree-shaken) — see frontend/src/render/vtk-init.ts. The dev proxy
// forwards API calls to the FastAPI backend so the browser talks to one origin.
export default defineConfig({
  // Emit RELATIVE asset URLs so one build serves from any mount point — '/' locally and
  // '/webcip/' behind the PHP site's Apache. See src/api/paths.ts for the URLs Vite cannot
  // rewrite (those built as strings in TS).
  base: './',
  plugins: [react()],
  server: {
    // Dev: forward /api/* to the FastAPI backend (which serves the API under /api),
    // so browser paths are identical in dev and prod.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8011', changeOrigin: true },
    },
  },
});
