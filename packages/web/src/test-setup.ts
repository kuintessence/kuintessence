// Ensure localStorage is properly available in the happy-dom test environment.
// happy-dom 20.x exposes localStorage as an object but its methods may not be
// bound to the globalThis scope in all vitest configurations. This shim
// covers the gap without pulling in a full jsdom dependency.
if (
  typeof globalThis.localStorage === "undefined" ||
  typeof globalThis.localStorage.getItem !== "function"
) {
  const store: Record<string, string> = {};
  const storage: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    key(index: number): string | null {
      return Object.keys(store)[index] ?? null;
    },
    getItem(key: string): string | null {
      return Object.hasOwn(store, key) ? (store[key] ?? null) : null;
    },
    setItem(key: string, value: string): void {
      store[key] = value;
    },
    removeItem(key: string): void {
      delete store[key];
    },
    clear(): void {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    writable: false,
  });
}
