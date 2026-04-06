// KCode - Web Engine: Project Templates
//
// Pre-built file structures for each site type + stack combination.
// The machine generates ALL boilerplate. LLM only customizes content.

import type { DetectedIntent } from "./detector";

export interface FileTemplate {
  path: string;
  content: string;
  /** If true, LLM should customize this file's content */
  needsLlm: boolean;
}

export interface ProjectTemplate {
  files: FileTemplate[];
  installCmd: string;
  devCmd: string;
  buildCmd: string;
}

// ── Next.js Templates ──────────────────────────────────────────

function nextjsBase(intent: DetectedIntent): FileTemplate[] {
  const name = intent.name;
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name,
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "next dev",
          build: "next build",
          start: "next start",
          lint: "next lint",
        },
        dependencies: {
          next: "15.3.0",
          react: "19.1.0",
          "react-dom": "19.1.0",
          ...(intent.hasAuth ? { "next-auth": "^5.0.0" } : {}),
          ...(intent.hasPayments ? { stripe: "^17.0.0" } : {}),
        },
        devDependencies: {
          typescript: "^5.8.0",
          "@types/node": "^22.0.0",
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
          tailwindcss: "^4.0.0",
          "@tailwindcss/postcss": "^4.0.0",
          postcss: "^8.4.0",
        },
      }, null, 2),
      needsLlm: false,
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify({
        compilerOptions: {
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          incremental: true,
          plugins: [{ name: "next" }],
          paths: { "@/*": ["./src/*"] },
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
        exclude: ["node_modules"],
      }, null, 2),
      needsLlm: false,
    },
    {
      path: "next.config.ts",
      content: `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`,
      needsLlm: false,
    },
    {
      path: "postcss.config.mjs",
      content: `/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
`,
      needsLlm: false,
    },
    {
      path: "src/app/globals.css",
      content: `@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #171717;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #ededed;
  }
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: system-ui, -apple-system, sans-serif;
}
`,
      needsLlm: false,
    },
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "${name}",
  description: "Built with KCode",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
      needsLlm: false,
    },
  ];
}

// ── Landing Page Components ────────────────────────────────────

function landingComponents(intent: DetectedIntent): FileTemplate[] {
  return [
    {
      path: "src/app/page.tsx",
      content: `// Landing page — LLM will customize content
// Features: ${intent.features.join(", ")}
// Name: ${intent.name}
export default function Home() {
  return (
    <main>
      {/* HERO */}
      {/* FEATURES */}
      {/* TESTIMONIALS */}
      {/* PRICING */}
      {/* CTA */}
      {/* FOOTER */}
    </main>
  );
}
`,
      needsLlm: true,
    },
    {
      path: "src/components/hero.tsx",
      content: `export default function Hero() {
  return (
    <section className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-4xl text-center">
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight">
          {/* HEADLINE */}
        </h1>
        <p className="mt-6 text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
          {/* SUBHEADLINE */}
        </p>
        <div className="mt-10 flex gap-4 justify-center">
          <a href="#" className="px-8 py-3 bg-black text-white rounded-full font-medium hover:bg-gray-800 transition">
            Get Started
          </a>
          <a href="#" className="px-8 py-3 border border-gray-300 rounded-full font-medium hover:bg-gray-50 transition">
            Learn More
          </a>
        </div>
      </div>
    </section>
  );
}
`,
      needsLlm: true,
    },
    {
      path: "src/components/features.tsx",
      content: `const features = [
  { title: "Feature 1", description: "Description", icon: "⚡" },
  { title: "Feature 2", description: "Description", icon: "🔒" },
  { title: "Feature 3", description: "Description", icon: "🚀" },
];

export default function Features() {
  return (
    <section className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-16">Features</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {features.map((f, i) => (
            <div key={i} className="p-6 rounded-2xl border border-gray-200 dark:border-gray-800">
              <div className="text-4xl mb-4">{f.icon}</div>
              <h3 className="text-xl font-semibold mb-2">{f.title}</h3>
              <p className="text-gray-600 dark:text-gray-400">{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
`,
      needsLlm: true,
    },
    {
      path: "src/components/footer.tsx",
      content: `export default function Footer() {
  return (
    <footer className="border-t border-gray-200 dark:border-gray-800 py-12 px-6">
      <div className="max-w-6xl mx-auto flex justify-between items-center">
        <p className="text-sm text-gray-500">© ${new Date().getFullYear()} ${intent.name}. All rights reserved.</p>
        <div className="flex gap-6 text-sm text-gray-500">
          <a href="#" className="hover:text-gray-900 dark:hover:text-white transition">Privacy</a>
          <a href="#" className="hover:text-gray-900 dark:hover:text-white transition">Terms</a>
        </div>
      </div>
    </footer>
  );
}
`,
      needsLlm: false,
    },
  ];
}

// ── Pricing Component ──────────────────────────────────────────

