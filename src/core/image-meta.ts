// KCode - Image Metadata Reader
// Extracts basic metadata from image files without external dependencies

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { extname, basename } from "node:path";

export interface ImageMeta {
  filename: string;
  format: string;
  size: number; // bytes
  width?: number;
  height?: number;
}

/**
 * Read basic image metadata from a file.
 * Extracts dimensions from PNG/JPEG headers without external libs.
 */
export function getImageMeta(filePath: string): ImageMeta | null {
  const ext = extname(filePath).toLowerCase();
  const formats: Record<string, string> = {
    ".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG",
    ".gif": "GIF", ".webp": "WebP", ".svg": "SVG",
    ".bmp": "BMP", ".ico": "ICO",
  };

  const format = formats[ext];
  if (!format) return null;

  try {
    const stat = statSync(filePath);
    const meta: ImageMeta = {
      filename: basename(filePath),
      format,
      size: stat.size,
    };

    // Read only the first 32 bytes to extract dimensions
    const fd = openSync(filePath, "r");
    const header = Buffer.alloc(32);
    readSync(fd, header, 0, 32, 0);
    closeSync(fd);

    if (format === "PNG" && header.length >= 24) {
      // PNG: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
      meta.width = header.readUInt32BE(16);
      meta.height = header.readUInt32BE(20);
    } else if (format === "GIF" && header.length >= 10) {
      // GIF: width at offset 6 (2 bytes LE), height at offset 8 (2 bytes LE)
      meta.width = header.readUInt16LE(6);
      meta.height = header.readUInt16LE(8);
    } else if (format === "BMP" && header.length >= 26) {
      // BMP: width at offset 18 (4 bytes LE), height at offset 22 (4 bytes LE)
      meta.width = header.readInt32LE(18);
      meta.height = Math.abs(header.readInt32LE(22));
    }
    // JPEG dimensions require parsing markers — skip for simplicity

    return meta;
  } catch {
    return null;
  }
}

/**
 * Format image metadata as a display string.
 */
export function formatImageMeta(meta: ImageMeta): string {
  const sizeStr = meta.size < 1024 ? `${meta.size} B`
    : meta.size < 1024 * 1024 ? `${(meta.size / 1024).toFixed(1)} KB`
    : `${(meta.size / (1024 * 1024)).toFixed(1)} MB`;

  const dims = meta.width && meta.height ? `${meta.width}x${meta.height}` : "unknown dimensions";
  return `${meta.format} ${dims} (${sizeStr})`;
}
