// KCode - Image Generation Tool
// Generates images via ComfyUI running locally (part of Kulvex stack).
// Supports Flux, SDXL, and other models available in the local ComfyUI instance.

import type { ToolDefinition, ToolResult } from "../core/types";
import { log } from "../core/logger";

// ─── Constants ───────────────────────────────────────────────────

const COMFYUI_BASE = process.env.COMFYUI_URL ?? "http://localhost:8188";
const KULVEX_API_BASE = process.env.KULVEX_API_BASE ?? "http://localhost:9100";
const GENERATION_TIMEOUT = 120_000; // 2 minutes

// ─── Tool Definition ────────────────────────────────────────────

export const imageGenDefinition: ToolDefinition = {
  name: "ImageGen",
  description: `Generate images using the local ComfyUI instance (GPU-powered, 100% local).

Use cases: UI mockups, diagrams, concept art, reference images, logos, icons.

Parameters:
- prompt: Text description of the image to generate
- negative_prompt: What to avoid in the image (optional)
- width: Image width (default 1024)
- height: Image height (default 1024)
- steps: Sampling steps, more = better quality but slower (default 20)
- output: Output file path (default: /tmp/kcode-gen-{timestamp}.png)
- model: Model to use: "flux" (default), "sdxl", "sd15"

Requires ComfyUI running locally (port 8188) or Kulvex API (port 9100).`,
  input_schema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text description of the image" },
      negative_prompt: { type: "string", description: "What to avoid" },
      width: { type: "number", description: "Width in pixels (default 1024)" },
      height: { type: "number", description: "Height in pixels (default 1024)" },
      steps: { type: "number", description: "Sampling steps (default 20)" },
      output: { type: "string", description: "Output file path" },
      model: { type: "string", description: "Model: flux, sdxl, sd15", enum: ["flux", "sdxl", "sd15"] },
    },
    required: ["prompt"],
  },
};

// ─── ComfyUI Workflow ───────────────────────────────────────────

function buildFluxWorkflow(params: {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
}): Record<string, any> {
  // Minimal Flux txt2img workflow for ComfyUI
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: params.seed,
        steps: params.steps,
        cfg: 1.0,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1.0,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "flux1-dev.safetensors" },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: params.width, height: params.height, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.negative_prompt ?? "", clip: ["4", 1] },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "kcode_gen", images: ["8", 0] },
    },
  };
}

// ─── ComfyUI Direct API ─────────────────────────────────────────

async function generateViaComfyUI(params: {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  steps: number;
  output: string;
}): Promise<string> {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const workflow = buildFluxWorkflow({ ...params, seed });

  // Queue the prompt
  const queueResp = await fetch(`${COMFYUI_BASE}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!queueResp.ok) {
    throw new Error(`ComfyUI queue failed: ${queueResp.status}`);
  }

  const { prompt_id } = (await queueResp.json()) as { prompt_id: string };

  // Poll for completion
  const start = Date.now();
  while (Date.now() - start < GENERATION_TIMEOUT) {
    const historyResp = await fetch(`${COMFYUI_BASE}/history/${prompt_id}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (historyResp.ok) {
      const history = (await historyResp.json()) as Record<string, any>;
      const entry = history[prompt_id];
      if (entry?.outputs?.["9"]?.images?.[0]) {
        const img = entry.outputs["9"].images[0];
        const filename = img.filename;

        // Download the image
        const imgResp = await fetch(`${COMFYUI_BASE}/view?filename=${filename}`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (imgResp.ok) {
          const buffer = await imgResp.arrayBuffer();
          await Bun.write(params.output, buffer);
          return params.output;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("Image generation timed out");
}

// ─── Kulvex API Fallback ────────────────────────────────────────

async function generateViaKulvex(params: {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  steps: number;
  model: string;
}): Promise<string> {
  const resp = await fetch(`${KULVEX_API_BASE}/api/image-gen/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.KULVEX_API_KEY ? { Authorization: `Bearer ${process.env.KULVEX_API_KEY}` } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(GENERATION_TIMEOUT),
  });

  if (!resp.ok) {
    throw new Error(`Kulvex image-gen failed: ${resp.status}`);
  }

  const data = (await resp.json()) as any;
  return data.path ?? data.url ?? "Image generated (check Kulvex gallery)";
}

// ─── Executor ───────────────────────────────────────────────────

export async function executeImageGen(input: Record<string, unknown>): Promise<ToolResult> {
  const { requirePro } = await import("../core/pro.js");
  await requirePro("image-gen");

  const {
    prompt,
    negative_prompt,
    width = 1024,
    height = 1024,
    steps = 20,
    output = `/tmp/kcode-gen-${Date.now()}.png`,
    model = "flux",
  } = input as {
    prompt: string;
    negative_prompt?: string;
    width?: number;
    height?: number;
    steps?: number;
    output?: string;
    model?: string;
  };

  if (!prompt) {
    return { tool_use_id: "", content: "prompt is required", is_error: true };
  }

  // Try ComfyUI first
  try {
    const healthResp = await fetch(`${COMFYUI_BASE}/system_stats`, {
      signal: AbortSignal.timeout(3000),
    });
    if (healthResp.ok) {
      log.info("tool", `ImageGen: Using ComfyUI at ${COMFYUI_BASE}`);
      const path = await generateViaComfyUI({ prompt, negative_prompt, width, height, steps, output });
      return { tool_use_id: "", content: `Image generated: ${path}\nPrompt: ${prompt}\nSize: ${width}x${height}, Steps: ${steps}` };
    }
  } catch {
    // ComfyUI not available
  }

  // Try Kulvex API
  try {
    const healthResp = await fetch(`${KULVEX_API_BASE}/api/monitoring/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (healthResp.ok) {
      log.info("tool", `ImageGen: Using Kulvex API at ${KULVEX_API_BASE}`);
      const result = await generateViaKulvex({ prompt, negative_prompt, width, height, steps, model });
      return { tool_use_id: "", content: `Image generated: ${result}\nPrompt: ${prompt}` };
    }
  } catch {
    // Kulvex not available
  }

  return {
    tool_use_id: "",
    content: `Neither ComfyUI (${COMFYUI_BASE}) nor Kulvex API (${KULVEX_API_BASE}) is reachable. Start ComfyUI or the Kulvex backend to use image generation.`,
    is_error: true,
  };
}
