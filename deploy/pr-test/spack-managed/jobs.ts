import assert from "node:assert/strict";
import { JobSubmitSchema } from "@kuintessence/shared";
import { SpackInstallPathSchema } from "../../../packages/agent/src/spack/install-contract";
import { selectedCase } from "../spack-case/fixture";

type SuccessMarker = "KQ_MANAGED_HELLO_OK" | "KQ_MANAGED_SAMTOOLS_OK";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function samtoolsCommands(version: string): string[] {
  return [
    '"$binary" --version > version.txt',
    "IFS= read -r version < version.txt",
    `test "$version" = ${quote(`samtools ${version}`)}`,
    "printf '%s\\n' \\",
    "  $'@HD\\tVN:1.6\\tSO:unsorted' \\",
    "  $'@SQ\\tSN:chrSynthetic\\tLN:200' \\",
    "  $'read3\\t0\\tchrSynthetic\\t100\\t60\\t10M\\t*\\t0\\t0\\tGGGGGTTTTT\\tIIIIIIIIII' \\",
    "  $'read1\\t0\\tchrSynthetic\\t10\\t60\\t10M\\t*\\t0\\t0\\tACGTACGTAA\\tIIIIIIIIII' \\",
    "  $'read2\\t0\\tchrSynthetic\\t30\\t60\\t10M\\t*\\t0\\t0\\tTTGCAACGTT\\tIIIIIIIIII' > input.sam",
    '"$binary" view -b -o unsorted.bam input.sam',
    '"$binary" sort -@ 1 -m 64M -T "$scratch/sort" -o sorted.bam unsorted.bam',
    '"$binary" index -@ 1 sorted.bam',
    "test -s sorted.bam.bai",
    '"$binary" quickcheck -v sorted.bam',
    '"$binary" view -c sorted.bam > total.txt',
    'test "$(cat total.txt)" = 3',
    '"$binary" view -c sorted.bam chrSynthetic:1-50 > count.txt',
    'test "$(cat count.txt)" = 2',
    '"$binary" view sorted.bam chrSynthetic:1-50 > region.sam',
    "printf '%s\\n' \\",
    "  $'read1\\t0\\tchrSynthetic\\t10\\t60\\t10M\\t*\\t0\\t0\\tACGTACGTAA\\tIIIIIIIIII' \\",
    "  $'read2\\t0\\tchrSynthetic\\t30\\t60\\t10M\\t*\\t0\\t0\\tTTGCAACGTT\\tIIIIIIIIII' > expected.sam",
    "cmp -- expected.sam region.sam",
    "expect_rejected() {",
    '  if "$@" > /dev/null 2>&1; then return 1; else',
    "    status=$?",
    '    test "$status" -gt 0 && test "$status" -lt 126',
    "  fi",
    "}",
    "printf '%s\\n' 'not-a-SAM-record' > invalid.sam",
    'expect_rejected "$binary" view -b -o invalid.bam invalid.sam',
    'test "$(wc -c < sorted.bam)" -gt 32',
    "head -c 32 sorted.bam > truncated.bam",
    'expect_rejected "$binary" quickcheck -v truncated.bam',
    'expect_rejected "$binary" view truncated.bam',
  ];
}

export function buildManagedJob(queueId: string, prefix: string, shell: string) {
  const fixture = selectedCase();
  SpackInstallPathSchema.parse(prefix);
  assert(
    shell.trim().length > 0 && shell.length <= 256 * 1024 && !shell.includes("\0"),
    "Managed load did not return a usable shell",
  );
  const samtools = fixture.id === "samtools";
  const successMarker: SuccessMarker = samtools ? "KQ_MANAGED_SAMTOOLS_OK" : "KQ_MANAGED_HELLO_OK";
  const resources = samtools
    ? { cpus: 2, memoryMb: 512, wallTimeSec: 120 }
    : { cpus: 1, memoryMb: 128, wallTimeSec: 60 };
  const script = [
    "set -euo pipefail",
    "umask 077",
    `scratch="$(mktemp -d /tmp/kq-managed-${fixture.id}.XXXXXXXXXX)"`,
    "trap '/bin/rm -rf -- \"$scratch\"' EXIT",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    'cd -- "$scratch"',
    'export HOME="$scratch" TMPDIR="$scratch"',
    // Only the already-verified managed load result may populate this clean environment.
    shell,
    "set -euo pipefail",
    "hash -r",
    `binary=${quote(`${prefix}/bin/${fixture.name}`)}`,
    `test "$(command -v ${quote(fixture.name)})" = "$binary"`,
    'test -x "$binary"',
    ...(samtools
      ? samtoolsCommands(fixture.version)
      : [
          '"$binary" > hello.txt',
          'test "$(cat hello.txt)" = "Hello, world!"',
          "printf '%s\\n' 'Hello, world!'",
        ]),
    `printf '%s\\n' ${quote(successMarker)}`,
  ].join("\n");
  return {
    successMarker,
    timeoutMs: resources.wallTimeSec * 1000 + 120_000,
    submission: JobSubmitSchema.parse({
      name: `pr_spack_managed_${fixture.id}`,
      // Scrub loader/shell injection before launching env; env -i also removes Python,
      // module and inherited Spack state. No login scripts or inherited shell functions.
      command: [
        "unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH",
        "unset BASH_ENV ENV PYTHONPATH PYTHONHOME SPACK_LOADED_HASHES",
        `exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /bin/bash --noprofile --norc -c ${quote(script)}`,
      ].join("\n"),
      resources,
      schedulingStrategy: { queueId },
    }),
  };
}

export function managedJobOutputAccepted(text: string, marker: SuccessMarker): boolean {
  const lines = new Set(text.split(/\r?\n/));
  return lines.has(marker) && (marker !== "KQ_MANAGED_HELLO_OK" || lines.has("Hello, world!"));
}
