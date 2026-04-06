// KCode - CSS/Design System Project Engine
// Creates: design systems, component libraries, Tailwind plugins, animation libs, Sass frameworks

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CssProjectType = "design-system" | "component-library" | "tailwind-plugin" | "animation-library" | "sass-framework" | "postcss-plugin" | "custom";

interface CssConfig {
  name: string;
  type: CssProjectType;
  preprocessor: "css" | "scss" | "postcss";
  hasTailwind: boolean;
  hasStorybook: boolean;
  tokens: boolean;
  darkMode: boolean;
}

function detectCssProject(msg: string): CssConfig {
  const lower = msg.toLowerCase();
  let type: CssProjectType = "design-system";
  let preprocessor: "css" | "scss" | "postcss" = "css";
  let hasTailwind = false;
  let hasStorybook = false;
  let tokens = false;
  let darkMode = true;

  if (/\b(?:tailwind|tw)\s*(?:plugin|config|preset|extend)/i.test(lower)) {
    type = "tailwind-plugin"; hasTailwind = true; preprocessor = "postcss";
  }
  else if (/\b(?:animation|animate|motion|transition|keyframe)\b/i.test(lower)) { type = "animation-library"; }
  else if (/\b(?:component|ui\s*kit|ui\s*library|button|card|modal|widget)\b/i.test(lower)) {
    type = "component-library";
    hasStorybook = /\b(?:storybook|stories)\b/i.test(lower) || true;
  }
  else if (/\b(?:sass|scss)\s*(?:framework|lib|library|mixin)/i.test(lower)) { type = "sass-framework"; preprocessor = "scss"; }
  else if (/\b(?:postcss)\s*(?:plugin)/i.test(lower)) { type = "postcss-plugin"; preprocessor = "postcss"; }
  else if (/\b(?:design\s*system|token|design\s*token|theme|palette|typography)\b/i.test(lower)) { type = "design-system"; tokens = true; }
  else { type = "design-system"; tokens = true; }

  if (/\b(?:tailwind|tw)\b/i.test(lower)) hasTailwind = true;
  if (/\b(?:sass|scss)\b/i.test(lower)) preprocessor = "scss";
  if (/\b(?:postcss)\b/i.test(lower)) preprocessor = "postcss";
  if (/\b(?:token|variable|custom\s*prop)/i.test(lower)) tokens = true;
  if (/\b(?:storybook|stories|docs|documentation)\b/i.test(lower)) hasStorybook = true;
  if (/\b(?:no\s*dark|light\s*only)\b/i.test(lower)) darkMode = false;

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "tailwind-plugin" ? "tw-plugin" : type === "postcss-plugin" ? "postcss-plugin" : "design-system");

  return { name, type, preprocessor, hasTailwind, hasStorybook, tokens, darkMode };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface CssProjectResult { config: CssConfig; files: GenFile[]; projectPath: string; prompt: string; }

// ── Color palettes ────────────────────────────────────────────────

const PALETTES = {
  primary: { 50: "#eff6ff", 100: "#dbeafe", 200: "#bfdbfe", 300: "#93c5fd", 400: "#60a5fa", 500: "#3b82f6", 600: "#2563eb", 700: "#1d4ed8", 800: "#1e40af", 900: "#1e3a8a", 950: "#172554" },
  neutral: { 50: "#fafafa", 100: "#f5f5f5", 200: "#e5e5e5", 300: "#d4d4d4", 400: "#a3a3a3", 500: "#737373", 600: "#525252", 700: "#404040", 800: "#262626", 900: "#171717", 950: "#0a0a0a" },
  success: { 500: "#22c55e", 600: "#16a34a" },
  warning: { 500: "#f59e0b", 600: "#d97706" },
  error: { 500: "#ef4444", 600: "#dc2626" },
};

