import { describe, expect, test } from "bun:test";
import type { TuiSoftware } from "../backend/types";
import { initialState, type TuiState } from "../store";
import { render } from "../test-render";
import { SoftwarePane } from "./software-pane";

function softwareState(items: TuiSoftware[]): TuiState {
  return {
    ...initialState("software"),
    software: items,
    softwarePage: {
      page: 1,
      pageSize: 24,
      totalCount: items.length,
      totalPages: 1,
      serverFiltered: false,
    },
  };
}

const items: TuiSoftware[] = [
  {
    id: "public/openmpi",
    name: "openmpi",
    source: "upstream",
    versions: ["4.1.5", "5.0.0"],
    lifecycle: "published",
    spec: "openmpi@4.1.5",
  },
  {
    id: "org/x/cuda",
    name: "cuda",
    source: "vendor",
    versions: ["12.3"],
    lifecycle: "published",
    locked: true,
    spec: "cuda@12.3",
  },
];

describe("SoftwarePane", () => {
  test("renders the table with each software row", async () => {
    const { lastFrame } = await render(
      <SoftwarePane state={softwareState(items)} viewportRows={10} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("SOURCE");
    expect(frame).toContain("upstream");
    expect(frame).toContain("openmpi");
    expect(frame).toContain("4.1.5");
    expect(frame).toContain("vendor");
    expect(frame).toContain("cuda");
  });

  test("shows the catalog page and total count", async () => {
    const { lastFrame } = await render(
      <SoftwarePane state={softwareState(items)} viewportRows={10} />,
    );
    expect(lastFrame() ?? "").toContain("2 packages · page 1/1");
  });

  test("shows an empty / filtered-empty notice", async () => {
    expect((await render(<SoftwarePane state={softwareState([])} />)).lastFrame() ?? "").toContain(
      "No software found.",
    );
    const filtered: TuiState = { ...softwareState(items), filter: "zzz" };
    expect((await render(<SoftwarePane state={filtered} />)).lastFrame() ?? "").toContain(
      'No software matches "zzz"',
    );
  });

  test("detail view shows catalog-native source, versions, lifecycle, and optional local fields", async () => {
    const detail: TuiState = { ...softwareState(items), view: "detail", selectedIndex: 1 };
    const frame = (await render(<SoftwarePane state={detail} />)).lastFrame() ?? "";
    expect(frame).toContain("org/x/cuda");
    expect(frame).toContain("Source: vendor");
    expect(frame).toContain("Versions: 12.3");
    expect(frame).toContain("Lifecycle: published");
    expect(frame).toContain("Locked: yes");
    expect(frame).toContain("Spec: cuda@12.3");
  });

  test("shows a loading notice before the first fetch lands", async () => {
    const loading: TuiState = { ...softwareState([]), loading: true };
    expect((await render(<SoftwarePane state={loading} />)).lastFrame() ?? "").toContain(
      "Loading software…",
    );
  });

  test("surfaces a fetch error when the list is empty", async () => {
    const errored: TuiState = { ...softwareState([]), error: "registry unreachable" };
    expect((await render(<SoftwarePane state={errored} />)).lastFrame() ?? "").toContain(
      "Error: registry unreachable",
    );
  });
});
