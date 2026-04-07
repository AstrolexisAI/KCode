// KCode - Web Engine: Cinematic Effects Library
//
// Pre-built visual effects that make websites look premium.
// Machine injects these — zero LLM tokens for animations.

export interface Effect {
  name: string;
  css: string;
  jsInit?: string;
  description: string;
}

// ── CSS Animations ─────────────────────────────────────────────

export const CINEMATIC_CSS = `
/* ═══ KCode Cinematic Effects ═══ */

/* Smooth scroll */
html { scroll-behavior: smooth; }

/* Selection color */
::selection {
  background: rgba(99, 102, 241, 0.3);
  color: inherit;
}

/* ── Fade & Slide Reveals ───────────────────────── */

.reveal {
  opacity: 0;
  transform: translateY(40px);
  transition: opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.8s cubic-bezier(0.16, 1, 0.3, 1);
}

.reveal.visible {
  opacity: 1;
  transform: translateY(0);
}

.reveal-left {
  opacity: 0;
  transform: translateX(-60px);
  transition: opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.8s cubic-bezier(0.16, 1, 0.3, 1);
}

.reveal-left.visible {
  opacity: 1;
  transform: translateX(0);
}

.reveal-right {
  opacity: 0;
  transform: translateX(60px);
  transition: opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.8s cubic-bezier(0.16, 1, 0.3, 1);
}

.reveal-right.visible { opacity: 1; transform: translateX(0); }

.reveal-scale {
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 0.6s ease, transform 0.6s ease;
}

.reveal-scale.visible { opacity: 1; transform: scale(1); }

/* Stagger children */
.stagger > * { transition-delay: calc(var(--i, 0) * 0.1s); }

/* ── Gradient Animations ────────────────────────── */

@keyframes gradient-shift {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}

.gradient-animate {
  background-size: 200% 200%;
  animation: gradient-shift 8s ease infinite;
}

.gradient-text {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
  background-size: 200% 200%;
  animation: gradient-shift 5s ease infinite;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* ── Glow Effects ───────────────────────────────── */

.glow {
  box-shadow: 0 0 20px rgba(99, 102, 241, 0.15),
              0 0 60px rgba(99, 102, 241, 0.1);
}

.glow-hover:hover {
  box-shadow: 0 0 30px rgba(99, 102, 241, 0.3),
              0 0 80px rgba(99, 102, 241, 0.15);
  transition: box-shadow 0.3s ease;
}

.glow-text {
  text-shadow: 0 0 40px rgba(99, 102, 241, 0.5),
               0 0 80px rgba(99, 102, 241, 0.2);
}

/* ── Aurora / Northern Lights Background ────────── */

@keyframes aurora {
  0%, 100% {
    background-position: 50% 50%, 50% 50%;
    filter: blur(80px);
  }
  25% {
    background-position: 0% 0%, 100% 100%;
    filter: blur(100px);
  }
  50% {
    background-position: 100% 100%, 0% 0%;
    filter: blur(80px);
  }
  75% {
    background-position: 100% 0%, 0% 100%;
    filter: blur(90px);
  }
}

.aurora-bg {
  position: fixed;
  inset: 0;
  z-index: -1;
  opacity: 0.3;
  background:
    radial-gradient(ellipse at 50% 50%, #6366f1, transparent 70%),
    radial-gradient(ellipse at 80% 20%, #a855f7, transparent 70%),
    radial-gradient(ellipse at 20% 80%, #06b6d4, transparent 70%);
  animation: aurora 20s ease infinite;
}

/* ── Floating Particles ─────────────────────────── */

@keyframes float {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  25% { transform: translateY(-20px) rotate(5deg); }
  50% { transform: translateY(-10px) rotate(-3deg); }
  75% { transform: translateY(-25px) rotate(2deg); }
}

.float { animation: float 6s ease-in-out infinite; }
.float-delay-1 { animation-delay: -2s; }
.float-delay-2 { animation-delay: -4s; }
.float-delay-3 { animation-delay: -1s; }

/* ── Glass Morphism ─────────────────────────────── */

.glass {
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.glass-card {
  background: rgba(255, 255, 255, 0.03);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  transition: all 0.3s ease;
}

.glass-card:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.15);
  transform: translateY(-4px);
}

/* ── Mesh Gradient Background ───────────────────── */

.mesh-gradient {
  background-color: #0a0a0a;
  background-image:
    radial-gradient(at 40% 20%, #1e3a5f 0px, transparent 50%),
    radial-gradient(at 80% 0%, #4c1d95 0px, transparent 50%),
    radial-gradient(at 0% 50%, #064e3b 0px, transparent 50%),
    radial-gradient(at 80% 50%, #1e1b4b 0px, transparent 50%),
    radial-gradient(at 0% 100%, #312e81 0px, transparent 50%),
    radial-gradient(at 80% 100%, #0c4a6e 0px, transparent 50%);
}

/* ── Spotlight / Cursor Glow ────────────────────── */

.spotlight {
  position: relative;
  overflow: hidden;
}

.spotlight::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    600px circle at var(--mouse-x, 50%) var(--mouse-y, 50%),
    rgba(99, 102, 241, 0.06),
    transparent 40%
  );
  pointer-events: none;
  z-index: 1;
}

/* ── Text Shimmer ───────────────────────────────── */

@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.text-shimmer {
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0) 0%,
    rgba(255,255,255,0.4) 50%,
    rgba(255,255,255,0) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 3s ease-in-out infinite;
  -webkit-background-clip: text;
  background-clip: text;
}

/* ── Parallax Layers ────────────────────────────── */

.parallax-container {
  perspective: 1000px;
  overflow: hidden;
}

.parallax-slow { transform: translateZ(-200px) scale(1.2); }
.parallax-fast { transform: translateZ(100px) scale(0.9); }

/* ── Magnetic Button ────────────────────────────── */

.magnetic-btn {
  position: relative;
  transition: transform 0.3s cubic-bezier(0.2, 0, 0, 1);
}

.magnetic-btn:hover {
  transform: scale(1.05);
}

.magnetic-btn::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: inherit;
  background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899);
  z-index: -1;
  opacity: 0;
  transition: opacity 0.3s ease;
  filter: blur(12px);
}

.magnetic-btn:hover::after { opacity: 1; }

/* ── Number Counter ─────────────────────────────── */

@property --num {
  syntax: '<integer>';
  initial-value: 0;
  inherits: false;
}

.counter {
  transition: --num 2s ease-out;
  counter-reset: num var(--num);
}

.counter::after {
  content: counter(num);
}

/* ── Marquee / Infinite Scroll ──────────────────── */

@keyframes marquee {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}

.marquee {
  display: flex;
  overflow: hidden;
  white-space: nowrap;
}

.marquee-content {
  display: flex;
  animation: marquee 30s linear infinite;
}

/* ── Noise Texture Overlay ──────────────────────── */

.noise::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 9999;
  pointer-events: none;
  opacity: 0.03;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
}

/* ── Border Gradient ────────────────────────────── */

.border-gradient {
  position: relative;
  background: #0a0a0a;
  border-radius: 16px;
}

.border-gradient::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899, #06b6d4);
  z-index: -1;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  -webkit-mask-composite: xor;
  padding: 1px;
}

/* ── Smooth Image Reveal ────────────────────────── */

.img-reveal {
  clip-path: inset(100% 0 0 0);
  transition: clip-path 1s cubic-bezier(0.16, 1, 0.3, 1);
}

.img-reveal.visible {
  clip-path: inset(0 0 0 0);
}

/* ── Dark Mode Transitions ──────────────────────── */

* { transition: background-color 0.3s ease, border-color 0.3s ease, color 0.2s ease; }
`;

