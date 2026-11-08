import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import {
  FabricCommercialTrustSchema,
  fabricCommercialCollections,
} from "@kuintessence/shared/federation/commercial";
import {
  type FabricEvidenceTrust,
  FabricEvidenceTrustSchema,
  fabricEvidenceCollections,
} from "@kuintessence/shared/federation/ledger";
import { FabricMarketTrustSchema } from "@kuintessence/shared/federation/market";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { verifyCommercialNetwork } from "./fabric-commercial-assertions";
import { verifyEvidenceNetwork } from "./fabric-evidence-assertions";
import { verifyMarketNetwork } from "./fabric-market-assertions";
import { verifyExecutionGateNetwork } from "./fabric-market-gate-assertions";
import { verifyLiveExecution } from "./federation-live/verify";

const repo = resolve(import.meta.dir, "..");
const execution = process.argv.includes("--execution");
if (execution && process.env.KQ_FEDERATION_EXECUTION_LAB !== "1")
  throw new Error("Set KQ_FEDERATION_EXECUTION_LAB=1 for the disposable local k3s lab");
const toolsRoot = process.env.KQ_FABRIC_TOOLS;
if (!toolsRoot) throw new Error("Set KQ_FABRIC_TOOLS to a verified Fabric 3.1.5 release directory");
if (process.argv.includes("--database") && !process.env.KQ_FABRIC_DATABASE_URL)
  throw new Error("Set KQ_FABRIC_DATABASE_URL for the database integration check");
const binaries = join(resolve(toolsRoot), "bin");
const defaults = join(resolve(toolsRoot), "config");
await mkdir(join(repo, "temp"), { recursive: true });
const root = await mkdtemp(join(repo, "temp", "fabric-network-"));
await chmod(root, 0o700);
const children: { name: string; process: Bun.Subprocess; log: string }[] = [];
let closing: Promise<void> | undefined;
const additionalCleanups: (() => Promise<void>)[] = [];
const environment = {
  ...process.env,
  FABRIC_LOGGING_SPEC: "warning",
  GOMEMLIMIT: "256MiB",
  GOMAXPROCS: "2",
};
const channel = "kq-evidence-test";
const attested = execution && process.env.KQ_FEDERATION_LAB_MODE === "bilateral_attested";
const gate = (execution && !attested) || process.argv.includes("--gate");
const commercial = execution || gate || process.argv.includes("--commercial");
const secondaryKind = gate ? "market" : attested ? "evidence" : undefined;
const market = process.argv.includes("--market");
if (market && (commercial || process.argv.includes("--database")))
  throw new Error("Market probe is independent of commercial/database checks");
const kind = market ? "market" : commercial ? "commercial" : "evidence";
const chaincode = `kq-${kind}`;
const record = z.record(z.string(), z.unknown());
const section = (parent: Record<string, unknown>, key: string) => {
  const value = record.parse(parent[key] ?? {});
  parent[key] = value;
  return value;
};
const json = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const yaml = (path: string, value: unknown) => writeFile(path, stringify(value), { mode: 0o600 });

