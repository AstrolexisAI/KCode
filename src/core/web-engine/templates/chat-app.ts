// KCode - Web Engine: Chat/Messaging App Template
// Next.js + React + Tailwind — fully machine-generated

import type { FileTemplate } from "../templates";

export function chatAppComponents(): FileTemplate[] {
  return [
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChatApp",
  description: "Real-time messaging application",
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
import { ContactList } from "@/components/ContactList";
import { ChatWindow } from "@/components/ChatWindow";
import { ContactDetails } from "@/components/ContactDetails";

const contacts = [
  { id: 1, name: "Elena Rodriguez", avatar: "ER", status: "online" as const, lastMessage: "Sure, I'll send the designs over!", time: "2m ago", unread: 3 },
  { id: 2, name: "Marcus Chen", avatar: "MC", status: "online" as const, lastMessage: "The API integration is done", time: "15m ago", unread: 0 },
  { id: 3, name: "Sarah Williams", avatar: "SW", status: "offline" as const, lastMessage: "Let's schedule the meeting for Thursday", time: "1h ago", unread: 1 },
  { id: 4, name: "James Foster", avatar: "JF", status: "online" as const, lastMessage: "Thanks for the quick review!", time: "2h ago", unread: 0 },
  { id: 5, name: "Priya Sharma", avatar: "PS", status: "away" as const, lastMessage: "I've pushed the latest changes", time: "3h ago", unread: 5 },
  { id: 6, name: "David Kim", avatar: "DK", status: "offline" as const, lastMessage: "Can you check the staging server?", time: "5h ago", unread: 0 },
  { id: 7, name: "Olivia Brown", avatar: "OB", status: "online" as const, lastMessage: "The presentation looks great!", time: "1d ago", unread: 0 },
  { id: 8, name: "Team Frontend", avatar: "TF", status: "online" as const, lastMessage: "Alex: Merged the PR just now", time: "1d ago", unread: 2 },
];

export default function Home() {
  const [selectedId, setSelectedId] = useState(1);
  const [showDetails, setShowDetails] = useState(false);
  const selected = contacts.find((c) => c.id === selectedId) ?? contacts[0];

  return (
    <main className="flex h-screen bg-[#0a0a0a]">
      {/* Contacts sidebar */}
      <div className="w-80 border-r border-white/10 flex-shrink-0 hidden md:block">
        <ContactList
          contacts={contacts}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        <ChatWindow
          contact={selected}
          onToggleDetails={() => setShowDetails(!showDetails)}
        />
      </div>

      {/* Details panel */}
      {showDetails && (
        <div className="w-80 border-l border-white/10 flex-shrink-0 hidden lg:block">
          <ContactDetails contact={selected} />
        </div>
      )}
    </main>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/OnlineStatus.tsx",
      content: `"use client";

interface OnlineStatusProps {
  status: "online" | "offline" | "away";
  size?: "sm" | "md";
}

export function OnlineStatus({ status, size = "sm" }: OnlineStatusProps) {
  const colors = {
    online: "bg-green-500",
    away: "bg-yellow-500",
    offline: "bg-gray-500",
  };
  const sizes = {
    sm: "w-2.5 h-2.5",
    md: "w-3.5 h-3.5",
  };

  return (
    <span
      className={\`inline-block rounded-full \${colors[status]} \${sizes[size]} ring-2 ring-[#0a0a0a]\`}
    />
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/ContactList.tsx",
      content: `"use client";
import { Search } from "lucide-react";
import { OnlineStatus } from "./OnlineStatus";
import { useState } from "react";

interface Contact {
  id: number;
  name: string;
  avatar: string;
  status: "online" | "offline" | "away";
  lastMessage: string;
  time: string;
  unread: number;
}

interface ContactListProps {
  contacts: Contact[];
  selectedId: number;
  onSelect: (id: number) => void;
}

export function ContactList({ contacts, selectedId, onSelect }: ContactListProps) {
  const [search, setSearch] = useState("");

  const filtered = contacts.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* Header */}
      <div className="p-4 border-b border-white/10">
        <h1 className="text-xl font-bold mb-3">Messages</h1>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search conversations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg bg-[#141414] border border-white/10 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500/50"
          />
        </div>
      </div>

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map((contact) => (
          <button
            key={contact.id}
            onClick={() => onSelect(contact.id)}
            className={\`w-full flex items-center gap-3 p-4 hover:bg-white/5 transition-colors text-left \${
              selectedId === contact.id ? "bg-white/10" : ""
            }\`}
          >
            {/* Avatar */}
            <div className="relative flex-shrink-0">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm font-semibold">
                {contact.avatar}
              </div>
              <div className="absolute -bottom-0.5 -right-0.5">
                <OnlineStatus status={contact.status} />
              </div>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm truncate">{contact.name}</span>
                <span className="text-xs text-gray-500 flex-shrink-0 ml-2">{contact.time}</span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <p className="text-sm text-gray-400 truncate">{contact.lastMessage}</p>
                {contact.unread > 0 && (
                  <span className="ml-2 flex-shrink-0 w-5 h-5 rounded-full bg-blue-500 text-[11px] font-bold flex items-center justify-center">
                    {contact.unread}
                  </span>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/ChatWindow.tsx",
      content: `"use client";
import { Phone, Video, MoreVertical } from "lucide-react";
import { OnlineStatus } from "./OnlineStatus";
import { MessageInput } from "./MessageInput";

interface Contact {
  id: number;
  name: string;
  avatar: string;
  status: "online" | "offline" | "away";
  lastMessage: string;
  time: string;
  unread: number;
}

interface ChatWindowProps {
  contact: Contact;
  onToggleDetails: () => void;
}

interface Message {
  id: number;
  text: string;
  sent: boolean;
  time: string;
  read: boolean;
}

const messages: Message[] = [
  { id: 1, text: "Hey! How\\'s the new dashboard design coming along?", sent: true, time: "10:02 AM", read: true },
  { id: 2, text: "Hi! It\\'s going really well. I finished the wireframes yesterday.", sent: false, time: "10:05 AM", read: true },
  { id: 3, text: "That\\'s awesome! Can you share them with me?", sent: true, time: "10:06 AM", read: true },
  { id: 4, text: "Sure! Let me grab the Figma link real quick.", sent: false, time: "10:07 AM", read: true },
  { id: 5, text: "I also added the dark mode variants you requested.", sent: false, time: "10:08 AM", read: true },
  { id: 6, text: "Oh perfect, that was on my list to ask about!", sent: true, time: "10:10 AM", read: true },
  { id: 7, text: "The color palette uses the tokens we defined last sprint. Let me know if the contrast ratios look good on your end.", sent: false, time: "10:12 AM", read: true },
  { id: 8, text: "Will do. Did you also update the mobile breakpoints?", sent: true, time: "10:15 AM", read: true },
  { id: 9, text: "Yes! Mobile, tablet, and desktop are all covered. I followed the responsive grid we agreed on.", sent: false, time: "10:16 AM", read: true },
  { id: 10, text: "Great work. The client is going to love this.", sent: true, time: "10:18 AM", read: true },
  { id: 11, text: "I hope so! I spent extra time on the micro-interactions.", sent: false, time: "10:20 AM", read: true },
  { id: 12, text: "Those small details make all the difference. When can we do a review session?", sent: true, time: "10:22 AM", read: true },
  { id: 13, text: "How about tomorrow at 2 PM? I\\'ll have the prototype ready by then.", sent: false, time: "10:24 AM", read: true },
  { id: 14, text: "Works for me! I\\'ll set up the calendar invite.", sent: true, time: "10:25 AM", read: true },
  { id: 15, text: "Sure, I\\'ll send the designs over!", sent: false, time: "10:26 AM", read: false },
];

function ReadReceipt({ read }: { read: boolean }) {
  return (
    <span className="text-[10px] ml-1">
      {read ? (
        <svg width="16" height="10" viewBox="0 0 16 10" fill="none" className="inline">
          <path d="M1 5l3 3L10 1" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6 5l3 3L15 1" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="12" height="10" viewBox="0 0 12 10" fill="none" className="inline">
          <path d="M1 5l3 3L10 1" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

export function ChatWindow({ contact, onToggleDetails }: ChatWindowProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#0a0a0a]">
        <button onClick={onToggleDetails} className="flex items-center gap-3 hover:opacity-80 transition">
          <div className="relative">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm font-semibold">
              {contact.avatar}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5">
              <OnlineStatus status={contact.status} />
            </div>
          </div>
          <div>
            <p className="font-semibold text-sm">{contact.name}</p>
            <p className="text-xs text-gray-400">
              {contact.status === "online" ? "Online" : contact.status === "away" ? "Away" : "Last seen 2h ago"}
            </p>
          </div>
        </button>
        <div className="flex items-center gap-1">
          <button className="p-2 rounded-lg hover:bg-white/10 transition text-gray-400 hover:text-white">
            <Phone className="w-5 h-5" />
          </button>
          <button className="p-2 rounded-lg hover:bg-white/10 transition text-gray-400 hover:text-white">
            <Video className="w-5 h-5" />
          </button>
          <button className="p-2 rounded-lg hover:bg-white/10 transition text-gray-400 hover:text-white">
            <MoreVertical className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-[#0a0a0a]">
        {messages.map((msg) => (
          <div key={msg.id} className={\`flex \${msg.sent ? "justify-end" : "justify-start"}\`}>
            <div
              className={\`max-w-[70%] px-4 py-2.5 rounded-2xl \${
                msg.sent
                  ? "bg-blue-600 text-white rounded-br-md"
                  : "bg-[#141414] text-gray-200 rounded-bl-md border border-white/5"
              }\`}
            >
              <p className="text-sm leading-relaxed">{msg.text}</p>
              <div className={\`flex items-center justify-end gap-1 mt-1 \${msg.sent ? "text-blue-200" : "text-gray-500"}\`}>
                <span className="text-[10px]">{msg.time}</span>
                {msg.sent && <ReadReceipt read={msg.read} />}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <MessageInput />
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/MessageInput.tsx",
      content: `"use client";
import { useState } from "react";
import { Send, Paperclip, Smile } from "lucide-react";

export function MessageInput() {
  const [message, setMessage] = useState("");

  function handleSend() {
    if (!message.trim()) return;
    setMessage("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="px-6 py-4 border-t border-white/10 bg-[#0a0a0a]">
      <div className="flex items-end gap-3">
        <button className="p-2 rounded-lg hover:bg-white/10 transition text-gray-400 hover:text-white flex-shrink-0">
          <Paperclip className="w-5 h-5" />
        </button>
        <div className="flex-1 relative">
          <textarea
            rows={1}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="w-full px-4 py-3 pr-12 rounded-xl bg-[#141414] border border-white/10 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500/50"
          />
          <button className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg hover:bg-white/10 transition text-gray-400 hover:text-white">
            <Smile className="w-5 h-5" />
          </button>
        </div>
        <button
          onClick={handleSend}
          disabled={!message.trim()}
          className="p-3 rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/ContactDetails.tsx",
      content: `"use client";
import { Image, File } from "lucide-react";
import { OnlineStatus } from "./OnlineStatus";

interface Contact {
  id: number;
  name: string;
  avatar: string;
  status: "online" | "offline" | "away";
  lastMessage: string;
  time: string;
  unread: number;
}

interface ContactDetailsProps {
  contact: Contact;
}

const sharedFiles = [
  { name: "dashboard-wireframe.fig", size: "2.4 MB", date: "Today" },
  { name: "brand-guidelines.pdf", size: "8.1 MB", date: "Yesterday" },
  { name: "api-endpoints.md", size: "12 KB", date: "Mar 28" },
  { name: "meeting-notes.docx", size: "340 KB", date: "Mar 25" },
];

const sharedMedia = [
  { color: "from-pink-500 to-rose-600" },
  { color: "from-blue-500 to-cyan-500" },
  { color: "from-amber-400 to-orange-500" },
  { color: "from-emerald-500 to-teal-600" },
  { color: "from-violet-500 to-purple-600" },
  { color: "from-sky-400 to-indigo-500" },
];

export function ContactDetails({ contact }: ContactDetailsProps) {
  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] overflow-y-auto">
      {/* Profile section */}
      <div className="flex flex-col items-center p-6 border-b border-white/10">
        <div className="relative">
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-2xl font-bold">
            {contact.avatar}
          </div>
          <div className="absolute bottom-0 right-0">
            <OnlineStatus status={contact.status} size="md" />
          </div>
        </div>
        <h2 className="mt-4 text-lg font-semibold">{contact.name}</h2>
        <p className="text-sm text-gray-400">
          {contact.status === "online" ? "Active now" : contact.status === "away" ? "Away" : "Last seen 2h ago"}
        </p>
        <p className="text-xs text-gray-500 mt-1">Senior Product Designer</p>
      </div>

      {/* Shared Media */}
      <div className="p-6 border-b border-white/10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">Shared Media</h3>
          <span className="text-xs text-blue-400 cursor-pointer hover:underline">View all</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {sharedMedia.map((m, i) => (
            <div
              key={i}
              className={\`aspect-square rounded-lg bg-gradient-to-br \${m.color} flex items-center justify-center opacity-80 hover:opacity-100 transition cursor-pointer\`}
            >
              <Image className="w-5 h-5 text-white/70" />
            </div>
          ))}
        </div>
      </div>

      {/* Shared Files */}
      <div className="p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">Shared Files</h3>
          <span className="text-xs text-blue-400 cursor-pointer hover:underline">View all</span>
        </div>
        <div className="space-y-3">
          {sharedFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 transition cursor-pointer">
              <div className="w-9 h-9 rounded-lg bg-[#141414] border border-white/10 flex items-center justify-center flex-shrink-0">
                <File className="w-4 h-4 text-gray-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{f.name}</p>
                <p className="text-xs text-gray-500">{f.size} &middot; {f.date}</p>
              </div>
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
  ];
}