// ── JavaScript for Scroll Reveal ───────────────────────────────

export const REVEAL_SCRIPT = `
// Scroll reveal observer
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, index) => {
    if (entry.isIntersecting) {
      entry.target.style.setProperty('--i', index);
      entry.target.classList.add('visible');
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale, .img-reveal').forEach(el => {
  revealObserver.observe(el);
});

// Stagger children
document.querySelectorAll('.stagger').forEach(container => {
  Array.from(container.children).forEach((child, i) => {
    child.style.setProperty('--i', i);
  });
});

// Spotlight cursor effect
document.querySelectorAll('.spotlight').forEach(el => {
  el.addEventListener('mousemove', (e) => {
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mouse-x', ((e.clientX - rect.left) / rect.width * 100) + '%');
    el.style.setProperty('--mouse-y', ((e.clientY - rect.top) / rect.height * 100) + '%');
  });
});

// Smooth counter animation
document.querySelectorAll('[data-count]').forEach(el => {
  const target = parseInt(el.dataset.count);
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        el.style.setProperty('--num', target);
        observer.unobserve(el);
      }
    });
  });
  observer.observe(el);
});

// Parallax on scroll
let ticking = false;
window.addEventListener('scroll', () => {
  if (!ticking) {
    requestAnimationFrame(() => {
      const scrolled = window.scrollY;
      document.querySelectorAll('[data-parallax]').forEach(el => {
        const speed = parseFloat(el.dataset.parallax) || 0.5;
        el.style.transform = 'translateY(' + (scrolled * speed) + 'px)';
      });
      ticking = false;
    });
    ticking = true;
  }
});
`;

