// KCode - Astro Stack Templates
// Ideal for: blogs, portfolios, docs, content-heavy static sites

import { CINEMATIC_CSS, REVEAL_SCRIPT, PALETTES, paletteToCSS } from "../effects";
import type { DetectedIntent } from "../detector";
import type { FileTemplate } from "../templates";

export function astroBase(intent: DetectedIntent): FileTemplate[] {
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: intent.name,
        type: "module",
        version: "0.1.0",
        scripts: {
          dev: "astro dev",
          build: "astro build",
          preview: "astro preview",
        },
        dependencies: {
          astro: "^5.7.0",
          "@astrojs/mdx": "^4.0.0",
          tailwindcss: "^4.0.0",
          "@tailwindcss/vite": "^4.0.0",
        },
      }, null, 2),
      needsLlm: false,
    },
    {
      path: "astro.config.mjs",
      content: `import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';

export default defineConfig({
  integrations: [mdx()],
  vite: { plugins: [tailwindcss()] },
  site: 'https://${intent.name}.com',
});
`,
      needsLlm: false,
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify({
        extends: "astro/tsconfigs/strict",
        compilerOptions: { jsx: "preserve" },
      }, null, 2),
      needsLlm: false,
    },
    {
      path: "src/styles/global.css",
      content: `@import "tailwindcss";
${paletteToCSS(PALETTES.midnight)}
${CINEMATIC_CSS}
`,
      needsLlm: false,
    },
    {
      path: "src/layouts/Base.astro",
      content: `---
interface Props { title: string; description?: string; }
const { title, description = "Built with KCode" } = Astro.props;
---
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content={description} />
  <meta property="og:title" content={title} />
  <meta property="og:description" content={description} />
  <title>{title}</title>
  <link rel="stylesheet" href="/src/styles/global.css" />
</head>
<body class="antialiased noise">
  <div class="aurora-bg"></div>
  <slot />
  <script>${REVEAL_SCRIPT}</script>
</body>
</html>
`,
      needsLlm: false,
    },
    {
      path: "src/components/Nav.astro",
      content: `<nav id="nav" class="fixed top-0 left-0 right-0 z-50 py-6 transition-all duration-300">
  <div class="max-w-6xl mx-auto px-6 flex items-center justify-between">
    <a href="/" class="text-xl font-bold text-white">${intent.name}</a>
    <div class="hidden md:flex items-center gap-8 text-sm text-gray-400">
      <a href="#features" class="hover:text-white transition">Features</a>
      <a href="/blog" class="hover:text-white transition">Blog</a>
      <a href="/about" class="hover:text-white transition">About</a>
    </div>
  </div>
</nav>
<script>
  window.addEventListener('scroll', () => {
    document.getElementById('nav')?.classList.toggle('glass', window.scrollY > 20);
    document.getElementById('nav')?.classList.toggle('py-3', window.scrollY > 20);
    document.getElementById('nav')?.classList.toggle('py-6', window.scrollY <= 20);
  });
</script>
`,
      needsLlm: false,
    },
    {
      path: "src/components/Footer.astro",
      content: `<footer class="border-t border-white/5 py-12 px-6">
  <div class="max-w-6xl mx-auto flex justify-between items-center">
    <p class="text-sm text-gray-500">© ${new Date().getFullYear()} ${intent.name}</p>
    <div class="flex gap-6 text-sm text-gray-500">
      <a href="#" class="hover:text-white transition">Twitter</a>
      <a href="#" class="hover:text-white transition">GitHub</a>
    </div>
  </div>
</footer>
`,
      needsLlm: false,
    },
  ];
}

