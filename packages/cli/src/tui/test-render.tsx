import { afterEach } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";

type TestRenderer = Awaited<ReturnType<typeof testRender>>["renderer"];

const activeRenderers = new Set<TestRenderer>();

afterEach(() => {
  for (const renderer of activeRenderers) renderer.destroy();
  activeRenderers.clear();
});

function normalizeFrame(frame: string): string {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

export async function render(node: ReactNode, width = 120, height = 40) {
  const setup = await testRender(node, { width, height, kittyKeyboard: true });
  activeRenderers.add(setup.renderer);
  await setup.renderOnce();
  return {
    lastFrame: () => normalizeFrame(setup.captureCharFrame()),
    mockInput: setup.mockInput,
    flush: async () => {
      await act(async () => setup.flush());
    },
    resize: setup.resize,
    unmount: () => {
      setup.renderer.destroy();
      activeRenderers.delete(setup.renderer);
    },
  };
}
