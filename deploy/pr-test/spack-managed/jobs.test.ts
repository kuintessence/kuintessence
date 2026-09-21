import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectedCase } from "../spack-case/fixture";
import { buildManagedJob, managedJobOutputAccepted } from "./jobs";

const previousCase = process.env.KQ_PR_SPACK_CASE;
const temporary: string[] = [];
const queueId = randomUUID();
const prefix = "/srv/kq/spack/releases/11111111-1111-4111-8111-111111111111/root";
const load = `export PATH='${prefix}/bin':"$PATH"`;

afterEach(async () => {
  if (previousCase === undefined) delete process.env.KQ_PR_SPACK_CASE;
  else process.env.KQ_PR_SPACK_CASE = previousCase;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed acceptance job contract", () => {
  test("defaults to Hello and retains its output and bounded resources", () => {
    delete process.env.KQ_PR_SPACK_CASE;
    const job = buildManagedJob(queueId, prefix, load);
    expect(selectedCase().id).toBe("hello");
    expect(job.submission.name).toBe("pr_spack_managed_hello");
    expect(job.submission.resources).toEqual({ cpus: 1, memoryMb: 128, wallTimeSec: 60 });
    expect(job.submission.command).toContain("Hello, world!");
    expect(job.submission.command).toContain(`${prefix}/bin/hello`);
    expect(job.submission.schedulingStrategy).toEqual({ queueId });
    expect(job.successMarker).toBe("KQ_MANAGED_HELLO_OK");
  });

  test("samtools uses the controlled fixture, clean shell and complete acceptance sequence", () => {
    process.env.KQ_PR_SPACK_CASE = "samtools";
    const job = buildManagedJob(queueId, prefix, load);
    expect(selectedCase().name).toBe("samtools");
    expect(selectedCase().version).toBe("1.19.2");
    expect(job.submission.name).toBe("pr_spack_managed_samtools");
    expect(job.submission.resources).toEqual({ cpus: 2, memoryMb: 512, wallTimeSec: 120 });
    expect(job.timeoutMs).toBe(240_000);
    for (const required of [
      "exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C",
      "/bin/bash --noprofile --norc",
      "set -euo pipefail",
      "LD_PRELOAD LD_LIBRARY_PATH",
      "BASH_ENV ENV PYTHONPATH PYTHONHOME SPACK_LOADED_HASHES",
      "mktemp -d /tmp/kq-managed-samtools.XXXXXXXXXX",
      "/bin/rm -rf",
      `${prefix}/bin/samtools`,
      "samtools 1.19.2",
      "view -b -o unsorted.bam input.sam",
      "sort -@ 1 -m 64M",
      "index -@ 1 sorted.bam",
      "quickcheck -v sorted.bam",
      "chrSynthetic:1-50",
      "cmp -- expected.sam region.sam",
      "expect_rejected",
      "head -c 32 sorted.bam",
    ]) {
      expect(job.submission.command).toContain(required);
    }
    expect(job.successMarker).toBe("KQ_MANAGED_SAMTOOLS_OK");
    expect(job.submission.command.lastIndexOf(job.successMarker)).toBeGreaterThan(
      job.submission.command.lastIndexOf("view truncated.bam"),
    );
  });

  test.each(["", "unknown", "samtools;exit 0"])("rejects unknown fixture %j", (value) => {
    process.env.KQ_PR_SPACK_CASE = value;
    expect(() => buildManagedJob(queueId, prefix, load)).toThrow();
  });

  test.each(["relative", "/tmp/../bin", "/tmp/root';false", "/tmp/root\nbin"])(
    "rejects unsafe executable prefix %j",
    (value) => {
      process.env.KQ_PR_SPACK_CASE = "hello";
      expect(() => buildManagedJob(queueId, value, load)).toThrow();
    },
  );

  test.each(["", " ", "export PATH=\0", "x".repeat(256 * 1024 + 1)])(
    "rejects unusable load shell",
    (value) => {
      process.env.KQ_PR_SPACK_CASE = "hello";
      expect(() => buildManagedJob(queueId, prefix, value)).toThrow();
    },
  );

  test("requires exact marker lines, and retains the Hello output assertion", () => {
    expect(managedJobOutputAccepted("KQ_MANAGED_SAMTOOLS_OK\r\n", "KQ_MANAGED_SAMTOOLS_OK")).toBe(true);
    for (const text of ["", "prefix KQ_MANAGED_SAMTOOLS_OK", "KQ_MANAGED_SAMTOOLS_OK suffix"]) {
      expect(managedJobOutputAccepted(text, "KQ_MANAGED_SAMTOOLS_OK")).toBe(false);
    }
    expect(managedJobOutputAccepted("KQ_MANAGED_HELLO_OK\n", "KQ_MANAGED_HELLO_OK")).toBe(false);
    expect(
      managedJobOutputAccepted("Hello, world!\nKQ_MANAGED_HELLO_OK\n", "KQ_MANAGED_HELLO_OK"),
    ).toBe(true);
    expect(managedJobOutputAccepted("KQ_MANAGED_HELLO_OK\n", "KQ_MANAGED_SAMTOOLS_OK")).toBe(false);
  });
});

