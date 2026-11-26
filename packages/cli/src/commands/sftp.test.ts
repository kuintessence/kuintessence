import { expect, test } from "bun:test";
import { copyAgent } from "./sftp";

test("scp binds one remote endpoint to its Agent and keeps local paths local", () => {
  expect(copyAgent("./a:b", "cluster-1:/files/x y")).toBe("cluster-1");
  expect(copyAgent("cluster-1:relative", "/tmp/out")).toBe("cluster-1");
  for (const [source, target] of [
    ["local", "local"],
    ["a:x", "b:y"],
    ["-oProxyCommand=x:file", "x"],
    ["agent:", "x"],
  ] as const)
    expect(() => copyAgent(source, target)).toThrow();
});
