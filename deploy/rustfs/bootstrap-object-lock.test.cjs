const { describe, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const scripts = [
  path.join(__dirname, "bootstrap-object-lock.sh"),
  path.join(__dirname, "../helm/kq-platform/files/bootstrap-object-lock.sh"),
];
const privateValues = {
  RUSTFS_ENDPOINT: "http://PRIVATE_ENDPOINT.invalid:9000",
  RUSTFS_ACCESS_KEY: "PRIVATE_ROOT_KEY",
  RUSTFS_SECRET_KEY: "PRIVATE_ROOT_SECRET",
  DATA_MARKET_COMMITTER_SECRET_KEY: "PRIVATE_COMMITTER_SECRET",
};

const mockRc = `#!/bin/sh
set -eu
record() { printf '%s\\n' "$1" >> "$MOCK_DIR/events"; }
probe() {
  count=0
  if [ -f "$MOCK_DIR/$1-count" ]; then
    count="$(cat "$MOCK_DIR/$1-count")"
  fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$MOCK_DIR/$1-count"
  printf '%s %s %s %s\\n' "$RUSTFS_ENDPOINT" "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" "$DATA_MARKET_COMMITTER_SECRET_KEY"
  printf '%s %s %s %s\\n' "$RUSTFS_ENDPOINT" "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" "$DATA_MARKET_COMMITTER_SECRET_KEY" >&2
  if [ "$count" -le "$2" ]; then
    record "$1:fail"
    exit 1
  fi
  record "$1:ok"
}
case "$1" in
  alias)
    probe alias "$MOCK_ALIAS_FAILURES"
    touch "$MOCK_DIR/alias-ok"
    ;;
  ready)
    [ -f "$MOCK_DIR/alias-ok" ]
    probe ready "$MOCK_READY_FAILURES"
    touch "$MOCK_DIR/ready-ok"
    ;;
  mb)
    if [ ! -f "$MOCK_DIR/ready-ok" ]; then
      record premature-bucket
      exit 99
    fi
    record "mb:$*"
    ;;
  version | retention)
    record "$*"
    ;;
  --json)
    record "$1 $2 $3"
    printf '{}\\n'
    ;;
  admin)
    record "$1 $2 $3"
    ;;
  cors | ilm)
    record "$1 $2"
    ;;
  *) exit 98 ;;
esac
`;

const mockSleep = `#!/bin/sh
set -eu
printf 'sleep:%s\\n' "$1" >> "$MOCK_DIR/events"
`;

// The readiness tests mock jq too; they do not validate RustFS JSON semantics.
const mockJq = `#!/bin/sh
set -eu
for arg do
  case "$arg" in
    */retention.json) check=retention ;;
    */user.json) check=iam ;;
  esac
done
printf 'check:%s\\n' "$check" >> "$MOCK_DIR/events"
[ "$MOCK_REJECT_CHECK" != "$check" ]
`;

function bootstrap(script, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "kq-bootstrap-mock-"));
  try {
    for (const [name, content] of Object.entries({ rc: mockRc, sleep: mockSleep, jq: mockJq })) {
      writeFileSync(path.join(directory, name), content, { mode: 0o700 });
    }
    writeFileSync(path.join(directory, "events"), "");
    const result = spawnSync("/bin/sh", [script], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        ...privateValues,
        MOCK_DIR: directory,
        MOCK_ALIAS_FAILURES: String(options.aliasFailures ?? 0),
        MOCK_READY_FAILURES: String(options.readyFailures ?? 0),
        MOCK_REJECT_CHECK: options.rejectCheck ?? "",
        RUSTFS_READY_TIMEOUT_SECONDS: String(options.budget ?? 4),
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    for (const value of Object.values(privateValues)) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
    return {
      ...result,
      events: readFileSync(path.join(directory, "events"), "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Compose and Helm embed byte-identical bootstrap scripts", () => {
  expect(readFileSync(scripts[0], "utf8")).toBe(readFileSync(scripts[1], "utf8"));
});

for (const script of scripts) {
  describe(path.relative(path.join(__dirname, ".."), script), () => {
    test("retries transient alias failure before any readiness or bucket operation", () => {
      const result = bootstrap(script, { aliasFailures: 1 });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.events.slice(0, 5)).toEqual([
        "alias:fail", "sleep:2", "alias:ok", "ready:ok", "mb:mb --ignore-existing local/kq-netdrive",
      ]);
      expect(result.events).not.toContain("premature-bucket");
      expect(result.events.filter((event) => event.startsWith("mb:"))).toEqual([
        "mb:mb --ignore-existing local/kq-netdrive",
        "mb:mb --ignore-existing local/kq-data-market-staging",
        "mb:mb --ignore-existing --with-lock local/kq-data-market-immutable",
      ]);
      expect(result.events).toContain("version enable local/kq-data-market-immutable");
      expect(result.events).toContain("retention set --default compliance 365d local/kq-data-market-immutable");
      expect(result.events.slice(-5)).toEqual([
        "admin user add", "admin policy create", "admin policy attach", "--json admin user", "check:iam",
      ]);
    });

    test("persistent alias failure exhausts the budget without ready or bucket calls", () => {
      const result = bootstrap(script, { aliasFailures: 100 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("RustFS did not become ready within 4 seconds\n");
      expect(result.events).toEqual([
        "alias:fail", "sleep:2", "alias:fail", "sleep:2", "alias:fail",
      ]);
    });

    test("alias and ready can recover using one shared waiting budget", () => {
      const result = bootstrap(script, { aliasFailures: 1, readyFailures: 1 });
      expect(result.status).toBe(0);
      expect(result.events.slice(0, 7)).toEqual([
        "alias:fail", "sleep:2", "alias:ok", "ready:fail", "sleep:2", "ready:ok",
        "mb:mb --ignore-existing local/kq-netdrive",
      ]);
      expect(result.events.filter((event) => event.startsWith("sleep:"))).toHaveLength(2);
      expect(result.events.filter((event) => event.startsWith("alias:"))).toHaveLength(2);
    });

    test("alias retries do not give ready a fresh budget or permit bucket creation", () => {
      const result = bootstrap(script, { aliasFailures: 1, readyFailures: 2 });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("RustFS did not become ready within 4 seconds\n");
      expect(result.events).toEqual([
        "alias:fail", "sleep:2", "alias:ok", "ready:fail", "sleep:2", "ready:fail",
      ]);
    });

    test("persistent ready failure remains fail closed after alias succeeds", () => {
      const result = bootstrap(script, { readyFailures: 100 });
      expect(result.status).toBe(1);
      expect(result.events).toEqual([
        "alias:ok", "ready:fail", "sleep:2", "ready:fail", "sleep:2", "ready:fail",
      ]);
    });

    test.each(["retention", "iam"])("still rejects failed %s verification after recovery", (rejectCheck) => {
      const result = bootstrap(script, { aliasFailures: 1, rejectCheck });
      expect(result.status).toBe(1);
      expect(result.events.at(-1)).toBe(`check:${rejectCheck}`);
      expect(result.stderr).toBe(rejectCheck === "retention"
        ? "DATA_MARKET_IMMUTABLE_BUCKET must support COMPLIANCE Object Lock\n"
        : "Data Market committer IAM policy was not attached\n");
      if (rejectCheck === "retention") expect(result.events).not.toContain("admin user add");
    });
  });
}
