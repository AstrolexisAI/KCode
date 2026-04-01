import { describe, test, expect } from "bun:test";
import { ASCIICharts, charts } from "./charts";

describe("ASCIICharts", () => {
  describe("barChart", () => {
    test("renders horizontal bars", () => {
      const output = charts.barChart([
        { label: "Read", value: 80 },
        { label: "Edit", value: 40 },
        { label: "Bash", value: 20 },
      ]);
      expect(output).toContain("Read");
      expect(output).toContain("Edit");
      expect(output).toContain("\u2588");
      expect(output).toContain("80");
    });

    test("handles empty data", () => {
      expect(charts.barChart([])).toBe("");
    });

    test("handles single item", () => {
      const output = charts.barChart([{ label: "A", value: 10 }]);
      expect(output).toContain("A");
      expect(output).toContain("10");
    });

    test("hides values when showValue=false", () => {
      const output = charts.barChart(
        [{ label: "A", value: 42 }],
        { showValue: false },
      );
      expect(output).not.toContain("42");
    });

    test("respects custom width", () => {
      const narrow = charts.barChart(
        [{ label: "A", value: 100 }],
        { width: 10 },
      );
      const wide = charts.barChart(
        [{ label: "A", value: 100 }],
        { width: 50 },
      );
      expect(wide.length).toBeGreaterThan(narrow.length);
    });
  });

  describe("sparkline", () => {
    test("renders sparkline", () => {
      const output = charts.sparkline([1, 3, 5, 2, 8, 4, 6]);
      expect(output.length).toBe(7);
    });

    test("handles flat data", () => {
      const output = charts.sparkline([5, 5, 5, 5]);
      expect(output.length).toBe(4);
    });

    test("handles empty data", () => {
      expect(charts.sparkline([])).toBe("");
    });

    test("uses block characters", () => {
      const output = charts.sparkline([0, 100]);
      expect(output[0]).toBe("\u2581"); // lowest
      expect(output[1]).toBe("\u2588"); // highest
    });
  });

  describe("table", () => {
    test("renders formatted table", () => {
      const output = charts.table(
        ["Name", "Count"],
        [
          ["Read", "80"],
          ["Edit", "40"],
        ],
      );
      expect(output).toContain("Name");
      expect(output).toContain("Count");
      expect(output).toContain("Read");
      expect(output).toContain("\u2502"); // vertical line
      expect(output).toContain("\u2500"); // horizontal line
    });

    test("handles empty data", () => {
      expect(charts.table([], [])).toBe("");
    });

    test("aligns columns", () => {
      const output = charts.table(
        ["A", "Longer Header"],
        [["x", "y"]],
      );
      const lines = output.split("\n");
      // All lines should be same length
      expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    });
  });

  describe("pieChart", () => {
    test("renders percentage breakdown", () => {
      const output = charts.pieChart([
        { label: "A", value: 75 },
        { label: "B", value: 25 },
      ]);
      expect(output).toContain("75.0%");
      expect(output).toContain("25.0%");
    });

    test("handles empty data", () => {
      expect(charts.pieChart([])).toBe("");
    });
  });

  describe("histogram", () => {
    test("renders histogram", () => {
      const data = [1, 2, 2, 3, 3, 3, 4, 4, 5, 8, 10];
      const output = charts.histogram(data, 5);
      expect(output.split("\n").length).toBe(5);
      expect(output).toContain("\u2588");
    });

    test("handles empty data", () => {
      expect(charts.histogram([])).toBe("");
    });
  });
});
