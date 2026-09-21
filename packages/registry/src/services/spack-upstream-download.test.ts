import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpackUpstreamImport } from "@kuintessence/shared";
import {
  cleanupMaterials,
  LOCK,
  LOCK_BLOB,
  materialFixture,
  SOURCE,
  SOURCE_BLOB,
} from "../routes/spack-materials.test-helpers";
import { OWNER, USER } from "../routes/spack-repositories.test-helpers";
import {
  SpackUpstreamDownloader,
  type SpackUpstreamInput,
  type SpackUpstreamOptions,
} from "./spack-upstream-download";
import { SpackUpstreamImportService } from "./spack-upstream-import";
import { SpackUpstreamError } from "./spack-upstream-policy";
import {
  bounded,
  createTestCertificate,
  inspectCurlChild,
  PINNED_ADDRESS,
  type ProxyTransport,
  type TestCertificate,
  UPSTREAM_BYTES,
  UPSTREAM_HOST,
  UPSTREAM_ORIGIN,
  UpstreamTestFixture,
  waitUntil,
} from "./spack-upstream-test-fixture";

const TRANSPORTS = ["http", "socks5", "socks5h"] as const;
const INPUT: SpackUpstreamInput = {
  url: `${UPSTREAM_ORIGIN}/source.tar.gz`,
  digest: `sha256:${createHash("sha256").update(UPSTREAM_BYTES).digest("hex")}`,
  size: UPSTREAM_BYTES.length,
};
const TEST_TIMEOUT = 12_000;