function tokensCSS(name: string, darkMode: boolean): string {
  return `:root {
  /* ── Colors ── */
${Object.entries(PALETTES.primary).map(([k, v]) => `  --${name}-primary-${k}: ${v};`).join("\n")}
${Object.entries(PALETTES.neutral).map(([k, v]) => `  --${name}-neutral-${k}: ${v};`).join("\n")}
  --${name}-success: ${PALETTES.success[500]};
  --${name}-warning: ${PALETTES.warning[500]};
  --${name}-error: ${PALETTES.error[500]};

  /* ── Typography ── */
  --${name}-font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --${name}-font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --${name}-font-size-xs: 0.75rem;
  --${name}-font-size-sm: 0.875rem;
  --${name}-font-size-base: 1rem;
  --${name}-font-size-lg: 1.125rem;
  --${name}-font-size-xl: 1.25rem;
  --${name}-font-size-2xl: 1.5rem;
  --${name}-font-size-3xl: 1.875rem;
  --${name}-font-size-4xl: 2.25rem;
  --${name}-font-size-5xl: 3rem;
  --${name}-font-weight-normal: 400;
  --${name}-font-weight-medium: 500;
  --${name}-font-weight-semibold: 600;
  --${name}-font-weight-bold: 700;
  --${name}-line-height-tight: 1.25;
  --${name}-line-height-normal: 1.5;
  --${name}-line-height-relaxed: 1.75;

  /* ── Spacing ── */
  --${name}-space-1: 0.25rem;
  --${name}-space-2: 0.5rem;
  --${name}-space-3: 0.75rem;
  --${name}-space-4: 1rem;
  --${name}-space-5: 1.25rem;
  --${name}-space-6: 1.5rem;
  --${name}-space-8: 2rem;
  --${name}-space-10: 2.5rem;
  --${name}-space-12: 3rem;
  --${name}-space-16: 4rem;
  --${name}-space-20: 5rem;

  /* ── Borders ── */
  --${name}-radius-sm: 0.25rem;
  --${name}-radius-md: 0.375rem;
  --${name}-radius-lg: 0.5rem;
  --${name}-radius-xl: 0.75rem;
  --${name}-radius-2xl: 1rem;
  --${name}-radius-full: 9999px;
  --${name}-border-width: 1px;
  --${name}-border-color: var(--${name}-neutral-200);

  /* ── Shadows ── */
  --${name}-shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --${name}-shadow-md: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);
  --${name}-shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1);
  --${name}-shadow-xl: 0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1);

  /* ── Transitions ── */
  --${name}-transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  --${name}-transition-base: 200ms cubic-bezier(0.4, 0, 0.2, 1);
  --${name}-transition-slow: 300ms cubic-bezier(0.4, 0, 0.2, 1);
  --${name}-transition-spring: 500ms cubic-bezier(0.175, 0.885, 0.32, 1.275);

  /* ── Z-Index ── */
  --${name}-z-dropdown: 1000;
  --${name}-z-sticky: 1100;
  --${name}-z-fixed: 1200;
  --${name}-z-modal-backdrop: 1300;
  --${name}-z-modal: 1400;
  --${name}-z-popover: 1500;
  --${name}-z-tooltip: 1600;

  /* ── Breakpoints (for reference) ── */
  /* sm: 640px | md: 768px | lg: 1024px | xl: 1280px | 2xl: 1536px */
}
${darkMode ? `
[data-theme="dark"],
.dark,
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --${name}-primary-50: #172554;
    --${name}-primary-100: #1e3a8a;
    --${name}-primary-500: #60a5fa;
    --${name}-primary-600: #93c5fd;
    --${name}-neutral-50: #0a0a0a;
    --${name}-neutral-100: #171717;
    --${name}-neutral-200: #262626;
    --${name}-neutral-300: #404040;
    --${name}-neutral-400: #525252;
    --${name}-neutral-500: #737373;
    --${name}-neutral-600: #a3a3a3;
    --${name}-neutral-700: #d4d4d4;
    --${name}-neutral-800: #e5e5e5;
    --${name}-neutral-900: #f5f5f5;
    --${name}-neutral-950: #fafafa;
    --${name}-border-color: var(--${name}-neutral-200);
    --${name}-shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
    --${name}-shadow-md: 0 4px 6px -1px rgba(0,0,0,0.4);
    --${name}-shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.4);
  }
}
` : ""}`;
}

