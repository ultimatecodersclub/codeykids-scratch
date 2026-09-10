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
  server: { port: 8601 },
});
