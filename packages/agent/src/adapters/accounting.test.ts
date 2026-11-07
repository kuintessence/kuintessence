import { expect, test } from "bun:test";
import { SchedulerAccountingSchema } from "@kuintessence/shared";
import { accountingDuration, accountingInteger, schedulerAccounting } from "./accounting";

test("scheduler durations preserve integer precision and separate missing values from real zero", () => {
  expect(accountingDuration("2-03:04:05.123456", true)).toBe("183845123");
  expect(accountingDuration("02:03.004", true)).toBe("123004");
  expect(accountingDuration("100:00:01")).toBe("360001000");
  expect(accountingDuration("2500000000000:00:00")).toBe("9000000000000000000");
  expect(accountingDuration("00:00:00")).toBe("0");
  for (const value of [
    "",
    "Unknown",
    "-1:02:03",
    "1:60:00",
    "1:00:60",
    "1-24:00:00",
    "00:00",
    null,
  ])
    expect(accountingDuration(value)).toBeUndefined();
  expect(accountingInteger("9007199254740993")).toBe("9007199254740993");
  expect(accountingInteger(9007199254740992)).toBeUndefined();
  expect(accountingInteger("0012")).toBe("12");
  expect(accountingInteger("1.5")).toBeUndefined();
});

test("partial accounting never fills absent CPU time or elapsed time with zero", () => {
  expect(schedulerAccounting("pbs-qstat", "42.pbs", {})).toBeUndefined();
  const partial = schedulerAccounting("pbs-qstat", "42.pbs", { elapsedMilliseconds: "0" });
  expect(partial?.elapsedMilliseconds).toBe("0");
  expect(partial?.cpuTimeMilliseconds).toBeUndefined();
  expect(
    SchedulerAccountingSchema.safeParse({ ...partial, cpuTimeMilliseconds: "-1" }).success,
  ).toBe(false);
});
