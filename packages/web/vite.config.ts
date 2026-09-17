import { resolve } from "node:path";
import tailwind from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const repoRoot = resolve(__dirname, "../..");
const serverProxyTarget = process.env.KQ_WEB_SERVER_PROXY_TARGET ?? "http://localhost:3000";
const localRegistryPort = new URL(serverProxyTarget).port === "13000" ? "13100" : "3100";
const registryProxyTarget =
  process.env.KQ_WEB_REGISTRY_PROXY_TARGET ?? `http://localhost:${localRegistryPort}`;
const reactRefreshPreambleCompat = {
  name: "react-refresh-preamble-compat",
  apply: "serve" as const,
  transformIndexHtml() {
    return [
      {
        tag: "script",
        attrs: { type: "module" },
        children: [
          'import RefreshRuntime from "/@react-refresh";',
          "RefreshRuntime.injectIntoGlobalHook(window);",
          "window.$RefreshReg$ = () => {};",
          "window.$RefreshSig$ = () => (type) => type;",
          "window.__vite_plugin_react_preamble_installed__ = true;",
        ].join("\n"),
        injectTo: "head-prepend" as const,
      },
    ];
  },
};

export default defineConfig({
  plugins: [
    reactRefreshPreambleCompat,
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
    tailwind(),
  ],
  // Bun installs `react` / `react-dom` both at the workspace root (used by the
  // hoisted `@xyflow/react`) and inside this package. Pin them to a single
  // copy so dev / build do not double-load React.
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5173,
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      "/api": serverProxyTarget,
      "/platform/api": {
        target: serverProxyTarget,
        cookiePathRewrite: {
          "/api/auth/oidc": "/platform/api/auth/oidc",
          "/api/auth": "/platform/api/auth",
        },
        rewrite: (path) => path.replace(/^\/platform/, ""),
      },
      "/platform/ws": {
        target: serverProxyTarget,
        rewrite: (path) => path.replace(/^\/platform/, ""),
        ws: true,
      },
      "/software/api": {
        target: registryProxyTarget,
        rewrite: (path) => path.replace(/^\/software/, ""),
      },
      "/software/v2": {
        target: registryProxyTarget,
        rewrite: (path) => path.replace(/^\/software/, ""),
      },
      "/software/buildcache": {
        target: registryProxyTarget,
        rewrite: (path) => path.replace(/^\/software/, ""),
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    exclude: ["node_modules", "dist", "e2e", ".idea", ".git", ".cache"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      include: ["src/lib/**/*.ts"],
      // Generated, side-effect-only, or framework-glue files don't carry test value.
      exclude: ["src/lib/query-client.ts", "src/lib/**/*.test.ts", "src/lib/**/index.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