export function astroBlogPages(intent: DetectedIntent): FileTemplate[] {
  return [
    {
      path: "src/pages/index.astro",
      content: `---
import Base from '../layouts/Base.astro';
import Nav from '../components/Nav.astro';
import Footer from '../components/Footer.astro';
---
<Base title="${intent.name}">
  <Nav />
  <main>
    <!-- HERO -->
    <section class="relative min-h-screen flex items-center justify-center px-6 overflow-hidden">
      <div class="absolute inset-0 mesh-gradient"></div>
      <div class="relative z-10 max-w-4xl text-center reveal">
        <h1 class="text-6xl md:text-8xl font-bold">
          <span class="gradient-text"><!-- HEADLINE --></span>
        </h1>
        <p class="mt-8 text-xl text-gray-400 max-w-2xl mx-auto"><!-- SUBHEADLINE --></p>
      </div>
    </section>

    <!-- RECENT POSTS -->
    <section class="py-32 px-6">
      <div class="max-w-4xl mx-auto">
        <h2 class="text-3xl font-bold mb-12 reveal">Latest Posts</h2>
        <!-- Posts will be generated from content/ -->
      </div>
    </section>
  </main>
  <Footer />
</Base>
`,
      needsLlm: true,
    },
    {
      path: "src/pages/about.astro",
      content: `---
import Base from '../layouts/Base.astro';
import Nav from '../components/Nav.astro';
import Footer from '../components/Footer.astro';
---
<Base title="About — ${intent.name}">
  <Nav />
  <main class="pt-32 px-6">
    <div class="max-w-3xl mx-auto reveal">
      <h1 class="text-4xl font-bold gradient-text">About</h1>
      <div class="mt-8 prose prose-invert prose-lg">
        <!-- ABOUT CONTENT -->
      </div>
    </div>
  </main>
  <Footer />
</Base>
`,
      needsLlm: true,
    },
    {
      path: "src/content/config.ts",
      content: `import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    draft: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
  }),
});

export const collections = { blog };
`,
      needsLlm: false,
    },
    {
      path: "src/content/blog/hello-world.mdx",
      content: `---
title: "Hello World"
description: "First post on ${intent.name}"
date: ${new Date().toISOString().split("T")[0]}
tags: ["intro"]
---

# Hello World

Welcome to ${intent.name}. This is the first post.
`,
      needsLlm: true,
    },
  ];
}

export function astroPortfolioPages(intent: DetectedIntent): FileTemplate[] {
  return [
    {
      path: "src/pages/index.astro",
      content: `---
import Base from '../layouts/Base.astro';
import Nav from '../components/Nav.astro';
import Footer from '../components/Footer.astro';
---
<Base title="${intent.name}">
  <Nav />
  <main>
    <section class="relative min-h-screen flex items-center justify-center px-6 overflow-hidden">
      <div class="absolute inset-0 mesh-gradient"></div>
      <div class="absolute top-1/4 left-1/4 w-72 h-72 bg-indigo-500/20 rounded-full blur-3xl float"></div>
      <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/15 rounded-full blur-3xl float-delay-1"></div>
      <div class="relative z-10 max-w-4xl text-center reveal">
        <div class="w-24 h-24 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 mx-auto mb-8 flex items-center justify-center text-4xl">
          <!-- AVATAR/EMOJI -->
        </div>
        <h1 class="text-5xl md:text-7xl font-bold">
          <span class="gradient-text"><!-- NAME --></span>
        </h1>
        <p class="mt-6 text-xl text-gray-400"><!-- ROLE/TITLE --></p>
        <div class="mt-8 flex gap-4 justify-center">
          <a href="#projects" class="magnetic-btn px-8 py-3 bg-white text-black rounded-full font-medium">View Work</a>
          <a href="#contact" class="px-8 py-3 glass rounded-full text-white">Contact</a>
        </div>
      </div>
    </section>

    <section id="projects" class="py-32 px-6">
      <div class="max-w-6xl mx-auto">
        <h2 class="text-3xl font-bold mb-16 reveal">Projects</h2>
        <div class="grid md:grid-cols-2 gap-8 stagger">
          <!-- PROJECT CARDS -->
        </div>
      </div>
    </section>

    <section id="contact" class="py-32 px-6">
      <div class="max-w-xl mx-auto text-center reveal">
        <h2 class="text-3xl font-bold gradient-text">Get in Touch</h2>
        <p class="mt-4 text-gray-400"><!-- CONTACT TEXT --></p>
        <a href="mailto:hello@example.com" class="mt-8 inline-block magnetic-btn px-10 py-4 bg-white text-black rounded-full font-semibold text-lg">
          Say Hello →
        </a>
      </div>
    </section>
  </main>
  <Footer />
</Base>
`,
      needsLlm: true,
    },
  ];
}
