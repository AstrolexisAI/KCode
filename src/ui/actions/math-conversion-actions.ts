// Math, conversion, and calculation actions
// Extracted from utility-actions.ts

import type { ActionContext } from "./action-helpers.js";

export async function handleMathConversionAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { appConfig, args } = ctx;

  switch (action) {
    case "calc": {
      if (!args?.trim()) return "  Usage: /calc <expression>\n  Examples: /calc 2+3*4, /calc sqrt(144), /calc 2**10";

      const expr = args.trim();

      // Strict whitelist: only digits, operators, parens, dots, commas, spaces,
      // and known math function/constant names
      const allowedNames = new Set([
        "abs", "ceil", "floor", "round", "sqrt", "cbrt", "pow",
        "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
        "log", "log2", "log10", "exp", "min", "max", "random",
        "PI", "E", "TAU",
      ]);

      // Tokenize: split into numbers, identifiers, and operators
      const tokens = expr.match(/[a-zA-Z_]\w*|\d+\.?\d*(?:[eE][+-]?\d+)?|[+\-*/().,%^*\s]+/g);
      if (!tokens || tokens.join("").replace(/\s/g, "") !== expr.replace(/\s/g, "")) {
        return "  Invalid expression. Only numbers, operators, and math functions allowed.";
      }

      // Validate every identifier token against the whitelist
      for (const tok of tokens) {
        if (/^[a-zA-Z_]/.test(tok) && !allowedNames.has(tok)) {
          return `  Unknown identifier: ${tok}. Allowed: ${[...allowedNames].join(", ")}`;
        }
      }

      // No brackets, backticks, quotes, assignment, or dangerous constructs allowed
      if (/[\[\]`'"\\{}=;]/.test(expr)) {
        return "  Invalid characters in expression.";
      }
      // Block property access, template literals, and function constructor escape
      if (/\.\s*\w|=>|import|require|eval|Function|this|global|process|constructor|prototype|__proto__/.test(expr)) {
        return "  Invalid expression. Only numbers, operators, and math functions allowed.";
      }
      // Limit expression length to prevent abuse
      if (expr.length > 500) {
        return "  Expression too long (max 500 characters).";
      }

      try {
        const mathFns: Record<string, unknown> = {
          abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round,
          sqrt: Math.sqrt, cbrt: Math.cbrt, pow: Math.pow,
          sin: Math.sin, cos: Math.cos, tan: Math.tan,
          asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
          log: Math.log, log2: Math.log2, log10: Math.log10,
          exp: Math.exp, min: Math.min, max: Math.max,
          PI: Math.PI, E: Math.E, TAU: Math.PI * 2, random: Math.random,
        };
        const keys = Object.keys(mathFns);
        const values = Object.values(mathFns);
        const fn = new Function(...keys, `"use strict"; return (${expr});`);
        const result = fn(...values);

        if (typeof result !== "number" && typeof result !== "bigint") {
          return `  Result: ${String(result)}`;
        }

        const lines = [`  Calc\n`];
        lines.push(`  Expression: ${expr}`);
        lines.push(`  Result:     ${result}`);

        // Show extra representations for integers
        if (typeof result === "number" && Number.isInteger(result) && result >= 0 && result <= 0xFFFFFFFF) {
          lines.push(`  Hex:        0x${result.toString(16).toUpperCase()}`);
          lines.push(`  Binary:     0b${result.toString(2)}`);
          lines.push(`  Octal:      0o${result.toString(8)}`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "random": {
      const input = args?.trim() || "1-100";

      // Dice notation: NdM (e.g., 2d6, 1d20)
      const diceMatch = input.match(/^(\d+)d(\d+)$/i);
      if (diceMatch) {
        const n = Math.min(parseInt(diceMatch[1]!), 100);
        const sides = Math.min(parseInt(diceMatch[2]!), 1000);
        if (n < 1 || sides < 1) return "  Invalid dice: use NdM (e.g., 2d6).";
        const rolls: number[] = [];
        for (let i = 0; i < n; i++) {
          rolls.push(1 + Math.floor(Math.random() * sides));
        }
        const total = rolls.reduce((a, b) => a + b, 0);
        return [
          `  Dice Roll: ${n}d${sides}\n`,
          `  Rolls: ${rolls.join(", ")}`,
          `  Total: ${total}`,
          n > 1 ? `  Avg:   ${(total / n).toFixed(1)}` : "",
        ].filter(Boolean).join("\n");
      }

      // Pick from comma-separated list
      if (input.includes(",")) {
        const items = input.split(",").map(s => s.trim()).filter(Boolean);
        if (items.length < 2) return "  Provide at least 2 comma-separated items.";
        const pick = items[Math.floor(Math.random() * items.length)]!;
        return [
          `  Random Pick\n`,
          `  From: ${items.join(", ")}`,
          `  Pick: ${pick}`,
        ].join("\n");
      }

      // Range: min-max
      const rangeMatch = input.match(/^(-?\d+)\s*[-\u2013]\s*(-?\d+)$/);
      if (rangeMatch) {
        const min = parseInt(rangeMatch[1]!);
        const max = parseInt(rangeMatch[2]!);
        if (min >= max) return "  Min must be less than max.";
        const result = min + Math.floor(Math.random() * (max - min + 1));
        return `  Random: ${result}  (range: ${min}\u2013${max})`;
      }

      // Single number = 1 to N
      const num = parseInt(input);
      if (!isNaN(num) && num > 0) {
        const result = 1 + Math.floor(Math.random() * num);
        return `  Random: ${result}  (range: 1\u2013${num})`;
      }

      return "  Usage: /random [min-max | NdM | item1,item2,...]\n  Examples: /random 1-100, /random 2d6, /random red,blue,green";
    }
    case "uuid": {
      const { randomUUID } = await import("node:crypto");
      const count = Math.min(Math.max(parseInt(args?.trim() || "1") || 1, 1), 100);

      const lines = [`  UUID v4${count > 1 ? ` (${count})` : ""}\n`];
      for (let i = 0; i < count; i++) {
        lines.push(`  ${randomUUID()}`);
      }
      return lines.join("\n");
    }
    case "color": {
      if (!args?.trim()) return "  Usage: /color <#hex | rgb(r,g,b) | hsl(h,s,l)>";

      const input = args.trim();
      let r = 0, g = 0, b = 0;
      let parsed = false;

      // Parse hex
      const hexMatch = input.match(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
      if (hexMatch) {
        let hex = hexMatch[1]!;
        if (hex.length === 3) hex = hex[0]! + hex[0]! + hex[1]! + hex[1]! + hex[2]! + hex[2]!;
        if (hex.length >= 6) {
          r = parseInt(hex.slice(0, 2), 16);
          g = parseInt(hex.slice(2, 4), 16);
          b = parseInt(hex.slice(4, 6), 16);
          parsed = true;
        }
      }

      // Parse rgb(r, g, b)
      if (!parsed) {
        const rgbMatch = input.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
        if (rgbMatch) {
          r = Math.min(255, parseInt(rgbMatch[1]!));
          g = Math.min(255, parseInt(rgbMatch[2]!));
          b = Math.min(255, parseInt(rgbMatch[3]!));
          parsed = true;
        }
      }

      // Parse hsl(h, s%, l%)
      if (!parsed) {
        const hslMatch = input.match(/hsl\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*\)/i);
        if (hslMatch) {
          const h = parseInt(hslMatch[1]!) / 360;
          const s = parseInt(hslMatch[2]!) / 100;
          const l = parseInt(hslMatch[3]!) / 100;
          // HSL to RGB conversion
          if (s === 0) {
            r = g = b = Math.round(l * 255);
          } else {
            const hue2rgb = (p: number, q: number, t: number) => {
              if (t < 0) t += 1;
              if (t > 1) t -= 1;
              if (t < 1 / 6) return p + (q - p) * 6 * t;
              if (t < 1 / 2) return q;
              if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
              return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
            g = Math.round(hue2rgb(p, q, h) * 255);
            b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
          }
          parsed = true;
        }
      }

      if (!parsed) return "  Could not parse color. Use #hex, rgb(r,g,b), or hsl(h,s%,l%).";

      // Convert to all formats
      const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const l = (max + min) / 2;
      let h = 0, s = 0;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        const rn = r / 255, gn = g / 255, bn = b / 255;
        if (rn === max) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
        else if (gn === max) h = ((bn - rn) / d + 2) / 6;
        else h = ((rn - gn) / d + 4) / 6;
      }

      // ANSI color preview block
      const preview = `\x1b[48;2;${r};${g};${b}m      \x1b[0m`;

      return [
        `  Color\n`,
        `  Preview: ${preview}`,
        `  HEX:     ${hex}`,
        `  RGB:     rgb(${r}, ${g}, ${b})`,
        `  HSL:     hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
        `  Decimal: ${(r << 16 | g << 8 | b) >>> 0}`,
      ].join("\n");
    }
    case "timestamp": {
      const input = args?.trim() || "";

      const now = new Date();
      const nowEpoch = Math.floor(now.getTime() / 1000);

      if (!input) {
        return [
          `  Timestamp\n`,
          `  Now (UTC):   ${now.toISOString()}`,
          `  Now (local): ${now.toLocaleString()}`,
          `  Epoch (s):   ${nowEpoch}`,
          `  Epoch (ms):  ${now.getTime()}`,
        ].join("\n");
      }

      // Try epoch (seconds or milliseconds)
      if (/^\d+$/.test(input)) {
        const num = parseInt(input);
        // If > 10 billion, it's likely milliseconds
        const date = num > 1e10 ? new Date(num) : new Date(num * 1000);
        if (isNaN(date.getTime())) return "  Invalid epoch value.";

        return [
          `  Epoch \u2192 Date\n`,
          `  Input:       ${input}${num > 1e10 ? " (ms)" : " (s)"}`,
          `  UTC:         ${date.toISOString()}`,
          `  Local:       ${date.toLocaleString()}`,
          `  Relative:    ${formatRelative(date, now)}`,
        ].join("\n");
      }

      // Try date string
      const date = new Date(input);
      if (isNaN(date.getTime())) return `  Cannot parse date: ${input}`;

      return [
        `  Date \u2192 Epoch\n`,
        `  Input:       ${input}`,
        `  UTC:         ${date.toISOString()}`,
        `  Epoch (s):   ${Math.floor(date.getTime() / 1000)}`,
        `  Epoch (ms):  ${date.getTime()}`,
        `  Relative:    ${formatRelative(date, now)}`,
      ].join("\n");

      function formatRelative(d: Date, ref: Date): string {
        const diff = ref.getTime() - d.getTime();
        const abs = Math.abs(diff);
        const suffix = diff > 0 ? "ago" : "from now";
        if (abs < 60000) return `${Math.round(abs / 1000)}s ${suffix}`;
        if (abs < 3600000) return `${Math.round(abs / 60000)}m ${suffix}`;
        if (abs < 86400000) return `${Math.round(abs / 3600000)}h ${suffix}`;
        return `${Math.round(abs / 86400000)}d ${suffix}`;
      }
    }
    case "encode": {
      if (!args?.trim()) return "  Usage: /encode base64|url|hex encode|decode <text>";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 3) return "  Usage: /encode base64|url|hex encode|decode <text>";

      const format = parts[0]!.toLowerCase();
      const direction = parts[1]!.toLowerCase();
      const text = parts.slice(2).join(" ");

      if (!["base64", "url", "hex"].includes(format)) {
        return "  Formats: base64, url, hex";
      }
      if (!["encode", "decode"].includes(direction)) {
        return "  Direction: encode or decode";
      }

      try {
        let result: string;

        if (format === "base64") {
          if (direction === "encode") {
            result = Buffer.from(text, "utf-8").toString("base64");
          } else {
            result = Buffer.from(text, "base64").toString("utf-8");
          }
        } else if (format === "url") {
          if (direction === "encode") {
            result = encodeURIComponent(text);
          } else {
            result = decodeURIComponent(text);
          }
        } else {
          // hex
          if (direction === "encode") {
            result = Buffer.from(text, "utf-8").toString("hex");
          } else {
            result = Buffer.from(text, "hex").toString("utf-8");
          }
        }

        return [
          `  ${format.toUpperCase()} ${direction}`,
          ``,
          `  Input:  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`,
          `  Output: ${result.length > 200 ? result.slice(0, 200) + "..." : result}`,
        ].join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "checksum": {
      if (!args?.trim()) return "  Usage: /checksum [md5|sha256|sha512] <file or text>";

      const { createHash } = await import("node:crypto");
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");

      const parts = args.trim().split(/\s+/);
      let algo = "sha256";
      let target: string;

      if (["md5", "sha256", "sha512", "sha1"].includes(parts[0]!.toLowerCase())) {
        algo = parts[0]!.toLowerCase();
        target = parts.slice(1).join(" ");
      } else {
        target = args.trim();
      }

      if (!target) return "  Usage: /checksum [md5|sha256|sha512] <file or text>";

      let data: string | Buffer;
      let isFile = false;
      const filePath = resolvePath(appConfig.workingDirectory, target);

      const fileStat = existsSync(filePath) ? statSyncFn(filePath) : null;
      if (fileStat?.isFile()) {
        if (fileStat.size > 100 * 1024 * 1024) return "  File too large (max 100 MB).";
        data = readFileSync(filePath);
        isFile = true;
      } else {
        data = target;
      }

      const hash = createHash(algo).update(data).digest("hex");

      return [
        `  Checksum (${algo.toUpperCase()})`,
        ``,
        `  ${isFile ? "File" : "Text"}:  ${isFile ? target : (target.length > 60 ? target.slice(0, 60) + "..." : target)}`,
        `  Hash:  ${hash}`,
      ].join("\n");
    }
    case "semver": {
      if (!args?.trim()) return "  Usage: /semver <version> [bump major|minor|patch|prerelease]\n  Examples: /semver 1.2.3, /semver 1.2.3 bump minor";

      const input = args.trim();
      const parts = input.split(/\s+/);
      const raw = parts[0]!;
      const action2 = parts[1]?.toLowerCase();
      const bumpType = parts[2]?.toLowerCase();

      // Parse semver
      const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?(?:\+([a-zA-Z0-9.]+))?$/);
      if (!match) return `  Invalid semver: ${raw}\n  Expected format: MAJOR.MINOR.PATCH[-prerelease][+build]`;

      let major = parseInt(match[1]!);
      let minor = parseInt(match[2]!);
      let patch = parseInt(match[3]!);
      const pre = match[4] || "";
      const build = match[5] || "";

      const lines = [`  Semver: ${raw}\n`];
      lines.push(`  Major:      ${major}`);
      lines.push(`  Minor:      ${minor}`);
      lines.push(`  Patch:      ${patch}`);
      if (pre) lines.push(`  Prerelease: ${pre}`);
      if (build) lines.push(`  Build:      ${build}`);

      if (action2 === "bump" && bumpType) {
        let bumped: string;
        if (bumpType === "major") {
          bumped = `${major + 1}.0.0`;
        } else if (bumpType === "minor") {
          bumped = `${major}.${minor + 1}.0`;
        } else if (bumpType === "patch") {
          bumped = `${major}.${minor}.${patch + 1}`;
        } else if (bumpType === "prerelease") {
          // Increment last numeric in prerelease, or append .0
          if (pre) {
            const preParts = pre.split(".");
            const last = preParts[preParts.length - 1]!;
            if (/^\d+$/.test(last)) {
              preParts[preParts.length - 1] = String(parseInt(last) + 1);
            } else {
              preParts.push("1");
            }
            bumped = `${major}.${minor}.${patch}-${preParts.join(".")}`;
          } else {
            bumped = `${major}.${minor}.${patch + 1}-0`;
          }
        } else {
          return `  Unknown bump type: ${bumpType}. Use major, minor, patch, or prerelease.`;
        }
        lines.push(`\n  Bump ${bumpType}: ${bumped}`);
      }

      return lines.join("\n");
    }
    case "montecarlo": {
      const input = args?.trim() || "pi";
      const parts = input.split(/\s+/);
      const mode = parts[0]!.toLowerCase();

      if (mode === "pi") {
        const iterations = Math.min(parseInt(parts[1] ?? "1000000") || 1000000, 5000000);
        let inside = 0;

        const startTime = performance.now();
        for (let i = 0; i < iterations; i++) {
          const x = Math.random();
          const y = Math.random();
          if (x * x + y * y <= 1) inside++;
        }
        const elapsed = Math.round(performance.now() - startTime);

        const estimate = (4 * inside) / iterations;
        const error = Math.abs(estimate - Math.PI);

        return [
          `  Monte Carlo: Estimate Pi\n`,
          `  Iterations: ${iterations.toLocaleString()}`,
          `  Estimate:   ${estimate.toFixed(8)}`,
          `  Actual Pi:  ${Math.PI.toFixed(8)}`,
          `  Error:      ${error.toFixed(8)} (${(error / Math.PI * 100).toFixed(4)}%)`,
          `  Time:       ${elapsed}ms`,
        ].join("\n");
      }

      if (mode === "coin") {
        const flips = Math.min(parseInt(parts[1] ?? "10000") || 10000, 5000000);
        let heads = 0;

        const startTime = performance.now();
        for (let i = 0; i < flips; i++) {
          if (Math.random() < 0.5) heads++;
        }
        const elapsed = Math.round(performance.now() - startTime);
        const tails = flips - heads;

        return [
          `  Monte Carlo: Coin Flips\n`,
          `  Flips:  ${flips.toLocaleString()}`,
          `  Heads:  ${heads.toLocaleString()} (${(heads / flips * 100).toFixed(2)}%)`,
          `  Tails:  ${tails.toLocaleString()} (${(tails / flips * 100).toFixed(2)}%)`,
          `  Ratio:  ${(heads / tails).toFixed(4)}`,
          `  Time:   ${elapsed}ms`,
        ].join("\n");
      }

      if (mode === "dice") {
        const diceMatch = parts[1]?.match(/^(\d+)d(\d+)$/i);
        if (!diceMatch) return "  Usage: /montecarlo dice NdM [iterations]\n  Example: /montecarlo dice 2d6 100000";

        const n = Math.min(parseInt(diceMatch[1]!), 20);
        const sides = Math.min(parseInt(diceMatch[2]!), 100);
        const iterations = Math.min(parseInt(parts[2] ?? "100000") || 100000, 5000000);

        if (n < 1 || sides < 1) return "  Invalid dice notation.";

        const freq: Record<number, number> = {};
        const minVal = n;
        const maxVal = n * sides;

        const startTime = performance.now();
        for (let i = 0; i < iterations; i++) {
          let sum = 0;
          for (let d = 0; d < n; d++) {
            sum += 1 + Math.floor(Math.random() * sides);
          }
          freq[sum] = (freq[sum] ?? 0) + 1;
        }
        const elapsed = Math.round(performance.now() - startTime);

        // Build distribution
        const sorted = Object.entries(freq).map(([k, v]) => [parseInt(k), v] as [number, number]).sort((a, b) => a[0] - b[0]);
        const maxFreq = Math.max(...sorted.map(([, v]) => v));
        const barWidth = 25;

        const lines = [
          `  Monte Carlo: ${n}d${sides} Distribution\n`,
          `  Iterations: ${iterations.toLocaleString()}`,
          `  Range:      ${minVal}\u2013${maxVal}`,
          `  Time:       ${elapsed}ms`,
          ``,
        ];

        // Show top values or full distribution if small enough
        const display = sorted.length <= 25 ? sorted : sorted.slice(0, 20);
        for (const [val, count] of display) {
          const pct = (count / iterations * 100).toFixed(1);
          const filled = Math.max(1, Math.round((count / maxFreq) * barWidth));
          const bar = "\u2588".repeat(filled);
          lines.push(`  ${String(val).padStart(4)}  ${bar} ${pct}%`);
        }
        if (sorted.length > 25) lines.push(`\n  ... ${sorted.length - 20} more values`);

        return lines.join("\n");
      }

      return "  Usage: /montecarlo pi [N] | coin [N] | dice NdM [N]\n  Examples: /montecarlo pi 1000000, /montecarlo coin 50000, /montecarlo dice 2d6 100000";
    }
    case "chmod_calc": {
      if (!args?.trim()) return "  Usage: /chmod-calc <octal or symbolic>\n  Examples: /chmod-calc 755, /chmod-calc rwxr-xr-x";

      const input = args.trim();

      const octalToSymbolic = (octal: string): string => {
        const map: Record<string, string> = {
          "0": "---", "1": "--x", "2": "-w-", "3": "-wx",
          "4": "r--", "5": "r-x", "6": "rw-", "7": "rwx",
        };
        const digits = octal.padStart(3, "0").slice(-3);
        return digits.split("").map(d => map[d] ?? "---").join("");
      };

      const symbolicToOctal = (sym: string): string => {
        const map: Record<string, string> = {
          "---": "0", "--x": "1", "-w-": "2", "-wx": "3",
          "r--": "4", "r-x": "5", "rw-": "6", "rwx": "7",
        };
        const clean = sym.replace(/^[-d]/, "").slice(0, 9);
        if (clean.length !== 9) return "";
        const u = map[clean.slice(0, 3)] ?? "0";
        const g = map[clean.slice(3, 6)] ?? "0";
        const o = map[clean.slice(6, 9)] ?? "0";
        return u + g + o;
      };

      let octal: string;
      let symbolic: string;
      let mode: string;
      let specialBit = "";

      if (/^\d{3,4}$/.test(input)) {
        // Octal input
        const full = input.padStart(4, "0");
        const special = full[0]!;
        octal = full.slice(-3);
        symbolic = octalToSymbolic(octal);
        mode = "Octal \u2192 Symbolic";
        if (special === "1") specialBit = "sticky";
        else if (special === "2") specialBit = "setgid";
        else if (special === "4") specialBit = "setuid";
        else if (special === "6") specialBit = "setuid + setgid";
        else if (special === "5") specialBit = "setuid + sticky";
        else if (special === "3") specialBit = "setgid + sticky";
        else if (special === "7") specialBit = "setuid + setgid + sticky";
      } else if (/^[-drwx]{9,10}$/.test(input)) {
        // Symbolic input
        symbolic = input.replace(/^[-d]/, "").slice(0, 9);
        octal = symbolicToOctal(input);
        mode = "Symbolic \u2192 Octal";
        if (!octal) return "  Invalid symbolic permissions.";
      } else {
        return "  Invalid format. Use octal (755) or symbolic (rwxr-xr-x).";
      }

      const u = symbolic.slice(0, 3);
      const g = symbolic.slice(3, 6);
      const o = symbolic.slice(6, 9);
      const fullOctal = specialBit ? input.padStart(4, "0") : octal;

      const lines = [
        `  chmod Calculator: ${mode}\n`,
        `  Octal:    ${fullOctal}`,
        `  Symbolic: ${symbolic}`,
        ``,
        `  Owner:  ${u}  (${u.replace(/-/g, " ").trim() || "none"})`,
        `  Group:  ${g}  (${g.replace(/-/g, " ").trim() || "none"})`,
        `  Other:  ${o}  (${o.replace(/-/g, " ").trim() || "none"})`,
      ];

      if (specialBit) {
        lines.push(`  Special: ${specialBit}`);
      }

      lines.push(``, `  Command: chmod ${fullOctal} <file>`);

      return lines.join("\n");
    }
    default:
      return null;
  }
}
