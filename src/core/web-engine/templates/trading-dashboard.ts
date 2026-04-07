// KCode - Web Engine: Trading/Financial Dashboard Template
//
// Generates a complete, production-ready trading dashboard with
// Next.js + React + Tailwind CSS. All components are self-contained
// with realistic mock data. No external chart libraries — pure CSS/SVG.

import type { FileTemplate } from "../templates";

// ── Mock Data ─────────────────────────────────────────────────

const TICKER_DATA = `[
  { symbol: "AAPL", price: 198.11, change: 2.34, pct: 1.19 },
  { symbol: "TSLA", price: 248.42, change: -5.18, pct: -2.04 },
  { symbol: "NVDA", price: 131.29, change: 4.67, pct: 3.69 },
  { symbol: "AMZN", price: 186.49, change: 1.23, pct: 0.66 },
  { symbol: "GOOGL", price: 175.98, change: -0.87, pct: -0.49 },
  { symbol: "MSFT", price: 422.86, change: 3.12, pct: 0.74 },
  { symbol: "META", price: 531.49, change: 8.32, pct: 1.59 },
  { symbol: "AMD", price: 164.21, change: -2.45, pct: -1.47 },
  { symbol: "NFLX", price: 628.34, change: 11.56, pct: 1.87 },
  { symbol: "JPM", price: 198.67, change: 0.98, pct: 0.50 },
  { symbol: "V", price: 279.43, change: 1.67, pct: 0.60 },
  { symbol: "DIS", price: 112.85, change: -1.32, pct: -1.16 },
]`;

const CANDLE_DATA = `[
  { o: 192.5, h: 194.2, l: 191.8, c: 193.7, v: 42100 },
  { o: 193.7, h: 195.1, l: 193.0, c: 194.8, v: 38500 },
  { o: 194.8, h: 196.3, l: 194.1, c: 195.9, v: 45200 },
  { o: 195.9, h: 196.8, l: 194.5, c: 195.0, v: 39800 },
  { o: 195.0, h: 195.6, l: 192.8, c: 193.2, v: 51300 },
  { o: 193.2, h: 194.4, l: 192.0, c: 192.5, v: 48700 },
  { o: 192.5, h: 193.8, l: 191.2, c: 193.4, v: 43100 },
  { o: 193.4, h: 195.7, l: 193.0, c: 195.2, v: 46800 },
  { o: 195.2, h: 197.4, l: 195.0, c: 196.8, v: 52400 },
  { o: 196.8, h: 198.1, l: 196.2, c: 197.5, v: 49600 },
  { o: 197.5, h: 198.9, l: 196.8, c: 198.4, v: 44300 },
  { o: 198.4, h: 199.2, l: 197.1, c: 197.6, v: 41200 },
  { o: 197.6, h: 198.5, l: 195.9, c: 196.3, v: 47800 },
  { o: 196.3, h: 196.8, l: 194.7, c: 195.1, v: 50100 },
  { o: 195.1, h: 196.9, l: 194.8, c: 196.5, v: 43900 },
  { o: 196.5, h: 198.2, l: 196.1, c: 197.8, v: 45600 },
  { o: 197.8, h: 199.5, l: 197.4, c: 199.1, v: 53200 },
  { o: 199.1, h: 200.8, l: 198.7, c: 200.3, v: 58400 },
  { o: 200.3, h: 201.2, l: 199.1, c: 199.8, v: 47300 },
  { o: 199.8, h: 200.5, l: 198.4, c: 198.9, v: 44100 },
  { o: 198.9, h: 199.7, l: 197.6, c: 198.2, v: 42800 },
  { o: 198.2, h: 199.4, l: 197.8, c: 199.0, v: 41500 },
  { o: 199.0, h: 200.6, l: 198.5, c: 200.1, v: 46700 },
  { o: 200.1, h: 201.4, l: 199.6, c: 200.8, v: 48900 },
  { o: 200.8, h: 202.1, l: 200.2, c: 201.5, v: 51200 },
  { o: 201.5, h: 202.8, l: 200.9, c: 202.3, v: 54600 },
  { o: 202.3, h: 203.1, l: 201.4, c: 201.8, v: 49800 },
  { o: 201.8, h: 202.5, l: 200.6, c: 201.2, v: 46300 },
  { o: 201.2, h: 202.9, l: 200.8, c: 202.4, v: 48100 },
  { o: 202.4, h: 203.6, l: 201.7, c: 198.11, v: 52700 },
]`;

// ── Component Templates ───────────────────────────────────────

