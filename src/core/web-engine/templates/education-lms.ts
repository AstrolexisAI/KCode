// KCode - Web Engine: Education LMS Template
// Next.js + React + Tailwind — fully machine-generated

import type { FileTemplate } from "../templates";

export function educationLmsComponents(): FileTemplate[] {
  return [
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LearnHub",
  description: "Online Learning Management System",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-[#0a0a0a] text-white">
        {children}
      </body>
    </html>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/app/page.tsx",
      content: `"use client";
import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { CourseGrid } from "@/components/CourseGrid";
import { ProgressDashboard } from "@/components/ProgressDashboard";
import { LeaderBoard } from "@/components/LeaderBoard";

export default function Home() {
  const [activeNav, setActiveNav] = useState("dashboard");

  return (
    <div className="flex h-screen bg-[#0a0a0a]">
      <Sidebar active={activeNav} onNavigate={setActiveNav} />
      <main className="flex-1 overflow-y-auto p-8">
        {activeNav === "dashboard" && (
          <div className="max-w-7xl mx-auto space-y-8">
            <div>
              <h1 className="text-2xl font-bold">Welcome back, Alex!</h1>
              <p className="text-gray-400 mt-1">Continue your learning journey</p>
            </div>
            <ProgressDashboard />
            <div className="grid lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2">
                <h2 className="text-lg font-semibold mb-4">My Courses</h2>
                <CourseGrid />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-4">Leaderboard</h2>
                <LeaderBoard />
              </div>
            </div>
          </div>
        )}
        {activeNav === "courses" && (
          <div className="max-w-7xl mx-auto">
            <h1 className="text-2xl font-bold mb-6">Browse Courses</h1>
            <CourseGrid showFilter />
          </div>
        )}
        {activeNav === "certificates" && (
          <div className="max-w-7xl mx-auto">
            <h1 className="text-2xl font-bold mb-6">My Certificates</h1>
            <div className="grid md:grid-cols-2 gap-6">
              {["React Mastery", "TypeScript Pro"].map((cert, i) => (
                <div key={i} className="p-6 rounded-xl bg-[#141414] border border-white/10">
                  <div className="flex items-center gap-3 mb-3">
                    <svg width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="none" stroke="#3b82f6" strokeWidth="2" /><path d="M14 20l4 4 8-8" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
                    <div>
                      <p className="font-semibold">{cert}</p>
                      <p className="text-xs text-gray-500">Completed March 2026</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/Sidebar.tsx",
      content: `"use client";
import { BookOpen, Play, Award, Clock } from "lucide-react";

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
}

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: Play },
  { id: "courses", label: "My Courses", icon: BookOpen },
  { id: "browse", label: "Browse", icon: Clock },
  { id: "certificates", label: "Certificates", icon: Award },
  { id: "settings", label: "Settings", icon: Clock },
];

