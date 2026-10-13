const { expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { parse } = require("yaml");
for (const file of ["deploy/main/compose.yml", "deploy/compose/docker-compose.yml"]) {
  test(`${file}: optional read-only seed waits for migration and gates Web readiness`, () => {
    const compose = parse(readFileSync(file, "utf8"));
    const registry = compose.services.registry;
    expect(registry.environment.OFFLINE_DELIVERY_SEED).toBe(`\${OFFLINE_DELIVERY_SEED:-}`);
    expect(registry.environment.OFFLINE_DELIVERY_SEED_SUBJECT).toBe(
      `\${OFFLINE_DELIVERY_SEED_SUBJECT:-}`,
    );
    expect(registry.volumes).toContain(`\${KQ_SEED_DIRECTORY:-./seed}:/opt/kq-seed:ro`);
    expect(registry.depends_on["db-migrate"].condition).toBe("service_completed_successfully");
    expect(JSON.stringify(registry.healthcheck)).toContain("/api/ready");
    expect(compose.services.web.depends_on.registry.condition).toBe("service_healthy");
  });
}