function componentsCSS(name: string): string {
  return `/* ── Reset ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── Base ── */
body {
  font-family: var(--${name}-font-sans);
  font-size: var(--${name}-font-size-base);
  line-height: var(--${name}-line-height-normal);
  color: var(--${name}-neutral-900);
  background: var(--${name}-neutral-50);
  -webkit-font-smoothing: antialiased;
}

/* ── Typography ── */
.${name}-h1 { font-size: var(--${name}-font-size-5xl); font-weight: var(--${name}-font-weight-bold); line-height: var(--${name}-line-height-tight); letter-spacing: -0.025em; }
.${name}-h2 { font-size: var(--${name}-font-size-4xl); font-weight: var(--${name}-font-weight-bold); line-height: var(--${name}-line-height-tight); letter-spacing: -0.025em; }
.${name}-h3 { font-size: var(--${name}-font-size-3xl); font-weight: var(--${name}-font-weight-semibold); line-height: var(--${name}-line-height-tight); }
.${name}-h4 { font-size: var(--${name}-font-size-2xl); font-weight: var(--${name}-font-weight-semibold); }
.${name}-h5 { font-size: var(--${name}-font-size-xl); font-weight: var(--${name}-font-weight-medium); }
.${name}-h6 { font-size: var(--${name}-font-size-lg); font-weight: var(--${name}-font-weight-medium); }
.${name}-text-sm { font-size: var(--${name}-font-size-sm); }
.${name}-text-xs { font-size: var(--${name}-font-size-xs); }
.${name}-text-muted { color: var(--${name}-neutral-500); }
.${name}-text-gradient {
  background: linear-gradient(135deg, var(--${name}-primary-500), var(--${name}-primary-700));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* ── Button ── */
.${name}-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--${name}-space-2);
  padding: var(--${name}-space-2) var(--${name}-space-4);
  font-size: var(--${name}-font-size-sm); font-weight: var(--${name}-font-weight-medium);
  line-height: 1.5; border-radius: var(--${name}-radius-lg);
  border: var(--${name}-border-width) solid transparent;
  cursor: pointer; transition: all var(--${name}-transition-fast);
  text-decoration: none; white-space: nowrap; user-select: none;
}
.${name}-btn:focus-visible { outline: 2px solid var(--${name}-primary-500); outline-offset: 2px; }
.${name}-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.${name}-btn-primary {
  background: var(--${name}-primary-600); color: white;
}
.${name}-btn-primary:hover:not(:disabled) { background: var(--${name}-primary-700); }
.${name}-btn-primary:active { background: var(--${name}-primary-800); }

.${name}-btn-secondary {
  background: transparent; color: var(--${name}-neutral-700);
  border-color: var(--${name}-border-color);
}
.${name}-btn-secondary:hover:not(:disabled) { background: var(--${name}-neutral-100); }

.${name}-btn-ghost {
  background: transparent; color: var(--${name}-neutral-700);
}
.${name}-btn-ghost:hover:not(:disabled) { background: var(--${name}-neutral-100); }

.${name}-btn-danger {
  background: var(--${name}-error-500); color: white;
}
.${name}-btn-danger:hover:not(:disabled) { background: var(--${name}-error-600); }

.${name}-btn-sm { padding: var(--${name}-space-1) var(--${name}-space-3); font-size: var(--${name}-font-size-xs); }
.${name}-btn-lg { padding: var(--${name}-space-3) var(--${name}-space-6); font-size: var(--${name}-font-size-base); }
.${name}-btn-icon { padding: var(--${name}-space-2); aspect-ratio: 1; }

/* ── Input ── */
.${name}-input {
  width: 100%; padding: var(--${name}-space-2) var(--${name}-space-3);
  font-size: var(--${name}-font-size-sm); line-height: 1.5;
  color: var(--${name}-neutral-900); background: var(--${name}-neutral-50);
  border: var(--${name}-border-width) solid var(--${name}-border-color);
  border-radius: var(--${name}-radius-lg);
  transition: border-color var(--${name}-transition-fast), box-shadow var(--${name}-transition-fast);
}
.${name}-input:focus { outline: none; border-color: var(--${name}-primary-500); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15); }
.${name}-input::placeholder { color: var(--${name}-neutral-400); }
.${name}-input:disabled { background: var(--${name}-neutral-100); opacity: 0.7; }

.${name}-textarea { min-height: 5rem; resize: vertical; }
.${name}-select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 0.75rem center; padding-right: 2.5rem; }
.${name}-label { display: block; font-size: var(--${name}-font-size-sm); font-weight: var(--${name}-font-weight-medium); margin-bottom: var(--${name}-space-1); color: var(--${name}-neutral-700); }

/* ── Card ── */
.${name}-card {
  background: var(--${name}-neutral-50); border: var(--${name}-border-width) solid var(--${name}-border-color);
  border-radius: var(--${name}-radius-xl); overflow: hidden;
  box-shadow: var(--${name}-shadow-sm); transition: box-shadow var(--${name}-transition-base);
}
.${name}-card:hover { box-shadow: var(--${name}-shadow-md); }
.${name}-card-header { padding: var(--${name}-space-4) var(--${name}-space-6); border-bottom: var(--${name}-border-width) solid var(--${name}-border-color); }
.${name}-card-body { padding: var(--${name}-space-6); }
.${name}-card-footer { padding: var(--${name}-space-4) var(--${name}-space-6); border-top: var(--${name}-border-width) solid var(--${name}-border-color); background: var(--${name}-neutral-100); }

/* ── Badge ── */
.${name}-badge {
  display: inline-flex; align-items: center; padding: 0.125rem var(--${name}-space-2);
  font-size: var(--${name}-font-size-xs); font-weight: var(--${name}-font-weight-medium);
  border-radius: var(--${name}-radius-full); border: var(--${name}-border-width) solid transparent;
}
.${name}-badge-primary { background: rgba(59,130,246,0.1); color: var(--${name}-primary-700); border-color: rgba(59,130,246,0.2); }
.${name}-badge-success { background: rgba(34,197,94,0.1); color: #15803d; border-color: rgba(34,197,94,0.2); }
.${name}-badge-warning { background: rgba(245,158,11,0.1); color: #b45309; border-color: rgba(245,158,11,0.2); }
.${name}-badge-error { background: rgba(239,68,68,0.1); color: #b91c1c; border-color: rgba(239,68,68,0.2); }

/* ── Avatar ── */
.${name}-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.5rem; height: 2.5rem; border-radius: var(--${name}-radius-full);
  background: var(--${name}-primary-100); color: var(--${name}-primary-700);
  font-weight: var(--${name}-font-weight-semibold); font-size: var(--${name}-font-size-sm);
  overflow: hidden;
}
.${name}-avatar img { width: 100%; height: 100%; object-fit: cover; }
.${name}-avatar-sm { width: 2rem; height: 2rem; font-size: var(--${name}-font-size-xs); }
.${name}-avatar-lg { width: 3rem; height: 3rem; font-size: var(--${name}-font-size-base); }

/* ── Modal ── */
.${name}-modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
  z-index: var(--${name}-z-modal-backdrop); display: flex; align-items: center; justify-content: center;
  opacity: 0; visibility: hidden; transition: all var(--${name}-transition-base);
}
.${name}-modal-backdrop.open { opacity: 1; visibility: visible; }
.${name}-modal {
  background: var(--${name}-neutral-50); border-radius: var(--${name}-radius-xl);
  box-shadow: var(--${name}-shadow-xl); width: 100%; max-width: 32rem; max-height: 85vh;
  overflow-y: auto; z-index: var(--${name}-z-modal);
  transform: scale(0.95) translateY(10px); transition: transform var(--${name}-transition-spring);
}
.${name}-modal-backdrop.open .${name}-modal { transform: scale(1) translateY(0); }

/* ── Toast/Alert ── */
.${name}-alert {
  padding: var(--${name}-space-3) var(--${name}-space-4); border-radius: var(--${name}-radius-lg);
  border: var(--${name}-border-width) solid; display: flex; gap: var(--${name}-space-3); align-items: flex-start;
}
.${name}-alert-info { background: rgba(59,130,246,0.05); border-color: rgba(59,130,246,0.2); color: var(--${name}-primary-800); }
.${name}-alert-success { background: rgba(34,197,94,0.05); border-color: rgba(34,197,94,0.2); color: #15803d; }
.${name}-alert-warning { background: rgba(245,158,11,0.05); border-color: rgba(245,158,11,0.2); color: #b45309; }
.${name}-alert-error { background: rgba(239,68,68,0.05); border-color: rgba(239,68,68,0.2); color: #b91c1c; }

/* ── Skeleton ── */
.${name}-skeleton {
  background: linear-gradient(90deg, var(--${name}-neutral-200) 25%, var(--${name}-neutral-100) 50%, var(--${name}-neutral-200) 75%);
  background-size: 200% 100%; border-radius: var(--${name}-radius-md);
  animation: ${name}-shimmer 1.5s infinite;
}
@keyframes ${name}-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ── Spinner ── */
.${name}-spinner {
  width: 1.25rem; height: 1.25rem; border: 2px solid var(--${name}-neutral-200);
  border-top-color: var(--${name}-primary-600); border-radius: 50%;
  animation: ${name}-spin 0.6s linear infinite;
}
@keyframes ${name}-spin { to { transform: rotate(360deg); } }

/* ── Divider ── */
.${name}-divider { height: var(--${name}-border-width); background: var(--${name}-border-color); border: none; margin: var(--${name}-space-4) 0; }

/* ── Tooltip ── */
.${name}-tooltip {
  position: relative;
}
.${name}-tooltip::after {
  content: attr(data-tooltip); position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%) scale(0.9);
  padding: var(--${name}-space-1) var(--${name}-space-2); font-size: var(--${name}-font-size-xs);
  background: var(--${name}-neutral-900); color: var(--${name}-neutral-50); border-radius: var(--${name}-radius-md);
  white-space: nowrap; pointer-events: none; opacity: 0; transition: all var(--${name}-transition-fast);
  z-index: var(--${name}-z-tooltip);
}
.${name}-tooltip:hover::after { opacity: 1; transform: translateX(-50%) scale(1); }

/* ── Layout Utilities ── */
.${name}-container { width: 100%; max-width: 1280px; margin-inline: auto; padding-inline: var(--${name}-space-4); }
.${name}-flex { display: flex; }
.${name}-flex-col { display: flex; flex-direction: column; }
.${name}-grid { display: grid; }
.${name}-center { display: flex; align-items: center; justify-content: center; }
.${name}-between { display: flex; align-items: center; justify-content: space-between; }
.${name}-stack { display: flex; flex-direction: column; gap: var(--${name}-space-4); }
.${name}-row { display: flex; gap: var(--${name}-space-4); }
.${name}-wrap { flex-wrap: wrap; }
.${name}-gap-1 { gap: var(--${name}-space-1); }
.${name}-gap-2 { gap: var(--${name}-space-2); }
.${name}-gap-3 { gap: var(--${name}-space-3); }
.${name}-gap-4 { gap: var(--${name}-space-4); }
.${name}-gap-6 { gap: var(--${name}-space-6); }
.${name}-gap-8 { gap: var(--${name}-space-8); }

/* ── Visibility ── */
.${name}-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }

/* ── Responsive Grid ── */
.${name}-grid-cols-1 { grid-template-columns: repeat(1, 1fr); }
.${name}-grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
.${name}-grid-cols-3 { grid-template-columns: repeat(3, 1fr); }
.${name}-grid-cols-4 { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 768px) {
  .${name}-grid-cols-2, .${name}-grid-cols-3, .${name}-grid-cols-4 { grid-template-columns: 1fr; }
}
@media (min-width: 769px) and (max-width: 1024px) {
  .${name}-grid-cols-3, .${name}-grid-cols-4 { grid-template-columns: repeat(2, 1fr); }
}
`;
}

