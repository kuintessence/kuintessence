import { resolve } from "node:path";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react(), tailwind()],
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: resolve(import.meta.dirname, "../../../.impeccable/review/function-maps-build"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "function-maps.html") },
  },
});
