/** Canonical JSON makes signatures independent of transport serialization details. */
export function ecosystemCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(ecosystemCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${ecosystemCanonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Bundle manifest contains a non-JSON value");
}
