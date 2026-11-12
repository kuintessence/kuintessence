import { expect, test } from "bun:test";
import { formalBuildVariables } from "./build-environment";

test("formal build environment cannot inherit preload, global configuration, proxy or credential variables", () => {
  const root = "/private/build-environment";
  const env = formalBuildVariables(root);
  expect(env).toMatchObject({
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_CACHE_HOME: `${root}/cache`,
    TMPDIR: `${root}/tmp`,
    PATH: `${root}/bin:/usr/bin:/bin`,
    npm_config_userconfig: `${root}/empty-npmrc`,
    npm_config_globalconfig: `${root}/empty-npmrc`,
  });
  for (const key of [
    "NODE_OPTIONS",
    "BUN_OPTIONS",
    "NODE_PATH",
    "BUN_CONFIG",
    "BUN_PRELOAD",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NPM_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "SSH_AUTH_SOCK",
  ]) {
    expect(env[key]).toBeUndefined();
  }
});

test("only explicitly verified CA file paths cross into the formal build", () => {
  const env = formalBuildVariables("/private/build", {
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    NODE_EXTRA_CA_CERTS: "/verified/site-ca.crt",
  });
  expect(env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
  expect(env.NODE_EXTRA_CA_CERTS).toBe("/verified/site-ca.crt");
  expect(formalBuildVariables("/private/build").SSL_CERT_DIR).toBeUndefined();
});