// These stubs test generated shell control flow only. Real samtools semantics,
// installation and API/Slurm delivery are exercised by the managed Actions case.
async function shellFixture(id: "hello" | "samtools", mode = "ok") {
  process.env.KQ_PR_SPACK_CASE = id;
  const directory = await mkdtemp(join(tmpdir(), "kq-managed-job-test-"));
  temporary.push(directory);
  const bin = join(directory, "bin");
  const trace = join(directory, "scratch.txt");
  const calls = join(directory, "calls.txt");
  await mkdir(bin);
  await writeFile(calls, "");
  const guard = [
    "#!/bin/bash",
    "set -euo pipefail",
    `mode='${mode}'`,
    `printf '%s' "$PWD" > '${trace}'`,
    'test "$HOME" = "$PWD" && test "$TMPDIR" = "$PWD"',
    'test -z "${LD_LIBRARY_PATH+x}${LD_PRELOAD+x}${PYTHONPATH+x}${PYTHONHOME+x}"',
    'test -z "${SPACK_LOADED_HASHES+x}${BASH_ENV+x}${ENV+x}"',
    'test "$LANG" = C && test "$LC_ALL" = C',
    `printf '%s\\n' "$*" >> '${calls}'`,
  ];
  const stub =
    id === "hello"
      ? ['test "$mode" != fail', "printf '%s\\n' 'Hello, world!'"]
      : [
          'case "$1" in',
          "  --version)",
          '    if test "$mode" = version; then echo "samtools 0.0.0"; else echo "samtools 1.19.2"; fi ;;',
          "  view)",
          "    shift",
          '    case "$*" in',
          '      "-b -o unsorted.bam input.sam")',
          '        test "$mode" != view; cp input.sam unsorted.bam ;;',
          '      "-c sorted.bam") echo 3 ;;',
          '      "-c sorted.bam chrSynthetic:1-50")',
          '        if test "$mode" = count; then echo 9; else echo 2; fi ;;',
          '      "sorted.bam chrSynthetic:1-50")',
          '        if test "$mode" = records; then echo wrong; else grep "^read[12]" sorted.bam; fi ;;',
          '      "-b -o invalid.bam invalid.sam")',
          '        if test "$mode" = accept-invalid; then exit 0; fi',
          '        if test "$mode" = unavailable-negative; then exit 127; fi',
          "        exit 1 ;;",
          '      "truncated.bam")',
          '        if test "$mode" = accept-truncated-view; then exit 0; fi; exit 1 ;;',
          "      *) exit 2 ;;",
          "    esac ;;",
          "  sort)",
          '    test "$mode" != sort; cp unsorted.bam sorted.bam ;;',
          "  index)",
          '    test "$mode" != index; printf stub > sorted.bam.bai ;;',
          "  quickcheck)",
          '    if test "$2" = -v && test "$3" = truncated.bam; then',
          '      test "$(wc -c < truncated.bam)" = 32',
          '      if test "$mode" = accept-truncated-check; then exit 0; fi; exit 8',
          "    fi",
          '    test "$mode" != quickcheck ;;',
          "  *) exit 2 ;;",
          "esac",
        ];
  await writeFile(join(bin, id), `${[...guard, ...stub].join("\n")}\n`, { mode: 0o700 });
  return {
    directory,
    trace,
    calls,
    shell: `printf '%s' "$PWD" > '${trace}'\nexport PATH='${bin}':"$PATH"`,
  };
}