// TMPDIR and deliberately hostile parent environment settings require serial tests.
describe.serial("Spack upstream real curl proxy integration", () => {
  let certificate: TestCertificate;
  let fixture: UpstreamTestFixture;
  let directory: string;
  let lifetime: AbortController;
  const savedEnvironment = new Map<string, string | undefined>();
  const pending = new Set<Promise<unknown>>();

  function environment(values: Record<string, string>): void {
    for (const [name, value] of Object.entries(values)) {
      if (!savedEnvironment.has(name)) savedEnvironment.set(name, process.env[name]);
      process.env[name] = value;
    }
  }

  function downloader(
    transport: ProxyTransport,
    overrides: Partial<SpackUpstreamOptions> = {},
    lookup: (host: string, signal: AbortSignal) => Promise<string[]> = async () => [PINNED_ADDRESS],
  ): SpackUpstreamDownloader {
    return new SpackUpstreamDownloader(
      {
        proxyUrl: fixture.proxyUrl(transport),
        allowedOrigins: [UPSTREAM_ORIGIN],
        maxBytes: INPUT.size * 2,
        timeoutMs: 3_000,
        idleTimeoutMs: 1_500,
        maxConcurrent: 1,
        caBundle: certificate.caBundle,
        ...overrides,
      },
      lookup,
    );
  }

  function download(
    client: SpackUpstreamDownloader,
    input = INPUT,
    consume: (stream: ReadableStream<Uint8Array>) => Promise<Buffer> = readBytes,
    signal: AbortSignal = lifetime.signal,
  ): Promise<Buffer> {
    return track(client.withDownload(input, AbortSignal.any([lifetime.signal, signal]), consume));
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }

  async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    return Buffer.from(await new Response(stream).arrayBuffer());
  }

  async function staging(): Promise<string[]> {
    return (await readdir(directory)).filter((name) => name.startsWith("kq-spack-upstream-"));
  }

  async function rejectsSafely(
    promise: Promise<unknown>,
    category: SpackUpstreamError["category"],
  ): Promise<void> {
    let failure: unknown;
    try {
      await promise;
    } catch (error) {
      failure = error;
    }
    // Do not print a raw transport exception when a redaction regression occurs.
    expect(failure instanceof SpackUpstreamError).toBe(true);
    if (!(failure instanceof SpackUpstreamError)) throw new Error("Expected a sanitized failure");
    const exposed = `${failure.stack}\n${JSON.stringify(failure)}`;
    for (const secret of [
      fixture.username,
      fixture.password,
      encodeURIComponent(fixture.password),
      Buffer.from(`${fixture.username}:${fixture.password}`).toString("base64"),
      INPUT.url,
      certificate.caBundle,
    ]) {
      expect(exposed.includes(secret)).toBe(false);
    }
    expect(failure.category === category).toBe(true);
  }

  async function recovered(client: SpackUpstreamDownloader): Promise<void> {
    expect(await staging()).toEqual([]);
    fixture.mode = "ok";
    expect((await download(client)).equals(UPSTREAM_BYTES)).toBe(true);
    expect(await staging()).toEqual([]);
  }

  beforeAll(async () => {
    certificate = await createTestCertificate();
  }, 8_000);

  afterAll(async () => {
    await certificate?.dispose();
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kq-upstream-test-"));
    environment({ TMPDIR: directory });
    lifetime = new AbortController();
    fixture = new UpstreamTestFixture(certificate);
    await fixture.start();
  });

  afterEach(async () => {
    lifetime?.abort();
    try {
      try {
        await bounded(Promise.allSettled([...pending]));
      } finally {
        await fixture?.close();
      }
      expect(fixture.protocolFailures).toEqual([]);
      expect(await staging()).toEqual([]);
    } finally {
      for (const [name, value] of savedEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      savedEnvironment.clear();
      pending.clear();
      try {
        await cleanupMaterials();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 5_000);

  for (const transport of TRANSPORTS) {
    test(
      `${transport}: authenticated numeric tunnel preserves Host/SNI and verifies binary bytes`,
      async () => {
        const lookups: string[] = [];
        const client = downloader(transport, {}, async (host) => {
          lookups.push(host);
          return [PINNED_ADDRESS];
        });
        let consumed = false;
        const result = await download(client, INPUT, async (stream) => {
          consumed = true;
          const entries = await staging();
          expect(entries).toHaveLength(1);
          const entry = entries[0];
          if (!entry) throw new Error("Missing isolated download staging directory");
          const metadata = await stat(join(directory, entry, "verified"));
          expect(metadata.size).toBe(INPUT.size);
          expect(metadata.mode & 0o777).toBe(0o600);
          return readBytes(stream);
        });
        expect(consumed).toBe(true);
        expect(result.equals(UPSTREAM_BYTES)).toBe(true);
        expect(lookups).toEqual([UPSTREAM_HOST]);
        expect(fixture.proxy(transport).destinations).toEqual([
          {
            host: PINNED_ADDRESS,
            port: 443,
            addressType: transport === "http" ? "authority" : "ipv4",
          },
        ]);
        expect(fixture.proxy(transport).authentication).toEqual([true]);
        expect(fixture.requests).toEqual([
          {
            path: "/source.tar.gz",
            host: UPSTREAM_HOST,
            sni: UPSTREAM_HOST,
            hasProxyAuthorization: false,
            hasAuthorization: false,
            hasInheritedSecret: false,
          },
        ]);
        await recovered(client);
      },
      TEST_TIMEOUT,
    );

    test(
      `${transport}: bad configured credentials fail without fallback or exposed secrets`,
      async () => {
        const proxy = fixture.proxy(transport);
        proxy.rejectAuthentication = true;
        const client = downloader(transport);
        let consumed = false;
        await rejectsSafely(
          download(client, INPUT, async (stream) => {
            consumed = true;
            return readBytes(stream);
          }),
          "proxy",
        );
        expect(consumed).toBe(false);
        expect(proxy.authentication).toEqual([false]);
        expect(proxy.connections).toBe(1);
        expect(fixture.requests).toEqual([]);
        expect(transport === "http" ? fixture.socks.connections : fixture.http.connections).toBe(0);
        proxy.rejectAuthentication = false;
        await recovered(client);
      },
      TEST_TIMEOUT,
    );

    test(
      `${transport}: refuses redirects even to the allowed origin`,
      async () => {
        fixture.mode = "redirect";
        const client = downloader(transport);
        await rejectsSafely(download(client), "http");
        expect(fixture.requests.map((request) => request.path)).toEqual(["/source.tar.gz"]);
        expect(fixture.proxy(transport).connections).toBe(1);
        await recovered(client);
      },
      TEST_TIMEOUT,
    );

    for (const mode of ["short", "overflow", "chunked-overflow"] as const) {
      test(
        `${transport}: ${mode} content never reaches the consumer and releases staging/slot`,
        async () => {
          fixture.mode = mode;
          const client = downloader(transport);
          let consumed = false;
          await rejectsSafely(
            download(client, INPUT, async (stream) => {
              consumed = true;
              return readBytes(stream);
            }),
            "integrity",
          );
          expect(consumed).toBe(false);
          expect(fixture.requests).toHaveLength(1);
          await recovered(client);
        },
        TEST_TIMEOUT,
      );
    }

    test(
      `${transport}: rejects a wrong digest before consumption and releases staging/slot`,
      async () => {
        const client = downloader(transport);
        let consumed = false;
        await rejectsSafely(
          download(client, { ...INPUT, digest: `sha256:${"0".repeat(64)}` }, async (stream) => {
            consumed = true;
            return readBytes(stream);
          }),
          "integrity",
        );
        expect(consumed).toBe(false);
        await recovered(client);
      },
      TEST_TIMEOUT,
    );

    for (const mode of ["idle", "drip"] as const) {
      test(
        `${transport}: ${mode === "idle" ? "idle timeout" : "absolute deadline"} frees the slot`,
        async () => {
          fixture.mode = mode;
          const client = downloader(transport, {
            timeoutMs: mode === "idle" ? 3_000 : 2_500,
            idleTimeoutMs: mode === "idle" ? 650 : 1_200,
          });
          const started = performance.now();
          let consumed = false;
          await rejectsSafely(
            download(client, INPUT, async (stream) => {
              consumed = true;
              return readBytes(stream);
            }),
            "timeout",
          );
          expect(consumed).toBe(false);
          expect(fixture.requests).toHaveLength(1);
          if (mode === "drip") {
            expect(fixture.dripWrites).toBeGreaterThan(8);
            expect(performance.now() - started).toBeGreaterThanOrEqual(2_200);
          } else {
            expect(performance.now() - started).toBeLessThan(2_500);
          }
          await recovered(client);
        },
        TEST_TIMEOUT,
      );
    }

    test(
      `${transport}: cancellation kills an active transfer; busy does not open another tunnel`,
      async () => {
        fixture.mode = "idle";
        const client = downloader(transport);
        const cancel = new AbortController();
        let consumed = false;
        const transfer = download(
          client,
          INPUT,
          async (stream) => {
            consumed = true;
            return readBytes(stream);
          },
          cancel.signal,
        );
        await waitUntil(() => fixture.requests.length === 1);
        expect(await staging()).toHaveLength(1);
        await rejectsSafely(download(client), "busy");
        expect(fixture.proxy(transport).connections).toBe(1);
        cancel.abort();
        await rejectsSafely(transfer, "cancelled");
        expect(consumed).toBe(false);
        await waitUntil(() => fixture.sockets.size === 0);
        await recovered(client);
      },
      TEST_TIMEOUT,
    );

    test(
      `${transport}: actual certificate trust and hostname verification remain enabled`,
      async () => {
        const untrusted = downloader(transport, { caBundle: undefined });
        await rejectsSafely(download(untrusted), "proxy");
        expect(fixture.requests).toEqual([]);
        expect(fixture.proxy(transport).destinations).toHaveLength(1);
        await rejectsSafely(download(untrusted), "proxy");
        const wrongOrigin = "https://wrong-name.example.test";
        const wrongHostname = downloader(transport, { allowedOrigins: [wrongOrigin] });
        await rejectsSafely(
          download(wrongHostname, { ...INPUT, url: `${wrongOrigin}/source.tar.gz` }),
          "proxy",
        );
        expect(fixture.requests).toEqual([]);
        await recovered(downloader(transport));
      },
      TEST_TIMEOUT,
    );
  }

  test(
    "SOCKS5 also supports the real no-auth handshake without sending proxy credentials",
    async () => {
      fixture.socks.requireAuthentication = false;
      const client = downloader("socks5", { proxyUrl: fixture.proxyUrl("socks5", false) });
      await recovered(client);
      expect(fixture.socks.authentication).toEqual([]);
      expect(fixture.socks.destinations).toEqual([
        { host: PINNED_ADDRESS, port: 443, addressType: "ipv4" },
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "forbidden origins and mixed public/private DNS answers never contact either proxy",
    async () => {
      const lookups: string[] = [];
      const allowed = downloader("http", {}, async (host) => {
        lookups.push(host);
        return [PINNED_ADDRESS];
      });
      for (const url of [
        "https://not-allowed.example.test/source.tar.gz",
        "http://upstream.example.test/source.tar.gz",
        "https://upstream.example.test:444/source.tar.gz",
        "https://127.0.0.1/source.tar.gz",
      ]) {
        await rejectsSafely(download(allowed, { ...INPUT, url }), "policy");
      }
      expect(lookups).toEqual([]);
      for (const addresses of [
        [PINNED_ADDRESS, "127.0.0.1"],
        ["10.0.0.1", PINNED_ADDRESS],
        [PINNED_ADDRESS, "169.254.169.254"],
        [],
      ]) {
        const mixed = downloader("socks5", {}, async () => addresses);
        await rejectsSafely(download(mixed), "policy");
      }
      expect(fixture.http.connections + fixture.socks.connections).toBe(0);
      expect(fixture.requests).toEqual([]);
      await recovered(allowed);
    },
    TEST_TIMEOUT,
  );

  test(
    "invalid digest/size/maxBytes fail before DNS, staging, or proxy access",
    async () => {
      let lookups = 0;
      const client = downloader("http", { maxBytes: INPUT.size }, async () => {
        lookups += 1;
        return [PINNED_ADDRESS];
      });
      for (const input of [
        { ...INPUT, digest: "sha256:bad" },
        { ...INPUT, size: 0 },
        { ...INPUT, size: INPUT.size + 1 },
      ]) {
        await rejectsSafely(download(client, input), "policy");
      }
      expect(lookups).toBe(0);
      expect(fixture.http.connections + fixture.socks.connections).toBe(0);
      await recovered(client);
    },
    TEST_TIMEOUT,
  );

  test(
    "DNS cancellation retains admission until the pending resolver acknowledges abort",
    async () => {
      const cancel = new AbortController();
      cancel.abort();
      let lookups = 0;
      let lookupSignal: AbortSignal | undefined;
      let releaseLookup: (addresses: string[]) => void = () => {};
      const resolution = new Promise<string[]>((resolve) => {
        releaseLookup = resolve;
      });
      const client = downloader("http", {}, async (_host, signal) => {
        lookups += 1;
        lookupSignal = signal;
        return lookups === 1 ? resolution : [PINNED_ADDRESS];
      });
      await rejectsSafely(download(client, INPUT, readBytes, cancel.signal), "cancelled");
      expect(lookups).toBe(0);
      const dnsCancel = new AbortController();
      const transfer = download(client, INPUT, readBytes, dnsCancel.signal);
      let settled = false;
      void transfer.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await waitUntil(() => lookups === 1);
        dnsCancel.abort();
        expect(lookupSignal?.aborted).toBe(true);
        // Let a Promise.race-based early release become observable before checking admission.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        expect(settled).toBe(false);
        await rejectsSafely(download(client), "busy");
        expect(settled).toBe(false);
        expect(lookups).toBe(1);
        expect(await staging()).toEqual([]);
      } finally {
        dnsCancel.abort();
        releaseLookup([PINNED_ADDRESS]);
        await rejectsSafely(transfer, "cancelled");
      }
      expect(fixture.http.connections + fixture.socks.connections).toBe(0);
      await recovered(client);
    },
    TEST_TIMEOUT,
  );

  test(
    "consumer failure is sanitized and removes the verified file before reusing capacity",
    async () => {
      const client = downloader("http");
      let consumed = false;
      await rejectsSafely(
        download(client, INPUT, async () => {
          consumed = true;
          expect(await staging()).toHaveLength(1);
          throw new Error(fixture.password);
        }),
        "io",
      );
      expect(consumed).toBe(true);
      await recovered(client);
    },
    TEST_TIMEOUT,
  );

  test(
    "a completed download does not impose its transfer deadline on verified storage ingestion",
    async () => {
      const client = downloader("http", { timeoutMs: 2_000, idleTimeoutMs: 1_500 });
      const result = await download(client, INPUT, async (stream) => {
        const bytes = await readBytes(stream);
        await new Promise<void>((resolve) => setTimeout(resolve, 2_200));
        return bytes;
      });
      expect(result.equals(UPSTREAM_BYTES)).toBe(true);
      await recovered(client);
    },
    TEST_TIMEOUT,
  );

  for (const transport of ["http", "socks5"] as const) {
    test(
      `${transport}: sub-buffer TLS progress outlives the idle budget with curl no-buffer`,
      async () => {
        const bytes = Buffer.from("small TLS chunks");
        fixture.payloads.set("/slow", bytes);
        fixture.mode = "slow";
        const client = downloader(transport, { timeoutMs: 4_000, idleTimeoutMs: 800 });
        const input = {
          url: `${UPSTREAM_ORIGIN}/slow`,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          size: bytes.length,
        };
        const started = performance.now();
        expect((await download(client, input)).equals(bytes)).toBe(true);
        expect(performance.now() - started).toBeGreaterThanOrEqual(1_500);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.proxy(transport).connections).toBe(1);
        await recovered(client);
      },
      TEST_TIMEOUT,
    );

    test(
      `${transport}: real proxied downloads upload and publish a material release on disk`,
      async () => {
        const material = await materialFixture();
        fixture.payloads.set("/spack.lock", LOCK);
        fixture.payloads.set("/source.tar.gz", SOURCE);
        const client = downloader(transport);
        const service = new SpackUpstreamImportService({
          downloader: client,
          recipeStore: material.recipes,
          materialStore: material.store,
          totalTimeoutMs: 6_000,
        });
        const input: SpackUpstreamImport = {
          kind: "material",
          files: [
            { url: `${UPSTREAM_ORIGIN}/spack.lock`, blob: LOCK_BLOB },
            { url: INPUT.url, blob: SOURCE_BLOB },
          ],
          release: material.input,
        };
        const result = await track(service.import(input, OWNER, lifetime.signal));
        expect(result.kind).toBe("material");
        if (result.kind !== "material") throw new Error("Expected a published material release");
        const manifest = await material.store.getManifest(
          result.binding.repositoryId,
          result.binding.manifestDigest,
        );
        expect(manifest.manifest.repository).toBe(material.input.repository);
        expect(manifest.manifest.lockfile).toEqual(LOCK_BLOB);
        expect(manifest.manifest.sources).toEqual(material.input.sources);
        for (const [blob, bytes] of [
          [LOCK_BLOB, LOCK],
          [SOURCE_BLOB, SOURCE],
        ] as const) {
          const stored = await material.store.getBlob(
            result.binding.repositoryId,
            result.binding.manifestDigest,
            blob.digest,
            USER,
          );
          expect((await readBytes(stored.stream)).equals(Buffer.from(bytes))).toBe(true);
        }
        expect(fixture.requests.map((request) => request.path)).toEqual([
          "/spack.lock",
          "/source.tar.gz",
        ]);
        expect(fixture.proxy(transport).authentication).toEqual([true, true]);
        expect(fixture.proxy(transport).destinations).toHaveLength(2);
        expect(await readdir(join(material.root, "staging"))).toEqual([]);
        expect(await staging()).toEqual([]);
      },
      TEST_TIMEOUT,
    );

    test(
      `${transport}: hostile proxy environment and curlrc cannot alter the real child`,
      async () => {
        expect(process.platform).toBe("linux");
        const decoy = transport === "http" ? fixture.socks : fixture.http;
        const decoyUrl = `http://127.0.0.1:${decoy.port}`;
        await writeFile(
          join(directory, ".curlrc"),
          `insecure\nlocation\nheader = "X-Inherited-Secret: ${fixture.username}"\n`,
        );
        environment({
          HOME: directory,
          CURL_HOME: directory,
          XDG_CONFIG_HOME: directory,
          HTTP_PROXY: decoyUrl,
          HTTPS_PROXY: decoyUrl,
          ALL_PROXY: decoyUrl,
          http_proxy: decoyUrl,
          https_proxy: decoyUrl,
          all_proxy: decoyUrl,
          NO_PROXY: "*",
          no_proxy: "*",
          CURL_CA_BUNDLE: certificate.caBundle,
          SSL_CERT_FILE: certificate.caBundle,
          SSL_CERT_DIR: directory,
          KQ_PARENT_TEST_SECRET: fixture.password,
        });
        fixture.mode = "idle";
        const client = downloader(transport);
        const cancel = new AbortController();
        const transfer = download(client, INPUT, readBytes, cancel.signal);
        try {
          await waitUntil(() => fixture.requests.length === 1);
          const child = await inspectCurlChild();
          expect(child.args.join("\0") === ["/usr/bin/curl", "-q", "--config", "-"].join("\0")).toBe(
            true,
          );
          expect(
            child.environment.sort().join("\0") === ["LC_ALL=C", "PATH=/usr/bin:/bin"].join("\0"),
          ).toBe(true);
          expect([...child.args, ...child.environment].join("\n").includes(fixture.password)).toBe(
            false,
          );
        } finally {
          cancel.abort();
          await rejectsSafely(transfer, "cancelled");
        }
        expect(decoy.connections).toBe(0);
        await recovered(client);
        expect(fixture.requests.every((request) => !request.hasInheritedSecret)).toBe(true);
        const untrusted = downloader(transport, { caBundle: undefined });
        await rejectsSafely(download(untrusted), "proxy");
        expect(fixture.requests).toHaveLength(2);
        expect(decoy.connections).toBe(0);
      },
      TEST_TIMEOUT,
    );
  }
});
