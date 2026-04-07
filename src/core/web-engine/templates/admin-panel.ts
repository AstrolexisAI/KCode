// KCode - Web Engine: Admin Panel Template
//
// Complete Admin Panel dashboard with Next.js + React + Tailwind.
// All components are 100% machine-generated (needsLlm: false).

import type { FileTemplate } from "../templates";

export function adminPanelComponents(): FileTemplate[] {
  return [
    // ── Dashboard Page ────────────────────────────────────────────
    {
      path: "src/app/page.tsx",
      content: `"use client";
import { useState } from "react";
import Sidebar from "@/components/Sidebar";
import MetricCards from "@/components/MetricCards";
import DataTable from "@/components/DataTable";
import RecentActivity from "@/components/RecentActivity";
import QuickActions from "@/components/QuickActions";
import { Bell, Search } from "lucide-react";

export default function Dashboard() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div className="flex min-h-screen bg-[#0a0a0a] text-gray-100">
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />

      <main className={\`flex-1 transition-all duration-300 \${sidebarCollapsed ? "ml-20" : "ml-64"}\`}>
        {/* Top Bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-gray-800 bg-[#0a0a0a]/80 backdrop-blur-md px-8 py-4">
          <div className="relative w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-gray-800 bg-gray-900/50 py-2 pl-10 pr-4 text-sm text-gray-300 placeholder-gray-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div className="flex items-center gap-4">
            <button className="relative rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white transition">
              <Bell className="h-5 w-5" />
              <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-bold text-white">3</span>
            </button>
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600" />
              <span className="text-sm font-medium text-gray-300">Admin</span>
            </div>
          </div>
        </header>

        {/* Content */}
        <div className="p-8 space-y-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Dashboard</h1>
            <p className="text-sm text-gray-500 mt-1">Welcome back. Here is what is happening today.</p>
          </div>

          <MetricCards />

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
            <div className="xl:col-span-2">
              <DataTable />
            </div>
            <div className="space-y-8">
              <QuickActions />
              <RecentActivity />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Sidebar ───────────────────────────────────────────────────
    {
      path: "src/components/Sidebar.tsx",
      content: `"use client";
import { useState } from "react";
import {
  BarChart3,
  Users,
  Settings,
  Activity,
  DollarSign,
  ExternalLink,
} from "lucide-react";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const navItems = [
  { label: "Dashboard", icon: BarChart3, href: "/", active: true },
  { label: "Users", icon: Users, href: "/users", active: false },
  { label: "Products", icon: ExternalLink, href: "/products", active: false },
  { label: "Orders", icon: DollarSign, href: "/orders", active: false },
  { label: "Settings", icon: Settings, href: "/settings", active: false },
];

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const [activeIdx, setActiveIdx] = useState(0);

  return (
    <aside
      className={\`fixed top-0 left-0 z-40 flex h-screen flex-col border-r border-gray-800 bg-[#0f0f0f] transition-all duration-300 \${
        collapsed ? "w-20" : "w-64"
      }\`}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 border-b border-gray-800 px-6 py-5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white text-sm">
          A
        </div>
        {!collapsed && <span className="text-lg font-bold text-white">AdminPanel</span>}
      </div>

      {/* Toggle */}
      <button
        onClick={onToggle}
        className="mx-auto my-3 flex h-6 w-6 items-center justify-center rounded-full border border-gray-700 bg-gray-800 text-gray-400 hover:text-white transition text-xs"
        aria-label="Toggle sidebar"
      >
        {collapsed ? "\\u203A" : "\\u2039"}
      </button>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3">
        {navItems.map((item, idx) => {
          const Icon = item.icon;
          const isActive = idx === activeIdx;
          return (
            <button
              key={item.label}
              onClick={() => setActiveIdx(idx)}
              className={\`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition \${
                isActive
                  ? "bg-indigo-600/10 text-indigo-400"
                  : "text-gray-400 hover:bg-gray-800 hover:text-white"
              }\`}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* User avatar */}
      <div className="border-t border-gray-800 p-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500" />
          {!collapsed && (
            <div className="overflow-hidden">
              <p className="truncate text-sm font-medium text-white">Jane Cooper</p>
              <p className="truncate text-xs text-gray-500">jane@example.com</p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
`,
      needsLlm: false,
    },

    // ── Data Table ────────────────────────────────────────────────
    {
      path: "src/components/DataTable.tsx",
      content: `"use client";
import { useState, useMemo } from "react";
import { Search, ArrowUpRight, ArrowDownRight } from "lucide-react";

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  status: "Active" | "Inactive" | "Pending";
  joined: string;
}

const sampleUsers: User[] = [
  { id: 1, name: "Alice Johnson", email: "alice@example.com", role: "Admin", status: "Active", joined: "2025-11-02" },
  { id: 2, name: "Bob Smith", email: "bob@example.com", role: "Editor", status: "Active", joined: "2025-12-15" },
  { id: 3, name: "Carol White", email: "carol@example.com", role: "Viewer", status: "Inactive", joined: "2025-10-20" },
  { id: 4, name: "David Lee", email: "david@example.com", role: "Editor", status: "Active", joined: "2026-01-08" },
  { id: 5, name: "Eva Martinez", email: "eva@example.com", role: "Admin", status: "Active", joined: "2025-09-14" },
  { id: 6, name: "Frank Brown", email: "frank@example.com", role: "Viewer", status: "Pending", joined: "2026-02-22" },
  { id: 7, name: "Grace Kim", email: "grace@example.com", role: "Editor", status: "Active", joined: "2025-08-30" },
  { id: 8, name: "Henry Patel", email: "henry@example.com", role: "Viewer", status: "Inactive", joined: "2025-07-11" },
  { id: 9, name: "Iris Chen", email: "iris@example.com", role: "Admin", status: "Active", joined: "2026-03-05" },
  { id: 10, name: "Jack Wilson", email: "jack@example.com", role: "Editor", status: "Pending", joined: "2026-03-18" },
  { id: 11, name: "Karen Davis", email: "karen@example.com", role: "Viewer", status: "Active", joined: "2025-06-25" },
  { id: 12, name: "Leo Garcia", email: "leo@example.com", role: "Editor", status: "Active", joined: "2026-01-30" },
];

type SortKey = keyof User;
type SortDir = "asc" | "desc";

const PAGE_SIZE = 5;

const statusColors: Record<string, string> = {
  Active: "bg-emerald-500/10 text-emerald-400",
  Inactive: "bg-gray-500/10 text-gray-400",
  Pending: "bg-amber-500/10 text-amber-400",
};

export default function DataTable() {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return sampleUsers.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q)
    );
  }, [search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc" ? Number(av) - Number(bv) : Number(bv) - Number(av);
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageData = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(0);
  }

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " \\u2191" : " \\u2193") : "";

  return (
    <div className="rounded-xl border border-gray-800 bg-[#111111]">
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <h2 className="text-lg font-semibold text-white">Users</h2>
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search users..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="w-full rounded-lg border border-gray-800 bg-gray-900/50 py-1.5 pl-9 pr-3 text-sm text-gray-300 placeholder-gray-600 outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-500">
              {(["name", "email", "role", "status", "joined"] as SortKey[]).map((key) => (
                <th
                  key={key}
                  className="cursor-pointer px-6 py-3 hover:text-gray-300 transition select-none"
                  onClick={() => toggleSort(key)}
                >
                  {key}{sortIcon(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.map((user) => (
              <tr key={user.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                <td className="px-6 py-3 font-medium text-white">{user.name}</td>
                <td className="px-6 py-3 text-gray-400">{user.email}</td>
                <td className="px-6 py-3 text-gray-400">{user.role}</td>
                <td className="px-6 py-3">
                  <span className={\`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium \${statusColors[user.status]}\`}>
                    {user.status}
                  </span>
                </td>
                <td className="px-6 py-3 text-gray-500">{user.joined}</td>
              </tr>
            ))}
            {pageData.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-gray-600">No users found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t border-gray-800 px-6 py-3">
        <span className="text-xs text-gray-500">
          Showing {page * PAGE_SIZE + 1}\\u2013{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
        </span>
        <div className="flex gap-1">
          {Array.from({ length: totalPages }, (_, i) => (
            <button
              key={i}
              onClick={() => setPage(i)}
              className={\`h-8 w-8 rounded-lg text-xs font-medium transition \${
                i === page ? "bg-indigo-600 text-white" : "text-gray-500 hover:bg-gray-800 hover:text-white"
              }\`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Metric Cards ──────────────────────────────────────────────
    {
      path: "src/components/MetricCards.tsx",
      content: `import { Users, DollarSign, Activity, TrendingUp, ArrowUpRight, ArrowDownRight } from "lucide-react";

interface Metric {
  label: string;
  value: string;
  change: number;
  icon: React.ElementType;
  sparkline: number[];
}

const metrics: Metric[] = [
  { label: "Total Users", value: "24,891", change: 12.5, icon: Users, sparkline: [30, 45, 35, 55, 48, 62, 58, 75, 70, 82, 78, 90] },
  { label: "Revenue", value: "$148,230", change: 8.2, icon: DollarSign, sparkline: [20, 35, 28, 42, 38, 50, 45, 60, 55, 68, 72, 80] },
  { label: "Orders", value: "3,847", change: -2.4, icon: Activity, sparkline: [60, 55, 50, 48, 52, 45, 40, 42, 38, 35, 40, 37] },
  { label: "Conversion Rate", value: "3.24%", change: 0.8, icon: TrendingUp, sparkline: [15, 20, 18, 25, 22, 28, 30, 27, 32, 35, 33, 38] },
];

function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 120;
  const h = 32;
  const points = data
    .map((v, i) => \`\${(i / (data.length - 1)) * w},\${h - ((v - min) / range) * h}\`)
    .join(" ");

  return (
    <svg viewBox={\`0 0 \${w} \${h}\`} className="w-full h-8" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function MetricCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
      {metrics.map((m) => {
        const Icon = m.icon;
        const positive = m.change >= 0;
        const Arrow = positive ? ArrowUpRight : ArrowDownRight;
        return (
          <div
            key={m.label}
            className="rounded-xl border border-gray-800 bg-[#111111] p-6 hover:border-gray-700 transition"
          >
            <div className="flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-800">
                <Icon className="h-5 w-5 text-gray-400" />
              </div>
              <span
                className={\`flex items-center gap-0.5 text-xs font-medium \${
                  positive ? "text-emerald-400" : "text-red-400"
                }\`}
              >
                <Arrow className="h-3.5 w-3.5" />
                {Math.abs(m.change)}%
              </span>
            </div>
            <p className="mt-4 text-2xl font-bold text-white">{m.value}</p>
            <p className="text-xs text-gray-500 mt-1">{m.label}</p>
            <div className={\`mt-4 \${positive ? "text-emerald-400" : "text-red-400"}\`}>
              <Sparkline data={m.sparkline} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Recent Activity ───────────────────────────────────────────
    {
      path: "src/components/RecentActivity.tsx",
      content: `const activities = [
  { user: "Alice Johnson", action: "created a new order", time: "2 min ago", color: "from-indigo-500 to-purple-600" },
  { user: "Bob Smith", action: "updated product pricing", time: "15 min ago", color: "from-emerald-400 to-cyan-500" },
  { user: "Carol White", action: "exported monthly report", time: "1 hour ago", color: "from-amber-400 to-orange-500" },
  { user: "David Lee", action: "added 3 new users", time: "2 hours ago", color: "from-pink-500 to-rose-500" },
  { user: "Eva Martinez", action: "changed role to Admin", time: "4 hours ago", color: "from-blue-400 to-indigo-500" },
  { user: "Frank Brown", action: "deleted inactive account", time: "6 hours ago", color: "from-violet-400 to-purple-500" },
];

export default function RecentActivity() {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#111111]">
      <div className="border-b border-gray-800 px-6 py-4">
        <h2 className="text-lg font-semibold text-white">Recent Activity</h2>
      </div>
      <div className="divide-y divide-gray-800/50">
        {activities.map((a, i) => (
          <div key={i} className="flex items-center gap-3 px-6 py-3 hover:bg-gray-800/20 transition">
            <div className={\`h-8 w-8 shrink-0 rounded-full bg-gradient-to-br \${a.color}\`} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-gray-300">
                <span className="font-medium text-white">{a.user}</span>{" "}
                {a.action}
              </p>
              <p className="text-xs text-gray-600">{a.time}</p>
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

    // ── Quick Actions ─────────────────────────────────────────────
    {
      path: "src/components/QuickActions.tsx",
      content: `import { Users, DollarSign, BarChart3, ExternalLink } from "lucide-react";

const actions = [
  { label: "Add User", icon: Users, color: "bg-indigo-600 hover:bg-indigo-700" },
  { label: "New Order", icon: DollarSign, color: "bg-emerald-600 hover:bg-emerald-700" },
  { label: "Generate Report", icon: BarChart3, color: "bg-amber-600 hover:bg-amber-700" },
  { label: "Export Data", icon: ExternalLink, color: "bg-purple-600 hover:bg-purple-700" },
];

export default function QuickActions() {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#111111]">
      <div className="border-b border-gray-800 px-6 py-4">
        <h2 className="text-lg font-semibold text-white">Quick Actions</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 p-6">
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <button
              key={a.label}
              className={\`flex flex-col items-center gap-2 rounded-xl p-4 text-white transition \${a.color}\`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-xs font-medium">{a.label}</span>
            </button>
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
  title: "Admin Panel",
  description: "Admin dashboard built with KCode",
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