function pricingComponent(intent: DetectedIntent): FileTemplate[] {
  if (!intent.features.includes("pricing")) return [];
  return [{
    path: "src/components/pricing.tsx",
    content: `const plans = [
  { name: "Free", price: "$0", features: ["Feature 1", "Feature 2"], cta: "Get Started" },
  { name: "Pro", price: "$19", features: ["Everything in Free", "Feature 3", "Feature 4"], cta: "Start Trial", popular: true },
  { name: "Enterprise", price: "Custom", features: ["Everything in Pro", "Feature 5", "Support"], cta: "Contact Us" },
];

export default function Pricing() {
  return (
    <section className="py-24 px-6" id="pricing">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-16">Pricing</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {plans.map((plan, i) => (
            <div key={i} className={\`p-8 rounded-2xl border \${plan.popular ? "border-black dark:border-white ring-2 ring-black dark:ring-white" : "border-gray-200 dark:border-gray-800"}\`}>
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              <p className="text-4xl font-bold mt-4">{plan.price}<span className="text-sm font-normal text-gray-500">/mo</span></p>
              <ul className="mt-6 space-y-3">
                {plan.features.map((f, j) => (
                  <li key={j} className="flex items-center gap-2 text-sm">
                    <span className="text-green-500">✓</span> {f}
                  </li>
                ))}
              </ul>
              <button className={\`mt-8 w-full py-3 rounded-full font-medium transition \${plan.popular ? "bg-black text-white hover:bg-gray-800" : "border border-gray-300 hover:bg-gray-50"}\`}>
                {plan.cta}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
`,
    needsLlm: true,
  }];
}

// ── Auth Components ────────────────────────────────────────────

function authComponents(intent: DetectedIntent): FileTemplate[] {
  if (!intent.hasAuth) return [];
  return [
    {
      path: "src/app/login/page.tsx",
      content: `"use client";
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // TODO: implement auth
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-bold text-center">Sign In</h1>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900"
        />
        <button type="submit" className="w-full py-3 bg-black text-white rounded-lg font-medium hover:bg-gray-800 transition">
          Sign In
        </button>
        <p className="text-center text-sm text-gray-500">
          Don't have an account? <a href="/signup" className="underline">Sign up</a>
        </p>
      </form>
    </div>
  );
}
`,
      needsLlm: true,
    },
    {
      path: "src/app/signup/page.tsx",
      content: `"use client";
import { useState } from "react";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // TODO: implement auth
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-bold text-center">Create Account</h1>
        <input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)}
          className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900" />
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900" />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
          className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900" />
        <button type="submit" className="w-full py-3 bg-black text-white rounded-lg font-medium hover:bg-gray-800 transition">
          Create Account
        </button>
      </form>
    </div>
  );
}
`,
      needsLlm: true,
    },
  ];
}

// ── Dashboard Components ───────────────────────────────────────

function dashboardComponents(intent: DetectedIntent): FileTemplate[] {
  if (intent.siteType !== "dashboard" && intent.siteType !== "saas") return [];
  return [
    {
      path: "src/app/dashboard/page.tsx",
      content: `export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* SIDEBAR */}
      <div className="flex">
        <aside className="w-64 min-h-screen border-r border-gray-200 dark:border-gray-800 p-4">
          <h2 className="font-bold text-lg mb-6">${intent.name}</h2>
          <nav className="space-y-1">
            <a href="/dashboard" className="block px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-900 font-medium">Dashboard</a>
            <a href="/dashboard/analytics" className="block px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-900">Analytics</a>
            <a href="/dashboard/settings" className="block px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-900">Settings</a>
          </nav>
        </aside>
        <main className="flex-1 p-8">
          <h1 className="text-2xl font-bold mb-8">Dashboard</h1>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="p-6 rounded-xl border border-gray-200 dark:border-gray-800">
              <p className="text-sm text-gray-500">Total Users</p>
              <p className="text-3xl font-bold mt-1">1,234</p>
            </div>
            <div className="p-6 rounded-xl border border-gray-200 dark:border-gray-800">
              <p className="text-sm text-gray-500">Revenue</p>
              <p className="text-3xl font-bold mt-1">$12.4k</p>
            </div>
            <div className="p-6 rounded-xl border border-gray-200 dark:border-gray-800">
              <p className="text-sm text-gray-500">Active Now</p>
              <p className="text-3xl font-bold mt-1">42</p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
`,
      needsLlm: true,
    },
  ];
}

// ── Main Template Builder ──────────────────────────────────────

export function buildProjectTemplate(intent: DetectedIntent): ProjectTemplate {
  const files: FileTemplate[] = [];

  if (intent.stack === "nextjs") {
    files.push(...nextjsBase(intent));
    files.push(...landingComponents(intent));
    files.push(...pricingComponent(intent));
    files.push(...authComponents(intent));
    files.push(...dashboardComponents(intent));

    // .gitignore
    files.push({
      path: ".gitignore",
      content: "node_modules/\n.next/\nout/\n.env*.local\n",
      needsLlm: false,
    });

    // README
    files.push({
      path: "README.md",
      content: `# ${intent.name}\n\nBuilt with KCode.\n\n## Getting Started\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`,
      needsLlm: false,
    });
  }

  return {
    files,
    installCmd: "npm install",
    devCmd: "npm run dev",
    buildCmd: "npm run build",
  };
}
