// KCode - Model Router
// Auto-routes requests to the best model based on message content.
// Currently: images → vision/ocr model, everything else → default model.

import { listModels } from "./models";
import { log } from "./logger";

// Image file extensions (mirrors IMAGE_EXTENSIONS from tools/read.ts)
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

// Patterns that indicate image content in message history
const IMAGE_INDICATORS = [
  "data:image/",           // base64 data URIs
  "[Image:",               // Read tool image output header
  "[image/png output]",    // notebook image output
  "[image/jpeg output]",   // notebook image output
];

/**
 * Check whether a string contains signs of image content.
 * Uses simple string matching — no ML, no parsing.
 */
function detectImageContent(text: string): boolean {
  // Check for base64 data URIs or image tool output markers
  for (const indicator of IMAGE_INDICATORS) {
    if (text.includes(indicator)) return true;
  }

  // Check for image file paths with known extensions
  for (const ext of IMAGE_EXTENSIONS) {
    // Match common path patterns like /foo/bar.png or "screenshot.jpg"
    if (text.includes(ext)) {
      // Rough heuristic: extension appears near a path-like or filename-like string
      const idx = text.indexOf(ext);
      // Make sure it looks like a file extension (preceded by a non-space char)
      if (idx > 0 && text[idx - 1] !== " " && text[idx - 1] !== "\n") {
        return true;
      }
    }
  }

  return false;
}

/**
 * Route a request to the most appropriate model based on content.
 *
 * @param defaultModel - The currently configured model name
 * @param userMessage  - The latest user message text
 * @param hasImageContent - Optional explicit flag for image content
 * @returns The model name to use (may be the default if no routing needed)
 */
export async function routeToModel(
  defaultModel: string,
  userMessage: string,
  hasImageContent?: boolean,
): Promise<string> {
  const isImage = hasImageContent ?? detectImageContent(userMessage);

  if (!isImage) {
    return defaultModel;
  }

  // Look for a model with "vision" or "ocr" capability
  const models = await listModels();
  const visionModel = models.find(
    (m) =>
      m.capabilities?.includes("vision") || m.capabilities?.includes("ocr"),
  );

  if (!visionModel) {
    log.debug("router", "Image content detected but no vision/ocr model registered, using default");
    return defaultModel;
  }

  log.info("router", `Routing to ${visionModel.name} (image content detected)`);
  return visionModel.name;
}
