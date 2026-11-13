import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// This opt-in test needs a single-node Kubernetes cluster on the checkout host.
const repo = resolve(import.meta.dir, "..");
const image = process.env.KQ_ACCOUNTING_IMAGE;
assert(
  image && /@sha256:[a-f0-9]{64}$/.test(image),
  "Set KQ_ACCOUNTING_IMAGE to a pinned KQ Slurm runtime image",
);
assert(process.env.KQ_ACCOUNTING_LAB === "1", "Set KQ_ACCOUNTING_LAB=1 for the isolated test");
const namespace = `kq-accounting-${randomUUID().slice(0, 8)}`;
const output = resolve(repo, "temp", namespace);
await mkdir(output, { recursive: true, mode: 0o700 });
let created = false;
async function kubectl(
  args: string[],
  options: { input?: string; timeout?: number; allowFailure?: boolean } = {},
) {
  const child = Bun.spawn(["kubectl", ...args], {
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 60000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code && !options.allowFailure) {
      await writeFile(resolve(output, "failure.log"), stdout + stderr, { mode: 0o600 });
      throw new Error(`Accounting lab command failed; inspect ${output}/failure.log`);
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
try {
  await kubectl(["create", "namespace", namespace]);
  created = true;
  console.log(`Created isolated namespace ${namespace}`);
  await kubectl(["apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "slurm", namespace },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        activeDeadlineSeconds: 1200,
        containers: [
          {
            name: "slurm",
            image,
            imagePullPolicy: "IfNotPresent",
            command: ["sleep", "1200"],
            resources: {
              requests: { cpu: "100m", memory: "256Mi" },
              limits: { cpu: "1", memory: "1200Mi" },
            },
            volumeMounts: [{ name: "source", mountPath: "/workspace", readOnly: true }],
          },
        ],
        volumes: [{ name: "source", hostPath: { path: repo, type: "Directory" } }],
      },
    }),
  });
  await kubectl(["-n", namespace, "wait", "pod/slurm", "--for=condition=Ready", "--timeout=90s"], {
    timeout: 100000,
  });
  console.log("Isolated Slurm pod ready; installing accounting services inside this pod only");
  const install = await kubectl(
    [
      "-n",
      namespace,
      "exec",
      "slurm",
      "--",
      "bash",
      "-c",
      "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y --no-install-recommends slurmdbd mariadb-server",
    ],
    { timeout: 300000 },
  );
  await writeFile(resolve(output, "install.log"), install.stdout + install.stderr, { mode: 0o600 });
  const setup = await kubectl(
    [
      "-n",
      namespace,
      "exec",
      "slurm",
      "--",
      "env",
      "KQ_ACCOUNTING_LAB=1",
      "bash",
      "/workspace/deploy/federation/accounting/slurm-start.sh",
    ],
    { timeout: 150000 },
  );
  await writeFile(resolve(output, "setup.log"), setup.stdout + setup.stderr, { mode: 0o600 });
  console.log("Slurm accounting ready; running a one-core task with two CPU seconds of work");
  const probe = await kubectl(
    [
      "-n",
      namespace,
      "exec",
      "slurm",
      "--",
      "env",
      "LOG_LEVEL=warn",
      "KQ_ACCOUNTING_LAB=1",
      "bun",
      "/workspace/scripts/federation-slurm-accounting-probe.ts",
    ],
    { timeout: 90000 },
  );
  await writeFile(resolve(output, "observation.json"), probe.stdout, { mode: 0o600 });
  await writeFile(
    resolve(output, "checkout.json"),
    JSON.stringify(
      {
        image,
        namespace,
        config: await readFile(
          resolve(repo, "deploy/schedulers/slurm/slurm.conf.template"),
          "utf8",
        ),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`PASS actual Slurm task, sacct and production adapter; evidence: ${output}`);
} finally {
  if (created) {
    try {
      const diagnostics = await kubectl(
        [
          "-n",
          namespace,
          "exec",
          "slurm",
          "--",
          "sh",
          "-c",
          "tail -100 /tmp/slurmdbd.log /tmp/slurmctld.log /tmp/slurmd.log",
        ],
        { allowFailure: true },
      );
      await writeFile(resolve(output, "scheduler.log"), diagnostics.stdout + diagnostics.stderr, {
        mode: 0o600,
      });
    } finally {
      await kubectl(["delete", "namespace", namespace, "--wait=false"]);
      console.log(`Requested deletion of owned namespace ${namespace}`);
    }
  }
}