function animationsCSS(name: string): string {
  return `/* ── ${name} Animation Library ── */

/* Entrances */
@keyframes ${name}-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ${name}-fade-in-up { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes ${name}-fade-in-down { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes ${name}-fade-in-left { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes ${name}-fade-in-right { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes ${name}-scale-in { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
@keyframes ${name}-slide-in-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
@keyframes ${name}-slide-in-down { from { transform: translateY(-100%); } to { transform: translateY(0); } }

/* Emphasis */
@keyframes ${name}-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-25%); } }
@keyframes ${name}-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes ${name}-shake { 0%, 100% { transform: translateX(0); } 10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); } 20%, 40%, 60%, 80% { transform: translateX(4px); } }
@keyframes ${name}-wiggle { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-3deg); } 75% { transform: rotate(3deg); } }
@keyframes ${name}-ping { 75%, 100% { transform: scale(2); opacity: 0; } }
@keyframes ${name}-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
@keyframes ${name}-glow { 0%, 100% { box-shadow: 0 0 5px rgba(59,130,246,0.3); } 50% { box-shadow: 0 0 20px rgba(59,130,246,0.6); } }

/* Background effects */
@keyframes ${name}-gradient-shift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
@keyframes ${name}-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes ${name}-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* Exits */
@keyframes ${name}-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes ${name}-fade-out-up { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-20px); } }
@keyframes ${name}-fade-out-down { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(20px); } }
@keyframes ${name}-scale-out { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.9); } }

/* Utility classes */
.${name}-animate-fade-in { animation: ${name}-fade-in 0.3s ease-out both; }
.${name}-animate-fade-in-up { animation: ${name}-fade-in-up 0.4s ease-out both; }
.${name}-animate-fade-in-down { animation: ${name}-fade-in-down 0.4s ease-out both; }
.${name}-animate-fade-in-left { animation: ${name}-fade-in-left 0.4s ease-out both; }
.${name}-animate-fade-in-right { animation: ${name}-fade-in-right 0.4s ease-out both; }
.${name}-animate-scale-in { animation: ${name}-scale-in 0.3s ease-out both; }
.${name}-animate-slide-in-up { animation: ${name}-slide-in-up 0.3s ease-out both; }
.${name}-animate-bounce { animation: ${name}-bounce 1s ease-in-out infinite; }
.${name}-animate-pulse { animation: ${name}-pulse 2s ease-in-out infinite; }
.${name}-animate-shake { animation: ${name}-shake 0.5s ease-in-out; }
.${name}-animate-wiggle { animation: ${name}-wiggle 0.5s ease-in-out; }
.${name}-animate-float { animation: ${name}-float 3s ease-in-out infinite; }
.${name}-animate-glow { animation: ${name}-glow 2s ease-in-out infinite; }
.${name}-animate-spin { animation: ${name}-rotate 1s linear infinite; }
.${name}-animate-gradient { background-size: 200% 200%; animation: ${name}-gradient-shift 3s ease infinite; }

/* Stagger children */
.${name}-stagger > * { animation-fill-mode: both; }
.${name}-stagger > *:nth-child(1) { animation-delay: 0ms; }
.${name}-stagger > *:nth-child(2) { animation-delay: 50ms; }
.${name}-stagger > *:nth-child(3) { animation-delay: 100ms; }
.${name}-stagger > *:nth-child(4) { animation-delay: 150ms; }
.${name}-stagger > *:nth-child(5) { animation-delay: 200ms; }
.${name}-stagger > *:nth-child(6) { animation-delay: 250ms; }
.${name}-stagger > *:nth-child(7) { animation-delay: 300ms; }
.${name}-stagger > *:nth-child(8) { animation-delay: 350ms; }

/* Scroll-triggered (add .${name}-visible via JS IntersectionObserver) */
.${name}-reveal { opacity: 0; transform: translateY(20px); transition: all 0.5s ease-out; }
.${name}-reveal.${name}-visible { opacity: 1; transform: translateY(0); }

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`;
}