export function tradingDashboardComponents(): FileTemplate[] {
  return [
    // ── Root Layout ──────────────────────────────────────────
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trading Dashboard",
  description: "Real-time financial market dashboard",
  openGraph: {
    title: "Trading Dashboard",
    description: "Real-time financial market dashboard",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-[#0a0a0a] text-white" style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
`,
      needsLlm: false,
    },

    // ── Globals CSS ──────────────────────────────────────────
    {
      path: "src/app/globals.css",
      content: `@import "tailwindcss";

@keyframes ticker-scroll {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}

@keyframes pulse-glow {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.ticker-scroll {
  animation: ticker-scroll 30s linear infinite;
}

.glow-green {
  box-shadow: 0 0 12px rgba(16, 185, 129, 0.15);
}

.glow-red {
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.15);
}

.glow-blue {
  box-shadow: 0 0 12px rgba(59, 130, 246, 0.15);
}

/* Monospace for financial numbers */
.font-mono-num {
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: #0a0a0a;
}
::-webkit-scrollbar-thumb {
  background: #333;
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: #555;
}
`,
      needsLlm: false,
    },

    // ── Main Dashboard Page ──────────────────────────────────
    {
      path: "src/app/page.tsx",
      content: `import TickerTape from "@/components/TickerTape";
import CandlestickChart from "@/components/CandlestickChart";
import Portfolio from "@/components/Portfolio";
import MarketHeatmap from "@/components/MarketHeatmap";
import TopMovers from "@/components/TopMovers";
import OrderBook from "@/components/OrderBook";
import MarketStats from "@/components/MarketStats";
import { Activity, BarChart3, Bell, DollarSign, Search, Settings, TrendingUp } from "lucide-react";

const indices = [
  { name: "S&P 500", value: "5,218.19", change: "+18.32", pct: "+0.35%", up: true },
  { name: "NASDAQ", value: "16,384.47", change: "+67.89", pct: "+0.42%", up: true },
  { name: "DOW", value: "39,512.84", change: "-42.77", pct: "-0.11%", up: false },
  { name: "VIX", value: "13.49", change: "-0.62", pct: "-4.39%", up: false },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex">
      {/* Collapsed Sidebar */}
      <aside className="w-16 min-h-screen bg-[#0e0e0e] border-r border-white/5 flex flex-col items-center py-6 gap-6">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-blue-500 flex items-center justify-center">
          <DollarSign className="w-5 h-5 text-white" />
        </div>
        <div className="w-8 h-[1px] bg-white/10" />
        <button className="w-10 h-10 rounded-lg bg-white/5 hover:bg-white/10 transition flex items-center justify-center text-emerald-400" title="Dashboard">
          <BarChart3 className="w-5 h-5" />
        </button>
        <button className="w-10 h-10 rounded-lg hover:bg-white/10 transition flex items-center justify-center text-gray-500" title="Activity">
          <Activity className="w-5 h-5" />
        </button>
        <button className="w-10 h-10 rounded-lg hover:bg-white/10 transition flex items-center justify-center text-gray-500" title="Trending">
          <TrendingUp className="w-5 h-5" />
        </button>
        <div className="mt-auto flex flex-col gap-4">
          <button className="w-10 h-10 rounded-lg hover:bg-white/10 transition flex items-center justify-center text-gray-500" title="Settings">
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        {/* Header */}
        <header className="sticky top-0 z-40 bg-[#0a0a0a]/80 backdrop-blur-xl border-b border-white/5">
          <div className="flex items-center justify-between px-6 py-3">
            <div className="flex items-center gap-6">
              <h1 className="text-lg font-semibold text-white">Markets</h1>
              <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-emerald-400 font-medium">Market Open</span>
              </div>
            </div>
            <div className="flex items-center gap-6">
              {indices.map((idx) => (
                <div key={idx.name} className="flex items-center gap-2 text-sm">
                  <span className="text-gray-400">{idx.name}</span>
                  <span className="font-mono-num text-white">{idx.value}</span>
                  <span className={\`font-mono-num \${idx.up ? "text-emerald-400" : "text-red-400"}\`}>
                    {idx.pct}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button className="w-9 h-9 rounded-lg hover:bg-white/5 transition flex items-center justify-center text-gray-400">
                <Search className="w-4 h-4" />
              </button>
              <button className="w-9 h-9 rounded-lg hover:bg-white/5 transition flex items-center justify-center text-gray-400 relative">
                <Bell className="w-4 h-4" />
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-emerald-400 rounded-full" />
              </button>
            </div>
          </div>
          <TickerTape />
        </header>

        {/* Dashboard Grid */}
        <div className="p-6 space-y-6">
          {/* Top Row: Stats */}
          <MarketStats />

          {/* Middle Row: Chart + Order Book */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2">
              <CandlestickChart />
            </div>
            <div>
              <OrderBook />
            </div>
          </div>

          {/* Bottom Row: Portfolio + Heatmap + Movers */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2">
              <Portfolio />
            </div>
            <div>
              <TopMovers />
            </div>
          </div>

          {/* Heatmap Full Width */}
          <MarketHeatmap />
        </div>
      </main>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── TickerTape ───────────────────────────────────────────
    {
      path: "src/components/TickerTape.tsx",
      content: `"use client";

const tickers = ${TICKER_DATA};

export default function TickerTape() {
  const items = [...tickers, ...tickers]; // duplicate for seamless loop

  return (
    <div className="w-full overflow-hidden bg-[#0e0e0e] border-t border-white/5 py-2">
      <div className="ticker-scroll flex items-center gap-8 whitespace-nowrap" style={{ width: "max-content" }}>
        {items.map((t, i) => (
          <div key={\`\${t.symbol}-\${i}\`} className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-white">{t.symbol}</span>
            <span className="font-mono-num text-gray-300">\${t.price.toFixed(2)}</span>
            <span className={\`font-mono-num \${t.change >= 0 ? "text-emerald-400" : "text-red-400"}\`}>
              {t.change >= 0 ? "+" : ""}{t.change.toFixed(2)} ({t.pct >= 0 ? "+" : ""}{t.pct.toFixed(2)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── CandlestickChart ─────────────────────────────────────
    {
      path: "src/components/CandlestickChart.tsx",
      content: `"use client";
import { useState } from "react";
import { TrendingUp } from "lucide-react";

interface Candle {
  o: number; h: number; l: number; c: number; v: number;
}

const candles: Candle[] = ${CANDLE_DATA};

const periods = ["1D", "1W", "1M", "3M", "1Y"] as const;

export default function CandlestickChart() {
  const [activePeriod, setActivePeriod] = useState<string>("1M");

  const allPrices = candles.flatMap((c) => [c.h, c.l]);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const priceRange = maxPrice - minPrice;
  const maxVol = Math.max(...candles.map((c) => c.v));

  const chartW = 800;
  const chartH = 320;
  const volH = 60;
  const padding = 40;
  const candleW = (chartW - padding * 2) / candles.length;
  const bodyW = candleW * 0.6;

  function priceToY(price: number): number {
    return padding + (chartH - padding * 2) * (1 - (price - minPrice) / priceRange);
  }

  // Price grid lines
  const gridLines = 5;
  const gridPrices = Array.from({ length: gridLines }, (_, i) =>
    minPrice + (priceRange / (gridLines - 1)) * i
  );

  return (
    <div className="bg-[#141414] rounded-2xl border border-white/5 p-6 hover:border-white/10 transition">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">AAPL</h2>
            <p className="text-sm text-gray-500">Apple Inc.</p>
          </div>
          <div className="ml-4">
            <span className="font-mono-num text-2xl font-bold text-white">$198.11</span>
            <span className="ml-2 font-mono-num text-sm text-emerald-400">+2.34 (+1.19%)</span>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-[#1e1e1e] rounded-lg p-1">
          {periods.map((p) => (
            <button
              key={p}
              onClick={() => setActivePeriod(p)}
              className={\`px-3 py-1.5 text-xs font-medium rounded-md transition \${
                activePeriod === p
                  ? "bg-white/10 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }\`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Chart SVG */}
      <svg viewBox={\`0 0 \${chartW} \${chartH + volH}\`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        {gridPrices.map((price, i) => {
          const y = priceToY(price);
          return (
            <g key={i}>
              <line x1={padding} y1={y} x2={chartW - padding} y2={y} stroke="#1e1e1e" strokeWidth={1} />
              <text x={chartW - padding + 5} y={y + 4} fill="#666" fontSize={10} className="font-mono-num">
                {price.toFixed(1)}
              </text>
            </g>
          );
        })}

        {/* Candlesticks */}
        {candles.map((c, i) => {
          const x = padding + i * candleW + candleW / 2;
          const isGreen = c.c >= c.o;
          const color = isGreen ? "#10b981" : "#ef4444";
          const bodyTop = priceToY(Math.max(c.o, c.c));
          const bodyBottom = priceToY(Math.min(c.o, c.c));
          const bodyHeight = Math.max(bodyBottom - bodyTop, 1);

          return (
            <g key={i}>
              {/* Wick */}
              <line
                x1={x} y1={priceToY(c.h)}
                x2={x} y2={priceToY(c.l)}
                stroke={color} strokeWidth={1}
              />
              {/* Body */}
              <rect
                x={x - bodyW / 2} y={bodyTop}
                width={bodyW} height={bodyHeight}
                fill={color}
                rx={1}
              />
            </g>
          );
        })}

        {/* Volume bars */}
        {candles.map((c, i) => {
          const x = padding + i * candleW + candleW / 2;
          const isGreen = c.c >= c.o;
          const barH = (c.v / maxVol) * volH * 0.8;
          const barY = chartH + volH - barH;
          return (
            <rect
              key={\`v-\${i}\`}
              x={x - bodyW / 2}
              y={barY}
              width={bodyW}
              height={barH}
              fill={isGreen ? "#10b98133" : "#ef444433"}
              rx={1}
            />
          );
        })}

        {/* Volume label */}
        <text x={padding} y={chartH + 14} fill="#555" fontSize={10}>Volume</text>
      </svg>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Portfolio ────────────────────────────────────────────
    {
      path: "src/components/Portfolio.tsx",
      content: [
        `"use client";`,
        `import { ArrowUpRight, ArrowDownRight } from "lucide-react";`,
        ``,
        `const D = "$";`,
        `function usd(n: number) { return D + n.toFixed(2); }`,
        ``,
        `const holdings = [`,
        `  { symbol: "AAPL", name: "Apple Inc.", shares: 150, avgCost: 178.25, current: 198.11 },`,
        `  { symbol: "TSLA", name: "Tesla Inc.", shares: 50, avgCost: 262.30, current: 248.42 },`,
        `  { symbol: "NVDA", name: "NVIDIA Corp.", shares: 200, avgCost: 108.50, current: 131.29 },`,
        `  { symbol: "AMZN", name: "Amazon.com Inc.", shares: 80, avgCost: 168.90, current: 186.49 },`,
        `  { symbol: "GOOGL", name: "Alphabet Inc.", shares: 120, avgCost: 152.14, current: 175.98 },`,
        `];`,
        ``,
        `export default function Portfolio() {`,
        `  const rows = holdings.map((h) => {`,
        `    const marketValue = h.shares * h.current;`,
        `    const costBasis = h.shares * h.avgCost;`,
        `    const pl = marketValue - costBasis;`,
        `    const plPct = ((h.current - h.avgCost) / h.avgCost) * 100;`,
        `    return { ...h, marketValue, costBasis, pl, plPct };`,
        `  });`,
        ``,
        `  const totalValue = rows.reduce((s, r) => s + r.marketValue, 0);`,
        `  const totalCost = rows.reduce((s, r) => s + r.costBasis, 0);`,
        `  const totalPL = totalValue - totalCost;`,
        `  const totalPLPct = ((totalValue - totalCost) / totalCost) * 100;`,
        `  const dailyChange = 1847.20;`,
        `  const dailyPct = 0.94;`,
        ``,
        `  return (`,
        `    <div className="bg-[#141414] rounded-2xl border border-white/5 p-6 hover:border-white/10 transition">`,
        `      {/* Header */}`,
        "      <div className=\"flex items-center justify-between mb-6\">",
        `        <h2 className="text-lg font-semibold text-white">Portfolio</h2>`,
        `        <div className="flex items-center gap-6 text-sm">`,
        `          <div>`,
        `            <span className="text-gray-500">Total Value</span>`,
        "            <span className=\"ml-2 font-mono-num text-white font-semibold\">{usd(totalValue)}</span>",
        `          </div>`,
        `          <div>`,
        `            <span className="text-gray-500">Daily</span>`,
        "            <span className={`ml-2 font-mono-num ${dailyChange >= 0 ? \"text-emerald-400\" : \"text-red-400\"}`}>",
        `              +{usd(dailyChange)} (+{dailyPct.toFixed(2)}%)`,
        `            </span>`,
        `          </div>`,
        `          <div>`,
        `            <span className="text-gray-500">Total P&amp;L</span>`,
        "            <span className={`ml-2 font-mono-num ${totalPL >= 0 ? \"text-emerald-400\" : \"text-red-400\"}`}>",
        `              {totalPL >= 0 ? "+" : ""}{usd(Math.abs(totalPL))} ({totalPL >= 0 ? "+" : ""}{totalPLPct.toFixed(2)}%)`,
        `            </span>`,
        `          </div>`,
        `        </div>`,
        `      </div>`,
        ``,
        `      {/* Table */}`,
        `      <div className="overflow-x-auto">`,
        `        <table className="w-full text-sm">`,
        `          <thead>`,
        `            <tr className="border-b border-white/5 text-gray-500 text-xs uppercase tracking-wider">`,
        `              <th className="text-left py-3 pr-4">Symbol</th>`,
        `              <th className="text-right py-3 px-4">Shares</th>`,
        `              <th className="text-right py-3 px-4">Avg Cost</th>`,
        `              <th className="text-right py-3 px-4">Current</th>`,
        `              <th className="text-right py-3 px-4">Market Value</th>`,
        `              <th className="text-right py-3 px-4">P&amp;L</th>`,
        `              <th className="text-right py-3 pl-4">% Change</th>`,
        `            </tr>`,
        `          </thead>`,
        `          <tbody>`,
        `            {rows.map((r) => (`,
        `              <tr key={r.symbol} className="border-b border-white/5 hover:bg-white/[0.02] transition">`,
        `                <td className="py-3 pr-4">`,
        `                  <div className="flex items-center gap-2">`,
        `                    <span className="font-semibold text-white">{r.symbol}</span>`,
        `                    <span className="text-gray-600 text-xs">{r.name}</span>`,
        `                  </div>`,
        `                </td>`,
        `                <td className="text-right py-3 px-4 font-mono-num text-gray-300">{r.shares}</td>`,
        `                <td className="text-right py-3 px-4 font-mono-num text-gray-300">{usd(r.avgCost)}</td>`,
        `                <td className="text-right py-3 px-4 font-mono-num text-white">{usd(r.current)}</td>`,
        `                <td className="text-right py-3 px-4 font-mono-num text-white">{usd(r.marketValue)}</td>`,
        "                <td className={`text-right py-3 px-4 font-mono-num ${r.pl >= 0 ? \"text-emerald-400\" : \"text-red-400\"}`}>",
        `                  <div className="flex items-center justify-end gap-1">`,
        `                    {r.pl >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}`,
        `                    {r.pl >= 0 ? "+" : ""}{usd(Math.abs(r.pl))}`,
        `                  </div>`,
        `                </td>`,
        "                <td className={`text-right py-3 pl-4 font-mono-num ${r.plPct >= 0 ? \"text-emerald-400\" : \"text-red-400\"}`}>",
        `                  {r.plPct >= 0 ? "+" : ""}{r.plPct.toFixed(2)}%`,
        `                </td>`,
        `              </tr>`,
        `            ))}`,
        `          </tbody>`,
        `        </table>`,
        `      </div>`,
        `    </div>`,
        `  );`,
        `}`,
      ].join("\n"),
      needsLlm: false,
    },

    // ── MarketHeatmap ────────────────────────────────────────
    {
      path: "src/components/MarketHeatmap.tsx",
      content: `"use client";
import { useState } from "react";

interface Stock {
  symbol: string;
  name: string;
  change: number;
  price: number;
  marketCap: number; // in billions, controls tile size
  sector: string;
}

const stocks: Stock[] = [
  // Tech
  { symbol: "AAPL", name: "Apple Inc.", change: 1.19, price: 198.11, marketCap: 3040, sector: "Tech" },
  { symbol: "MSFT", name: "Microsoft Corp.", change: 0.74, price: 422.86, marketCap: 3140, sector: "Tech" },
  { symbol: "NVDA", name: "NVIDIA Corp.", change: 3.69, price: 131.29, marketCap: 3230, sector: "Tech" },
  { symbol: "GOOGL", name: "Alphabet Inc.", change: -0.49, price: 175.98, marketCap: 2180, sector: "Tech" },
  { symbol: "META", name: "Meta Platforms", change: 1.59, price: 531.49, marketCap: 1360, sector: "Tech" },
  { symbol: "AMZN", name: "Amazon.com Inc.", change: 0.66, price: 186.49, marketCap: 1930, sector: "Tech" },
  // Healthcare
  { symbol: "UNH", name: "UnitedHealth", change: -1.24, price: 492.18, marketCap: 454, sector: "Healthcare" },
  { symbol: "JNJ", name: "Johnson & Johnson", change: 0.38, price: 156.72, marketCap: 378, sector: "Healthcare" },
  { symbol: "LLY", name: "Eli Lilly", change: 2.14, price: 792.45, marketCap: 753, sector: "Healthcare" },
  { symbol: "PFE", name: "Pfizer Inc.", change: -0.87, price: 27.34, marketCap: 153, sector: "Healthcare" },
  // Finance
  { symbol: "JPM", name: "JPMorgan Chase", change: 0.50, price: 198.67, marketCap: 572, sector: "Finance" },
  { symbol: "V", name: "Visa Inc.", change: 0.60, price: 279.43, marketCap: 573, sector: "Finance" },
  { symbol: "BAC", name: "Bank of America", change: -0.33, price: 37.82, marketCap: 298, sector: "Finance" },
  { symbol: "GS", name: "Goldman Sachs", change: 1.12, price: 464.21, marketCap: 154, sector: "Finance" },
  // Energy
  { symbol: "XOM", name: "Exxon Mobil", change: -1.87, price: 113.52, marketCap: 464, sector: "Energy" },
  { symbol: "CVX", name: "Chevron Corp.", change: -1.42, price: 158.34, marketCap: 293, sector: "Energy" },
  { symbol: "COP", name: "ConocoPhillips", change: -2.31, price: 114.67, marketCap: 136, sector: "Energy" },
  // Consumer
  { symbol: "WMT", name: "Walmart Inc.", change: 0.28, price: 168.45, marketCap: 454, sector: "Consumer" },
  { symbol: "PG", name: "Procter & Gamble", change: 0.15, price: 162.89, marketCap: 383, sector: "Consumer" },
  { symbol: "KO", name: "Coca-Cola Co.", change: -0.21, price: 61.42, marketCap: 265, sector: "Consumer" },
  { symbol: "DIS", name: "Walt Disney", change: -1.16, price: 112.85, marketCap: 206, sector: "Consumer" },
];

function getHeatColor(change: number): string {
  if (change >= 3) return "bg-emerald-500";
  if (change >= 2) return "bg-emerald-500/80";
  if (change >= 1) return "bg-emerald-500/60";
  if (change >= 0.3) return "bg-emerald-500/40";
  if (change >= 0) return "bg-emerald-500/20";
  if (change >= -0.3) return "bg-red-500/20";
  if (change >= -1) return "bg-red-500/40";
  if (change >= -2) return "bg-red-500/60";
  if (change >= -3) return "bg-red-500/80";
  return "bg-red-500";
}

function getTileSize(marketCap: number): string {
  if (marketCap >= 2000) return "col-span-2 row-span-2";
  if (marketCap >= 500) return "col-span-2";
  return "";
}

export default function MarketHeatmap() {
  const [hovered, setHovered] = useState<string | null>(null);

  const sectors = ["Tech", "Healthcare", "Finance", "Energy", "Consumer"];

  return (
    <div className="bg-[#141414] rounded-2xl border border-white/5 p-6 hover:border-white/10 transition">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-white">Market Heatmap</h2>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          {sectors.map((s) => (
            <span key={s} className="px-2 py-1 rounded bg-white/5">{s}</span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-8 gap-1.5 auto-rows-[60px]">
        {stocks.map((s) => (
          <div
            key={s.symbol}
            className={\`relative rounded-lg \${getHeatColor(s.change)} \${getTileSize(s.marketCap)} flex flex-col items-center justify-center cursor-pointer transition-all hover:brightness-125 hover:z-10 hover:scale-[1.02]\`}
            onMouseEnter={() => setHovered(s.symbol)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="font-semibold text-white text-sm">{s.symbol}</span>
            <span className={\`font-mono-num text-xs \${s.change >= 0 ? "text-white/80" : "text-white/80"}\`}>
              {s.change >= 0 ? "+" : ""}{s.change.toFixed(2)}%
            </span>

            {/* Tooltip */}
            {hovered === s.symbol && (
              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-[#1e1e1e] border border-white/10 rounded-lg px-3 py-2 text-xs whitespace-nowrap z-50 shadow-xl">
                <div className="font-semibold text-white">{s.name}</div>
                <div className="font-mono-num text-gray-300">\${s.price.toFixed(2)}</div>
                <div className={\`font-mono-num \${s.change >= 0 ? "text-emerald-400" : "text-red-400"}\`}>
                  {s.change >= 0 ? "+" : ""}{s.change.toFixed(2)}%
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── TopMovers ────────────────────────────────────────────
    {
      path: "src/components/TopMovers.tsx",
      content: `"use client";
import { useState } from "react";
import { ArrowUpRight, ArrowDownRight, Activity } from "lucide-react";

interface Mover {
  symbol: string;
  name: string;
  price: number;
  change: number;
  volume: string;
}

const gainers: Mover[] = [
  { symbol: "SMCI", name: "Super Micro Computer", price: 924.18, change: 8.43, volume: "12.4M" },
  { symbol: "MARA", name: "Marathon Digital", price: 24.67, change: 6.21, volume: "28.7M" },
  { symbol: "PLTR", name: "Palantir Technologies", price: 24.89, change: 5.87, volume: "41.2M" },
  { symbol: "RIVN", name: "Rivian Automotive", price: 12.34, change: 4.92, volume: "22.1M" },
  { symbol: "NVDA", name: "NVIDIA Corp.", price: 131.29, change: 3.69, volume: "48.3M" },
];

const losers: Mover[] = [
  { symbol: "MRNA", name: "Moderna Inc.", price: 98.42, change: -7.82, volume: "15.8M" },
  { symbol: "SNAP", name: "Snap Inc.", price: 11.23, change: -5.41, volume: "19.3M" },
  { symbol: "LYFT", name: "Lyft Inc.", price: 14.56, change: -4.67, volume: "14.2M" },
  { symbol: "COIN", name: "Coinbase Global", price: 178.34, change: -3.89, volume: "9.7M" },
  { symbol: "COP", name: "ConocoPhillips", price: 114.67, change: -2.31, volume: "7.1M" },
];

const active: Mover[] = [
  { symbol: "TSLA", name: "Tesla Inc.", price: 248.42, change: -2.04, volume: "82.4M" },
  { symbol: "NVDA", name: "NVIDIA Corp.", price: 131.29, change: 3.69, volume: "48.3M" },
  { symbol: "PLTR", name: "Palantir Technologies", price: 24.89, change: 5.87, volume: "41.2M" },
  { symbol: "AMD", name: "AMD Inc.", price: 164.21, change: -1.47, volume: "38.6M" },
  { symbol: "AAPL", name: "Apple Inc.", price: 198.11, change: 1.19, volume: "36.1M" },
];

const tabs = [
  { key: "gainers", label: "Gainers" },
  { key: "losers", label: "Losers" },
  { key: "active", label: "Most Active" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

export default function TopMovers() {
  const [activeTab, setActiveTab] = useState<TabKey>("gainers");

  const data = activeTab === "gainers" ? gainers : activeTab === "losers" ? losers : active;

  return (
    <div className="bg-[#141414] rounded-2xl border border-white/5 p-6 hover:border-white/10 transition h-full">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold text-white">Top Movers</h2>
        <div className="flex items-center gap-1 bg-[#1e1e1e] rounded-lg p-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={\`px-3 py-1.5 text-xs font-medium rounded-md transition \${
                activeTab === tab.key
                  ? "bg-white/10 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }\`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        {data.map((m) => (
          <div
            key={m.symbol}
            className="flex items-center justify-between py-3 px-3 rounded-lg hover:bg-white/[0.03] transition cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <div className={\`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold \${
                m.change >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
              }\`}>
                {m.change >= 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
              </div>
              <div>
                <div className="font-semibold text-white text-sm">{m.symbol}</div>
                <div className="text-xs text-gray-500 truncate max-w-[120px]">{m.name}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono-num text-sm text-white">\${m.price.toFixed(2)}</div>
              <div className={\`font-mono-num text-xs \${m.change >= 0 ? "text-emerald-400" : "text-red-400"}\`}>
                {m.change >= 0 ? "+" : ""}{m.change.toFixed(2)}%
              </div>
            </div>
            <div className="text-right ml-3">
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <Activity className="w-3 h-3" />
                {m.volume}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── OrderBook ────────────────────────────────────────────
    {
      path: "src/components/OrderBook.tsx",
      content: `"use client";

interface Order {
  price: number;
  amount: number;
  total: number;
}

const bids: Order[] = [
  { price: 198.08, amount: 245, total: 48530 },
  { price: 198.05, amount: 412, total: 81597 },
  { price: 198.02, amount: 189, total: 37426 },
  { price: 197.98, amount: 567, total: 112255 },
  { price: 197.95, amount: 328, total: 64928 },
  { price: 197.90, amount: 891, total: 176271 },
  { price: 197.85, amount: 456, total: 90220 },
  { price: 197.80, amount: 234, total: 46285 },
  { price: 197.75, amount: 678, total: 134075 },
  { price: 197.70, amount: 345, total: 68207 },
];

const asks: Order[] = [
  { price: 198.12, amount: 312, total: 61813 },
  { price: 198.15, amount: 198, total: 39234 },
  { price: 198.20, amount: 567, total: 112379 },
  { price: 198.25, amount: 423, total: 83860 },
  { price: 198.30, amount: 289, total: 57309 },
  { price: 198.35, amount: 734, total: 145589 },
  { price: 198.40, amount: 156, total: 30950 },
  { price: 198.45, amount: 489, total: 97042 },
  { price: 198.50, amount: 367, total: 72850 },
  { price: 198.55, amount: 512, total: 101658 },
];

const maxTotal = Math.max(
  ...bids.map((b) => b.total),
  ...asks.map((a) => a.total)
);

const spread = asks[0].price - bids[0].price;
const spreadPct = (spread / asks[0].price) * 100;

export default function OrderBook() {
  return (
    <div className="bg-[#141414] rounded-2xl border border-white/5 p-6 hover:border-white/10 transition h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Order Book</h2>
        <span className="text-xs text-gray-500">AAPL</span>
      </div>

      {/* Column Headers */}
      <div className="grid grid-cols-3 text-xs text-gray-500 uppercase tracking-wider pb-2 border-b border-white/5">
        <span>Price</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Total</span>
      </div>

      {/* Asks (reversed so lowest ask is at bottom) */}
      <div className="flex-1 overflow-hidden">
        <div className="space-y-[2px] py-1">
          {[...asks].reverse().map((a, i) => (
            <div key={\`a-\${i}\`} className="relative grid grid-cols-3 text-xs py-1 px-1 rounded">
              <div
                className="absolute right-0 top-0 bottom-0 bg-red-500/8 rounded"
                style={{ width: \`\${(a.total / maxTotal) * 100}%\` }}
              />
              <span className="relative font-mono-num text-red-400">{a.price.toFixed(2)}</span>
              <span className="relative font-mono-num text-gray-300 text-right">{a.amount}</span>
              <span className="relative font-mono-num text-gray-500 text-right">{a.total}</span>
            </div>
          ))}
        </div>

        {/* Spread */}
        <div className="flex items-center justify-center gap-2 py-2.5 my-1 bg-[#1e1e1e] rounded-lg">
          <span className="font-mono-num text-sm font-semibold text-white">{spread.toFixed(2)}</span>
          <span className="text-xs text-gray-500">Spread</span>
          <span className="font-mono-num text-xs text-gray-500">({spreadPct.toFixed(3)}%)</span>
        </div>

        {/* Bids */}
        <div className="space-y-[2px] py-1">
          {bids.map((b, i) => (
            <div key={\`b-\${i}\`} className="relative grid grid-cols-3 text-xs py-1 px-1 rounded">
              <div
                className="absolute left-0 top-0 bottom-0 bg-emerald-500/8 rounded"
                style={{ width: \`\${(b.total / maxTotal) * 100}%\` }}
              />
              <span className="relative font-mono-num text-emerald-400">{b.price.toFixed(2)}</span>
              <span className="relative font-mono-num text-gray-300 text-right">{b.amount}</span>
              <span className="relative font-mono-num text-gray-500 text-right">{b.total}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── MarketStats ──────────────────────────────────────────
    {
      path: "src/components/MarketStats.tsx",
      content: `"use client";
import { DollarSign, BarChart3, TrendingUp, Activity } from "lucide-react";

interface StatCard {
  label: string;
  value: string;
  change: string;
  changeUp: boolean;
  icon: React.ReactNode;
  sparkline: number[];
}

const stats: StatCard[] = [
  {
    label: "Market Cap",
    value: "$3.04T",
    change: "+1.19%",
    changeUp: true,
    icon: <DollarSign className="w-4 h-4" />,
    sparkline: [28, 32, 30, 35, 33, 38, 36, 42, 40, 44, 41, 46],
  },
  {
    label: "Volume",
    value: "48.3M",
    change: "+12.4%",
    changeUp: true,
    icon: <BarChart3 className="w-4 h-4" />,
    sparkline: [20, 35, 28, 45, 32, 50, 38, 42, 55, 48, 60, 52],
  },
  {
    label: "P/E Ratio",
    value: "31.24",
    change: "-0.8%",
    changeUp: false,
    icon: <TrendingUp className="w-4 h-4" />,
    sparkline: [45, 43, 44, 42, 41, 43, 40, 39, 41, 38, 40, 37],
  },
  {
    label: "Div Yield",
    value: "0.52%",
    change: "+0.02%",
    changeUp: true,
    icon: <Activity className="w-4 h-4" />,
    sparkline: [30, 31, 30, 32, 31, 33, 32, 34, 33, 35, 34, 36],
  },
];

function Sparkline({ data, up }: { data: number[]; up: boolean }) {
  const h = 32;
  const w = 80;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);

  const points = data.map((v, i) => \`\${i * step},\${h - ((v - min) / range) * h}\`).join(" ");
  const color = up ? "#10b981" : "#ef4444";

  // Area fill path
  const areaPath = \`M0,\${h - ((data[0] - min) / range) * h} \${data.map((v, i) => \`L\${i * step},\${h - ((v - min) / range) * h}\`).join(" ")} L\${w},\${h} L0,\${h} Z\`;

  return (
    <svg width={w} height={h} viewBox={\`0 0 \${w} \${h}\`} className="overflow-visible">
      <defs>
        <linearGradient id={\`spark-\${up ? "up" : "down"}\`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={\`url(#spark-\${up ? "up" : "down"})\`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function MarketStats() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {stats.map((s) => (
        <div
          key={s.label}
          className={\`bg-[#141414] rounded-2xl border border-white/5 p-5 hover:border-white/10 transition group \${
            s.changeUp ? "hover:glow-green" : "hover:glow-red"
          }\`}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className={\`w-8 h-8 rounded-lg flex items-center justify-center \${
                s.changeUp ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
              }\`}>
                {s.icon}
              </div>
              <span className="text-sm text-gray-500">{s.label}</span>
            </div>
            <span className={\`text-xs font-mono-num px-2 py-0.5 rounded-full \${
              s.changeUp
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-red-500/10 text-red-400"
            }\`}>
              {s.change}
            </span>
          </div>
          <div className="flex items-end justify-between">
            <span className="font-mono-num text-2xl font-bold text-white">{s.value}</span>
            <Sparkline data={s.sparkline} up={s.changeUp} />
          </div>
        </div>
      ))}
    </div>
  );
}
`,
      needsLlm: false,
    },
  ];
}
