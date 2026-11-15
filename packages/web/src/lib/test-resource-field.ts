/** Existing form tests exercise the native event/FormData bridge; picker interaction has dedicated tests. */
export function nativeControl(element: HTMLElement): HTMLElement {
  if (element.matches('button[role="combobox"]')) {
    const select = element.parentElement?.querySelector<HTMLSelectElement>(
      'select[aria-hidden="true"]',
    );
    if (select) return select;
  }
  return element;
}