async function executeJob(id: "hello" | "samtools", mode = "ok", pipelineFailure = false) {
  const fixture = await shellFixture(id, mode);
  const shell = pipelineFailure
    ? `printf '%s' "$PWD" > '${fixture.trace}'\nfalse | true\n${fixture.shell}`
    : fixture.shell;
  const expectedPrefix =
    mode === "wrong-prefix" ? join(fixture.directory, "other-release") : fixture.directory;
  const job = buildManagedJob(queueId, expectedPrefix, shell);
  const child = Bun.spawn({
    cmd: ["/bin/bash", "--noprofile", "--norc", "-c", job.submission.command],
    env: {
      PATH: "/inherited-wrong-path",
      LD_LIBRARY_PATH: "/inherited-wrong-libraries",
      PYTHONPATH: "/inherited-wrong-python",
      PYTHONHOME: "/inherited-wrong-python",
      SPACK_LOADED_HASHES: "inherited-wrong-hash",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const scratch = await readFile(fixture.trace, "utf8");
    expect(scratch).toMatch(new RegExp(`^/tmp/kq-managed-${id}\\.[A-Za-z0-9]{10}$`));
    temporary.push(scratch);
    await expect(stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
    const calls = (await readFile(fixture.calls, "utf8")).trim().split("\n");
    return { exitCode, accepted: managedJobOutputAccepted(stdout, job.successMarker), calls };
  } finally {
    clearTimeout(timer);
  }
}

describe("managed job shell control flow (stub executable, Actions only)", () => {
  test.each(["hello", "samtools"] as const)(
    "%s completes from a clean environment and removes scratch",
    async (id) => {
      expect(await executeJob(id)).toMatchObject({ exitCode: 0, accepted: true });
    },
    15_000,
  );

  test.each([
    ["version", /^--version$/],
    ["view", /^view -b -o unsorted\.bam input\.sam$/],
    ["sort", /^sort -@ 1 -m 64M -T /],
    ["index", /^index -@ 1 sorted\.bam$/],
    ["quickcheck", /^quickcheck -v sorted\.bam$/],
    ["count", /^view -c sorted\.bam chrSynthetic:1-50$/],
    ["records", /^view sorted\.bam chrSynthetic:1-50$/],
    ["accept-invalid", /^view -b -o invalid\.bam invalid\.sam$/],
    ["unavailable-negative", /^view -b -o invalid\.bam invalid\.sam$/],
    ["accept-truncated-check", /^quickcheck -v truncated\.bam$/],
    ["accept-truncated-view", /^view truncated\.bam$/],
    ["wrong-prefix", /^$/],
  ] as const)(
    "samtools rejects %s without emitting success and cleans scratch",
    async (mode, expectedLastCall) => {
      const result = await executeJob("samtools", mode);
      expect(result.exitCode).not.toBe(0);
      expect(result.accepted).toBe(false);
      expect(result.calls.at(-1)).toMatch(expectedLastCall);
    },
    15_000,
  );

  test("Hello errors remain failures", async () => {
    const result = await executeJob("hello", "fail");
    expect(result.exitCode).not.toBe(0);
    expect(result.accepted).toBe(false);
  }, 15_000);

  test("a failed pipeline in the load shell cannot be masked by its last command", async () => {
    const result = await executeJob("samtools", "ok", true);
    expect(result.exitCode).not.toBe(0);
    expect(result.accepted).toBe(false);
  }, 15_000);
});
