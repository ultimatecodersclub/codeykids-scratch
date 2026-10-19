import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // The Scratch bundle resolves some of its `static/...` URLs relative to its
  // own script URL, so the built script must sit at the site root, next to
  // the `static/` directory. The other editors are pages of the same site.
  build: {
    assetsDir: "",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        python: resolve(__dirname, "python/index.html"),
        web: resolve(__dirname, "web/index.html"),
      },
    },
  },
  plugins: [react()],
  // The Python editor's real-Python worker lives under /python/, inside the
  // scope of the service worker that lets it wait for input().
  worker: {
    format: "es",
    rollupOptions: {
      output: { chunkFileNames: "python/[name]-[hash].js", entryFileNames: "python/[name]-[hash].js" },
    },
  },
  // 127.0.0.1, which localhost also reaches: the web editor's preview runs on
  // 127.0.0.1 in development, an origin apart from the editor's localhost.
  // The preview's service worker (public/preview/sw.js) serves the whole
  // 127.0.0.1 origin, as it does the preview host's in production.
  server: { headers: { "Service-Worker-Allowed": "/" }, host: "127.0.0.1", port: 8601 },
});
