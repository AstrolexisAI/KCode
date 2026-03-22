// KCode - Image Generation Tool
// Generates images via cloud APIs: Together AI (Flux) and OpenAI (DALL-E 3/2).

import type { ToolDefinition, ToolResult } from "../core/types";
import { log } from "../core/logger";

// ─── Constants ───────────────────────────────────────────────────

const GENERATION_TIMEOUT = 60_000; // 1 minute

const COST_ESTIMATES: Record<string, string> = {
  flux: "~$0.003/image",
  "dall-e-3": "~$0.04/image",
  "dall-e-2": "~$0.02/image",
};

// ─── Tool Definition ────────────────────────────────────────────

export const imageGenDefinition: ToolDefinition = {
  name: "ImageGen",
  description: `Generate images using cloud APIs: Together AI (Flux) or OpenAI (DALL-E 3/2).

Use cases: UI mockups, diagrams, concept art, reference images, logos, icons.

Parameters:
- prompt: Text description of the image to generate
- width: Image width (default 1024)
- height: Image height (default 1024)
- output: Output file path (default: /tmp/kcode-gen-{timestamp}.png)
- model: Model to use: "flux" (Together AI, default), "dall-e-3" (OpenAI), "dall-e-2" (OpenAI)

Cost per image: Flux ~$0.003, DALL-E 3 ~$0.04, DALL-E 2 ~$0.02.
Requires TOGETHER_API_KEY / KCODE_TOGETHER_API_KEY or OPENAI_API_KEY / KCODE_OPENAI_API_KEY.`,
  input_schema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text description of the image" },
      width: { type: "number", description: "Width in pixels (default 1024)" },
      height: { type: "number", description: "Height in pixels (default 1024)" },
      output: { type: "string", description: "Output file path" },
      model: {
        type: "string",
        description: "Model: flux (Together AI), dall-e-3 (OpenAI), dall-e-2 (OpenAI)",
        enum: ["flux", "dall-e-3", "dall-e-2"],
      },
    },
    required: ["prompt"],
  },
};

// ─── Together AI (Flux) ─────────────────────────────────────────

function getTogetherAPIKey(): string | undefined {
  return process.env.TOGETHER_API_KEY ?? process.env.KCODE_TOGETHER_API_KEY;
}

async function generateViaTogetherAI(params: {
  prompt: string;
  width: number;
  height: number;
  output: string;
}): Promise<string> {
  const apiKey = getTogetherAPIKey();
  if (!apiKey) {
    throw new Error(
      "Together AI API key not found. Set TOGETHER_API_KEY or KCODE_TOGETHER_API_KEY in your environment.",
    );
  }

  log.info("tool", "ImageGen: Generating via Together AI (Flux)");

  const resp = await fetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "black-forest-labs/FLUX.1-schnell",
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      n: 1,
    }),
    signal: AbortSignal.timeout(GENERATION_TIMEOUT),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Together AI request failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { data: { url: string }[] };
  const imageUrl = data.data?.[0]?.url;
  if (!imageUrl) {
    throw new Error("Together AI returned no image URL in response.");
  }

  // Download and save image
  const imgResp = await fetch(imageUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!imgResp.ok) {
    throw new Error(`Failed to download generated image: ${imgResp.status}`);
  }

  const buffer = await imgResp.arrayBuffer();
  await Bun.write(params.output, buffer);

  return params.output;
}

// ─── OpenAI (DALL-E) ────────────────────────────────────────────

function getOpenAIAPIKey(): string | undefined {
  return process.env.OPENAI_API_KEY ?? process.env.KCODE_OPENAI_API_KEY;
}

async function generateViaOpenAI(params: {
  prompt: string;
  width: number;
  height: number;
  output: string;
  model: "dall-e-3" | "dall-e-2";
}): Promise<string> {
  const apiKey = getOpenAIAPIKey();
  if (!apiKey) {
    throw new Error(
      "OpenAI API key not found. Set OPENAI_API_KEY or KCODE_OPENAI_API_KEY in your environment.",
    );
  }

  log.info("tool", `ImageGen: Generating via OpenAI (${params.model})`);

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      size: `${params.width}x${params.height}`,
      n: 1,
      quality: "standard",
    }),
    signal: AbortSignal.timeout(GENERATION_TIMEOUT),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenAI request failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { data: { url: string }[] };
  const imageUrl = data.data?.[0]?.url;
  if (!imageUrl) {
    throw new Error("OpenAI returned no image URL in response.");
  }

  // Download and save image
  const imgResp = await fetch(imageUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!imgResp.ok) {
    throw new Error(`Failed to download generated image: ${imgResp.status}`);
  }

  const buffer = await imgResp.arrayBuffer();
  await Bun.write(params.output, buffer);

  return params.output;
}

