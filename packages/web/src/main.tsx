import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GlobalErrorPage } from "./components/GlobalErrorPage";
import { ThemeProvider } from "./components/ThemeProvider";
import "./lib/i18n";
// Side-effect: registers MonacoEnvironment.getWorker so monaco-editor runs its
// language services in a Web Worker instead of falling back to the main thread.
import "./lib/monaco-env";
import { ensureLocalSession } from "./lib/local-mode";
import { queryClient } from "./lib/query-client";
import { routeTree } from "./routeTree.gen";
import "./styles/app.css";

// Local mode (`kq gui`) injects a trusted token before the bundle runs; promote
// it to a session here so the very first render is authenticated (no /login
// bounce). No-op outside local mode — Server mode is unaffected.
ensureLocalSession();

const router = createRouter({
  routeTree,
  defaultErrorComponent: GlobalErrorPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root");

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
