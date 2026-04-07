// KCode - Web Engine: Analytics Dashboard Template
//
// Complete Analytics Dashboard with Next.js + React + Tailwind.
// Pure CSS/SVG charts, no external chart libraries.
// All components are 100% machine-generated (needsLlm: false).

import type { FileTemplate } from "../templates";

export function analyticsDashboardComponents(): FileTemplate[] {
  return [
    // ── Dashboard Page ────────────────────────────────────────────
    {
      path: "src/app/page.tsx",
      content: `"use client";
import { useState } from "react";
import KPICards from "@/components/KPICards";
import TrafficChart from "@/components/TrafficChart";
import DeviceBreakdown from "@/components/DeviceBreakdown";
import TopPages from "@/components/TopPages";
import GeographyMap from "@/components/GeographyMap";
import RealTimeWidget from "@/components/RealTimeWidget";
import DateRangePicker from "@/components/DateRangePicker";
import SourceBreakdown from "@/components/SourceBreakdown";
import { BarChart3, Bell, Settings } from "lucide-react";

export default function AnalyticsDashboard() {
  const [dateRange, setDateRange] = useState("30d");

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-gray-800 bg-[#0a0a0a]/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600">
              <BarChart3 className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-lg font-bold text-white">Analytics</h1>
          </div>
          <div className="flex items-center gap-4">
            <DateRangePicker value={dateRange} onChange={setDateRange} />
            <button className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white transition">
              <Bell className="h-5 w-5" />
            </button>
            <button className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white transition">
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-[1400px] space-y-8 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white">Overview</h2>
            <p className="text-sm text-gray-500 mt-1">Your website performance at a glance.</p>
          </div>
          <RealTimeWidget />
        </div>

        <KPICards />

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
          <div className="xl:col-span-2">
            <TrafficChart />
          </div>
          <div>
            <DeviceBreakdown />
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
          <div className="xl:col-span-2">
            <TopPages />
          </div>
          <div>
            <SourceBreakdown />
          </div>
        </div>

        <GeographyMap />
      </main>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── KPI Cards ─────────────────────────────────────────────────
    {
      path: "src/components/KPICards.tsx",
      content: `import { Activity, Users, TrendingDown, TrendingUp, DollarSign, ArrowUpRight, ArrowDownRight } from "lucide-react";

interface KPI {
  label: string;
  value: string;
  previous: string;
  change: number;
  icon: React.ElementType;
}

const kpis: KPI[] = [
  { label: "Page Views", value: "284,912", previous: "251,340", change: 13.3, icon: Activity },
  { label: "Unique Visitors", value: "87,241", previous: "79,108", change: 10.3, icon: Users },
  { label: "Bounce Rate", value: "42.3%", previous: "45.1%", change: -6.2, icon: TrendingDown },
  { label: "Avg Session", value: "4m 32s", previous: "3m 58s", change: 14.3, icon: TrendingUp },
  { label: "Conversion Rate", value: "3.84%", previous: "3.21%", change: 19.6, icon: TrendingUp },
  { label: "Revenue", value: "$52,847", previous: "$45,230", change: 16.8, icon: DollarSign },
];

export default function KPICards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      {kpis.map((kpi) => {
        const Icon = kpi.icon;
        const positive = kpi.label === "Bounce Rate" ? kpi.change < 0 : kpi.change > 0;
        const Arrow = positive ? ArrowUpRight : ArrowDownRight;
        return (
          <div
            key={kpi.label}
            className="rounded-xl border border-gray-800 bg-[#111111] p-5 hover:border-gray-700 transition"
          >
            <div className="flex items-center justify-between">
              <Icon className="h-4 w-4 text-gray-500" />
              <span
                className={\`flex items-center gap-0.5 text-xs font-medium \${
                  positive ? "text-emerald-400" : "text-red-400"
                }\`}
              >
                <Arrow className="h-3 w-3" />
                {Math.abs(kpi.change)}%
              </span>
            </div>
            <p className="mt-3 text-xl font-bold text-white">{kpi.value}</p>
            <p className="text-xs text-gray-500 mt-1">{kpi.label}</p>
            <p className="text-[10px] text-gray-600 mt-0.5">vs {kpi.previous}</p>
          </div>
        );
      })}
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Traffic Chart (SVG) ───────────────────────────────────────
    {
      path: "src/components/TrafficChart.tsx",
      content: `"use client";
import { useState } from "react";

const trafficData = [
  8420, 9130, 7850, 10240, 9870, 11350, 10690, 12480, 11920, 13100,
  12540, 14200, 13670, 15020, 14380, 13920, 15680, 14870, 16200, 15430,
  17100, 16580, 18240, 17390, 19100, 18420, 17860, 19540, 20100, 21350,
];

const labels = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(2026, 2, i + 1);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
});

export default function TrafficChart() {
  const [hovered, setHovered] = useState<number | null>(null);

  const max = Math.max(...trafficData);
  const min = Math.min(...trafficData);
  const range = max - min || 1;
  const W = 800;
  const H = 280;
  const padX = 50;
  const padY = 30;
  const chartW = W - padX * 2;
  const chartH = H - padY * 2;

  const points = trafficData.map((v, i) => ({
    x: padX + (i / (trafficData.length - 1)) * chartW,
    y: padY + chartH - ((v - min) / range) * chartH,
    value: v,
  }));

  const linePath = points.map((p, i) => \`\${i === 0 ? "M" : "L"} \${p.x} \${p.y}\`).join(" ");
  const areaPath = \`\${linePath} L \${points[points.length - 1].x} \${padY + chartH} L \${points[0].x} \${padY + chartH} Z\`;

  const yTicks = 5;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = min + (range / yTicks) * i;
    return { value: Math.round(val), y: padY + chartH - (i / yTicks) * chartH };
  });

  return (
    <div className="rounded-xl border border-gray-800 bg-[#111111] p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Traffic Overview</h2>
          <p className="text-xs text-gray-500 mt-0.5">Page views over the last 30 days</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-white">{trafficData.reduce((a, b) => a + b, 0)}</p>
          <p className="text-xs text-emerald-400">Total views</p>
        </div>
      </div>

      <svg viewBox={\`0 0 \${W} \${H}\`} className="w-full" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {yLabels.map((tick, i) => (
          <g key={i}>
            <line x1={padX} y1={tick.y} x2={W - padX} y2={tick.y} stroke="#1f1f1f" strokeWidth="1" />
            <text x={padX - 8} y={tick.y + 4} textAnchor="end" fill="#555" fontSize="10">
              {(tick.value / 1000).toFixed(1)}k
            </text>
          </g>
        ))}

        {/* Area */}
        <path d={areaPath} fill="url(#areaGrad)" />

        {/* Line */}
        <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

        {/* Hover targets */}
        {points.map((p, i) => (
          <g key={i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
            <rect x={p.x - chartW / trafficData.length / 2} y={padY} width={chartW / trafficData.length} height={chartH} fill="transparent" />
            {hovered === i && (
              <>
                <line x1={p.x} y1={padY} x2={p.x} y2={padY + chartH} stroke="#6366f1" strokeWidth="1" strokeDasharray="4" opacity="0.5" />
                <circle cx={p.x} cy={p.y} r="5" fill="#6366f1" stroke="#0a0a0a" strokeWidth="2" />
                <rect x={p.x - 40} y={p.y - 30} width="80" height="22" rx="4" fill="#1f1f1f" />
                <text x={p.x} y={p.y - 15} textAnchor="middle" fill="#fff" fontSize="11" fontWeight="600">
                  {p.value}
                </text>
              </>
            )}
          </g>
        ))}

        {/* X labels */}
        {points.filter((_, i) => i % 5 === 0).map((p, i) => (
          <text key={i} x={p.x} y={H - 4} textAnchor="middle" fill="#555" fontSize="10">
            {labels[i * 5]}
          </text>
        ))}
      </svg>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Device Breakdown (SVG Donut) ──────────────────────────────
    {
      path: "src/components/DeviceBreakdown.tsx",
      content: `const devices = [
  { label: "Desktop", value: 58.4, color: "#6366f1" },
  { label: "Mobile", value: 34.2, color: "#10b981" },
  { label: "Tablet", value: 7.4, color: "#f59e0b" },
];

function DonutChart({ data }: { data: typeof devices }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const cx = 80;
  const cy = 80;
  const r = 60;
  const strokeWidth = 20;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  return (
    <svg viewBox="0 0 160 160" className="w-48 h-48 mx-auto">
      {data.map((d, i) => {
        const segmentLength = (d.value / total) * circumference;
        const dashArray = \`\${segmentLength} \${circumference - segmentLength}\`;
        const dashOffset = -offset;
        offset += segmentLength;
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={d.color}
            strokeWidth={strokeWidth}
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform={\`rotate(-90 \${cx} \${cy})\`}
            className="transition-all duration-500"
          />
        );
      })}
      <text x={cx} y={cy - 6} textAnchor="middle" fill="#fff" fontSize="20" fontWeight="700">
        {data[0].value}%
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fill="#666" fontSize="10">
        Desktop
      </text>
    </svg>
  );
}

export default function DeviceBreakdown() {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#111111] p-6 h-full">
      <h2 className="text-lg font-semibold text-white mb-6">Devices</h2>
      <DonutChart data={devices} />
      <div className="mt-6 space-y-3">
        {devices.map((d) => (
          <div key={d.label} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full" style={{ backgroundColor: d.color }} />
              <span className="text-sm text-gray-400">{d.label}</span>
            </div>
            <span className="text-sm font-medium text-white">{d.value}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Top Pages ─────────────────────────────────────────────────
    {
      path: "src/components/TopPages.tsx",
      content: `const pages = [
  { path: "/", views: 48210, uniques: 32140, avgTime: "2m 45s", bounce: "38.2%" },
  { path: "/pricing", views: 24830, uniques: 18920, avgTime: "3m 12s", bounce: "32.1%" },
  { path: "/blog/getting-started", views: 18450, uniques: 14230, avgTime: "5m 08s", bounce: "28.4%" },
  { path: "/features", views: 15670, uniques: 11840, avgTime: "2m 55s", bounce: "41.3%" },
  { path: "/docs/api-reference", views: 12940, uniques: 9870, avgTime: "6m 42s", bounce: "22.7%" },
  { path: "/about", views: 10280, uniques: 8120, avgTime: "1m 48s", bounce: "52.6%" },
  { path: "/blog/advanced-tips", views: 9540, uniques: 7310, avgTime: "4m 35s", bounce: "30.8%" },
  { path: "/contact", views: 7820, uniques: 6240, avgTime: "1m 22s", bounce: "58.1%" },
  { path: "/changelog", views: 6430, uniques: 5180, avgTime: "3m 18s", bounce: "35.4%" },
  { path: "/careers", views: 4210, uniques: 3640, avgTime: "2m 56s", bounce: "44.9%" },
];

export default function TopPages() {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#111111]">
      <div className="border-b border-gray-800 px-6 py-4">
        <h2 className="text-lg font-semibold text-white">Top Pages</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-500">
              <th className="px-6 py-3">Page</th>
              <th className="px-6 py-3 text-right">Views</th>
              <th className="px-6 py-3 text-right">Uniques</th>
              <th className="px-6 py-3 text-right">Avg Time</th>
              <th className="px-6 py-3 text-right">Bounce</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.path} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                <td className="px-6 py-3 font-medium text-indigo-400">{p.path}</td>
                <td className="px-6 py-3 text-right text-gray-300">{p.views}</td>
                <td className="px-6 py-3 text-right text-gray-400">{p.uniques}</td>
                <td className="px-6 py-3 text-right text-gray-400">{p.avgTime}</td>
                <td className="px-6 py-3 text-right text-gray-400">{p.bounce}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Geography Map (SVG) ───────────────────────────────────────
    {
      path: "src/components/GeographyMap.tsx",
      content: `const countries = [
  { name: "United States", code: "US", visitors: 32450, x: 180, y: 120 },
  { name: "United Kingdom", code: "GB", visitors: 12840, x: 420, y: 90 },
  { name: "Germany", code: "DE", visitors: 9870, x: 450, y: 95 },
  { name: "India", code: "IN", visitors: 8920, x: 580, y: 150 },
  { name: "Brazil", code: "BR", visitors: 7340, x: 270, y: 210 },
  { name: "Canada", code: "CA", visitors: 6210, x: 180, y: 80 },
  { name: "Australia", code: "AU", visitors: 5430, x: 680, y: 240 },
  { name: "Japan", code: "JP", visitors: 4890, x: 700, y: 120 },
  { name: "France", code: "FR", visitors: 4560, x: 430, y: 100 },
  { name: "Mexico", code: "MX", visitors: 3210, x: 160, y: 155 },
];

const maxVisitors = Math.max(...countries.map((c) => c.visitors));

export default function GeographyMap() {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#111111] p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Geography</h2>
          <p className="text-xs text-gray-500 mt-0.5">Visitor distribution by country</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-8">
        {/* Map */}
        <div className="xl:col-span-3">
          <svg viewBox="0 0 800 320" className="w-full">
            {/* Simplified world outline */}
            <rect x="0" y="0" width="800" height="320" fill="transparent" />

            {/* Continental outlines (simplified rectangles with rounded corners) */}
            <rect x="100" y="60" width="200" height="130" rx="20" fill="#1a1a2e" stroke="#252540" strokeWidth="1" />
            <text x="200" y="55" textAnchor="middle" fill="#333" fontSize="9">North America</text>

            <rect x="210" y="170" width="120" height="100" rx="15" fill="#1a1a2e" stroke="#252540" strokeWidth="1" />
            <text x="270" y="165" textAnchor="middle" fill="#333" fontSize="9">South America</text>

            <rect x="380" y="55" width="150" height="120" rx="15" fill="#1a1a2e" stroke="#252540" strokeWidth="1" />
            <text x="455" y="50" textAnchor="middle" fill="#333" fontSize="9">Europe</text>

            <rect x="400" y="140" width="160" height="100" rx="15" fill="#1a1a2e" stroke="#252540" strokeWidth="1" />
            <text x="480" y="135" textAnchor="middle" fill="#333" fontSize="9">Africa</text>

            <rect x="540" y="70" width="180" height="130" rx="15" fill="#1a1a2e" stroke="#252540" strokeWidth="1" />
            <text x="630" y="65" textAnchor="middle" fill="#333" fontSize="9">Asia Pacific</text>

            <rect x="630" y="200" width="100" height="80" rx="15" fill="#1a1a2e" stroke="#252540" strokeWidth="1" />
            <text x="680" y="195" textAnchor="middle" fill="#333" fontSize="9">Oceania</text>

            {/* Country dots */}
            {countries.map((c) => {
              const intensity = c.visitors / maxVisitors;
              const radius = 6 + intensity * 14;
              return (
                <g key={c.code}>
                  <circle
                    cx={c.x}
                    cy={c.y}
                    r={radius}
                    fill="#6366f1"
                    opacity={0.2 + intensity * 0.5}
                    className="animate-pulse"
                  />
                  <circle cx={c.x} cy={c.y} r={4} fill="#6366f1" />
                  <text x={c.x} y={c.y - radius - 4} textAnchor="middle" fill="#888" fontSize="9">
                    {c.code}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Country list */}
        <div className="xl:col-span-2 space-y-2">
          {countries.map((c, i) => {
            const pct = (c.visitors / maxVisitors) * 100;
            return (
              <div key={c.code} className="flex items-center gap-3">
                <span className="w-5 text-xs text-gray-600 text-right">{i + 1}</span>
                <div className="flex-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">{c.name}</span>
                    <span className="text-gray-500">{c.visitors}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-all duration-700"
                      style={{ width: \`\${pct}%\` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Real-Time Widget ──────────────────────────────────────────
    {
      path: "src/components/RealTimeWidget.tsx",
      content: `"use client";
import { useState, useEffect } from "react";
import { Activity } from "lucide-react";

export default function RealTimeWidget() {
  const [count, setCount] = useState(247);
  const [display, setDisplay] = useState(247);

  useEffect(() => {
    const interval = setInterval(() => {
      setCount((prev) => {
        const delta = Math.floor(Math.random() * 11) - 5;
        return Math.max(180, Math.min(350, prev + delta));
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (display === count) return;
    const step = count > display ? 1 : -1;
    const timer = setTimeout(() => setDisplay((d) => d + step), 30);
    return () => clearTimeout(timer);
  }, [count, display]);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-800 bg-[#111111] px-4 py-2.5">
      <div className="relative">
        <Activity className="h-5 w-5 text-emerald-400" />
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-400" />
      </div>
      <div>
        <span className="text-xl font-bold text-white tabular-nums">{display}</span>
        <span className="ml-1.5 text-xs text-gray-500">active now</span>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Date Range Picker ─────────────────────────────────────────
    {
      path: "src/components/DateRangePicker.tsx",
      content: `"use client";

interface DateRangePickerProps {
  value: string;
  onChange: (value: string) => void;
}

const ranges = [
  { label: "Today", value: "today" },
  { label: "7D", value: "7d" },
  { label: "30D", value: "30d" },
  { label: "90D", value: "90d" },
  { label: "Custom", value: "custom" },
];

export default function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  return (
    <div className="flex items-center rounded-lg border border-gray-800 bg-gray-900/50 p-0.5">
      {ranges.map((r) => (
        <button
          key={r.value}
          onClick={() => onChange(r.value)}
          className={\`rounded-md px-3 py-1.5 text-xs font-medium transition \${
            value === r.value
              ? "bg-indigo-600 text-white"
              : "text-gray-500 hover:text-white"
          }\`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Source Breakdown ───────────────────────────────────────────
    {
      path: "src/components/SourceBreakdown.tsx",
      content: `import { Globe, Search, Users, Mail, ExternalLink } from "lucide-react";

const sources = [
  { label: "Direct", visitors: 28430, pct: 32.6, icon: Globe, color: "#6366f1" },
  { label: "Organic Search", visitors: 24810, pct: 28.4, icon: Search, color: "#10b981" },
  { label: "Social Media", visitors: 18240, pct: 20.9, icon: Users, color: "#f59e0b" },
  { label: "Referral", visitors: 10360, pct: 11.9, icon: ExternalLink, color: "#ec4899" },
  { label: "Email", visitors: 5401, pct: 6.2, icon: Mail, color: "#8b5cf6" },
];

export default function SourceBreakdown() {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#111111] p-6 h-full">
      <h2 className="text-lg font-semibold text-white mb-6">Traffic Sources</h2>
      <div className="space-y-5">
        {sources.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4" style={{ color: s.color }} />
                  <span className="text-sm text-gray-300">{s.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">{s.visitors}</span>
                  <span className="text-xs text-gray-500">{s.pct}%</span>
                </div>
              </div>
              <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: \`\${s.pct}%\`, backgroundColor: s.color }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Root Layout ───────────────────────────────────────────────
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Analytics Dashboard",
  description: "Analytics dashboard built with KCode",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-[#0a0a0a] text-gray-100">
        {children}
      </body>
    </html>
  );
}
`,
      needsLlm: false,
    },
  ];
}
