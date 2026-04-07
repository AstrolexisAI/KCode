// KCode - Web Engine: CRM Dashboard Template
//
// Complete CRM dashboard with Next.js + React + Tailwind.
// Pipeline view, contacts, deals, activities, revenue chart.
// 100% machine-generated — no LLM customization needed.

interface FileTemplate {
  path: string;
  content: string;
  needsLlm: boolean;
}

export function crmComponents(): FileTemplate[] {
  return [
    // ── Root Layout ────────────────────────────────────────────
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CRM Dashboard",
  description: "Customer Relationship Management — Built with KCode",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0a0a0a] text-white antialiased">
        {children}
      </body>
    </html>
  );
}
`,
      needsLlm: false,
    },

    // ── Main Dashboard Page ────────────────────────────────────
    {
      path: "src/app/page.tsx",
      content: `import Sidebar from "@/components/Sidebar";
import MetricCards from "@/components/MetricCards";
import Pipeline from "@/components/Pipeline";
import ActivityTimeline from "@/components/ActivityTimeline";
import RevenueChart from "@/components/RevenueChart";
import ContactList from "@/components/ContactList";

export default function CRMDashboard() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 ml-64 p-8 space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-sm text-gray-400 mt-1">Welcome back. Here is your sales overview.</p>
          </div>
          <div className="flex items-center gap-3">
            <button className="px-4 py-2 rounded-lg bg-[#1e1e1e] text-sm text-gray-300 hover:bg-[#282828] transition">
              Export
            </button>
            <button className="px-4 py-2 rounded-lg bg-indigo-600 text-sm font-medium hover:bg-indigo-500 transition">
              + New Deal
            </button>
          </div>
        </div>

        <MetricCards />

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Deal Pipeline</h2>
          <Pipeline />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
          <div className="xl:col-span-2">
            <RevenueChart />
          </div>
          <div>
            <ActivityTimeline />
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-4">Recent Contacts</h2>
          <ContactList />
        </div>
      </main>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Sidebar ────────────────────────────────────────────────
    {
      path: "src/components/Sidebar.tsx",
      content: `"use client";

import { useState } from "react";
import {
  BarChart3,
  Users,
  Target,
  Building,
  CheckCircle,
  Activity,
  Settings,
  Search,
  Bell,
  ChevronDown,
} from "lucide-react";

const navItems = [
  { label: "Dashboard", icon: BarChart3, active: true },
  { label: "Contacts", icon: Users, active: false },
  { label: "Deals", icon: Target, active: false },
  { label: "Companies", icon: Building, active: false },
  { label: "Tasks", icon: CheckCircle, active: false },
  { label: "Reports", icon: Activity, active: false },
];

export default function Sidebar() {
  const [activeItem, setActiveItem] = useState("Dashboard");

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-64 bg-[#0a0a0a] border-r border-white/5 flex flex-col z-40">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-sm font-bold">
            C
          </div>
          <span className="font-semibold text-lg">CRM Pro</span>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#141414] text-gray-500 text-sm">
          <Search size={14} />
          <span>Search...</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeItem === item.label;
          return (
            <button
              key={item.label}
              onClick={() => setActiveItem(item.label)}
              className={\`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors \${
                isActive
                  ? "bg-indigo-600/10 text-indigo-400"
                  : "text-gray-400 hover:bg-[#141414] hover:text-gray-200"
              }\`}
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div className="px-3 pb-4 space-y-1">
        <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-400 hover:bg-[#141414] hover:text-gray-200 transition-colors">
          <Settings size={18} />
          <span>Settings</span>
        </button>
        <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-400 hover:bg-[#141414] hover:text-gray-200 transition-colors">
          <Bell size={18} />
          <span>Notifications</span>
          <span className="ml-auto w-5 h-5 rounded-full bg-indigo-600 text-[10px] flex items-center justify-center text-white">3</span>
        </button>
      </div>

      {/* User */}
      <div className="px-4 py-3 border-t border-white/5">
        <button className="w-full flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-xs font-medium">
            JD
          </div>
          <div className="flex-1 text-left">
            <div className="text-sm font-medium">Jane Doe</div>
            <div className="text-xs text-gray-500">Sales Manager</div>
          </div>
          <ChevronDown size={14} className="text-gray-500" />
        </button>
      </div>
    </aside>
  );
}
`,
      needsLlm: false,
    },

    // ── Metric Cards ───────────────────────────────────────────
    {
      path: "src/components/MetricCards.tsx",
      content: `import {
  DollarSign,
  Target,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  BarChart3,
} from "lucide-react";

const metrics = [
  {
    title: "Total Pipeline Value",
    value: "$2,847,500",
    change: "+12.5%",
    up: true,
    icon: DollarSign,
    color: "from-indigo-500 to-indigo-600",
  },
  {
    title: "Deals Won This Month",
    value: "14",
    change: "+8.3%",
    up: true,
    icon: Target,
    color: "from-emerald-500 to-emerald-600",
  },
  {
    title: "Conversion Rate",
    value: "24.8%",
    change: "-2.1%",
    up: false,
    icon: TrendingUp,
    color: "from-amber-500 to-amber-600",
  },
  {
    title: "Avg Deal Size",
    value: "$38,200",
    change: "+5.7%",
    up: true,
    icon: BarChart3,
    color: "from-purple-500 to-purple-600",
  },
];

export default function MetricCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {metrics.map((m, i) => {
        const Icon = m.icon;
        return (
          <div
            key={i}
            className="p-5 rounded-xl bg-[#141414] border border-white/5 hover:border-white/10 transition-colors"
          >
            <div className="flex items-center justify-between mb-4">
              <div className={\`w-10 h-10 rounded-lg bg-gradient-to-br \${m.color} flex items-center justify-center\`}>
                <Icon size={18} className="text-white" />
              </div>
              <div className={\`flex items-center gap-1 text-xs font-medium \${m.up ? "text-emerald-400" : "text-red-400"}\`}>
                {m.up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                {m.change}
              </div>
            </div>
            <div className="text-2xl font-bold">{m.value}</div>
            <div className="text-xs text-gray-500 mt-1">{m.title}</div>
          </div>
        );
      })}
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Deal Card ──────────────────────────────────────────────
    {
      path: "src/components/DealCard.tsx",
      content: `"use client";

import { Grip, Building, Clock, MoreHorizontal } from "lucide-react";

interface Deal {
  id: number;
  company: string;
  value: number;
  contact: string;
  daysInStage: number;
  probability: number;
}

export default function DealCard({ deal }: { deal: Deal }) {
  const formatValue = (v: number) =>
    v >= 1000 ? \`$\${(v / 1000).toFixed(0)}k\` : \`$\${v}\`;

  const probColor =
    deal.probability >= 70
      ? "bg-emerald-500/10 text-emerald-400"
      : deal.probability >= 40
      ? "bg-amber-500/10 text-amber-400"
      : "bg-red-500/10 text-red-400";

  return (
    <div className="p-3 rounded-lg bg-[#1e1e1e] border border-white/5 hover:border-white/10 transition-colors group cursor-grab active:cursor-grabbing">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
          <Grip size={12} />
        </div>
        <button className="text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity hover:text-gray-300">
          <MoreHorizontal size={14} />
        </button>
      </div>

      <div className="flex items-center gap-2 mb-1">
        <Building size={12} className="text-gray-500" />
        <span className="text-sm font-medium truncate">{deal.company}</span>
      </div>

      <div className="text-lg font-bold text-indigo-400 mb-2">
        {formatValue(deal.value)}
      </div>

      <div className="text-xs text-gray-500 mb-2">{deal.contact}</div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs text-gray-500">
          <Clock size={10} />
          <span>{deal.daysInStage}d</span>
        </div>
        <span className={\`text-[10px] font-medium px-2 py-0.5 rounded-full \${probColor}\`}>
          {deal.probability}%
        </span>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Pipeline ───────────────────────────────────────────────
    {
      path: "src/components/Pipeline.tsx",
      content: `"use client";

import DealCard from "./DealCard";

interface Deal {
  id: number;
  company: string;
  value: number;
  contact: string;
  daysInStage: number;
  probability: number;
  stage: string;
}

const deals: Deal[] = [
  { id: 1, company: "Acme Corp", value: 125000, contact: "Sarah Chen", daysInStage: 3, probability: 20, stage: "Lead" },
  { id: 2, company: "TechFlow Inc", value: 85000, contact: "Mike Rivera", daysInStage: 7, probability: 15, stage: "Lead" },
  { id: 3, company: "Globex Systems", value: 210000, contact: "Elena Vasquez", daysInStage: 12, probability: 45, stage: "Qualified" },
  { id: 4, company: "Initech Labs", value: 67000, contact: "James Park", daysInStage: 5, probability: 50, stage: "Qualified" },
  { id: 5, company: "Sterling & Co", value: 340000, contact: "Aisha Patel", daysInStage: 8, probability: 55, stage: "Qualified" },
  { id: 6, company: "Apex Digital", value: 195000, contact: "Tom Bradley", daysInStage: 14, probability: 65, stage: "Proposal" },
  { id: 7, company: "Horizon Media", value: 150000, contact: "Lisa Wong", daysInStage: 6, probability: 70, stage: "Proposal" },
  { id: 8, company: "Vertex Solutions", value: 420000, contact: "David Kim", daysInStage: 3, probability: 60, stage: "Proposal" },
  { id: 9, company: "Pinnacle Group", value: 290000, contact: "Rachel Green", daysInStage: 18, probability: 75, stage: "Negotiation" },
  { id: 10, company: "Atlas Partners", value: 175000, contact: "Carlos Mendez", daysInStage: 10, probability: 80, stage: "Negotiation" },
  { id: 11, company: "Quantum Dynamics", value: 95000, contact: "Nina Foster", daysInStage: 22, probability: 85, stage: "Negotiation" },
  { id: 12, company: "Silverline Tech", value: 310000, contact: "Alex Turner", daysInStage: 2, probability: 95, stage: "Closed Won" },
  { id: 13, company: "Meridian Corp", value: 88000, contact: "Priya Sharma", daysInStage: 1, probability: 100, stage: "Closed Won" },
  { id: 14, company: "Vanguard AI", value: 145000, contact: "Chris Evans", daysInStage: 5, probability: 0, stage: "Closed Lost" },
  { id: 15, company: "Echo Systems", value: 52000, contact: "Maya Johnson", daysInStage: 30, probability: 0, stage: "Closed Lost" },
];

const stages = [
  { name: "Lead", color: "border-blue-500/30" },
  { name: "Qualified", color: "border-cyan-500/30" },
  { name: "Proposal", color: "border-amber-500/30" },
  { name: "Negotiation", color: "border-purple-500/30" },
  { name: "Closed Won", color: "border-emerald-500/30" },
  { name: "Closed Lost", color: "border-red-500/30" },
];

function formatTotal(v: number): string {
  if (v >= 1000000) return \`$\${(v / 1000000).toFixed(1)}M\`;
  if (v >= 1000) return \`$\${(v / 1000).toFixed(0)}k\`;
  return \`$\${v}\`;
}

export default function Pipeline() {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {stages.map((stage) => {
        const stageDeals = deals.filter((d) => d.stage === stage.name);
        const total = stageDeals.reduce((sum, d) => sum + d.value, 0);
        return (
          <div
            key={stage.name}
            className={\`flex-shrink-0 w-64 rounded-xl bg-[#141414] border-t-2 \${stage.color}\`}
          >
            <div className="px-3 py-3 border-b border-white/5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{stage.name}</span>
                <span className="text-xs text-gray-500">{stageDeals.length}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">{formatTotal(total)}</div>
            </div>
            <div className="p-2 space-y-2 min-h-[120px]">
              {stageDeals.map((deal) => (
                <DealCard key={deal.id} deal={deal} />
              ))}
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

    // ── Contact List ───────────────────────────────────────────
    {
      path: "src/components/ContactList.tsx",
      content: `import { Mail, Phone } from "lucide-react";

interface Contact {
  name: string;
  initials: string;
  company: string;
  email: string;
  phone: string;
  lastContact: string;
  status: "Active" | "Inactive" | "New";
  gradient: string;
}

const contacts: Contact[] = [
  { name: "Sarah Chen", initials: "SC", company: "Acme Corp", email: "sarah@acme.com", phone: "+1 (555) 201-3344", lastContact: "2 hours ago", status: "Active", gradient: "from-indigo-500 to-blue-500" },
  { name: "Mike Rivera", initials: "MR", company: "TechFlow Inc", email: "mike@techflow.io", phone: "+1 (555) 302-7781", lastContact: "1 day ago", status: "Active", gradient: "from-emerald-500 to-teal-500" },
  { name: "Elena Vasquez", initials: "EV", company: "Globex Systems", email: "elena@globex.com", phone: "+1 (555) 410-9922", lastContact: "3 days ago", status: "Active", gradient: "from-purple-500 to-pink-500" },
  { name: "James Park", initials: "JP", company: "Initech Labs", email: "james@initech.dev", phone: "+1 (555) 518-4400", lastContact: "1 week ago", status: "Inactive", gradient: "from-amber-500 to-orange-500" },
  { name: "Aisha Patel", initials: "AP", company: "Sterling & Co", email: "aisha@sterling.co", phone: "+1 (555) 623-1155", lastContact: "4 hours ago", status: "Active", gradient: "from-cyan-500 to-blue-500" },
  { name: "Tom Bradley", initials: "TB", company: "Apex Digital", email: "tom@apexdigital.io", phone: "+1 (555) 734-8899", lastContact: "5 days ago", status: "New", gradient: "from-rose-500 to-pink-500" },
  { name: "Lisa Wong", initials: "LW", company: "Horizon Media", email: "lisa@horizon.media", phone: "+1 (555) 845-2233", lastContact: "2 days ago", status: "Active", gradient: "from-violet-500 to-purple-500" },
  { name: "David Kim", initials: "DK", company: "Vertex Solutions", email: "david@vertex.io", phone: "+1 (555) 901-6677", lastContact: "6 hours ago", status: "Active", gradient: "from-sky-500 to-indigo-500" },
  { name: "Rachel Green", initials: "RG", company: "Pinnacle Group", email: "rachel@pinnacle.com", phone: "+1 (555) 012-3344", lastContact: "3 hours ago", status: "New", gradient: "from-lime-500 to-emerald-500" },
  { name: "Carlos Mendez", initials: "CM", company: "Atlas Partners", email: "carlos@atlas.co", phone: "+1 (555) 189-5566", lastContact: "1 week ago", status: "Inactive", gradient: "from-orange-500 to-red-500" },
];

const statusStyles: Record<string, string> = {
  Active: "bg-emerald-500/10 text-emerald-400",
  Inactive: "bg-gray-500/10 text-gray-400",
  New: "bg-indigo-500/10 text-indigo-400",
};

export default function ContactList() {
  return (
    <div className="rounded-xl bg-[#141414] border border-white/5 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                Contact
              </th>
              <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                Company
              </th>
              <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                Email
              </th>
              <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                Phone
              </th>
              <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                Last Contact
              </th>
              <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c, i) => (
              <tr
                key={i}
                className="border-b border-white/5 last:border-0 hover:bg-[#1e1e1e] transition-colors"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className={\`w-8 h-8 rounded-full bg-gradient-to-br \${c.gradient} flex items-center justify-center text-[10px] font-bold\`}>
                      {c.initials}
                    </div>
                    <span className="text-sm font-medium">{c.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-gray-400">{c.company}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 text-sm text-gray-400">
                    <Mail size={12} />
                    <span>{c.email}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 text-sm text-gray-400">
                    <Phone size={12} />
                    <span>{c.phone}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{c.lastContact}</td>
                <td className="px-4 py-3">
                  <span className={\`text-[10px] font-medium px-2 py-1 rounded-full \${statusStyles[c.status]}\`}>
                    {c.status}
                  </span>
                </td>
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

    // ── Activity Timeline ──────────────────────────────────────
    {
      path: "src/components/ActivityTimeline.tsx",
      content: `import { Phone, Mail, Calendar, CheckCircle } from "lucide-react";

interface ActivityItem {
  type: "call" | "email" | "meeting" | "note";
  title: string;
  description: string;
  time: string;
}

const activities: ActivityItem[] = [
  { type: "call", title: "Call with Sarah Chen", description: "Discussed Q2 renewal pricing for Acme Corp", time: "25 min ago" },
  { type: "email", title: "Proposal sent to Apex Digital", description: "Enterprise plan proposal — $195k annual deal", time: "1 hour ago" },
  { type: "meeting", title: "Demo with Pinnacle Group", description: "Product walkthrough with 4 stakeholders", time: "3 hours ago" },
  { type: "note", title: "Note on Vertex Solutions", description: "Decision maker changed — follow up with new CTO", time: "5 hours ago" },
  { type: "email", title: "Follow-up to Atlas Partners", description: "Sent updated contract with revised terms", time: "6 hours ago" },
  { type: "call", title: "Discovery call — Horizon Media", description: "Initial outreach, booked follow-up demo", time: "Yesterday" },
  { type: "meeting", title: "QBR with Sterling & Co", description: "Quarterly business review — upsell opportunity", time: "Yesterday" },
  { type: "note", title: "Competitor intel update", description: "TechFlow considering alternative vendors", time: "2 days ago" },
];

const iconMap = {
  call: Phone,
  email: Mail,
  meeting: Calendar,
  note: CheckCircle,
};

const colorMap = {
  call: "bg-blue-500/10 text-blue-400",
  email: "bg-indigo-500/10 text-indigo-400",
  meeting: "bg-purple-500/10 text-purple-400",
  note: "bg-emerald-500/10 text-emerald-400",
};

export default function ActivityTimeline() {
  return (
    <div className="rounded-xl bg-[#141414] border border-white/5 p-4">
      <h3 className="text-sm font-semibold mb-4">Recent Activity</h3>
      <div className="space-y-4">
        {activities.map((a, i) => {
          const Icon = iconMap[a.type];
          return (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className={\`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 \${colorMap[a.type]}\`}>
                  <Icon size={14} />
                </div>
                {i < activities.length - 1 && (
                  <div className="w-px flex-1 bg-white/5 mt-1" />
                )}
              </div>
              <div className="pb-4 min-w-0">
                <div className="text-sm font-medium leading-tight">{a.title}</div>
                <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{a.description}</div>
                <div className="text-[10px] text-gray-600 mt-1">{a.time}</div>
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

    // ── Revenue Chart (Pure SVG) ───────────────────────────────
    {
      path: "src/components/RevenueChart.tsx",
      content: `"use client";

import { useState } from "react";

const months = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const revenueData = [
  42000, 58000, 35000, 71000, 63000, 89000,
  95000, 78000, 110000, 102000, 128000, 145000,
];

const maxValue = Math.max(...revenueData);

function formatValue(v: number): string {
  if (v >= 1000) return \`$\${(v / 1000).toFixed(0)}k\`;
  return \`$\${v}\`;
}

export default function RevenueChart() {
  const [hovered, setHovered] = useState<number | null>(null);

  const chartWidth = 600;
  const chartHeight = 220;
  const barWidth = 32;
  const gap = (chartWidth - barWidth * 12) / 13;

  return (
    <div className="rounded-xl bg-[#141414] border border-white/5 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">Monthly Revenue</h3>
        <div className="text-xs text-gray-500">
          Total: {formatValue(revenueData.reduce((a, b) => a + b, 0))}
        </div>
      </div>

      <div className="w-full overflow-x-auto">
        <svg
          viewBox={\`0 0 \${chartWidth} \${chartHeight + 30}\`}
          className="w-full h-auto min-w-[500px]"
          role="img"
          aria-label="Monthly revenue bar chart"
        >
          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = chartHeight - ratio * chartHeight;
            return (
              <g key={ratio}>
                <line
                  x1={0}
                  y1={y}
                  x2={chartWidth}
                  y2={y}
                  stroke="rgba(255,255,255,0.04)"
                  strokeDasharray="4 4"
                />
                <text
                  x={0}
                  y={y - 4}
                  fontSize="9"
                  fill="rgba(255,255,255,0.25)"
                >
                  {formatValue(Math.round(maxValue * ratio))}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          {revenueData.map((value, i) => {
            const barHeight = (value / maxValue) * (chartHeight - 20);
            const x = gap + i * (barWidth + gap);
            const y = chartHeight - barHeight;
            const isHovered = hovered === i;
            return (
              <g
                key={i}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                className="cursor-pointer"
              >
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barHeight}
                  rx={4}
                  fill={isHovered ? "rgb(99,102,241)" : "rgb(79,82,201)"}
                  opacity={isHovered ? 1 : 0.7}
                  className="transition-all duration-150"
                />
                {/* Month label */}
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 16}
                  textAnchor="middle"
                  fontSize="10"
                  fill="rgba(255,255,255,0.35)"
                >
                  {months[i]}
                </text>
                {/* Hover tooltip */}
                {isHovered && (
                  <>
                    <rect
                      x={x + barWidth / 2 - 28}
                      y={y - 24}
                      width={56}
                      height={20}
                      rx={4}
                      fill="#1e1e1e"
                      stroke="rgba(255,255,255,0.1)"
                    />
                    <text
                      x={x + barWidth / 2}
                      y={y - 10}
                      textAnchor="middle"
                      fontSize="10"
                      fontWeight="bold"
                      fill="white"
                    >
                      {formatValue(value)}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
  ];
}