// ─── Executor ───────────────────────────────────────────────────

export async function executeImageGen(input: Record<string, unknown>): Promise<ToolResult> {
  const { requirePro } = await import("../core/pro.js");
  await requirePro("image-gen");

  const {
    prompt,
    width = 1024,
    height = 1024,
    output = `/tmp/kcode-gen-${Date.now()}.png`,
    model = "flux",
  } = input as {
    prompt: string;
    width?: number;
    height?: number;
    output?: string;
    model?: "flux" | "dall-e-3" | "dall-e-2";
  };

  if (!prompt) {
    return { tool_use_id: "", content: "prompt is required", is_error: true };
  }

  // Cost warning
  const costEstimate = COST_ESTIMATES[model] ?? "unknown";
  log.info("tool", `ImageGen: Model "${model}" — estimated cost: ${costEstimate}`);

  // Determine provider based on model choice
  const useOpenAI = model === "dall-e-3" || model === "dall-e-2";

  if (useOpenAI) {
    // OpenAI DALL-E path
    if (!getOpenAIAPIKey()) {
      return {
        tool_use_id: "",
        content:
          "OpenAI API key not configured. Set OPENAI_API_KEY or KCODE_OPENAI_API_KEY to use DALL-E models.",
        is_error: true,
      };
    }

    try {
      const path = await generateViaOpenAI({
        prompt,
        width,
        height,
        output,
        model: model as "dall-e-3" | "dall-e-2",
      });
      return {
        tool_use_id: "",
        content: `Image generated: ${path}\nModel: ${model}\nPrompt: ${prompt}\nSize: ${width}x${height}\nEstimated cost: ${costEstimate}`,
      };
    } catch (err: any) {
      return {
        tool_use_id: "",
        content: `OpenAI image generation failed: ${err.message}`,
        is_error: true,
      };
    }
  }

  // Flux (Together AI) path — also used as fallback for "flux" model
  if (getTogetherAPIKey()) {
    try {
      const path = await generateViaTogetherAI({ prompt, width, height, output });
      return {
        tool_use_id: "",
        content: `Image generated: ${path}\nModel: flux (Together AI)\nPrompt: ${prompt}\nSize: ${width}x${height}\nEstimated cost: ${costEstimate}`,
      };
    } catch (err: any) {
      // If Together fails and OpenAI is available, try OpenAI as fallback
      if (getOpenAIAPIKey()) {
        log.info("tool", "ImageGen: Together AI failed, falling back to OpenAI DALL-E 3");
        try {
          const fallbackCost = COST_ESTIMATES["dall-e-3"];
          const path = await generateViaOpenAI({
            prompt,
            width,
            height,
            output,
            model: "dall-e-3",
          });
          return {
            tool_use_id: "",
            content: `Image generated (fallback to DALL-E 3): ${path}\nModel: dall-e-3 (OpenAI, fallback)\nPrompt: ${prompt}\nSize: ${width}x${height}\nEstimated cost: ${fallbackCost}`,
          };
        } catch (fallbackErr: any) {
          return {
            tool_use_id: "",
            content: `Both Together AI and OpenAI failed.\nTogether AI: ${err.message}\nOpenAI: ${fallbackErr.message}`,
            is_error: true,
          };
        }
      }

      return {
        tool_use_id: "",
        content: `Together AI image generation failed: ${err.message}`,
        is_error: true,
      };
    }
  }

  // No Together key, try OpenAI as fallback
  if (getOpenAIAPIKey()) {
    log.info("tool", "ImageGen: No Together AI key, falling back to OpenAI DALL-E 3");
    try {
      const fallbackCost = COST_ESTIMATES["dall-e-3"];
      const path = await generateViaOpenAI({ prompt, width, height, output, model: "dall-e-3" });
      return {
        tool_use_id: "",
        content: `Image generated (fallback to DALL-E 3): ${path}\nModel: dall-e-3 (OpenAI, fallback)\nPrompt: ${prompt}\nSize: ${width}x${height}\nEstimated cost: ${fallbackCost}`,
      };
    } catch (err: any) {
      return {
        tool_use_id: "",
        content: `OpenAI image generation failed: ${err.message}`,
        is_error: true,
      };
    }
  }

  return {
    tool_use_id: "",
    content:
      "No image generation API keys configured.\nSet TOGETHER_API_KEY (or KCODE_TOGETHER_API_KEY) for Flux, or OPENAI_API_KEY (or KCODE_OPENAI_API_KEY) for DALL-E.",
    is_error: true,
  };
}
