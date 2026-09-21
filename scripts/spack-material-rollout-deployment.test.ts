import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const chart = "deploy/helm/kq-platform";

interface Compose {
  services: Record<string, { environment?: Record<string, string>; volumes?: string[] }>;
  volumes: Record<string, unknown>;
}

interface Values {
  spackMaterial?: { epoch: string };
  registry: {
    replicas: number;
    persistence: { enabled: boolean; mountPath: string };
  };
}

describe("Spack material rollout deployment (offline, no process execution)", () => {
  for (const [file, serviceName, volume, mount, postgresVolume] of [
    [
      "docker-compose.yml",
      "registry",
      "registry-data",
      "/var/lib/kuintessence/registry",
      "pg-data",
    ],
    [
      "docker-compose.schedulers.yml",
      "registry",
      "scheduler-registry-data",
      "/var/lib/kuintessence/registry",
      "scheduler-pg-data",
    ],
    [
      "docker-compose.preview.yml",
      "registry",
      "registry-data",
      "/var/lib/kuintessence/registry",
      "pg-data",
    ],
    ["docker-compose.aio.yml", "kq", "kq-aio-data", "/data", undefined],
  ] as const) {
    test(`${file} shares an optional epoch without replacing persistence or auth`, async () => {
      const config = parse(await read(`deploy/compose/${file}`), { merge: true }) as Compose;
      const materialService = config.services[serviceName];
      const participants = serviceName === "kq" ? ["kq"] : ["server", "registry"];
      for (const name of participants) {
        expect(config.services[name]?.environment?.SPACK_MATERIAL_EPOCH).toBe(
          `\${SPACK_MATERIAL_EPOCH:-}`,
        );
      }
      const recipients = Object.entries(config.services)
        .filter(([, service]) => service.environment?.SPACK_MATERIAL_EPOCH !== undefined)
        .map(([name]) => name)
        .sort();
      expect(recipients).toEqual([...participants].sort());

      expect(materialService?.volumes).toContain(`${volume}:${mount}`);
      expect(config.volumes).toHaveProperty(volume);
      const directory = serviceName === "kq" ? "/data/registry" : mount;
      expect(materialService?.environment?.SPACK_RECIPE_STORE_DIR).toBe(`${directory}/recipes`);
      expect(materialService?.environment?.SPACK_MATERIAL_STORE_DIR).toBe(`${directory}/materials`);
      if (postgresVolume) {
        expect(config.services.postgres?.volumes).toContain(
          `${postgresVolume}:/var/lib/postgresql/data`,
        );
        expect(config.volumes).toHaveProperty(postgresVolume);
        const server = config.services.server?.environment;
        const registry = materialService?.environment;
        expect(server?.DATABASE_URL).toBeDefined();
        expect(registry?.DATABASE_URL).toBe(server?.DATABASE_URL);
        expect(server?.JWT_SECRET).toBeDefined();
        expect(registry?.REGISTRY_AUTH_MODE).toBe("jwt");
        expect(registry?.REGISTRY_JWT_SECRET).toBe(server?.JWT_SECRET);
      }
    });
  }

  test("Helm defaults to no epoch across base, production and testing values", async () => {
    const values = parse(await read(`${chart}/values.yaml`)) as Values;
    expect(values.spackMaterial).toEqual({ epoch: "" });
    expect(values.registry.replicas).toBe(1);
    expect(values.registry.persistence.enabled).toBe(true);
    expect(values.registry.persistence.mountPath).toBe("/var/lib/kuintessence/registry/blobs");
    for (const file of ["values.production.yaml", "values.testing.yaml"]) {
      const override = parse(await read(`${chart}/${file}`)) as Values;
      expect(override.spackMaterial?.epoch ?? values.spackMaterial?.epoch).toBe("");
    }
  });

  for (const component of ["server", "registry"]) {
    test(`Helm ${component} shares the optional epoch and retains Secrets`, async () => {
      const template = await read(`${chart}/templates/${component}-deployment.yaml`);
      expect(template).toMatch(
        /{{- if \.Values\.spackMaterial\.epoch }}\s+- name: SPACK_MATERIAL_EPOCH\s+value: {{ \.Values\.spackMaterial\.epoch \| quote }}\s+{{- end }}/,
      );
      expect(template.match(/name: SPACK_MATERIAL_EPOCH/g)).toHaveLength(1);
      expect(template).toContain('{{- include "kq.databaseEnv" . | nindent 12 }}');
      expect(template).toMatch(
        /name: (?:REGISTRY_)?JWT_SECRET\s+valueFrom:\s+secretKeyRef:\s+name: {{ include "kq.secretName" \. }}\s+key: JWT_SECRET/,
      );
      expect(template).not.toContain(`.Values.${component}.spackMaterial`);
    });
  }

  test("Helm retains the Registry single-writer storage and upstream Secret reference", async () => {
    const template = await read(`${chart}/templates/registry-deployment.yaml`);
    expect(template).toContain(
      'fail "registry.recipes.enabled requires registry.persistence.enabled"',
    );
    expect(template).toContain('fail "registry.recipes.enabled requires registry.replicas=1"');
    expect(template).toContain("type: Recreate");
    expect(template).toContain("claimName: {{ .Release.Name }}-registry-blobs");
    expect(template).toContain('printf "%s/recipes"');
    expect(template).toContain('printf "%s/materials"');
    expect(template).toMatch(
      /name: SPACK_UPSTREAM_PROXY_URL\s+valueFrom:\s+secretKeyRef:\s+name: {{ \.Values\.registry\.upstream\.proxySecretRef\.name \| quote }}/,
    );
  });
});

