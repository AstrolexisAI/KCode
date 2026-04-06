// KCode - Web Engine Types

export type SiteType =
  | "landing"      // Landing page / marketing
  | "dashboard"    // Admin dashboard / SaaS panel
  | "blog"         // Blog / content site
  | "ecommerce"    // E-commerce / store
  | "portfolio"    // Portfolio / personal site
  | "docs"         // Documentation site
  | "saas"         // Full SaaS app (auth + dashboard + landing)
  | "api"          // API-only backend
  | "fullstack"    // Full-stack app
  | "custom";

export type Stack =
  | "nextjs"       // Next.js + React + Tailwind
  | "astro"        // Astro (static/content)
  | "svelte"       // SvelteKit
  | "vue"          // Nuxt/Vue
  | "html"         // Plain HTML + CSS + JS
  | "express"      // Express API
  | "fastapi"      // FastAPI
  | "rails";       // Ruby on Rails

export interface WebComponent {
  name: string;
  file: string;
  template: string;
  description: string;
}

export interface WebProject {
  siteType: SiteType;
  stack: Stack;
  name: string;
  description: string;
  components: WebComponent[];
  pages: string[];
  config: Record<string, string>;
}
