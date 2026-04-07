// KCode - Web Engine Types

export type SiteType =
  | "landing"           // Landing page / marketing
  | "dashboard"         // Generic admin dashboard
  | "trading-dashboard" // Financial/trading dashboard
  | "analytics"         // Analytics dashboard
  | "admin-panel"       // Admin panel with CRUD
  | "blog"              // Blog / content site
  | "ecommerce"         // E-commerce / store
  | "social-feed"       // Social media feed
  | "crm"               // CRM pipeline
  | "project-mgmt"      // Project management / kanban
  | "chat"              // Chat / messaging app
  | "education"         // LMS / education platform
  | "iot"               // IoT / device monitoring
  | "portfolio"         // Portfolio / personal site
  | "docs"              // Documentation site
  | "saas"              // Full SaaS app
  | "api"               // API-only backend
  | "fullstack"         // Full-stack app
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
