// KCode - Web Engine: Project Templates
//
// Pre-built file structures for each site type + stack combination.
// The machine generates ALL boilerplate. LLM only customizes content.

import type { DetectedIntent } from "./detector";
import { CINEMATIC_CSS, REVEAL_SCRIPT, PALETTES, paletteToCSS } from "./effects";

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

${paletteToCSS(PALETTES.midnight)}

${CINEMATIC_CSS}
`,
      needsLlm: false,
    },
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "${name}",
  description: "Built with KCode",
  openGraph: { title: "${name}", description: "Built with KCode" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased noise">
        <div className="aurora-bg" />
        {children}
        <Script id="kcode-effects" strategy="afterInteractive">
          {\`${REVEAL_SCRIPT.replace(/`/g, "\\`")}\`}
        </Script>
      </body>
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
    <section className="relative min-h-screen flex items-center justify-center px-6 overflow-hidden">
      {/* Background mesh gradient */}
      <div className="absolute inset-0 mesh-gradient" />

      {/* Floating orbs */}
      <div className="absolute top-1/4 left-1/4 w-72 h-72 bg-indigo-500/20 rounded-full blur-3xl float" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/15 rounded-full blur-3xl float-delay-1" />
      <div className="absolute top-1/2 right-1/3 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl float-delay-2" />

      <div className="relative z-10 max-w-4xl text-center reveal">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass text-sm text-gray-300 mb-8">
          <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          {/* BADGE TEXT */}
        </div>

        <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight">
          <span className="gradient-text">{/* HEADLINE LINE 1 */}</span>
          <br />
          <span className="text-white">{/* HEADLINE LINE 2 */}</span>
        </h1>

        <p className="mt-8 text-lg md:text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
          {/* SUBHEADLINE */}
        </p>

        <div className="mt-12 flex flex-col sm:flex-row gap-4 justify-center">
          <a href="#" className="magnetic-btn px-8 py-4 bg-white text-black rounded-full font-semibold hover:bg-gray-100 transition-all text-lg">
            Get Started Free →
          </a>
          <a href="#" className="px-8 py-4 glass rounded-full font-medium text-white hover:bg-white/10 transition-all text-lg">
            Watch Demo
          </a>
        </div>

        {/* Social proof */}
        <div className="mt-16 flex items-center justify-center gap-8 text-sm text-gray-500">
          <div className="flex -space-x-2">
            {[1,2,3,4,5].map(i => (
              <div key={i} className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 border-2 border-black" />
            ))}
          </div>
          <span>{/* SOCIAL PROOF TEXT */}</span>
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
  { title: "Feature 4", description: "Description", icon: "✨" },
  { title: "Feature 5", description: "Description", icon: "🎯" },
  { title: "Feature 6", description: "Description", icon: "💎" },
];

export default function Features() {
  return (
    <section className="py-32 px-6 relative">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-20 reveal">
          <span className="text-sm font-medium text-indigo-400 tracking-widest uppercase">Features</span>
          <h2 className="text-4xl md:text-5xl font-bold mt-4">{/* SECTION TITLE */}</h2>
          <p className="mt-4 text-lg text-gray-400 max-w-xl mx-auto">{/* SECTION SUBTITLE */}</p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 stagger">
          {features.map((f, i) => (
            <div key={i} className="reveal glass-card p-8 group spotlight">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center text-2xl mb-6 group-hover:scale-110 transition-transform">
                {f.icon}
              </div>
              <h3 className="text-xl font-semibold mb-3 text-white">{f.title}</h3>
              <p className="text-gray-400 leading-relaxed">{f.description}</p>
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

function statsComponent(intent: DetectedIntent): FileTemplate[] {
  return [{
    path: "src/components/stats.tsx",
    content: `const stats = [
  { value: "10K+", label: "Active Users" },
  { value: "99.9%", label: "Uptime" },
  { value: "150+", label: "Countries" },
  { value: "4.9", label: "Rating" },
];

export default function Stats() {
  return (
    <section className="py-24 px-6 border-y border-white/5">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 reveal">
          {stats.map((s, i) => (
            <div key={i} className="text-center">
              <div className="text-4xl md:text-5xl font-bold gradient-text">{s.value}</div>
              <div className="mt-2 text-sm text-gray-500 uppercase tracking-wider">{s.label}</div>
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

function testimonialsComponent(intent: DetectedIntent): FileTemplate[] {
  return [{
    path: "src/components/testimonials.tsx",
    content: `const testimonials = [
  { name: "Name", role: "CEO at Company", text: "Quote here.", avatar: "🧑" },
  { name: "Name", role: "CTO at Company", text: "Quote here.", avatar: "👩" },
  { name: "Name", role: "Developer", text: "Quote here.", avatar: "🧑‍💻" },
];

export default function Testimonials() {
  return (
    <section className="py-32 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-20 reveal">
          <span className="text-sm font-medium text-indigo-400 tracking-widest uppercase">Testimonials</span>
          <h2 className="text-4xl font-bold mt-4">Loved by developers</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-6 stagger">
          {testimonials.map((t, i) => (
            <div key={i} className="reveal glass-card p-8">
              <p className="text-gray-300 leading-relaxed mb-6">"{t.text}"</p>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-lg">
                  {t.avatar}
                </div>
                <div>
                  <div className="font-medium text-white">{t.name}</div>
                  <div className="text-sm text-gray-500">{t.role}</div>
                </div>
              </div>
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

function ctaComponent(intent: DetectedIntent): FileTemplate[] {
  return [{
    path: "src/components/cta.tsx",
    content: `export default function CTA() {
  return (
    <section className="py-32 px-6">
      <div className="max-w-4xl mx-auto text-center reveal">
        <div className="relative p-16 rounded-3xl overflow-hidden border-gradient">
          <div className="absolute inset-0 mesh-gradient opacity-50" />
          <div className="relative z-10">
            <h2 className="text-4xl md:text-5xl font-bold">
              <span className="gradient-text">{/* CTA HEADLINE */}</span>
            </h2>
            <p className="mt-6 text-lg text-gray-400 max-w-xl mx-auto">
              {/* CTA SUBTEXT */}
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
              <a href="#" className="magnetic-btn px-10 py-4 bg-white text-black rounded-full font-semibold text-lg hover:bg-gray-100 transition-all">
                Start Building →
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
`,
    needsLlm: true,
  }];
}

function navComponent(intent: DetectedIntent): FileTemplate[] {
  return [{
    path: "src/components/nav.tsx",
    content: `"use client";
import { useState, useEffect } from "react";

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className={\`fixed top-0 left-0 right-0 z-50 transition-all duration-300 \${
      scrolled ? "glass py-3" : "py-6"
    }\`}>
      <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
        <a href="/" className="text-xl font-bold text-white">${intent.name}</a>
        <div className="hidden md:flex items-center gap-8 text-sm text-gray-400">
          <a href="#features" className="hover:text-white transition">Features</a>
          <a href="#pricing" className="hover:text-white transition">Pricing</a>
          <a href="#" className="px-5 py-2 glass rounded-full text-white hover:bg-white/10 transition">
            Sign In
          </a>
          <a href="#" className="px-5 py-2 bg-white text-black rounded-full font-medium hover:bg-gray-200 transition">
            Get Started
          </a>
        </div>
      </div>
    </nav>
  );
}
`,
    needsLlm: false,
  }];
}

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
    files.push(...navComponent(intent));
    files.push(...landingComponents(intent));
    files.push(...statsComponent(intent));
    files.push(...testimonialsComponent(intent));
    files.push(...ctaComponent(intent));
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
