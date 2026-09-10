import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // The Scratch bundle resolves some of its `static/...` URLs relative to its
  // own script URL, so the built script must sit at the site root, next to
  // the `static/` directory.
  build: { assetsDir: "" },
  plugins: [react()],
  server: { port: 8601 },
});