// ── Color Palettes ─────────────────────────────────────────────

export interface ColorPalette {
  name: string;
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  textDim: string;
  gradient: string;
}

export const PALETTES: Record<string, ColorPalette> = {
  midnight: {
    name: "Midnight",
    primary: "#6366f1",
    secondary: "#a855f7",
    accent: "#06b6d4",
    background: "#030712",
    surface: "#111827",
    text: "#f9fafb",
    textDim: "#9ca3af",
    gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  },
  aurora: {
    name: "Aurora",
    primary: "#10b981",
    secondary: "#06b6d4",
    accent: "#8b5cf6",
    background: "#0a0f1a",
    surface: "#111827",
    text: "#ecfdf5",
    textDim: "#6ee7b7",
    gradient: "linear-gradient(135deg, #065f46 0%, #0e7490 50%, #7c3aed 100%)",
  },
  sunset: {
    name: "Sunset",
    primary: "#f59e0b",
    secondary: "#ef4444",
    accent: "#ec4899",
    background: "#0c0a09",
    surface: "#1c1917",
    text: "#fef3c7",
    textDim: "#a8a29e",
    gradient: "linear-gradient(135deg, #f59e0b 0%, #ef4444 50%, #ec4899 100%)",
  },
  ocean: {
    name: "Ocean",
    primary: "#0ea5e9",
    secondary: "#6366f1",
    accent: "#14b8a6",
    background: "#020617",
    surface: "#0f172a",
    text: "#e0f2fe",
    textDim: "#64748b",
    gradient: "linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)",
  },
  mono: {
    name: "Mono",
    primary: "#ffffff",
    secondary: "#a1a1aa",
    accent: "#f4f4f5",
    background: "#09090b",
    surface: "#18181b",
    text: "#fafafa",
    textDim: "#71717a",
    gradient: "linear-gradient(135deg, #ffffff 0%, #a1a1aa 100%)",
  },
  neon: {
    name: "Neon",
    primary: "#22d3ee",
    secondary: "#e879f9",
    accent: "#a3e635",
    background: "#020202",
    surface: "#0a0a0a",
    text: "#f0fdfa",
    textDim: "#5eead4",
    gradient: "linear-gradient(135deg, #22d3ee 0%, #e879f9 50%, #a3e635 100%)",
  },
};

/**
 * Generate CSS custom properties for a color palette.
 */
export function paletteToCSS(palette: ColorPalette): string {
  return `
:root {
  --color-primary: ${palette.primary};
  --color-secondary: ${palette.secondary};
  --color-accent: ${palette.accent};
  --color-bg: ${palette.background};
  --color-surface: ${palette.surface};
  --color-text: ${palette.text};
  --color-text-dim: ${palette.textDim};
  --gradient: ${palette.gradient};
}

body {
  background: var(--color-bg);
  color: var(--color-text);
}
`;
}
