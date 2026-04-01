import { describe, expect, test } from "bun:test";
import {
  contentToSource,
  createCell,
  findCell,
  notebookSummary,
  parseNotebook,
  serializeNotebook,
  sourceToContent,
} from "./notebook-utils";

const SAMPLE_NOTEBOOK = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
  },
  cells: [
    {
      cell_type: "markdown",
      source: ["# Title\n", "Description"],
      metadata: {},
    },
    {
      cell_type: "code",
      source: ["import pandas as pd\n", "df = pd.read_csv('data.csv')"],
      metadata: {},
      outputs: [{ output_type: "stream", text: ["loaded 100 rows\n"], name: "stdout" }],
      execution_count: 1,
    },
    {
      cell_type: "code",
      source: ["print(df.head())"],
      metadata: {},
      outputs: [],
      execution_count: 2,
    },
  ],
});

describe("parseNotebook", () => {
  test("parses valid nbformat 4 notebook", () => {
    const nb = parseNotebook(SAMPLE_NOTEBOOK);
    expect(nb.nbformat).toBe(4);
    expect(nb.cells).toHaveLength(3);
    expect(nb.metadata.kernelspec?.display_name).toBe("Python 3");
  });

  test("rejects non-v4 notebooks", () => {
    const nb3 = JSON.stringify({ nbformat: 3, cells: [] });
    expect(() => parseNotebook(nb3)).toThrow("Only nbformat 4");
  });

  test("rejects invalid JSON", () => {
    expect(() => parseNotebook("not json")).toThrow();
  });
});

describe("serializeNotebook", () => {
  test("produces valid JSON with trailing newline", () => {
    const nb = parseNotebook(SAMPLE_NOTEBOOK);
    const output = serializeNotebook(nb);
    expect(output.endsWith("\n")).toBe(true);
    const reparsed = JSON.parse(output);
    expect(reparsed.cells).toHaveLength(3);
  });
});

describe("findCell", () => {
  test("finds cell by index", () => {
    const nb = parseNotebook(SAMPLE_NOTEBOOK);
    expect(findCell(nb, { index: 1 })).toBe(1);
  });

  test("finds cell by content", () => {
    const nb = parseNotebook(SAMPLE_NOTEBOOK);
    expect(findCell(nb, { contains: "pandas" })).toBe(1);
  });

  test("returns -1 when content not found", () => {
    const nb = parseNotebook(SAMPLE_NOTEBOOK);
    expect(findCell(nb, { contains: "nonexistent" })).toBe(-1);
  });

  test("returns -1 when neither index nor contains given", () => {
    const nb = parseNotebook(SAMPLE_NOTEBOOK);
    expect(findCell(nb, {})).toBe(-1);
  });
});

describe("contentToSource", () => {
  test("splits content into Jupyter source lines", () => {
    const lines = contentToSource("line1\nline2\nline3");
    expect(lines).toEqual(["line1\n", "line2\n", "line3"]);
  });

  test("handles single line", () => {
    const lines = contentToSource("single");
    expect(lines).toEqual(["single"]);
  });
});

describe("sourceToContent", () => {
  test("joins source lines", () => {
    expect(sourceToContent(["line1\n", "line2"])).toBe("line1\nline2");
  });
});

describe("createCell", () => {
  test("creates code cell with outputs and execution_count", () => {
    const cell = createCell("x = 1", "code");
    expect(cell.cell_type).toBe("code");
    expect(cell.outputs).toEqual([]);
    expect(cell.execution_count).toBeNull();
    expect(cell.source).toEqual(["x = 1"]);
  });

  test("creates markdown cell without outputs", () => {
    const cell = createCell("# Hello", "markdown");
    expect(cell.cell_type).toBe("markdown");
    expect(cell.outputs).toBeUndefined();
  });

  test("defaults to code type", () => {
    const cell = createCell("x = 1");
    expect(cell.cell_type).toBe("code");
  });
});

describe("notebookSummary", () => {
  test("produces human-readable summary", () => {
    const nb = parseNotebook(SAMPLE_NOTEBOOK);
    const summary = notebookSummary(nb);
    expect(summary).toContain("3 cells");
    expect(summary).toContain("2 code");
    expect(summary).toContain("1 markdown");
    expect(summary).toContain("Python 3");
  });
});
