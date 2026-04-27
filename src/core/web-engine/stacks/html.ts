// KCode - Plain HTML/CSS/JS Stack Templates
// No framework, no build step. Just open in browser.

import type { DetectedIntent } from "../detector";
import { CINEMATIC_CSS, PALETTES, paletteToCSS, REVEAL_SCRIPT } from "../effects";
import type { FileTemplate } from "../templates";

export function htmlBase(intent: DetectedIntent): FileTemplate[] {
  return [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${intent.name}</title>
  <meta name="description" content="Built with KCode" />
  <meta property="og:title" content="${intent.name}" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body class="antialiased noise">
  <div class="aurora-bg"></div>

  <!-- NAV -->
  <nav id="nav" class="fixed top-0 left-0 right-0 z-50 py-6 transition-all">
    <div class="container mx-auto px-6 flex items-center justify-between">
      <a href="/" class="text-xl font-bold text-white">${intent.name}</a>
      <div class="flex items-center gap-6 text-sm text-gray-400">
        <a href="#features" class="hover:text-white transition">Features</a>
        <a href="#pricing" class="hover:text-white transition">Pricing</a>
        <a href="#" class="px-5 py-2 bg-white text-black rounded-full font-medium hover:bg-gray-200 transition">Get Started</a>
      </div>
    </div>
  </nav>

  <!-- HERO -->
  <section class="relative min-h-screen flex items-center justify-center px-6 overflow-hidden">
    <div class="mesh-gradient absolute inset-0"></div>
    <div class="absolute top-1/4 left-1/4 w-72 h-72 bg-indigo-500/20 rounded-full blur-3xl float"></div>
    <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/15 rounded-full blur-3xl float-delay-1"></div>
    <div class="relative z-10 max-w-4xl text-center reveal">
      <h1 class="text-5xl md:text-7xl font-bold tracking-tight">
        <span class="gradient-text"><!-- HEADLINE --></span>
      </h1>
      <p class="mt-8 text-xl text-gray-400 max-w-2xl mx-auto"><!-- SUBHEADLINE --></p>
      <div class="mt-12 flex gap-4 justify-center">
        <a href="#" class="magnetic-btn px-8 py-4 bg-white text-black rounded-full font-semibold text-lg">Get Started →</a>
        <a href="#" class="px-8 py-4 glass rounded-full text-white text-lg">Learn More</a>
      </div>
    </div>
  </section>

  <!-- FEATURES -->
  <section id="features" class="py-32 px-6">
    <div class="container mx-auto max-w-6xl">
      <div class="text-center mb-20 reveal">
        <span class="text-sm font-medium text-indigo-400 tracking-widest uppercase">Features</span>
        <h2 class="text-4xl font-bold mt-4"><!-- FEATURES TITLE --></h2>
      </div>
      <div class="grid md:grid-cols-3 gap-6 stagger">
        <!-- FEATURE CARDS (glass-card spotlight) -->
      </div>
    </div>
  </section>

  <!-- FOOTER -->
  <footer class="border-t border-white/5 py-12 px-6">
    <div class="container mx-auto max-w-6xl flex justify-between items-center">
      <p class="text-sm text-gray-500">© ${new Date().getFullYear()} ${intent.name}</p>
      <div class="flex gap-6 text-sm text-gray-500">
        <a href="#" class="hover:text-white transition">Twitter</a>
        <a href="#" class="hover:text-white transition">GitHub</a>
      </div>
    </div>
  </footer>

  <script src="app.js"></script>
</body>
</html>
`,
      needsLlm: true,
    },
    {
      path: "styles.css",
      content: `/* Reset */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* System font stack */
body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; }

/* Container */
.container { width: 100%; max-width: 1200px; margin: 0 auto; }

/* Utilities */
.text-center { text-align: center; }
.flex { display: flex; }
.grid { display: grid; }
.items-center { align-items: center; }
.justify-center { justify-content: center; }
.justify-between { justify-content: space-between; }
.gap-4 { gap: 1rem; }
.gap-6 { gap: 1.5rem; }
.gap-8 { gap: 2rem; }
.mt-4 { margin-top: 1rem; }
.mt-8 { margin-top: 2rem; }
.mt-12 { margin-top: 3rem; }
.mb-4 { margin-bottom: 1rem; }
.mb-8 { margin-bottom: 2rem; }
.mb-16 { margin-bottom: 4rem; }
.mb-20 { margin-bottom: 5rem; }
.mx-auto { margin-left: auto; margin-right: auto; }
.px-6 { padding-left: 1.5rem; padding-right: 1.5rem; }
.py-12 { padding-top: 3rem; padding-bottom: 3rem; }
.py-24 { padding-top: 6rem; padding-bottom: 6rem; }
.py-32 { padding-top: 8rem; padding-bottom: 8rem; }
.p-8 { padding: 2rem; }
.max-w-2xl { max-width: 42rem; }
.max-w-4xl { max-width: 56rem; }
.max-w-6xl { max-width: 72rem; }
.min-h-screen { min-height: 100vh; }
.relative { position: relative; }
.absolute { position: absolute; }
.fixed { position: fixed; }
.inset-0 { top:0; right:0; bottom:0; left:0; }
.z-10 { z-index: 10; }
.z-50 { z-index: 50; }
.overflow-hidden { overflow: hidden; }
.rounded-full { border-radius: 9999px; }
.text-white { color: #fff; }
.text-sm { font-size: 0.875rem; }
.text-lg { font-size: 1.125rem; }
.text-xl { font-size: 1.25rem; }
.text-3xl { font-size: 1.875rem; }
.text-4xl { font-size: 2.25rem; }
.text-5xl { font-size: 3rem; }
.font-bold { font-weight: 700; }
.font-semibold { font-weight: 600; }
.font-medium { font-weight: 500; }
.tracking-tight { letter-spacing: -0.025em; }
.uppercase { text-transform: uppercase; }
.transition { transition: all 0.3s ease; }

@media (min-width: 768px) {
  .md\\:grid-cols-3 { grid-template-columns: repeat(3, 1fr); }
  .md\\:text-7xl { font-size: 4.5rem; }
}

${paletteToCSS(PALETTES.midnight)}
${CINEMATIC_CSS}
`,
      needsLlm: false,
    },
    {
      path: "app.js",
      content: `// KCode cinematic effects
${REVEAL_SCRIPT}

// Nav glass on scroll
window.addEventListener('scroll', () => {
  const nav = document.getElementById('nav');
  if (nav) {
    nav.classList.toggle('glass', window.scrollY > 20);
    nav.style.paddingTop = window.scrollY > 20 ? '0.75rem' : '1.5rem';
    nav.style.paddingBottom = window.scrollY > 20 ? '0.75rem' : '1.5rem';
  }
});
`,
      needsLlm: false,
    },
    {
      path: ".gitignore",
      content: ".DS_Store\nnode_modules/\n",
      needsLlm: false,
    },
    {
      path: "README.md",
      content: `# ${intent.name}\n\nBuilt with KCode. No build step required — just open index.html.\n`,
      needsLlm: false,
    },
  ];
}
