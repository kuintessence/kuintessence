import { expect, test } from "bun:test";
import type { Spawner } from "../adapters/base";
import { LocalSoftwareCatalog } from "./software-catalog";

const spackJson = JSON.stringify([
  {
    name: "gromacs",
    version: "2024.1",
    hash: "gromacs-spec",
    compiler: { name: "gcc", version: "13" },
  },
  { name: "openmpi", version: "5.0.3", hash: "openmpi-spec" },
]);

/** Spawner that returns a fixed result per argv[0]; default exit 127 (not found). */
function spawner(
  map: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): Spawner {
  return {
    async run(cmd) {
      return map[cmd[0] ?? ""] ?? { exitCode: 127, stdout: "", stderr: "command not found" };
    },
  };
}

test("detect reports spack present, modules absent", async () => {
  const cat = new LocalSoftwareCatalog({
    spawner: spawner({ spack: { exitCode: 0, stdout: "spack 0.21", stderr: "" } }),
  });
  expect(await cat.detect()).toEqual({ spack: true, modules: false });
});

test("detect reports modules present via module --version", async () => {
  const cat = new LocalSoftwareCatalog({
    spawner: spawner({ module: { exitCode: 0, stdout: "Modules 5.3", stderr: "" } }),
  });
  expect(await cat.detect()).toEqual({ spack: false, modules: true });
});

test("listInstalled parses spack find --json", async () => {
  const cat = new LocalSoftwareCatalog({
    spawner: spawner({ spack: { exitCode: 0, stdout: spackJson, stderr: "" } }),
  });
  const list = await cat.listInstalled();
  expect(list).toContainEqual({
    name: "gromacs",
    version: "2024.1",
    hash: "gromacs-spec",
    compiler: "gcc@13",
    spec: "gromacs@2024.1%gcc@13",
    source: "spack",
  });
  expect(list).toContainEqual({
    name: "openmpi",
    version: "5.0.3",
    hash: "openmpi-spec",
    spec: "openmpi@5.0.3",
    source: "spack",
  });
});

test("listInstalled degrades to [] when neither tool exists", async () => {
  const cat = new LocalSoftwareCatalog({ spawner: spawner({}) });
  expect(await cat.detect()).toEqual({ spack: false, modules: false });
  expect(await cat.listInstalled()).toEqual([]);
});

test("listInstalled tolerates malformed spack json without throwing", async () => {
  const cat = new LocalSoftwareCatalog({
    spawner: spawner({ spack: { exitCode: 0, stdout: "not json{", stderr: "" } }),
  });
  expect(await cat.listInstalled()).toEqual([]);
});
