import { createContext, type ReactNode, useContext } from "react";

const SurfaceContext = createContext(false);

export function SurfaceBoundary({ children }: { children: ReactNode }) {
  return <SurfaceContext.Provider value={true}>{children}</SurfaceContext.Provider>;
}

export function useInsideSurface(): boolean {
  return useContext(SurfaceContext);
}
