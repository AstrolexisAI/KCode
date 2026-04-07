// KCode - Web Engine: Social Media Feed Template
//
// Complete Next.js + React + Tailwind social media feed.
// All components are fully machine-generated (needsLlm: false).

import type { FileTemplate } from "../templates";

export function socialFeedComponents(): FileTemplate[] {
  return [
    // ── Root Layout ─────────────────────────────────────────────
    {
      path: "src/app/layout.tsx",
      content: `"use client";
import { useState, createContext, useContext, type ReactNode } from "react";
import "./globals.css";

interface ThemeContextValue {
  dark: boolean;
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  dark: false,
  toggle: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export default function RootLayout({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(false);

  return (
    <html lang="en" className={dark ? "dark" : ""}>
      <body className="antialiased bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 min-h-screen transition-colors">
        <ThemeContext.Provider value={{ dark, toggle: () => setDark(d => !d) }}>
          {children}
        </ThemeContext.Provider>
      </body>
    </html>
  );
}
`,
      needsLlm: false,
    },
    // ── Global CSS ──────────────────────────────────────────────
    {
      path: "src/app/globals.css",
      content: `@import "tailwindcss";

@layer utilities {
  .scrollbar-hide {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
  .avatar-ring {
    background: linear-gradient(135deg, #f59e0b, #ec4899, #8b5cf6);
    padding: 2px;
  }
}
`,
      needsLlm: false,
    },
    // ── Feed Homepage ───────────────────────────────────────────
    {
      path: "src/app/page.tsx",
      content: `"use client";
import LeftSidebar from "@/components/LeftSidebar";
import RightSidebar from "@/components/RightSidebar";
import StoryBar from "@/components/StoryBar";
import CreatePost from "@/components/CreatePost";
import Feed from "@/components/Feed";

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-7xl mx-auto flex">
        {/* Left Sidebar */}
        <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen overflow-y-auto p-4">
          <LeftSidebar />
        </aside>

        {/* Center Feed */}
        <main className="flex-1 min-w-0 max-w-2xl mx-auto px-4 py-6 space-y-6">
          <StoryBar />
          <CreatePost />
          <Feed />
        </main>

        {/* Right Sidebar */}
        <aside className="hidden xl:block w-80 shrink-0 sticky top-0 h-screen overflow-y-auto p-4">
          <RightSidebar />
        </aside>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── LeftSidebar ─────────────────────────────────────────────
    {
      path: "src/components/LeftSidebar.tsx",
      content: `"use client";
import { Home, Search, Bell, MessageCircle, Bookmark, User, Settings, Sun, Moon } from "lucide-react";
import { useTheme } from "@/app/layout";
import ProfileCard from "./ProfileCard";

const NAV_ITEMS = [
  { icon: Home, label: "Home", active: true },
  { icon: Search, label: "Explore", active: false },
  { icon: Bell, label: "Notifications", active: false },
  { icon: MessageCircle, label: "Messages", active: false },
  { icon: Bookmark, label: "Bookmarks", active: false },
  { icon: User, label: "Profile", active: false },
  { icon: Settings, label: "Settings", active: false },
];

export default function LeftSidebar() {
  const { dark, toggle } = useTheme();

  return (
    <div className="space-y-6">
      {/* Logo */}
      <div className="px-3 py-2">
        <h1 className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">SocialK</h1>
      </div>

      {/* Navigation */}
      <nav className="space-y-1">
        {NAV_ITEMS.map(({ icon: Icon, label, active }) => (
          <button
            key={label}
            className={\`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors \${
              active
                ? "bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-900"
            }\`}
          >
            <Icon className="w-5 h-5" />
            {label}
            {label === "Notifications" && (
              <span className="ml-auto w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                3
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Dark mode toggle */}
      <button
        onClick={toggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
      >
        {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        {dark ? "Light Mode" : "Dark Mode"}
      </button>

      {/* Profile card */}
      <ProfileCard />
    </div>
  );
}

`,
      needsLlm: false,
    },
    // ── ProfileCard ─────────────────────────────────────────────
    {
      path: "src/components/ProfileCard.tsx",
      content: `export default function ProfileCard() {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-4">
      <div className="flex items-center gap-3">
        <div className="avatar-ring rounded-full">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm">
            AJ
          </div>
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-sm truncate">Alex Johnson</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">@alexjohnson</p>
        </div>
      </div>
      <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        Full-stack developer. Building cool stuff.
      </div>
      <div className="mt-3 flex gap-4 text-xs">
        <div>
          <span className="font-bold text-gray-900 dark:text-white">1,234</span>
          <span className="text-gray-500 dark:text-gray-400 ml-1">Followers</span>
        </div>
        <div>
          <span className="font-bold text-gray-900 dark:text-white">567</span>
          <span className="text-gray-500 dark:text-gray-400 ml-1">Following</span>
        </div>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── RightSidebar ────────────────────────────────────────────
    {
      path: "src/components/RightSidebar.tsx",
      content: `"use client";
import { TrendingUp, ArrowUpRight } from "lucide-react";
import { useState } from "react";

const TRENDING = [
  { tag: "#WebDev", posts: "12.4K", category: "Technology" },
  { tag: "#DesignSystem", posts: "8.2K", category: "Design" },
  { tag: "#OpenSource", posts: "6.7K", category: "Technology" },
  { tag: "#ProductHunt", posts: "5.1K", category: "Startup" },
  { tag: "#RemoteWork", posts: "4.3K", category: "Lifestyle" },
];

const SUGGESTED = [
  { name: "Sarah Chen", handle: "@sarahchen", bio: "UX Designer at Figma", initials: "SC", gradient: "from-pink-500 to-rose-600" },
  { name: "Marcus Rivera", handle: "@marcusdev", bio: "React & TypeScript", initials: "MR", gradient: "from-cyan-500 to-blue-600" },
  { name: "Priya Patel", handle: "@priyapatel", bio: "AI Researcher", initials: "PP", gradient: "from-violet-500 to-purple-600" },
];

export default function RightSidebar() {
  return (
    <div className="space-y-6 py-6">
      {/* Trending */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-4">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h3 className="font-semibold">Trending</h3>
        </div>
        <div className="space-y-3">
          {TRENDING.map(item => (
            <button key={item.tag} className="w-full text-left group">
              <p className="text-xs text-gray-500 dark:text-gray-400">{item.category}</p>
              <p className="font-semibold text-sm group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors flex items-center gap-1">
                {item.tag}
                <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{item.posts} posts</p>
            </button>
          ))}
        </div>
      </div>

      {/* Suggested Users */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-4">
        <h3 className="font-semibold mb-4">Suggested for You</h3>
        <div className="space-y-3">
          {SUGGESTED.map(user => (
            <SuggestedUser key={user.handle} user={user} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SuggestedUser({ user }: { user: typeof SUGGESTED[number] }) {
  const [followed, setFollowed] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <div className={\`w-10 h-10 rounded-full bg-gradient-to-br \${user.gradient} flex items-center justify-center text-white text-xs font-bold shrink-0\`}>
        {user.initials}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm truncate">{user.name}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.bio}</p>
      </div>
      <button
        onClick={() => setFollowed(!followed)}
        className={\`shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-all \${
          followed
            ? "bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
            : "bg-indigo-600 text-white hover:bg-indigo-700"
        }\`}
      >
        {followed ? "Following" : "Follow"}
      </button>
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── StoryBar ────────────────────────────────────────────────
    {
      path: "src/components/StoryBar.tsx",
      content: `"use client";
import { Plus } from "lucide-react";

const STORIES = [
  { name: "Your Story", initials: "+", gradient: "from-gray-300 to-gray-400", isAdd: true },
  { name: "Emma", initials: "EW", gradient: "from-pink-500 to-rose-600", isAdd: false },
  { name: "Liam", initials: "LK", gradient: "from-orange-500 to-amber-600", isAdd: false },
  { name: "Olivia", initials: "OM", gradient: "from-emerald-500 to-green-600", isAdd: false },
  { name: "Noah", initials: "NB", gradient: "from-cyan-500 to-blue-600", isAdd: false },
  { name: "Ava", initials: "AT", gradient: "from-violet-500 to-purple-600", isAdd: false },
  { name: "James", initials: "JR", gradient: "from-red-500 to-pink-600", isAdd: false },
  { name: "Sophia", initials: "SL", gradient: "from-indigo-500 to-blue-600", isAdd: false },
];

export default function StoryBar() {
  return (
    <div className="flex gap-4 overflow-x-auto scrollbar-hide py-1">
      {STORIES.map((story, i) => (
        <button key={i} className="flex flex-col items-center gap-1.5 shrink-0">
          <div className={story.isAdd ? "" : "avatar-ring rounded-full"}>
            <div className={\`w-14 h-14 rounded-full bg-gradient-to-br \${story.gradient} flex items-center justify-center text-white font-bold text-sm \${
              story.isAdd ? "border-2 border-dashed border-gray-300 dark:border-gray-700 !bg-none bg-gray-100 dark:bg-gray-900" : ""
            }\`}>
              {story.isAdd ? (
                <Plus className="w-5 h-5 text-gray-500 dark:text-gray-400" />
              ) : (
                story.initials
              )}
            </div>
          </div>
          <span className="text-xs text-gray-600 dark:text-gray-400 max-w-[60px] truncate">
            {story.name}
          </span>
        </button>
      ))}
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── CreatePost ──────────────────────────────────────────────
    {
      path: "src/components/CreatePost.tsx",
      content: `"use client";
import { Image, Smile, BarChart3 } from "lucide-react";
import { useState } from "react";

export default function CreatePost() {
  const [text, setText] = useState("");

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-4">
      <div className="flex gap-3">
        <div className="avatar-ring rounded-full shrink-0">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm">
            AJ
          </div>
        </div>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="What's on your mind?"
          rows={2}
          className="flex-1 resize-none bg-transparent text-sm placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none py-2"
        />
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-gray-100 dark:border-gray-800 pt-3">
        <div className="flex gap-1">
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition">
            <Image className="w-4 h-4 text-emerald-500" />
            <span className="hidden sm:inline">Photo</span>
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition">
            <Smile className="w-4 h-4 text-amber-500" />
            <span className="hidden sm:inline">Emoji</span>
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition">
            <BarChart3 className="w-4 h-4 text-indigo-500" />
            <span className="hidden sm:inline">Poll</span>
          </button>
        </div>
        <button
          disabled={!text.trim()}
          className={\`px-5 py-1.5 rounded-full text-sm font-semibold transition-all \${
            text.trim()
              ? "bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95"
              : "bg-indigo-200 dark:bg-indigo-900 text-indigo-400 dark:text-indigo-600 cursor-not-allowed"
          }\`}
        >
          Post
        </button>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── Feed ────────────────────────────────────────────────────
    {
      path: "src/components/Feed.tsx",
      content: `import PostCard from "./PostCard";

const POSTS = [
  {
    id: 1,
    author: "Sarah Chen",
    handle: "@sarahchen",
    initials: "SC",
    gradient: "from-pink-500 to-rose-600",
    time: "2h",
    content: "Just shipped a new design system with 50+ components. Took 3 months but it was worth every iteration. Open source link coming soon!",
    hasImage: true,
    imageGradient: "from-pink-400 via-purple-400 to-indigo-400",
    likes: 234,
    comments: 45,
    shares: 12,
  },
  {
    id: 2,
    author: "Marcus Rivera",
    handle: "@marcusdev",
    initials: "MR",
    gradient: "from-cyan-500 to-blue-600",
    time: "4h",
    content: "Hot take: TypeScript's type system is Turing complete and we should be writing more type-level programs. Here's a type-safe SQL query builder I made this weekend.",
    hasImage: false,
    imageGradient: "",
    likes: 567,
    comments: 89,
    shares: 34,
  },
  {
    id: 3,
    author: "Priya Patel",
    handle: "@priyapatel",
    initials: "PP",
    gradient: "from-violet-500 to-purple-600",
    time: "5h",
    content: "Our new paper on efficient attention mechanisms just got accepted! Reduces memory usage by 40% while maintaining quality. Preprint dropping tomorrow.",
    hasImage: true,
    imageGradient: "from-violet-400 via-blue-400 to-cyan-400",
    likes: 892,
    comments: 156,
    shares: 78,
  },
  {
    id: 4,
    author: "Emma Watson",
    handle: "@emmawatson",
    initials: "EW",
    gradient: "from-orange-500 to-amber-600",
    time: "6h",
    content: "Morning coffee + code review = perfect start to the day. Found 3 bugs before they hit production. Always review your own PRs first!",
    hasImage: false,
    imageGradient: "",
    likes: 123,
    comments: 18,
    shares: 5,
  },
  {
    id: 5,
    author: "Liam Kim",
    handle: "@liamkim",
    initials: "LK",
    gradient: "from-emerald-500 to-green-600",
    time: "8h",
    content: "Built a real-time collaborative editor this weekend using CRDTs. No server needed for conflict resolution. The future of local-first is here.",
    hasImage: true,
    imageGradient: "from-emerald-400 via-teal-400 to-cyan-400",
    likes: 445,
    comments: 67,
    shares: 23,
  },
  {
    id: 6,
    author: "Olivia Martinez",
    handle: "@oliviam",
    initials: "OM",
    gradient: "from-red-500 to-pink-600",
    time: "10h",
    content: "Reminder: your side project doesn't need to be a startup. It's okay to build things just because they're fun. I made a pixel art editor for my cat photos.",
    hasImage: false,
    imageGradient: "",
    likes: 1024,
    comments: 201,
    shares: 89,
  },
  {
    id: 7,
    author: "Noah Brown",
    handle: "@noahb",
    initials: "NB",
    gradient: "from-sky-500 to-indigo-600",
    time: "12h",
    content: "Just hit 100 days of open source contributions. Not about the streak, but about the communities I've been part of. Grateful for every code review.",
    hasImage: false,
    imageGradient: "",
    likes: 678,
    comments: 92,
    shares: 41,
  },
  {
    id: 8,
    author: "Ava Thompson",
    handle: "@avathompson",
    initials: "AT",
    gradient: "from-fuchsia-500 to-purple-600",
    time: "14h",
    content: "Learning Rust has completely changed how I think about memory management. Even my JavaScript is better now. 10/10 would recommend.",
    hasImage: true,
    imageGradient: "from-fuchsia-400 via-pink-400 to-rose-400",
    likes: 356,
    comments: 78,
    shares: 19,
  },
  {
    id: 9,
    author: "James Rodriguez",
    handle: "@jamesrod",
    initials: "JR",
    gradient: "from-amber-500 to-orange-600",
    time: "16h",
    content: "Deployed our app to 12 regions worldwide. Latency went from 200ms to 30ms for most users. Edge computing is not a buzzword, it's a game changer.",
    hasImage: false,
    imageGradient: "",
    likes: 789,
    comments: 134,
    shares: 56,
  },
  {
    id: 10,
    author: "Sophia Lee",
    handle: "@sophialee",
    initials: "SL",
    gradient: "from-lime-500 to-emerald-600",
    time: "18h",
    content: "Taught my first workshop today! 30 beginners built their first React app in 2 hours. The excitement in the room was electric. Teaching > everything.",
    hasImage: true,
    imageGradient: "from-lime-400 via-green-400 to-emerald-400",
    likes: 543,
    comments: 87,
    shares: 32,
  },
];

export default function Feed() {
  return (
    <div className="space-y-4">
      {POSTS.map(post => (
        <PostCard key={post.id} post={post} />
      ))}
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── PostCard ─────────────────────────────────────────────────
    {
      path: "src/components/PostCard.tsx",
      content: `"use client";
import { Heart, MessageCircle, Share2, Bookmark, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import CommentSection from "./CommentSection";

interface Post {
  id: number;
  author: string;
  handle: string;
  initials: string;
  gradient: string;
  time: string;
  content: string;
  hasImage: boolean;
  imageGradient: string;
  likes: number;
  comments: number;
  shares: number;
}

export default function PostCard({ post }: { post: Post }) {
  const [liked, setLiked] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const [likeCount, setLikeCount] = useState(post.likes);
  const [showComments, setShowComments] = useState(false);

  const handleLike = () => {
    setLiked(!liked);
    setLikeCount(c => liked ? c - 1 : c + 1);
  };

  return (
    <article className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <div className="p-4">
        {/* Author row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="avatar-ring rounded-full">
              <div className={\`w-10 h-10 rounded-full bg-gradient-to-br \${post.gradient} flex items-center justify-center text-white font-bold text-xs\`}>
                {post.initials}
              </div>
            </div>
            <div>
              <p className="font-semibold text-sm">{post.author}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {post.handle} · {post.time}
              </p>
            </div>
          </div>
          <button className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition">
            <MoreHorizontal className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <p className="mt-3 text-sm leading-relaxed">{post.content}</p>
      </div>

      {/* Image placeholder */}
      {post.hasImage && (
        <div className={\`h-64 bg-gradient-to-br \${post.imageGradient} mx-4 rounded-xl\`} />
      )}

      {/* Action bar */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            <button
              onClick={handleLike}
              className={\`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors \${
                liked
                  ? "text-red-500 bg-red-50 dark:bg-red-950"
                  : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
              }\`}
            >
              <Heart className="w-4 h-4" fill={liked ? "currentColor" : "none"} />
              <span className="text-xs font-medium">{likeCount}</span>
            </button>
            <button
              onClick={() => setShowComments(!showComments)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <MessageCircle className="w-4 h-4" />
              <span className="text-xs font-medium">{post.comments}</span>
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
              <Share2 className="w-4 h-4" />
              <span className="text-xs font-medium">{post.shares}</span>
            </button>
          </div>
          <button
            onClick={() => setBookmarked(!bookmarked)}
            className={\`p-2 rounded-lg transition-colors \${
              bookmarked
                ? "text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950"
                : "text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            }\`}
          >
            <Bookmark className="w-4 h-4" fill={bookmarked ? "currentColor" : "none"} />
          </button>
        </div>
      </div>

      {/* Comment section */}
      {showComments && <CommentSection postId={post.id} />}
    </article>
  );
}
`,
      needsLlm: false,
    },
    // ── CommentSection ──────────────────────────────────────────
    {
      path: "src/components/CommentSection.tsx",
      content: `"use client";
import { useState } from "react";
import { Heart } from "lucide-react";

const SAMPLE_COMMENTS: Record<number, { author: string; initials: string; gradient: string; text: string; time: string; likes: number }[]> = {
  1: [
    { author: "Liam Kim", initials: "LK", gradient: "from-emerald-500 to-green-600", text: "This is amazing! Can't wait to try it out.", time: "1h", likes: 12 },
    { author: "Noah Brown", initials: "NB", gradient: "from-sky-500 to-indigo-600", text: "50 components is impressive. What's the bundle size?", time: "45m", likes: 8 },
  ],
  2: [
    { author: "Ava Thompson", initials: "AT", gradient: "from-fuchsia-500 to-purple-600", text: "I've been doing this! Type-level programming is underrated.", time: "3h", likes: 23 },
  ],
  3: [
    { author: "Marcus Rivera", initials: "MR", gradient: "from-cyan-500 to-blue-600", text: "Congratulations! The results look very promising.", time: "4h", likes: 15 },
    { author: "Sarah Chen", initials: "SC", gradient: "from-pink-500 to-rose-600", text: "40% reduction is huge. Will it work with Flash Attention?", time: "3h", likes: 9 },
    { author: "James Rodriguez", initials: "JR", gradient: "from-amber-500 to-orange-600", text: "Can't wait to read the paper!", time: "2h", likes: 5 },
  ],
};

export default function CommentSection({ postId }: { postId: number }) {
  const [reply, setReply] = useState("");
  const comments = SAMPLE_COMMENTS[postId] || [];

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 px-4 pb-4">
      {/* Existing comments */}
      <div className="space-y-3 pt-3">
        {comments.map((comment, i) => (
          <div key={i} className="flex gap-2.5">
            <div className={\`w-8 h-8 rounded-full bg-gradient-to-br \${comment.gradient} flex items-center justify-center text-white text-xs font-bold shrink-0\`}>
              {comment.initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl px-3 py-2">
                <p className="text-xs font-semibold">{comment.author}</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5">{comment.text}</p>
              </div>
              <div className="flex items-center gap-3 mt-1 px-1">
                <span className="text-xs text-gray-400">{comment.time}</span>
                <button className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 font-medium">
                  Reply
                </button>
                <button className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition">
                  <Heart className="w-3 h-3" />
                  {comment.likes}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Reply input */}
      <div className="flex gap-2.5 mt-3">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
          AJ
        </div>
        <div className="flex-1 flex gap-2">
          <input
            type="text"
            value={reply}
            onChange={e => setReply(e.target.value)}
            placeholder="Write a reply..."
            className="flex-1 bg-gray-50 dark:bg-gray-800 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition"
          />
          {reply.trim() && (
            <button
              onClick={() => setReply("")}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-full hover:bg-indigo-700 transition"
            >
              Reply
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
  ];
}