describe("Spack material rollout documentation (offline reads only)", () => {
  test("visibility activation documents one-way fencing and old-ticket revocation", async () => {
    const guide = await read("docs/spack-material-visibility.md");
    const commands = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
      (match) => JSON.parse(match[1] ?? "") as Record<string, unknown>,
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      action: "activate-policy",
      operatorId: "<current operator UUID>",
      epoch: "<epoch returned by pause>",
      evidence: {
        legacyProcessesStoppedAndDrained: true,
        legacyAccessRevoked: true,
        legacyInventoryComplete: true,
      },
    });
    expect(commands[1]).toMatchObject({
      policy: { mode: "allowlist", orgIds: [] },
      expectedRevision: 0,
    });
    expect(JSON.stringify(commands)).not.toMatch(/DATABASE_URL|SECRET|PASSWORD|TOKEN/);
    for (const text of [
      "policy-ready",
      "policy-paused",
      "不可退回",
      "旧 ticket",
      "不是跨组织分享",
      "100",
    ]) {
      expect(guide).toContain(text);
    }
    expect(guide).toContain("](spack-material-rollout.md)");
    expect(await read("docs/spack-material-rollout.md")).toContain(
      "](spack-material-visibility.md)",
    );
  });

  test("retirement documentation requires explicit configuration removal and preserves history", async () => {
    const guide = await read("docs/spack-binding-retirement.md");
    const commands = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
      (match) => JSON.parse(match[1] ?? "") as Record<string, unknown>,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      action: "retire",
      operatorId: "<current operator UUID>",
      expectedRevision: 2,
      epoch: "<epoch returned by pause>",
      inventoryDigest: "sha256:<current reconciled inventory digest>",
      evidence: {
        legacyProcessesStoppedAndDrained: true,
        legacyAccessRevoked: true,
        legacyInventoryComplete: true,
        bindingConfigurationsRemoved: true,
      },
    });
    expect(guide).toContain("retiredBindingCount");
    expect(guide).toContain("不会恢复");
    expect(guide).toContain("整批回滚");
    expect(guide).toContain("已经支持 epoch、但还没有退役检查");
    expect(guide).toContain(
      "bun packages/db/src/spack-material-rollout-cli.ts <absolute-command-json-path>",
    );
    expect(JSON.stringify(commands)).not.toMatch(/DATABASE_URL|SECRET|PASSWORD|TOKEN/);
    const rollout = await read("docs/spack-material-rollout.md");
    expect(rollout).toContain("](spack-binding-retirement.md)");
  });

  test("command examples describe inspect, pause, reconcile and activate without credentials", async () => {
    const guide = await read("docs/spack-material-rollout.md");
    const commands = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
      (match) => JSON.parse(match[1] ?? "") as Record<string, unknown>,
    );
    expect(commands.map((command) => command.action)).toEqual([
      "inspect",
      "pause",
      "reconcile",
      "activate",
    ]);
    expect(commands[0]).toEqual({ action: "inspect" });
    for (const command of commands.slice(1)) {
      expect(command.operatorId).toBe("<current operator UUID>");
      expect(typeof command.expectedRevision).toBe("number");
    }
    expect(commands[1]).not.toHaveProperty("epoch");
    for (const command of commands.slice(2)) {
      expect(command.epoch).toBe("<epoch returned by pause>");
    }
    expect(commands[2]?.bindings).toEqual([
      {
        "zlib@1.3.1": {
          repositoryId: "<historical namespace SHA-256 hash: 64 lowercase hex>",
          manifestDigest: "sha256:<historical manifest digest>",
        },
      },
      {
        "zlib@1.3.1": {
          repositoryId: "<another historical namespace SHA-256 hash: 64 lowercase hex>",
          manifestDigest: "sha256:<another historical manifest digest>",
        },
      },
    ]);
    expect(commands[3]?.inventoryDigest).toBe("sha256:<current reconciled inventory digest>");
    expect(commands[3]?.evidence).toEqual({
      legacyProcessesStoppedAndDrained: true,
      legacyAccessRevoked: true,
      legacyInventoryComplete: true,
    });
    expect(JSON.stringify(commands)).not.toMatch(/DATABASE_URL|SECRET|PASSWORD|TOKEN/);
    expect(guide).toContain(
      "bun packages/db/src/spack-material-rollout-cli.ts <absolute-command-json-path>",
    );
  });

  test("the rollout guide and its entry links resolve to local documentation", async () => {
    const guideUrl = new URL("../docs/spack-material-rollout.md", import.meta.url);
    const guide = await readFile(guideUrl, "utf8");
    const links = [...guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = new URL(link[1] ?? "", guideUrl);
      expect(target.protocol).toBe("file:");
      expect((await readFile(target, "utf8")).length).toBeGreaterThan(0);
    }
    for (const file of ["deployment.md", "spack-material-delivery.md", "status/current-state.md"]) {
      const entryUrl = new URL(`../docs/${file}`, import.meta.url);
      const entry = await readFile(entryUrl, "utf8");
      const relative = file.startsWith("status/")
        ? "../spack-material-rollout.md"
        : "spack-material-rollout.md";
      expect(entry).toContain(`](${relative})`);
      expect(new URL(relative, entryUrl).href).toBe(guideUrl.href);
    }
    const deployment = await read("docs/deployment.md");
    expect(deployment).toContain("](#spack-material-rollout)");
    expect(deployment).toContain('<a id="spack-material-rollout"></a>');
  });
});