export function createCssProject(userRequest: string, cwd: string): CssProjectResult {
  const cfg = detectCssProject(userRequest);
  const files: GenFile[] = [];

  if (cfg.type === "design-system" || cfg.type === "component-library") {
    // Tokens
    files.push({ path: `src/tokens.css`, content: tokensCSS(cfg.name, cfg.darkMode), needsLlm: false });
    // Components
    files.push({ path: `src/components.css`, content: componentsCSS(cfg.name), needsLlm: false });
    // Animations
    files.push({ path: `src/animations.css`, content: animationsCSS(cfg.name), needsLlm: false });
    // Main entry
    files.push({ path: `src/index.css`, content: `/* ${cfg.name} — Design System */\n@import "./tokens.css";\n@import "./components.css";\n@import "./animations.css";\n`, needsLlm: false });
    // Minified bundle placeholder
    files.push({ path: `dist/${cfg.name}.css`, content: `/* Built version — run: npm run build */\n`, needsLlm: false });

    // Demo page
    files.push({ path: "demo/index.html", content: `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cfg.name} — Demo</title>
  <link rel="stylesheet" href="../src/index.css">
  <style>body { padding: 2rem; } section { margin-bottom: 3rem; } h2 { margin-bottom: 1rem; }</style>
</head>
<body>
  <div class="${cfg.name}-container ${cfg.name}-stack">
    <h1 class="${cfg.name}-h1">${cfg.name}</h1>
    <p class="${cfg.name}-text-muted">Design system demo</p>

    <section>
      <h2 class="${cfg.name}-h3">Buttons</h2>
      <div class="${cfg.name}-row ${cfg.name}-wrap ${cfg.name}-gap-2">
        <button class="${cfg.name}-btn ${cfg.name}-btn-primary">Primary</button>
        <button class="${cfg.name}-btn ${cfg.name}-btn-secondary">Secondary</button>
        <button class="${cfg.name}-btn ${cfg.name}-btn-ghost">Ghost</button>
        <button class="${cfg.name}-btn ${cfg.name}-btn-danger">Danger</button>
        <button class="${cfg.name}-btn ${cfg.name}-btn-primary ${cfg.name}-btn-sm">Small</button>
        <button class="${cfg.name}-btn ${cfg.name}-btn-primary ${cfg.name}-btn-lg">Large</button>
        <button class="${cfg.name}-btn ${cfg.name}-btn-primary" disabled>Disabled</button>
      </div>
    </section>

    <section>
      <h2 class="${cfg.name}-h3">Inputs</h2>
      <div class="${cfg.name}-stack" style="max-width:24rem;">
        <div><label class="${cfg.name}-label">Email</label><input class="${cfg.name}-input" placeholder="you@example.com"></div>
        <div><label class="${cfg.name}-label">Message</label><textarea class="${cfg.name}-input ${cfg.name}-textarea" placeholder="Write something..."></textarea></div>
      </div>
    </section>

    <section>
      <h2 class="${cfg.name}-h3">Cards</h2>
      <div class="${cfg.name}-grid ${cfg.name}-grid-cols-3 ${cfg.name}-gap-4">
        <div class="${cfg.name}-card"><div class="${cfg.name}-card-body"><h4 class="${cfg.name}-h5">Card Title</h4><p class="${cfg.name}-text-muted">Card description goes here.</p></div></div>
        <div class="${cfg.name}-card"><div class="${cfg.name}-card-header"><strong>With Header</strong></div><div class="${cfg.name}-card-body">Content here.</div><div class="${cfg.name}-card-footer"><button class="${cfg.name}-btn ${cfg.name}-btn-primary ${cfg.name}-btn-sm">Action</button></div></div>
        <div class="${cfg.name}-card"><div class="${cfg.name}-card-body ${cfg.name}-center" style="min-height:8rem"><div class="${cfg.name}-spinner"></div></div></div>
      </div>
    </section>

    <section>
      <h2 class="${cfg.name}-h3">Badges</h2>
      <div class="${cfg.name}-row ${cfg.name}-gap-2">
        <span class="${cfg.name}-badge ${cfg.name}-badge-primary">Primary</span>
        <span class="${cfg.name}-badge ${cfg.name}-badge-success">Success</span>
        <span class="${cfg.name}-badge ${cfg.name}-badge-warning">Warning</span>
        <span class="${cfg.name}-badge ${cfg.name}-badge-error">Error</span>
      </div>
    </section>

    <section>
      <h2 class="${cfg.name}-h3">Alerts</h2>
      <div class="${cfg.name}-stack">
        <div class="${cfg.name}-alert ${cfg.name}-alert-info">This is an informational alert.</div>
        <div class="${cfg.name}-alert ${cfg.name}-alert-success">Operation completed successfully!</div>
        <div class="${cfg.name}-alert ${cfg.name}-alert-warning">Please review before proceeding.</div>
        <div class="${cfg.name}-alert ${cfg.name}-alert-error">Something went wrong.</div>
      </div>
    </section>

    <section>
      <h2 class="${cfg.name}-h3">Animations</h2>
      <div class="${cfg.name}-row ${cfg.name}-gap-4 ${cfg.name}-stagger">
        <div class="${cfg.name}-card ${cfg.name}-animate-fade-in-up" style="padding:1rem;">Fade Up</div>
        <div class="${cfg.name}-card ${cfg.name}-animate-scale-in" style="padding:1rem;">Scale In</div>
        <div class="${cfg.name}-card ${cfg.name}-animate-bounce" style="padding:1rem;">Bounce</div>
        <div class="${cfg.name}-card ${cfg.name}-animate-float" style="padding:1rem;">Float</div>
        <div class="${cfg.name}-card ${cfg.name}-animate-glow" style="padding:1rem;">Glow</div>
      </div>
    </section>

    <section>
      <h2 class="${cfg.name}-h3">Skeleton</h2>
      <div class="${cfg.name}-stack" style="max-width:20rem;">
        <div class="${cfg.name}-skeleton" style="height:1rem; width:60%;"></div>
        <div class="${cfg.name}-skeleton" style="height:1rem; width:80%;"></div>
        <div class="${cfg.name}-skeleton" style="height:6rem;"></div>
      </div>
    </section>

    <section>
      <h2 class="${cfg.name}-h3">Dark Mode</h2>
      <button class="${cfg.name}-btn ${cfg.name}-btn-secondary" onclick="document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'">Toggle Dark Mode</button>
    </section>
  </div>

  <script>
    // Scroll reveal
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('${cfg.name}-visible'); });
    }, { threshold: 0.1 });
    document.querySelectorAll('.${cfg.name}-reveal').forEach(el => observer.observe(el));
  </script>
</body>
</html>
`, needsLlm: false });

  } else if (cfg.type === "animation-library") {
    files.push({ path: `src/${cfg.name}.css`, content: animationsCSS(cfg.name), needsLlm: false });
    files.push({ path: `src/index.css`, content: `/* ${cfg.name} — Animation Library */\n@import "./${cfg.name}.css";\n`, needsLlm: false });
    files.push({ path: "demo/index.html", content: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${cfg.name} Demo</title><link rel="stylesheet" href="../src/index.css">
<style>body{font-family:system-ui;padding:2rem;}.box{width:80px;height:80px;background:#3b82f6;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;color:white;font-size:12px;margin:8px;}</style></head>
<body><h1>${cfg.name}</h1>
<div class="${cfg.name}-stagger">
<div class="box ${cfg.name}-animate-fade-in-up">fade-up</div>
<div class="box ${cfg.name}-animate-bounce">bounce</div>
<div class="box ${cfg.name}-animate-float">float</div>
<div class="box ${cfg.name}-animate-pulse">pulse</div>
<div class="box ${cfg.name}-animate-glow">glow</div>
<div class="box ${cfg.name}-animate-spin">spin</div>
</div></body></html>`, needsLlm: false });

  } else if (cfg.type === "tailwind-plugin") {
    files.push({ path: "src/index.js", content: `const plugin = require("tailwindcss/plugin");

module.exports = plugin(function ({ addUtilities, addComponents, matchUtilities, theme }) {
  // Custom utilities
  addUtilities({
    ".text-gradient": {
      "background": "linear-gradient(135deg, var(--tw-gradient-from), var(--tw-gradient-to))",
      "-webkit-background-clip": "text",
      "-webkit-text-fill-color": "transparent",
      "background-clip": "text",
    },
    ".glass": {
      "background": "rgba(255,255,255,0.1)",
      "backdrop-filter": "blur(12px)",
      "-webkit-backdrop-filter": "blur(12px)",
      "border": "1px solid rgba(255,255,255,0.15)",
    },
    ".hide-scrollbar": {
      "-ms-overflow-style": "none",
      "scrollbar-width": "none",
      "&::-webkit-scrollbar": { display: "none" },
    },
  });

  // Custom components
  addComponents({
    ".btn": {
      "display": "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      "padding": theme("spacing.2") + " " + theme("spacing.4"),
      "border-radius": theme("borderRadius.lg"),
      "font-weight": theme("fontWeight.medium"),
      "font-size": theme("fontSize.sm"),
      "transition": "all 150ms ease",
      "cursor": "pointer",
      "&:disabled": { opacity: "0.5", cursor: "not-allowed" },
    },
  });

  // Dynamic utilities
  matchUtilities(
    { "animate-delay": (value) => ({ "animation-delay": value }) },
    { values: { 75: "75ms", 100: "100ms", 150: "150ms", 200: "200ms", 300: "300ms", 500: "500ms", 700: "700ms", 1000: "1000ms" } }
  );

  // TODO: add more utilities/components
}, {
  theme: {
    extend: {
      animation: {
        "fade-in": "fade-in 0.3s ease-out",
        "fade-in-up": "fade-in-up 0.4s ease-out",
        "scale-in": "scale-in 0.3s ease-out",
        "float": "float 3s ease-in-out infinite",
        "glow": "glow 2s ease-in-out infinite",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-in-up": { from: { opacity: "0", transform: "translateY(20px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "scale-in": { from: { opacity: "0", transform: "scale(0.9)" }, to: { opacity: "1", transform: "scale(1)" } },
        "float": { "0%, 100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-10px)" } },
        "glow": { "0%, 100%": { "box-shadow": "0 0 5px rgba(59,130,246,0.3)" }, "50%": { "box-shadow": "0 0 20px rgba(59,130,246,0.6)" } },
      },
    },
  },
});
`, needsLlm: true });

  } else if (cfg.type === "sass-framework") {
    files.push({ path: "src/_variables.scss", content: `// ${cfg.name} — Variables\n\n$${cfg.name}-primary: #3b82f6 !default;\n$${cfg.name}-font-sans: 'Inter', system-ui, sans-serif !default;\n$${cfg.name}-radius: 0.5rem !default;\n$${cfg.name}-shadow: 0 4px 6px rgba(0,0,0,0.1) !default;\n\n// Spacing scale\n$${cfg.name}-space: 0.25rem !default;\n@for $i from 1 through 20 {\n  $${cfg.name}-space-#{$i}: $${cfg.name}-space * $i;\n}\n`, needsLlm: false });
    files.push({ path: "src/_mixins.scss", content: `// ${cfg.name} — Mixins\n\n@mixin ${cfg.name}-respond($bp) {\n  @if $bp == sm { @media (min-width: 640px) { @content; } }\n  @else if $bp == md { @media (min-width: 768px) { @content; } }\n  @else if $bp == lg { @media (min-width: 1024px) { @content; } }\n  @else if $bp == xl { @media (min-width: 1280px) { @content; } }\n}\n\n@mixin ${cfg.name}-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n@mixin ${cfg.name}-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }\n@mixin ${cfg.name}-flex-center { display: flex; align-items: center; justify-content: center; }\n`, needsLlm: false });
    files.push({ path: "src/index.scss", content: `// ${cfg.name}\n@import "variables";\n@import "mixins";\n\n// TODO: add component styles\n`, needsLlm: true });

  } else if (cfg.type === "postcss-plugin") {
    files.push({ path: "src/index.js", content: `/**\n * ${cfg.name} — PostCSS Plugin\n */\nmodule.exports = (opts = {}) => {\n  return {\n    postcssPlugin: "${cfg.name}",\n    Declaration(decl) {\n      // TODO: transform declarations\n    },\n    Rule(rule) {\n      // TODO: transform rules\n    },\n  };\n};\nmodule.exports.postcss = true;\n`, needsLlm: true });
  }

  // package.json
  const devDeps: Record<string, string> = {};
  if (cfg.preprocessor === "scss") devDeps["sass"] = "*";
  if (cfg.preprocessor === "postcss") { devDeps["postcss"] = "*"; devDeps["postcss-cli"] = "*"; devDeps["autoprefixer"] = "*"; devDeps["cssnano"] = "*"; }
  if (cfg.hasTailwind) { devDeps["tailwindcss"] = "*"; }
  if (cfg.type === "tailwind-plugin") { devDeps["tailwindcss"] = "*"; }
  devDeps["lightningcss-cli"] = "*";

  files.push({ path: "package.json", content: JSON.stringify({
    name: cfg.name,
    version: "0.1.0",
    main: cfg.type === "tailwind-plugin" || cfg.type === "postcss-plugin" ? "src/index.js" : `dist/${cfg.name}.css`,
    style: `dist/${cfg.name}.css`,
    files: ["dist", "src"],
    scripts: {
      build: cfg.preprocessor === "scss"
        ? `sass src/index.scss dist/${cfg.name}.css && lightningcss --minify --bundle dist/${cfg.name}.css -o dist/${cfg.name}.min.css`
        : `cat src/index.css | lightningcss --minify --bundle - -o dist/${cfg.name}.min.css && cp src/index.css dist/${cfg.name}.css`,
      dev: "npx live-server demo",
      watch: cfg.preprocessor === "scss" ? `sass --watch src/index.scss dist/${cfg.name}.css` : `echo "edit src/*.css and reload demo"`,
    },
    devDependencies: devDeps,
  }, null, 2), needsLlm: false });

  // Extras
  files.push({ path: ".gitignore", content: "node_modules/\ndist/\n*.log\n", needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nCSS ${cfg.type.replace(/-/g, " ")}. Built with KCode.\n\n## Install\n\`\`\`bash\nnpm install ${cfg.name}\n\`\`\`\n\n## Usage\n\`\`\`html\n<link rel="stylesheet" href="node_modules/${cfg.name}/dist/${cfg.name}.min.css">\n\`\`\`\n\n## Development\n\`\`\`bash\nnpm install\nnpm run dev\nnpm run build\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `CSS ${cfg.type}. ${m} files machine. USER: "${userRequest}"` };
}