async function run(name: string, argv: string[], env: NodeJS.ProcessEnv = {}, cwd = root) {
  const log = join(root, `${name}.log`);
  const child = Bun.spawn(argv, {
    cwd,
    env: { ...environment, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    await writeFile(log, stdout + stderr, { mode: 0o600 });
    if (code !== 0) throw new Error(`${name} failed (${code}); inspect ${log}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

function start(name: string, argv: string[], env: NodeJS.ProcessEnv) {
  const log = join(root, `${name}.log`);
  const fd = openSync(log, "a", 0o600);
  try {
    const process = Bun.spawn(argv, {
      cwd: root,
      env: { ...environment, ...env },
      stdout: fd,
      stderr: fd,
    });
    children.push({ name, process, log });
    return process;
  } finally {
    closeSync(fd);
  }
}

const reservedPorts = new Set<number>();
async function port(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot allocate test port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!reservedPorts.has(address.port)) {
      reservedPorts.add(address.port);
      return address.port;
    }
  }
}

async function listening(target: number) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const exited = children.find((c) => c.process.exitCode !== null);
    if (exited) throw new Error(`${exited.name} exited; inspect ${exited.log}`);
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: target });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    await Bun.sleep(200);
  }
  throw new Error(`Local test port ${target} did not open`);
}

async function stop(name: string) {
  const index = children.findIndex((child) => child.name === name);
  const child = children[index];
  if (!child) throw new Error(`Unknown owned test process: ${name}`);
  child.process.kill("SIGTERM");
  const timer = setTimeout(() => child.process.kill("SIGKILL"), 5_000);
  try {
    await child.process.exited;
  } finally {
    clearTimeout(timer);
    children.splice(index, 1);
  }
}

function cleanup() {
  closing ??= (async () => {
    const results = await Promise.allSettled(additionalCleanups.map((cleanup) => cleanup()));
    for (const child of [...children].reverse()) await stop(child.name);
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Additional test cleanup failed; inspect retained private artifacts");
  })();
  return closing;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    cleanup().finally(() => {
      console.error(`Interrupted; private artifacts retained: ${root}`);
      process.exit(1);
    });
  });
}

async function onlyKey(directory: string) {
  const names = await readdir(directory);
  if (names.length !== 1 || !names[0]) throw new Error("Expected one generated test key");
  const path = join(directory, names[0]);
  await chmod(path, 0o600);
  return path;
}

async function setup() {
  const version = await run("version", [join(binaries, "peer"), "version"]);
  if (!version.includes("Version: v3.1.5")) throw new Error("Expected Fabric 3.1.5");
  const ordererPort = await port();
  const ordererAdmin = await port();
  const members = await Promise.all(
    ["A", "B", "C"].map(async (name) => ({
      name,
      siteId: randomUUID(),
      peerPort: await port(),
      chaincodePort: await port(),
      chaincodeListener: await port(),
      gateChaincodePort: secondaryKind ? await port() : 0,
    })),
  );
  await yaml(join(root, "crypto.yaml"), {
    OrdererOrgs: [
      {
        Name: "Orderer",
        Domain: "orderer.kq.test",
        EnableNodeOUs: true,
        Specs: [{ Hostname: "orderer0", SANS: ["localhost", "127.0.0.1"] }],
      },
    ],
    PeerOrgs: members.map((m) => ({
      Name: m.name,
      Domain: `${m.name.toLowerCase()}.kq.test`,
      EnableNodeOUs: true,
      Template: { Count: 1, SANS: ["localhost", "127.0.0.1"] },
      Users: { Count: secondaryKind ? 2 : 1 },
    })),
  });
  await run("cryptogen", [
    join(binaries, "cryptogen"),
    "generate",
    `--config=${join(root, "crypto.yaml")}`,
    `--output=${join(root, "crypto")}`,
  ]);
  const organizations = [];
  const sites = [];
  for (const m of members) {
    const domain = `${m.name.toLowerCase()}.kq.test`;
    const directory = join(root, "crypto", "peerOrganizations", domain);
    const peerDir = join(directory, "peers", `peer0.${domain}`);
    const caNames = await readdir(join(directory, "ca"));
    const caKeyName = caNames.find((n) => n.endsWith("_sk"));
    const caCertName = caNames.find((n) => n.endsWith(".pem"));
    if (!caKeyName || !caCertName) throw new Error("Missing test institution CA");
    for (const [identity, role, ou] of [
      ["Admin", "trust-admin", "admin"],
      ["User1", market ? "market" : commercial ? "commercial" : "attestor", "client"],
      ...(secondaryKind ? [["User2", gate ? "market" : "attestor", "client"]] : []),
    ] as const) {
      const msp = join(directory, "users", `${identity}@${domain}`, "msp");
      const key = await onlyKey(join(msp, "keystore"));
      const attributes = Buffer.from(
        JSON.stringify({ attrs: { "kq.federation.site": m.siteId, "kq.federation.role": role } }),
      )
        .toString("hex")
        .match(/../g)
        ?.join(":");
      const extension = join(root, `${m.name}-${identity}.ext`);
      await writeFile(
        extension,
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.3.4.5.6.7.8.1=DER:${attributes}\n`,
        { mode: 0o600 },
      );
      const csr = join(root, `${m.name}-${identity}.csr`);
      await run(`${m.name}-${identity}-csr`, [
        "openssl",
        "req",
        "-new",
        "-key",
        key,
        "-subj",
        `/C=ZZ/O=KQ Test/OU=${ou}/CN=${identity}@${domain}`,
        "-out",
        csr,
      ]);
      await run(`${m.name}-${identity}-cert`, [
        "openssl",
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        join(directory, "ca", caCertName),
        "-CAkey",
        join(directory, "ca", caKeyName),
        "-set_serial",
        `0x${randomBytes(16).toString("hex")}`,
        "-days",
        "2",
        "-extfile",
        extension,
        "-out",
        join(msp, "signcerts", `${identity}@${domain}-cert.pem`),
      ]);
    }
    const business = await generateKeyPair("RS256", { extractable: true });
    const businessKeyFile = join(root, `${m.name}-business.key`);
    await writeFile(businessKeyFile, await exportPKCS8(business.privateKey), { mode: 0o600 });
    organizations.push({
      siteId: m.siteId,
      mspId: `${m.name}MSP`,
      keys: [
        {
          keyId: "batch-1",
          publicKeyPem: await exportSPKI(business.publicKey),
          validFrom: new Date(Date.now() - 60_000).toISOString(),
          validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
    });
    sites.push({
      ...m,
      domain,
      directory,
      peerDir,
      businessKeyFile,
      tls: join(peerDir, "tls"),
      adminMsp: join(directory, "users", `Admin@${domain}`, "msp"),
      userMsp: join(directory, "users", `User1@${domain}`, "msp"),
    });
  }
  const a = sites[0];
  const b = sites[1];
  if (!a || !b) throw new Error("Missing institutions");
  const evidenceTrust: FabricEvidenceTrust = {
    version: 1,
    generationId: randomUUID(),
    organizations,
    domains: [
      {
        domainId: randomUUID(),
        collection: commercial ? "commercial_AB_v1" : "evidence_AB_v1",
        siteIds: [a.siteId, b.siteId],
      },
    ],
  };
  const trust = market
    ? FabricMarketTrustSchema.parse({
        version: 1,
        generationId: randomUUID(),
        organizations: organizations.map(({ siteId, mspId }) => ({ siteId, mspId })),
      })
    : commercial
      ? FabricCommercialTrustSchema.parse({
          ...evidenceTrust,
          keyPurposes: organizations.flatMap((org) =>
            org.keys.map((key) => ({
              siteId: org.siteId,
              keyId: key.keyId,
              kinds: [
                "commercial-agreement",
                "commercial-usage",
                "commercial-discount",
                "commercial-bill",
                "commercial-settlement",
                "commercial-adjustment",
                ...(gate
                  ? ["commercial-reservation", "commercial-release", "commercial-terminal"]
                  : []),
              ],
            })),
          ),
        })
      : evidenceTrust;
  await json(join(root, "trust.json"), trust);
  await json(
    join(root, "collections.json"),
    market
      ? []
      : commercial
        ? fabricCommercialCollections(FabricCommercialTrustSchema.parse(trust))
        : fabricEvidenceCollections(evidenceTrust),
  );
  const ordererDir = join(
    root,
    "crypto/ordererOrganizations/orderer.kq.test/orderers/orderer0.orderer.kq.test",
  );
  const ordererTls = join(ordererDir, "tls");
  const tlsRoots = [...sites.map((s) => join(s.tls, "ca.crt")), join(ordererTls, "ca.crt")];
  const orgPolicies = (msp: string) =>
    msp === "OrdererMSP"
      ? {
          Readers: { Type: "Signature", Rule: "OR('OrdererMSP.member')" },
          Writers: { Type: "Signature", Rule: "OR('OrdererMSP.member')" },
          Admins: { Type: "Signature", Rule: "OR('OrdererMSP.admin')" },
        }
      : {
          Readers: { Type: "Signature", Rule: `OR('${msp}.admin','${msp}.peer','${msp}.client')` },
          Writers: { Type: "Signature", Rule: `OR('${msp}.admin','${msp}.client')` },
          Admins: { Type: "Signature", Rule: `OR('${msp}.admin')` },
          Endorsement: { Type: "Signature", Rule: `OR('${msp}.peer')` },
        };
  const policies = {
    Readers: { Type: "ImplicitMeta", Rule: "ANY Readers" },
    Writers: { Type: "ImplicitMeta", Rule: "ANY Writers" },
    Admins: { Type: "ImplicitMeta", Rule: "ALL Admins" },
  };
  await yaml(join(root, "configtx.yaml"), {
    Profiles: {
      KqEvidence: {
        Policies: policies,
        Capabilities: { V2_0: true },
        Orderer: {
          OrdererType: "etcdraft",
          EtcdRaft: {
            Consenters: [
              {
                Host: "127.0.0.1",
                Port: ordererPort,
                ClientTLSCert: join(ordererTls, "server.crt"),
                ServerTLSCert: join(ordererTls, "server.crt"),
              },
            ],
          },
          BatchTimeout: "200ms",
          BatchSize: { MaxMessageCount: 10, AbsoluteMaxBytes: "2 MB", PreferredMaxBytes: "512 KB" },
          Organizations: [
            {
              Name: "OrdererMSP",
              ID: "OrdererMSP",
              MSPDir: join(root, "crypto/ordererOrganizations/orderer.kq.test/msp"),
              Policies: orgPolicies("OrdererMSP"),
              OrdererEndpoints: [`127.0.0.1:${ordererPort}`],
            },
          ],
          Policies: { ...policies, BlockValidation: { Type: "ImplicitMeta", Rule: "ANY Writers" } },
          Capabilities: { V2_0: true },
        },
        Application: {
          Organizations: sites.map((s) => ({
            Name: `${s.name}MSP`,
            ID: `${s.name}MSP`,
            MSPDir: join(s.directory, "msp"),
            Policies: orgPolicies(`${s.name}MSP`),
            AnchorPeers: [{ Host: "127.0.0.1", Port: s.peerPort }],
          })),
          Policies: {
            ...policies,
            LifecycleEndorsement: { Type: "ImplicitMeta", Rule: "ALL Endorsement" },
            Endorsement: { Type: "ImplicitMeta", Rule: "MAJORITY Endorsement" },
          },
          Capabilities: { V2_5: true },
        },
      },
    },
  });
  await run(
    "channel-genesis",
    [
      join(binaries, "configtxgen"),
      "-profile",
      "KqEvidence",
      "-channelID",
      channel,
      "-outputBlock",
      join(root, "channel.block"),
    ],
    { FABRIC_CFG_PATH: root },
  );

  const orderer = record.parse(parse(await readFile(join(defaults, "orderer.yaml"), "utf8")));
  const general = section(orderer, "General");
  Object.assign(general, {
    ListenAddress: "127.0.0.1",
    ListenPort: ordererPort,
    LocalMSPID: "OrdererMSP",
    LocalMSPDir: join(ordererDir, "msp"),
  });
  Object.assign(section(general, "TLS"), {
    Enabled: true,
    PrivateKey: join(ordererTls, "server.key"),
    Certificate: join(ordererTls, "server.crt"),
    RootCAs: tlsRoots,
    ClientAuthRequired: true,
    ClientRootCAs: tlsRoots,
  });
  Object.assign(section(general, "Cluster"), {
    ClientCertificate: join(ordererTls, "server.crt"),
    ClientPrivateKey: join(ordererTls, "server.key"),
    RootCAs: tlsRoots,
  });
  Object.assign(section(orderer, "Admin"), {
    ListenAddress: `127.0.0.1:${ordererAdmin}`,
    TLS: {
      Enabled: true,
      PrivateKey: join(ordererTls, "server.key"),
      Certificate: join(ordererTls, "server.crt"),
      ClientAuthRequired: true,
      ClientRootCAs: tlsRoots,
    },
  });
  section(orderer, "FileLedger").Location = join(root, "orderer-ledger");
  Object.assign(section(orderer, "Consensus"), {
    WALDir: join(root, "orderer-wal"),
    SnapDir: join(root, "orderer-snapshots"),
  });
  section(orderer, "Operations").ListenAddress = "127.0.0.1:0";
  await yaml(join(root, "orderer.yaml"), orderer);
  start("orderer", [join(binaries, "orderer")], { FABRIC_CFG_PATH: root });
  await listening(ordererAdmin);
  await run("orderer-join", [
    join(binaries, "osnadmin"),
    "channel",
    "join",
    "--channelID",
    channel,
    "--config-block",
    join(root, "channel.block"),
    "-o",
    `127.0.0.1:${ordererAdmin}`,
    "--ca-file",
    join(ordererTls, "ca.crt"),
    "--client-cert",
    join(ordererTls, "server.crt"),
    "--client-key",
    join(ordererTls, "server.key"),
  ]);
  console.log("Orderer joined the isolated channel");

  const builder = join(root, "builder/bin");
  await mkdir(builder, { recursive: true });
  const scripts = {
    detect: `import json,sys\nsys.exit(0 if json.load(open(sys.argv[2]+'/metadata.json'))['type']=='kq-evidence-ccaas' else 1)\n`,
    build: `import json,sys,os\nvalue={'address':(os.environ['KQ_SECONDARY_CCAAS_ADDRESS'] if json.load(open(sys.argv[2]+'/metadata.json'))['label'] in ('kq-market-gate','kq-evidence-live') else os.environ['KQ_CCAAS_ADDRESS']),'dial_timeout':'10s','tls_required':True,'client_auth_required':True,'root_cert':open(os.environ['KQ_CCAAS_CA']).read(),'client_cert':open(os.environ['KQ_CCAAS_CERT']).read(),'client_key':open(os.environ['KQ_CCAAS_KEY']).read()}\nwith open(sys.argv[3]+'/connection.json','w') as f:json.dump(value,f)\n`,
    release: `import sys,os,shutil\np=sys.argv[2]+'/chaincode/server'\nos.makedirs(p,exist_ok=True)\nshutil.copyfile(sys.argv[1]+'/connection.json',p+'/connection.json')\n`,
  };
  for (const [name, source] of Object.entries(scripts)) {
    const file = join(builder, name);
    await writeFile(file, `#!/usr/bin/python3\n${source}`, { mode: 0o700 });
  }
  const packageDir = join(root, "package");
  await mkdir(packageDir);
  await json(join(packageDir, "metadata.json"), {
    type: "kq-evidence-ccaas",
    label: "kq-evidence-test",
    path: "kq-evidence",
  });
  await mkdir(join(packageDir, "code"));
  await writeFile(join(packageDir, "code", "fixture"), "KQ isolated CCAAS evidence validation\n");
  await run("package-code", [
    "tar",
    "-czf",
    join(packageDir, "code.tar.gz"),
    "-C",
    join(packageDir, "code"),
    ".",
  ]);
  const archive = join(root, "evidence.tar.gz");
  await run("package", ["tar", "-czf", archive, "-C", packageDir, "metadata.json", "code.tar.gz"]);
  const packageId = `kq-evidence-test:${createHash("sha256")
    .update(await readFile(archive))
    .digest("hex")}`;
  const build = await Bun.build({
    entrypoints: [join(repo, `contracts/fabric/${kind}/src/main.ts`)],
    outdir: join(root, "chaincode"),
    target: "node",
    format: "esm",
    external: ["fabric-shim"],
  });
  if (!build.success) throw new Error("Evidence chaincode build failed");
  const peerEnvironments: Record<string, NodeJS.ProcessEnv> = {};
  for (const site of sites) {
    const config = record.parse(parse(await readFile(join(defaults, "core.yaml"), "utf8")));
    const peer = section(config, "peer");
    Object.assign(peer, {
      id: `peer0.${site.domain}`,
      networkId: "kq-evidence-test",
      listenAddress: `127.0.0.1:${site.peerPort}`,
      address: `127.0.0.1:${site.peerPort}`,
      chaincodeListenAddress: `127.0.0.1:${site.chaincodeListener}`,
      localMspId: `${site.name}MSP`,
      mspConfigPath: join(site.peerDir, "msp"),
      fileSystemPath: join(root, `${site.name}-ledger`),
    });
    Object.assign(section(peer, "gossip"), {
      bootstrap: "",
      endpoint: `127.0.0.1:${site.peerPort}`,
      externalEndpoint: `127.0.0.1:${site.peerPort}`,
      useLeaderElection: false,
      orgLeader: true,
    });
    Object.assign(section(peer, "tls"), {
      enabled: true,
      clientAuthRequired: true,
      cert: { file: join(site.tls, "server.crt") },
      key: { file: join(site.tls, "server.key") },
      rootcert: { file: join(site.tls, "ca.crt") },
      clientRootCAs: { files: tlsRoots },
    });
    section(config, "operations").listenAddress = "127.0.0.1:0";
    section(config, "vm").endpoint = "";
    section(config, "chaincode").externalBuilders = [
      {
        name: "kq-evidence",
        path: dirname(builder),
        propagateEnvironment: [
          "KQ_CCAAS_ADDRESS",
          "KQ_SECONDARY_CCAAS_ADDRESS",
          "KQ_CCAAS_CA",
          "KQ_CCAAS_CERT",
          "KQ_CCAAS_KEY",
        ],
      },
    ];
    const configDir = join(root, `${site.name}-config`);
    await mkdir(configDir);
    await yaml(join(configDir, "core.yaml"), config);
    const env = {
      FABRIC_CFG_PATH: configDir,
      KQ_CCAAS_ADDRESS: `127.0.0.1:${site.chaincodePort}`,
      KQ_SECONDARY_CCAAS_ADDRESS: `127.0.0.1:${site.gateChaincodePort}`,
      KQ_CCAAS_CA: join(site.tls, "ca.crt"),
      KQ_CCAAS_CERT: join(site.tls, "server.crt"),
      KQ_CCAAS_KEY: join(site.tls, "server.key"),
    };
    start(
      `chaincode-${site.name}`,
      ["node", "--max-old-space-size=192", join(root, "chaincode/main.js")],
      {
        [`KQ_${kind.toUpperCase()}_TRUST_FILE`]: join(root, "trust.json"),
        CHAINCODE_ID: packageId,
        CHAINCODE_ADDRESS: `127.0.0.1:${site.chaincodePort}`,
        CHAINCODE_TLS_KEY_FILE: join(site.tls, "server.key"),
        CHAINCODE_TLS_CERT_FILE: join(site.tls, "server.crt"),
        CHAINCODE_TLS_CLIENT_CA_FILE: join(site.tls, "ca.crt"),
        CORE_CHAINCODE_LOGGING_LEVEL: "error",
      },
    );
    start(`peer-${site.name}`, [join(binaries, "peer"), "node", "start"], env);
    await listening(site.peerPort);
    await listening(site.chaincodePort);
    const cli = {
      ...env,
      CORE_PEER_MSPCONFIGPATH: site.adminMsp,
      CORE_PEER_TLS_CLIENTCERT_FILE: join(site.tls, "server.crt"),
      CORE_PEER_TLS_CLIENTKEY_FILE: join(site.tls, "server.key"),
    };
    peerEnvironments[site.name] = cli;
    await run(
      `peer-${site.name}-join`,
      [join(binaries, "peer"), "channel", "join", "-b", join(root, "channel.block")],
      cli,
    );
    await run(
      `peer-${site.name}-install`,
      [join(binaries, "peer"), "lifecycle", "chaincode", "install", archive],
      cli,
    );
  }
  console.log("Three peers and TLS chaincode services are running");
  const ordererOptions = [
    "-o",
    `127.0.0.1:${ordererPort}`,
    "--tls",
    "--cafile",
    join(ordererTls, "ca.crt"),
    "--clientauth",
    "--certfile",
    join(a.tls, "server.crt"),
    "--keyfile",
    join(a.tls, "server.key"),
  ];
  const definition = [
    "--channelID",
    channel,
    "--name",
    chaincode,
    "--version",
    "1",
    "--sequence",
    "1",
    "--init-required",
    ...(market
      ? ["--channel-config-policy", "/Channel/Application/Endorsement"]
      : [
          "--signature-policy",
          "AND('AMSP.peer','BMSP.peer','CMSP.peer')",
          "--collections-config",
          join(root, "collections.json"),
        ]),
  ];
  for (const site of sites)
    await run(
      `${site.name}-approve`,
      [
        join(binaries, "peer"),
        "lifecycle",
        "chaincode",
        "approveformyorg",
        ...definition,
        "--package-id",
        packageId,
        ...ordererOptions,
      ],
      peerEnvironments[site.name],
    );
  const peerOptions = sites.flatMap((site) => [
    "--peerAddresses",
    `127.0.0.1:${site.peerPort}`,
    "--tlsRootCertFiles",
    join(site.tls, "ca.crt"),
  ]);
  await run(
    "commit-definition",
    [
      join(binaries, "peer"),
      "lifecycle",
      "chaincode",
      "commit",
      ...definition,
      ...ordererOptions,
      ...peerOptions,
    ],
    peerEnvironments.A,
  );
  await run(
    "initialize",
    [
      join(binaries, "peer"),
      "chaincode",
      "invoke",
      "-C",
      channel,
      "-n",
      chaincode,
      "--isInit",
      "-c",
      JSON.stringify({ Args: ["Init"] }),
      "--waitForEvent",
      ...ordererOptions,
      ...peerOptions,
    ],
    peerEnvironments.A,
  );
  if (secondaryKind) {
    const secondaryTrust = gate
      ? FabricMarketTrustSchema.parse({
          version: 1,
          generationId: randomUUID(),
          organizations: organizations.map(({ siteId, mspId }) => ({ siteId, mspId })),
        })
      : {
          ...evidenceTrust,
          domains: evidenceTrust.domains.map((domain) => ({
            ...domain,
            collection: "evidence_AB_v1",
          })),
        };
    const trustFile = join(root, gate ? "gate-market-trust.json" : "execution-evidence-trust.json");
    const label = gate ? "kq-market-gate" : "kq-evidence-live";
    await json(trustFile, secondaryTrust);
    if (attested)
      await json(
        join(root, "execution-evidence-collections.json"),
        fabricEvidenceCollections(FabricEvidenceTrustSchema.parse(secondaryTrust)),
      );
    const gateDir = join(root, "gate-package");
    await mkdir(gateDir);
    await json(join(gateDir, "metadata.json"), {
      type: "kq-evidence-ccaas",
      label,
      path: `kq-${secondaryKind}`,
    });
    await writeFile(join(gateDir, "code.tar.gz"), await readFile(join(packageDir, "code.tar.gz")), {
      mode: 0o600,
    });
    const gateArchive = join(root, "gate-market.tar.gz");
    await run("gate-package", [
      "tar",
      "-czf",
      gateArchive,
      "-C",
      gateDir,
      "metadata.json",
      "code.tar.gz",
    ]);
    const gatePackageId = `${label}:${createHash("sha256")
      .update(await readFile(gateArchive))
      .digest("hex")}`;
    const gateBuild = await Bun.build({
      entrypoints: [join(repo, `contracts/fabric/${secondaryKind}/src/main.ts`)],
      outdir: join(root, "gate-chaincode"),
      target: "node",
      format: "esm",
      external: ["fabric-shim"],
    });
    if (!gateBuild.success) throw new Error("Secondary execution chaincode build failed");
    const gateDefinition = [
      "--channelID",
      channel,
      "--name",
      `kq-${secondaryKind}`,
      "--version",
      "1",
      "--sequence",
      "1",
      "--init-required",
      ...(gate
        ? ["--channel-config-policy", "/Channel/Application/Endorsement"]
        : [
            "--signature-policy",
            "AND('AMSP.peer','BMSP.peer','CMSP.peer')",
            "--collections-config",
            join(root, "execution-evidence-collections.json"),
          ]),
    ];
    for (const site of sites) {
      start(
        `gate-chaincode-${site.name}`,
        ["node", "--max-old-space-size=192", join(root, "gate-chaincode/main.js")],
        {
          [`KQ_${secondaryKind.toUpperCase()}_TRUST_FILE`]: trustFile,
          CHAINCODE_ID: gatePackageId,
          CHAINCODE_ADDRESS: `127.0.0.1:${site.gateChaincodePort}`,
          CHAINCODE_TLS_KEY_FILE: join(site.tls, "server.key"),
          CHAINCODE_TLS_CERT_FILE: join(site.tls, "server.crt"),
          CHAINCODE_TLS_CLIENT_CA_FILE: join(site.tls, "ca.crt"),
          CORE_CHAINCODE_LOGGING_LEVEL: "error",
        },
      );
      await listening(site.gateChaincodePort);
      await run(
        `gate-${site.name}-install`,
        [join(binaries, "peer"), "lifecycle", "chaincode", "install", gateArchive],
        peerEnvironments[site.name],
      );
      await run(
        `gate-${site.name}-approve`,
        [
          join(binaries, "peer"),
          "lifecycle",
          "chaincode",
          "approveformyorg",
          ...gateDefinition,
          "--package-id",
          gatePackageId,
          ...ordererOptions,
        ],
        peerEnvironments[site.name],
      );
    }
    await run(
      "gate-commit-definition",
      [
        join(binaries, "peer"),
        "lifecycle",
        "chaincode",
        "commit",
        ...gateDefinition,
        ...ordererOptions,
        ...peerOptions,
      ],
      peerEnvironments.A,
    );
    await run(
      "gate-initialize",
      [
        join(binaries, "peer"),
        "chaincode",
        "invoke",
        "-C",
        channel,
        "-n",
        `kq-${secondaryKind}`,
        "--isInit",
        "-c",
        JSON.stringify({ Args: ["Init"] }),
        "--waitForEvent",
        ...ordererOptions,
        ...peerOptions,
      ],
      peerEnvironments.A,
    );
  }
  await json(join(root, "network.json"), {
    channel,
    chaincode,
    packageId,
    trust,
    sites,
    ordererPort,
    ordererAdmin,
    peerEnvironments,
  });
  console.log(`Fabric network initialized: ${root}`);
  return {
    onCleanup: (cleanup: () => Promise<void>) => {
      additionalCleanups.push(cleanup);
    },
    stopOrderer: () => stop("orderer"),
    startOrderer: async () => {
      start("orderer", [join(binaries, "orderer")], { FABRIC_CFG_PATH: root });
      await listening(ordererAdmin);
      await run("orderer-restarted", [
        join(binaries, "osnadmin"),
        "channel",
        "list",
        "--channelID",
        channel,
        "-o",
        `127.0.0.1:${ordererAdmin}`,
        "--ca-file",
        join(ordererTls, "ca.crt"),
        "--client-cert",
        join(ordererTls, "server.crt"),
        "--client-key",
        join(ordererTls, "server.key"),
      ]);
    },
  };
}

let succeeded = false;
try {
  const controls = await setup();
  if (process.argv.includes("--hold")) {
    console.log("Holding owned test processes; send a line on stdin to stop");
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
      process.stdin.resume();
    });
    process.stdin.pause();
  } else {
    if (execution) await verifyLiveExecution(root, controls);
    else if (gate) await verifyExecutionGateNetwork(root, controls);
    else if (market) await verifyMarketNetwork(root, controls);
    else if (commercial) await verifyCommercialNetwork(root, controls);
    else await verifyEvidenceNetwork(root, controls);
  }
  succeeded = true;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Fabric network verification failed");
  process.exitCode = 1;
} finally {
  await cleanup();
  if (succeeded && !process.env.KQ_FABRIC_KEEP_ARTIFACTS)
    await rm(root, { recursive: true, force: true });
  else console.log(`Private local test artifacts retained: ${root}`);
}
