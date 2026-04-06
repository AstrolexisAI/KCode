// KCode - SvelteKit Stack Templates

import { CINEMATIC_CSS, REVEAL_SCRIPT, PALETTES, paletteToCSS } from "../effects";
import type { DetectedIntent } from "../detector";
import type { FileTemplate } from "../templates";

export function svelteBase(intent: DetectedIntent): FileTemplate[] {
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: intent.name,
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "vite dev",
          build: "vite build",
          preview: "vite preview",
        },
        devDependencies: {
          "@sveltejs/adapter-auto": "^4.0.0",
          "@sveltejs/kit": "^2.15.0",
          "@sveltejs/vite-plugin-svelte": "^5.0.0",
          svelte: "^5.0.0",
          typescript: "^5.8.0",
          vite: "^6.0.0",
          tailwindcss: "^4.0.0",
          "@tailwindcss/vite": "^4.0.0",
        },
      }, null, 2),
      needsLlm: false,
    },
    {
      path: "svelte.config.js",
      content: `import adapter from '@sveltejs/adapter-auto';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: { adapter: adapter() }
};

export default config;
`,
      needsLlm: false,
    },
    {
      path: "vite.config.ts",
      content: `import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()]
});
`,
      needsLlm: false,
    },
    {
      path: "src/app.css",
      content: `@import "tailwindcss";
${paletteToCSS(PALETTES.midnight)}
${CINEMATIC_CSS}
`,
      needsLlm: false,
    },
    {
      path: "src/app.html",
      content: `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  %sveltekit.head%
</head>
<body class="antialiased noise" data-sveltekit-preload-data="hover">
  <div class="aurora-bg"></div>
  %sveltekit.body%
</body>
</html>
`,
      needsLlm: false,
    },
    {
      path: "src/routes/+layout.svelte",
      content: `<script>
  import '../app.css';
  import { onMount } from 'svelte';

  onMount(() => {
    ${REVEAL_SCRIPT}
  });
</script>

<slot />
`,
      needsLlm: false,
    },
    {
      path: "src/routes/+page.svelte",
      content: `<script>
  import Hero from '$lib/components/Hero.svelte';
  import Features from '$lib/components/Features.svelte';
  import Footer from '$lib/components/Footer.svelte';
</script>

<svelte:head>
  <title>${intent.name}</title>
  <meta name="description" content="Built with KCode" />
</svelte:head>

<main>
  <Hero />
  <Features />
  <Footer />
</main>
`,
      needsLlm: true,
    },
    {
      path: "src/lib/components/Hero.svelte",
      content: `<section class="relative min-h-screen flex items-center justify-center px-6 overflow-hidden">
  <div class="absolute inset-0 mesh-gradient"></div>
  <div class="absolute top-1/4 left-1/4 w-72 h-72 bg-indigo-500/20 rounded-full blur-3xl float"></div>
  <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/15 rounded-full blur-3xl float-delay-1"></div>

  <div class="relative z-10 max-w-4xl text-center reveal">
    <h1 class="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight">
      <span class="gradient-text"><!-- HEADLINE --></span>
    </h1>
    <p class="mt-8 text-lg md:text-xl text-gray-400 max-w-2xl mx-auto">
      <!-- SUBHEADLINE -->
    </p>
    <div class="mt-12 flex gap-4 justify-center">
      <a href="#" class="magnetic-btn px-8 py-4 bg-white text-black rounded-full font-semibold text-lg">
        Get Started →
      </a>
      <a href="#" class="px-8 py-4 glass rounded-full text-white text-lg">
        Learn More
      </a>
    </div>
  </div>
</section>
`,
      needsLlm: true,
    },
    {
      path: "src/lib/components/Features.svelte",
      content: `<script>
  const features = [
    { title: "Feature 1", desc: "Description", icon: "⚡" },
    { title: "Feature 2", desc: "Description", icon: "🔒" },
    { title: "Feature 3", desc: "Description", icon: "🚀" },
  ];
</script>

<section class="py-32 px-6">
  <div class="max-w-6xl mx-auto">
    <div class="text-center mb-20 reveal">
      <h2 class="text-4xl font-bold">Features</h2>
    </div>
    <div class="grid md:grid-cols-3 gap-6 stagger">
      {#each features as f, i}
        <div class="reveal glass-card p-8 spotlight">
          <div class="text-3xl mb-4">{f.icon}</div>
          <h3 class="text-xl font-semibold mb-2 text-white">{f.title}</h3>
          <p class="text-gray-400">{f.desc}</p>
        </div>
      {/each}
    </div>
  </div>
</section>
`,
      needsLlm: true,
    },
    {
      path: "src/lib/components/Footer.svelte",
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
