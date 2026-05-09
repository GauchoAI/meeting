import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.MEETING_WEB_PORT || 5173)
  },
  build: {
    rollupOptions: {
      input: {
        main: `${rootDir}/index.html`,
        realtime: `${rootDir}/realtime.html`
      }
    }
  }
});