export function Sidebar({ active, onNavigate }: SidebarProps) {
  return (
    <aside className="w-64 border-r border-white/10 bg-[#0a0a0a] flex flex-col h-full flex-shrink-0 hidden md:flex">
      <div className="p-6">
        <h1 className="text-xl font-bold">
          <span className="text-blue-500">Learn</span>Hub
        </h1>
      </div>
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={\`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition \${
                active === item.id
                  ? "bg-blue-500/10 text-blue-400 font-medium"
                  : "text-gray-400 hover:bg-white/5 hover:text-white"
              }\`}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="p-4 m-3 rounded-xl bg-gradient-to-br from-blue-600/20 to-purple-600/20 border border-white/10">
        <p className="text-sm font-medium">Upgrade to Pro</p>
        <p className="text-xs text-gray-400 mt-1">Unlock all courses and features</p>
        <button className="mt-3 w-full py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 transition">
          Upgrade Now
        </button>
      </div>
    </aside>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/CourseCard.tsx",
      content: `"use client";
import { Star, Clock, Play } from "lucide-react";

interface Course {
  id: number;
  title: string;
  instructor: string;
  progress: number;
  lessons: number;
  duration: string;
  rating: number;
  gradient: string;
  category: string;
}

interface CourseCardProps {
  course: Course;
}

export function CourseCard({ course }: CourseCardProps) {
  return (
    <div className="rounded-xl bg-[#141414] border border-white/10 overflow-hidden hover:border-white/20 transition group">
      {/* Gradient cover */}
      <div className={\`h-32 bg-gradient-to-br \${course.gradient} relative\`}>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition bg-black/30">
          <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur flex items-center justify-center">
            <Play className="w-5 h-5 text-white ml-0.5" />
          </div>
        </div>
        <span className="absolute top-3 right-3 px-2 py-1 rounded-md bg-black/30 backdrop-blur text-[10px] font-medium">
          {course.category}
        </span>
      </div>

      <div className="p-4">
        <h3 className="font-semibold text-sm leading-tight">{course.title}</h3>
        <p className="text-xs text-gray-500 mt-1">{course.instructor}</p>

        {/* Progress bar */}
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-gray-400">{course.progress}% complete</span>
            <span className="text-gray-500">{course.lessons} lessons</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all"
              style={{ width: \`\${course.progress}%\` }}
            />
          </div>
        </div>

        {/* Meta */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/5">
          <div className="flex items-center gap-1 text-xs text-gray-400">
            <Clock className="w-3 h-3" />
            <span>{course.duration}</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-amber-400">
            <Star className="w-3 h-3 fill-current" />
            <span>{course.rating}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/CourseGrid.tsx",
      content: `"use client";
import { useState } from "react";
import { CourseCard } from "./CourseCard";

const courses = [
  { id: 1, title: "Advanced React Patterns & Performance", instructor: "Sarah Chen", progress: 72, lessons: 24, duration: "8h 30m", rating: 4.9, gradient: "from-blue-600 to-indigo-700", category: "Frontend" },
  { id: 2, title: "TypeScript Mastery: From Zero to Hero", instructor: "Marcus Lee", progress: 45, lessons: 32, duration: "12h 15m", rating: 4.8, gradient: "from-emerald-500 to-teal-700", category: "Language" },
  { id: 3, title: "System Design for Senior Engineers", instructor: "Priya Patel", progress: 18, lessons: 18, duration: "6h 45m", rating: 4.9, gradient: "from-purple-600 to-pink-600", category: "Architecture" },
  { id: 4, title: "Full-Stack Next.js Applications", instructor: "James Kim", progress: 91, lessons: 28, duration: "10h 20m", rating: 4.7, gradient: "from-amber-500 to-orange-600", category: "Frontend" },
  { id: 5, title: "Docker & Kubernetes in Production", instructor: "Alex Rivera", progress: 33, lessons: 20, duration: "7h 10m", rating: 4.6, gradient: "from-cyan-500 to-blue-600", category: "DevOps" },
  { id: 6, title: "GraphQL API Design Fundamentals", instructor: "Olivia Zhang", progress: 60, lessons: 16, duration: "5h 40m", rating: 4.8, gradient: "from-rose-500 to-red-700", category: "Backend" },
];

const categories = ["All", "Frontend", "Backend", "DevOps", "Language", "Architecture"];

interface CourseGridProps {
  showFilter?: boolean;
}

export function CourseGrid({ showFilter }: CourseGridProps) {
  const [filter, setFilter] = useState("All");

  const filtered = filter === "All"
    ? courses
    : courses.filter((c) => c.category === filter);

  return (
    <div>
      {showFilter && (
        <div className="flex items-center gap-2 mb-6 flex-wrap">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={\`px-4 py-1.5 rounded-full text-sm transition \${
                filter === cat
                  ? "bg-blue-600 text-white"
                  : "bg-[#141414] border border-white/10 text-gray-400 hover:text-white"
              }\`}
            >
              {cat}
            </button>
          ))}
        </div>
      )}
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((course) => (
          <CourseCard key={course.id} course={course} />
        ))}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/LessonList.tsx",
      content: `"use client";
import { useState } from "react";
import { Play, CheckCircle, Circle, Clock } from "lucide-react";

interface Lesson {
  id: number;
  title: string;
  duration: string;
  completed: boolean;
}

interface Module {
  id: number;
  title: string;
  lessons: Lesson[];
}

const modules: Module[] = [
  {
    id: 1,
    title: "Getting Started",
    lessons: [
      { id: 1, title: "Course Introduction", duration: "5:30", completed: true },
      { id: 2, title: "Setting Up Your Environment", duration: "12:15", completed: true },
      { id: 3, title: "Understanding the Basics", duration: "18:40", completed: true },
    ],
  },
  {
    id: 2,
    title: "Core Concepts",
    lessons: [
      { id: 4, title: "Component Architecture", duration: "22:10", completed: true },
      { id: 5, title: "State Management Patterns", duration: "25:30", completed: false },
      { id: 6, title: "Performance Optimization", duration: "19:45", completed: false },
      { id: 7, title: "Testing Strategies", duration: "16:20", completed: false },
    ],
  },
  {
    id: 3,
    title: "Advanced Topics",
    lessons: [
      { id: 8, title: "Server Components Deep Dive", duration: "28:15", completed: false },
      { id: 9, title: "Streaming & Suspense", duration: "21:50", completed: false },
      { id: 10, title: "Production Deployment", duration: "15:30", completed: false },
    ],
  },
];

export function LessonList() {
  const [expandedModules, setExpandedModules] = useState<number[]>([1, 2]);

  function toggleModule(id: number) {
    setExpandedModules((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  }

  return (
    <div className="space-y-3">
      {modules.map((mod) => {
        const completed = mod.lessons.filter((l) => l.completed).length;
        const expanded = expandedModules.includes(mod.id);

        return (
          <div key={mod.id} className="rounded-xl bg-[#141414] border border-white/10 overflow-hidden">
            <button
              onClick={() => toggleModule(mod.id)}
              className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition text-left"
            >
              <div>
                <p className="font-medium text-sm">{mod.title}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {completed}/{mod.lessons.length} lessons complete
                </p>
              </div>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                className={\`text-gray-400 transition-transform \${expanded ? "rotate-180" : ""}\`}
              >
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>

            {expanded && (
              <div className="border-t border-white/5">
                {mod.lessons.map((lesson) => (
                  <div
                    key={lesson.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition cursor-pointer"
                  >
                    {lesson.completed ? (
                      <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                    ) : (
                      <Circle className="w-4 h-4 text-gray-600 flex-shrink-0" />
                    )}
                    <Play className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                    <span className={\`flex-1 text-sm \${lesson.completed ? "text-gray-400" : "text-gray-200"}\`}>
                      {lesson.title}
                    </span>
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      <Clock className="w-3 h-3" />
                      {lesson.duration}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/ProgressDashboard.tsx",
      content: `"use client";
import { BookOpen, Clock, Award, Star } from "lucide-react";

const stats = [
  { label: "Courses Enrolled", value: "6", icon: BookOpen, color: "text-blue-400" },
  { label: "Hours Spent", value: "48.5", icon: Clock, color: "text-emerald-400" },
  { label: "Certificates", value: "2", icon: Award, color: "text-amber-400" },
  { label: "Avg. Rating", value: "4.8", icon: Star, color: "text-purple-400" },
];

function ProgressRing({ progress }: { progress: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (progress / 100) * circumference;

  return (
    <div className="relative w-36 h-36">
      <svg width="144" height="144" viewBox="0 0 144 144" className="-rotate-90">
        <circle
          cx="72"
          cy="72"
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.05)"
          strokeWidth="10"
        />
        <circle
          cx="72"
          cy="72"
          r={radius}
          fill="none"
          stroke="url(#progressGradient)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-1000"
        />
        <defs>
          <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold">{progress}%</span>
        <span className="text-xs text-gray-500">Overall</span>
      </div>
    </div>
  );
}

export function ProgressDashboard() {
  return (
    <div className="rounded-xl bg-[#141414] border border-white/10 p-6">
      <div className="flex flex-col md:flex-row items-center gap-8">
        <ProgressRing progress={53} />
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-4 w-full">
          {stats.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <div key={i} className="p-4 rounded-xl bg-[#0a0a0a] border border-white/5 text-center">
                <Icon className={\`w-5 h-5 mx-auto mb-2 \${stat.color}\`} />
                <p className="text-2xl font-bold">{stat.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{stat.label}</p>
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
    {
      path: "src/components/LeaderBoard.tsx",
      content: `"use client";
import { Trophy } from "lucide-react";

const students = [
  { rank: 1, name: "Maya Johnson", xp: 12450, streak: 32, avatar: "MJ", gradient: "from-amber-400 to-yellow-600" },
  { rank: 2, name: "Alex Rivera", xp: 11280, streak: 28, avatar: "AR", gradient: "from-gray-300 to-gray-500" },
  { rank: 3, name: "Jordan Lee", xp: 10870, streak: 21, avatar: "JL", gradient: "from-amber-600 to-orange-800" },
  { rank: 4, name: "Sam Patel", xp: 9540, streak: 15, avatar: "SP", gradient: "from-blue-400 to-indigo-600" },
  { rank: 5, name: "Chris Kim", xp: 8920, streak: 12, avatar: "CK", gradient: "from-emerald-400 to-teal-600" },
];

const rankColors: Record<number, string> = {
  1: "text-amber-400",
  2: "text-gray-300",
  3: "text-amber-600",
};

export function LeaderBoard() {
  return (
    <div className="rounded-xl bg-[#141414] border border-white/10 overflow-hidden">
      <div className="p-4 border-b border-white/5 flex items-center gap-2">
        <Trophy className="w-4 h-4 text-amber-400" />
        <span className="text-sm font-semibold">This Week</span>
      </div>
      <div>
        {students.map((student) => (
          <div
            key={student.rank}
            className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition"
          >
            <span className={\`w-6 text-center text-sm font-bold \${rankColors[student.rank] ?? "text-gray-500"}\`}>
              {student.rank}
            </span>
            <div className={\`w-8 h-8 rounded-full bg-gradient-to-br \${student.gradient} flex items-center justify-center text-xs font-semibold flex-shrink-0\`}>
              {student.avatar}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{student.name}</p>
              <p className="text-xs text-gray-500">{student.streak} day streak</p>
            </div>
            <span className="text-sm font-semibold text-blue-400">{student.xp} XP</span>
          </div>
        ))}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
  ];
}
