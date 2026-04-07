// KCode - Web Engine: Project Management Template
//
// Complete project management tool with Next.js + React + Tailwind.
// Kanban board, timeline, calendar, team management.
// 100% machine-generated — no LLM customization needed.

interface FileTemplate {
  path: string;
  content: string;
  needsLlm: boolean;
}

export function projectManagementComponents(): FileTemplate[] {
  return [
    // ── Root Layout ────────────────────────────────────────────
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Project Management",
  description: "Project Management Dashboard — Built with KCode",
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
import ProjectStats from "@/components/ProjectStats";
import KanbanBoard from "@/components/KanbanBoard";
import TeamMembers from "@/components/TeamMembers";
import Timeline from "@/components/Timeline";
import CalendarView from "@/components/CalendarView";

export default function ProjectDashboard() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 ml-64 p-8 space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Project Board</h1>
            <p className="text-sm text-gray-400 mt-1">Website Redesign — Sprint 4</p>
          </div>
          <div className="flex items-center gap-3">
            <button className="px-4 py-2 rounded-lg bg-[#1e1e1e] text-sm text-gray-300 hover:bg-[#282828] transition">
              Filter
            </button>
            <button className="px-4 py-2 rounded-lg bg-indigo-600 text-sm font-medium hover:bg-indigo-500 transition">
              + New Task
            </button>
          </div>
        </div>

        <ProjectStats />

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Board</h2>
          <KanbanBoard />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
          <Timeline />
          <CalendarView />
        </div>

        <TeamMembers />
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
  Layers,
  BarChart3,
  Calendar,
  Users,
  Settings,
  Search,
  Bell,
  ChevronDown,
  ChevronRight,
  Plus,
} from "lucide-react";

const navItems = [
  { label: "Projects", icon: Layers },
  { label: "Board", icon: BarChart3 },
  { label: "Timeline", icon: Activity },
  { label: "Calendar", icon: Calendar },
  { label: "Team", icon: Users },
  { label: "Settings", icon: Settings },
];

// Use Activity from lucide — import separately
import { Activity } from "lucide-react";

const projects = [
  { name: "Website Redesign", color: "bg-indigo-500" },
  { name: "Mobile App v2", color: "bg-emerald-500" },
  { name: "API Migration", color: "bg-amber-500" },
];

export default function Sidebar() {
  const [activeItem, setActiveItem] = useState("Board");
  const [projectsOpen, setProjectsOpen] = useState(true);

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-64 bg-[#0a0a0a] border-r border-white/5 flex flex-col z-40">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-sm font-bold">
            P
          </div>
          <span className="font-semibold text-lg">ProjectHub</span>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#141414] text-gray-500 text-sm">
          <Search size={14} />
          <span>Search tasks...</span>
        </div>
      </div>

      {/* Projects section */}
      <div className="px-3 mb-2">
        <button
          onClick={() => setProjectsOpen(!projectsOpen)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider"
        >
          <span>Projects</span>
          <div className="flex items-center gap-1">
            <Plus size={12} className="hover:text-gray-300 transition-colors" />
            {projectsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </div>
        </button>
        {projectsOpen && (
          <div className="space-y-0.5">
            {projects.map((p) => (
              <button
                key={p.name}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-[#141414] hover:text-gray-200 transition-colors"
              >
                <div className={\`w-2.5 h-2.5 rounded-full \${p.color}\`} />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 space-y-1">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wider px-3 py-2">
          Navigation
        </div>
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

      {/* Bottom */}
      <div className="px-4 py-3 border-t border-white/5">
        <button className="w-full flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-xs font-medium">
            AL
          </div>
          <div className="flex-1 text-left">
            <div className="text-sm font-medium">Alex Lee</div>
            <div className="text-xs text-gray-500">Project Lead</div>
          </div>
          <Bell size={14} className="text-gray-500" />
        </button>
      </div>
    </aside>
  );
}
`,
      needsLlm: false,
    },

    // ── Project Stats ──────────────────────────────────────────
    {
      path: "src/components/ProjectStats.tsx",
      content: `const stats = [
  { label: "Total Tasks", value: 20, total: 20, color: "#6366f1" },
  { label: "Completed", value: 5, total: 20, color: "#10b981" },
  { label: "In Progress", value: 8, total: 20, color: "#f59e0b" },
  { label: "Overdue", value: 3, total: 20, color: "#ef4444" },
];

function ProgressRing({
  value,
  total,
  color,
  size = 56,
}: {
  value: number;
  total: number;
  color: string;
  size?: number;
}) {
  const strokeWidth = 5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? (value / total) * circumference : 0;

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke="rgba(255,255,255,0.05)"
        strokeWidth={strokeWidth}
        fill="none"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={circumference - progress}
        strokeLinecap="round"
        className="transition-all duration-500"
      />
    </svg>
  );
}

export default function ProjectStats() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {stats.map((s, i) => (
        <div
          key={i}
          className="p-5 rounded-xl bg-[#141414] border border-white/5 hover:border-white/10 transition-colors"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold">{s.value}</div>
              <div className="text-xs text-gray-500 mt-1">{s.label}</div>
            </div>
            <div className="relative">
              <ProgressRing value={s.value} total={s.total} color={s.color} />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-[10px] font-medium text-gray-400">
                  {Math.round((s.value / s.total) * 100)}%
                </span>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Task Card ──────────────────────────────────────────────
    {
      path: "src/components/TaskCard.tsx",
      content: `"use client";

import { Grip, Calendar, MoreHorizontal, Tag } from "lucide-react";

interface Task {
  id: number;
  title: string;
  assignee: { name: string; initials: string; gradient: string };
  priority: "High" | "Medium" | "Low";
  dueDate: string;
  tags: string[];
  subtasksDone: number;
  subtasksTotal: number;
}

const priorityStyles = {
  High: "bg-red-500/10 text-red-400",
  Medium: "bg-amber-500/10 text-amber-400",
  Low: "bg-blue-500/10 text-blue-400",
};

export default function TaskCard({ task }: { task: Task }) {
  const subtaskPercent =
    task.subtasksTotal > 0
      ? Math.round((task.subtasksDone / task.subtasksTotal) * 100)
      : 0;

  return (
    <div className="p-3 rounded-lg bg-[#1e1e1e] border border-white/5 hover:border-white/10 transition-colors group cursor-grab active:cursor-grabbing">
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-1 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
          <Grip size={12} />
        </div>
        <button className="text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity hover:text-gray-300">
          <MoreHorizontal size={14} />
        </button>
      </div>

      {/* Title */}
      <div className="text-sm font-medium mb-2 leading-snug">{task.title}</div>

      {/* Tags */}
      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {task.tags.map((tag, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[#141414] text-gray-400"
            >
              <Tag size={8} />
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Subtask progress */}
      {task.subtasksTotal > 0 && (
        <div className="mb-2">
          <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
            <span>Subtasks</span>
            <span>
              {task.subtasksDone}/{task.subtasksTotal}
            </span>
          </div>
          <div className="h-1 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-300"
              style={{ width: \`\${subtaskPercent}%\` }}
            />
          </div>
        </div>
      )}

      {/* Bottom row */}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-2">
          {/* Assignee avatar */}
          <div
            className={\`w-6 h-6 rounded-full bg-gradient-to-br \${task.assignee.gradient} flex items-center justify-center text-[8px] font-bold\`}
          >
            {task.assignee.initials}
          </div>
          {/* Priority */}
          <span
            className={\`text-[10px] font-medium px-1.5 py-0.5 rounded \${priorityStyles[task.priority]}\`}
          >
            {task.priority}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-gray-500">
          <Calendar size={10} />
          <span>{task.dueDate}</span>
        </div>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },

    // ── Kanban Board ───────────────────────────────────────────
    {
      path: "src/components/KanbanBoard.tsx",
      content: `"use client";

import TaskCard from "./TaskCard";

interface Task {
  id: number;
  title: string;
  assignee: { name: string; initials: string; gradient: string };
  priority: "High" | "Medium" | "Low";
  dueDate: string;
  tags: string[];
  subtasksDone: number;
  subtasksTotal: number;
  column: string;
}

const team = {
  alex: { name: "Alex Lee", initials: "AL", gradient: "from-indigo-500 to-purple-600" },
  sam: { name: "Sam Chen", initials: "SC", gradient: "from-emerald-500 to-teal-500" },
  jordan: { name: "Jordan Kim", initials: "JK", gradient: "from-amber-500 to-orange-500" },
  taylor: { name: "Taylor Swift", initials: "TS", gradient: "from-rose-500 to-pink-500" },
  morgan: { name: "Morgan Davis", initials: "MD", gradient: "from-cyan-500 to-blue-500" },
  riley: { name: "Riley Garcia", initials: "RG", gradient: "from-violet-500 to-purple-500" },
};

const tasks: Task[] = [
  { id: 1, title: "Design new landing page mockups", assignee: team.alex, priority: "High", dueDate: "Apr 8", tags: ["Design", "Frontend"], subtasksDone: 2, subtasksTotal: 5, column: "To Do" },
  { id: 2, title: "Set up CI/CD pipeline", assignee: team.sam, priority: "Medium", dueDate: "Apr 9", tags: ["DevOps"], subtasksDone: 0, subtasksTotal: 3, column: "To Do" },
  { id: 3, title: "Write API documentation", assignee: team.jordan, priority: "Low", dueDate: "Apr 12", tags: ["Docs"], subtasksDone: 0, subtasksTotal: 8, column: "To Do" },
  { id: 4, title: "Database schema migration", assignee: team.morgan, priority: "High", dueDate: "Apr 7", tags: ["Backend", "Database"], subtasksDone: 1, subtasksTotal: 4, column: "To Do" },
  { id: 5, title: "Implement user authentication", assignee: team.sam, priority: "High", dueDate: "Apr 10", tags: ["Backend", "Security"], subtasksDone: 3, subtasksTotal: 6, column: "In Progress" },
  { id: 6, title: "Create dashboard components", assignee: team.alex, priority: "Medium", dueDate: "Apr 11", tags: ["Frontend"], subtasksDone: 4, subtasksTotal: 7, column: "In Progress" },
  { id: 7, title: "Mobile responsive layouts", assignee: team.taylor, priority: "Medium", dueDate: "Apr 9", tags: ["Frontend", "Mobile"], subtasksDone: 2, subtasksTotal: 4, column: "In Progress" },
  { id: 8, title: "Set up error monitoring", assignee: team.morgan, priority: "Low", dueDate: "Apr 14", tags: ["DevOps"], subtasksDone: 1, subtasksTotal: 2, column: "In Progress" },
  { id: 9, title: "Integrate payment gateway", assignee: team.riley, priority: "High", dueDate: "Apr 8", tags: ["Backend", "Payments"], subtasksDone: 5, subtasksTotal: 5, column: "In Progress" },
  { id: 10, title: "Unit tests for auth module", assignee: team.sam, priority: "Medium", dueDate: "Apr 10", tags: ["Testing"], subtasksDone: 8, subtasksTotal: 10, column: "Review" },
  { id: 11, title: "Accessibility audit fixes", assignee: team.taylor, priority: "High", dueDate: "Apr 7", tags: ["Frontend", "A11y"], subtasksDone: 6, subtasksTotal: 6, column: "Review" },
  { id: 12, title: "Performance optimization", assignee: team.jordan, priority: "Medium", dueDate: "Apr 11", tags: ["Performance"], subtasksDone: 3, subtasksTotal: 4, column: "Review" },
  { id: 13, title: "Code review — search feature", assignee: team.riley, priority: "Low", dueDate: "Apr 9", tags: ["Review"], subtasksDone: 2, subtasksTotal: 2, column: "Review" },
  { id: 14, title: "Deploy staging environment", assignee: team.morgan, priority: "Medium", dueDate: "Apr 6", tags: ["DevOps"], subtasksDone: 3, subtasksTotal: 3, column: "Done" },
  { id: 15, title: "Design system tokens", assignee: team.alex, priority: "High", dueDate: "Apr 4", tags: ["Design"], subtasksDone: 5, subtasksTotal: 5, column: "Done" },
  { id: 16, title: "User onboarding flow", assignee: team.taylor, priority: "Medium", dueDate: "Apr 5", tags: ["Frontend", "UX"], subtasksDone: 4, subtasksTotal: 4, column: "Done" },
  { id: 17, title: "Email notification service", assignee: team.riley, priority: "Low", dueDate: "Apr 3", tags: ["Backend"], subtasksDone: 6, subtasksTotal: 6, column: "Done" },
  { id: 18, title: "API rate limiting", assignee: team.sam, priority: "High", dueDate: "Apr 2", tags: ["Backend", "Security"], subtasksDone: 2, subtasksTotal: 2, column: "Done" },
  { id: 19, title: "Analytics dashboard wireframes", assignee: team.alex, priority: "Low", dueDate: "Apr 15", tags: ["Design"], subtasksDone: 0, subtasksTotal: 3, column: "To Do" },
  { id: 20, title: "Internationalization setup", assignee: team.jordan, priority: "Medium", dueDate: "Apr 13", tags: ["Frontend", "i18n"], subtasksDone: 1, subtasksTotal: 5, column: "In Progress" },
];

const columns = [
  { name: "To Do", color: "border-gray-500/30" },
  { name: "In Progress", color: "border-amber-500/30" },
  { name: "Review", color: "border-purple-500/30" },
  { name: "Done", color: "border-emerald-500/30" },
];

export default function KanbanBoard() {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map((col) => {
        const colTasks = tasks.filter((t) => t.column === col.name);
        return (
          <div
            key={col.name}
            className={\`flex-shrink-0 w-72 rounded-xl bg-[#141414] border-t-2 \${col.color}\`}
          >
            <div className="px-3 py-3 border-b border-white/5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{col.name}</span>
                <span className="text-xs text-gray-500 bg-[#1e1e1e] px-2 py-0.5 rounded-full">
                  {colTasks.length}
                </span>
              </div>
            </div>
            <div className="p-2 space-y-2 min-h-[120px]">
              {colTasks.map((task) => (
                <TaskCard key={task.id} task={task} />
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

    // ── Team Members ───────────────────────────────────────────
    {
      path: "src/components/TeamMembers.tsx",
      content: `const members = [
  {
    name: "Alex Lee",
    initials: "AL",
    role: "Project Lead",
    taskCount: 4,
    status: "online" as const,
    gradient: "from-indigo-500 to-purple-600",
  },
  {
    name: "Sam Chen",
    initials: "SC",
    role: "Backend Engineer",
    taskCount: 5,
    status: "online" as const,
    gradient: "from-emerald-500 to-teal-500",
  },
  {
    name: "Jordan Kim",
    initials: "JK",
    role: "Technical Writer",
    taskCount: 3,
    status: "away" as const,
    gradient: "from-amber-500 to-orange-500",
  },
  {
    name: "Taylor Swift",
    initials: "TS",
    role: "Frontend Developer",
    taskCount: 4,
    status: "online" as const,
    gradient: "from-rose-500 to-pink-500",
  },
  {
    name: "Morgan Davis",
    initials: "MD",
    role: "DevOps Engineer",
    taskCount: 3,
    status: "offline" as const,
    gradient: "from-cyan-500 to-blue-500",
  },
  {
    name: "Riley Garcia",
    initials: "RG",
    role: "Full Stack Developer",
    taskCount: 4,
    status: "online" as const,
    gradient: "from-violet-500 to-purple-500",
  },
];

const statusColors = {
  online: "bg-emerald-500",
  away: "bg-amber-500",
  offline: "bg-gray-500",
};

const statusLabels = {
  online: "Online",
  away: "Away",
  offline: "Offline",
};

export default function TeamMembers() {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Team</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {members.map((m, i) => (
          <div
            key={i}
            className="p-4 rounded-xl bg-[#141414] border border-white/5 hover:border-white/10 transition-colors flex items-center gap-4"
          >
            {/* Avatar */}
            <div className="relative">
              <div
                className={\`w-12 h-12 rounded-full bg-gradient-to-br \${m.gradient} flex items-center justify-center text-sm font-bold\`}
              >
                {m.initials}
              </div>
              <div
                className={\`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-[#141414] \${statusColors[m.status]}\`}
              />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{m.name}</div>
              <div className="text-xs text-gray-500">{m.role}</div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-[10px] text-gray-400">
                  {m.taskCount} tasks
                </span>
                <span className={\`text-[10px] flex items-center gap-1\`}>
                  <span className={\`w-1.5 h-1.5 rounded-full \${statusColors[m.status]}\`} />
                  <span className="text-gray-500">{statusLabels[m.status]}</span>
                </span>
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

    // ── Timeline (Gantt-style, pure CSS) ───────────────────────
    {
      path: "src/components/Timeline.tsx",
      content: `const weeks = ["Week 1", "Week 2", "Week 3", "Week 4"];

interface TimelineTask {
  name: string;
  assignee: string;
  startWeek: number; // 0-3
  duration: number; // in weeks
  color: string;
}

const timelineTasks: TimelineTask[] = [
  { name: "Design mockups", assignee: "Alex", startWeek: 0, duration: 1, color: "bg-indigo-500" },
  { name: "Auth system", assignee: "Sam", startWeek: 0, duration: 2, color: "bg-emerald-500" },
  { name: "Dashboard UI", assignee: "Alex", startWeek: 1, duration: 2, color: "bg-indigo-500" },
  { name: "API endpoints", assignee: "Sam", startWeek: 1, duration: 1.5, color: "bg-emerald-500" },
  { name: "Mobile layout", assignee: "Taylor", startWeek: 1.5, duration: 1.5, color: "bg-rose-500" },
  { name: "Payment integration", assignee: "Riley", startWeek: 2, duration: 1, color: "bg-violet-500" },
  { name: "Testing & QA", assignee: "Morgan", startWeek: 2.5, duration: 1.5, color: "bg-cyan-500" },
  { name: "Deployment", assignee: "Morgan", startWeek: 3.5, duration: 0.5, color: "bg-amber-500" },
];

export default function Timeline() {
  return (
    <div className="rounded-xl bg-[#141414] border border-white/5 p-4">
      <h3 className="text-sm font-semibold mb-4">Timeline</h3>

      {/* Week headers */}
      <div className="flex mb-3">
        <div className="w-36 flex-shrink-0" />
        <div className="flex-1 grid grid-cols-4">
          {weeks.map((w) => (
            <div key={w} className="text-[10px] text-gray-500 text-center">
              {w}
            </div>
          ))}
        </div>
      </div>

      {/* Tasks */}
      <div className="space-y-2">
        {timelineTasks.map((task, i) => {
          const leftPercent = (task.startWeek / 4) * 100;
          const widthPercent = (task.duration / 4) * 100;
          return (
            <div key={i} className="flex items-center">
              <div className="w-36 flex-shrink-0 pr-3">
                <div className="text-xs font-medium truncate">{task.name}</div>
                <div className="text-[10px] text-gray-500">{task.assignee}</div>
              </div>
              <div className="flex-1 relative h-7 bg-[#0a0a0a] rounded">
                {/* Grid lines */}
                {[1, 2, 3].map((n) => (
                  <div
                    key={n}
                    className="absolute top-0 bottom-0 w-px bg-white/5"
                    style={{ left: \`\${(n / 4) * 100}%\` }}
                  />
                ))}
                {/* Bar */}
                <div
                  className={\`absolute top-1 bottom-1 rounded \${task.color} opacity-70 hover:opacity-100 transition-opacity\`}
                  style={{
                    left: \`\${leftPercent}%\`,
                    width: \`\${widthPercent}%\`,
                  }}
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

    // ── Calendar View ──────────────────────────────────────────
    {
      path: "src/components/CalendarView.tsx",
      content: `"use client";

import { ChevronDown } from "lucide-react";

// April 2026 calendar
const daysOfWeek = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// April 2026 starts on Wednesday (index 2 in Mon-based week)
const startOffset = 2;
const daysInMonth = 30;

// Tasks mapped to dates (day of month -> task colors)
const taskDots: Record<number, string[]> = {
  2: ["bg-emerald-500"],
  3: ["bg-violet-500"],
  4: ["bg-indigo-500"],
  5: ["bg-rose-500"],
  6: ["bg-cyan-500"],
  7: ["bg-red-500", "bg-purple-500"],
  8: ["bg-indigo-500", "bg-violet-500"],
  9: ["bg-amber-500", "bg-emerald-500"],
  10: ["bg-emerald-500", "bg-amber-500"],
  11: ["bg-indigo-500", "bg-amber-500"],
  12: ["bg-amber-500"],
  13: ["bg-amber-500"],
  14: ["bg-cyan-500"],
  15: ["bg-indigo-500"],
};

const today = 7; // Assume "today" is April 7

export default function CalendarView() {
  const cells: (number | null)[] = [];

  // Empty cells before month starts
  for (let i = 0; i < startOffset; i++) {
    cells.push(null);
  }
  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(d);
  }
  // Pad to complete last row
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  return (
    <div className="rounded-xl bg-[#141414] border border-white/5 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">April 2026</h3>
        <button className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors">
          Month <ChevronDown size={12} />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 mb-2">
        {daysOfWeek.map((d) => (
          <div key={d} className="text-center text-[10px] text-gray-500 font-medium py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const isToday = day === today;
          const dots = day ? taskDots[day] || [] : [];
          return (
            <div
              key={i}
              className={\`relative p-1.5 text-center min-h-[40px] border border-white/[0.02] \${
                day ? "hover:bg-[#1e1e1e] cursor-pointer" : ""
              } transition-colors\`}
            >
              {day && (
                <>
                  <span
                    className={\`text-xs \${
                      isToday
                        ? "w-6 h-6 inline-flex items-center justify-center rounded-full bg-indigo-600 text-white font-medium"
                        : "text-gray-400"
                    }\`}
                  >
                    {day}
                  </span>
                  {dots.length > 0 && (
                    <div className="flex justify-center gap-0.5 mt-1">
                      {dots.slice(0, 3).map((color, j) => (
                        <div
                          key={j}
                          className={\`w-1 h-1 rounded-full \${color}\`}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
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
  ];
}
