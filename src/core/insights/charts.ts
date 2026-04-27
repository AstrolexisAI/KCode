// KCode - ASCII Chart Rendering

import type { ChartData } from "./types";

export class ASCIICharts {
  barChart(data: ChartData[], config?: { width?: number; showValue?: boolean }): string {
    if (data.length === 0) return "";
    const maxValue = Math.max(...data.map((d) => d.value));
    const maxWidth = config?.width || 40;
    const maxLabel = Math.max(...data.map((d) => d.label.length));

    return data
      .map((d) => {
        const barLen = maxValue > 0 ? Math.round((d.value / maxValue) * maxWidth) : 0;
        const bar = "\u2588".repeat(barLen);
        const label = d.label.padEnd(maxLabel);
        const value = config?.showValue !== false ? ` ${d.value}` : "";
        return `${label} \u2502${bar}${value}`;
      })
      .join("\n");
  }

  sparkline(data: number[]): string {
    if (data.length === 0) return "";
    const chars = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    return data
      .map((v) => {
        const index = Math.round(((v - min) / range) * (chars.length - 1));
        return chars[index];
      })
      .join("");
  }

  table(headers: string[], rows: string[][]): string {
    if (headers.length === 0) return "";
    const colWidths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] || "").length)),
    );

    const sep = (l: string, m: string, r: string) =>
      l + colWidths.map((w) => "\u2500".repeat(w + 2)).join(m) + r;

    const formatRow = (cells: string[]) =>
      "\u2502" +
      cells.map((c, i) => ` ${(c || "").padEnd(colWidths[i]!)} `).join("\u2502") +
      "\u2502";

    return [
      sep("\u250c", "\u252c", "\u2510"),
      formatRow(headers),
      sep("\u251c", "\u253c", "\u2524"),
      ...rows.map(formatRow),
      sep("\u2514", "\u2534", "\u2518"),
    ].join("\n");
  }

  pieChart(data: ChartData[]): string {
    if (data.length === 0) return "";
    const total = data.reduce((s, d) => s + d.value, 0);
    if (total === 0) return "";

    const maxLabel = Math.max(...data.map((d) => d.label.length));
    const barWidth = 20;

    return data
      .map((d) => {
        const pct = (d.value / total) * 100;
        const filled = Math.round((pct / 100) * barWidth);
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
        return `${d.label.padEnd(maxLabel)} ${bar} ${pct.toFixed(1)}%`;
      })
      .join("\n");
  }

  histogram(data: number[], bins: number = 10): string {
    if (data.length === 0) return "";
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const binWidth = range / bins;

    const buckets = new Array(bins).fill(0);
    for (const v of data) {
      const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
      buckets[idx]++;
    }

    const maxCount = Math.max(...buckets);
    const barWidth = 30;

    return buckets
      .map((count, i) => {
        const lo = (min + i * binWidth).toFixed(1);
        const hi = (min + (i + 1) * binWidth).toFixed(1);
        const label = `${lo}-${hi}`.padEnd(15);
        const barLen = maxCount > 0 ? Math.round((count / maxCount) * barWidth) : 0;
        const bar = "\u2588".repeat(barLen);
        return `${label} \u2502${bar} ${count}`;
      })
      .join("\n");
  }
}

export const charts = new ASCIICharts();
