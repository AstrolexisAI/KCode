// Text, string manipulation, and formatting actions
// Extracted from utility-actions.ts

import type { ActionContext } from "./action-helpers.js";

export async function handleTextAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { conversationManager, appConfig, args } = ctx;

  switch (action) {
    case "regex": {
      if (!args?.trim()) return "  Usage: /regex <pattern> <text or file path>\n  Example: /regex \"\\d+\\.\\d+\" package.json";

      const input = args.trim();
      // Parse: first quoted or unquoted token is the pattern, rest is text/file
      let pattern: string;
      let target: string;

      const quotedMatch = input.match(/^["'](.+?)["']\s+(.+)$/);
      if (quotedMatch) {
        pattern = quotedMatch[1];
        target = quotedMatch[2];
      } else {
        const spaceIdx = input.indexOf(" ");
        if (spaceIdx === -1) return "  Usage: /regex <pattern> <text or file path>";
        pattern = input.slice(0, spaceIdx);
        target = input.slice(spaceIdx + 1);
      }

      // Check if target is a file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      let text = target;
      let isFile = false;
      const filePath = resolvePath(appConfig.workingDirectory, target);

      if (existsSync(filePath) && statSyncFn(filePath).isFile()) {
        if (statSyncFn(filePath).size > 1024 * 1024) return "  File too large (max 1 MB for regex testing).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "g");
      } catch (err) {
        return `  Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Guard against ReDoS: run regex with a timeout
      const matches: Array<{ index: number; match: string; groups?: string[] }> = [];
      const startTime = Date.now();
      let m;
      while ((m = regex.exec(text)) !== null && matches.length < 50) {
        if (Date.now() - startTime > 3000) {
          return `  Regex execution timed out (>3s). Pattern may cause catastrophic backtracking.`;
        }
        const groups = m.slice(1).length > 0 ? m.slice(1) : undefined;
        matches.push({ index: m.index, match: m[0], groups });
        if (m[0].length === 0) { regex.lastIndex++; } // prevent infinite loop on zero-length matches
        if (!regex.global) break;
      }

      if (matches.length === 0) return `  No matches for /${pattern}/${isFile ? ` in ${target}` : ""}`;

      const lines = [`  Regex: /${pattern}/g${isFile ? ` in ${target}` : ""}\n  ${matches.length} match(es)\n`];

      for (let i = 0; i < Math.min(matches.length, 20); i++) {
        const match = matches[i];
        const context = text.slice(Math.max(0, match.index - 20), match.index + match.match.length + 20).replace(/\n/g, "\\n");
        lines.push(`  [${i + 1}] "${match.match}" at index ${match.index}`);
        if (match.groups) {
          lines.push(`       Groups: ${match.groups.map((g, j) => `$${j + 1}="${g}"`).join(", ")}`);
        }
      }

      if (matches.length > 20) lines.push(`\n  ... ${matches.length - 20} more matches`);
      return lines.join("\n");
    }
    case "lorem": {
      const parts = (args?.trim() || "paragraphs 3").split(/\s+/);
      const unit = parts[0]?.toLowerCase() ?? "paragraphs";
      const count = Math.min(Math.max(parseInt(parts[1] ?? "3") || 3, 1), 50);

      const loremWords = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum".split(" ");

      const genSentence = (): string => {
        const len = 8 + Math.floor(Math.random() * 12);
        const words: string[] = [];
        for (let i = 0; i < len; i++) {
          words.push(loremWords[Math.floor(Math.random() * loremWords.length)]!);
        }
        words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
        return words.join(" ") + ".";
      };

      const genParagraph = (): string => {
        const sentences = 3 + Math.floor(Math.random() * 4);
        const result: string[] = [];
        for (let i = 0; i < sentences; i++) result.push(genSentence());
        return result.join(" ");
      };

      let output: string;

      if (unit.startsWith("w")) {
        // words
        const words: string[] = [];
        for (let i = 0; i < count; i++) {
          words.push(loremWords[Math.floor(Math.random() * loremWords.length)]!);
        }
        words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
        output = words.join(" ") + ".";
      } else if (unit.startsWith("s")) {
        // sentences
        const sentences: string[] = [];
        for (let i = 0; i < count; i++) sentences.push(genSentence());
        output = sentences.join(" ");
      } else {
        // paragraphs
        const paragraphs: string[] = [];
        for (let i = 0; i < count; i++) paragraphs.push(genParagraph());
        output = paragraphs.join("\n\n");
      }

      const wordCount = output.split(/\s+/).length;
      const lines = [
        `  Lorem Ipsum (${count} ${unit.startsWith("w") ? "words" : unit.startsWith("s") ? "sentences" : "paragraphs"}, ${wordCount} words total)\n`,
      ];
      for (const l of output.split("\n")) {
        lines.push(`  ${l}`);
      }
      return lines.join("\n");
    }
    case "ascii": {
      if (!args?.trim()) return "  Usage: /ascii <text>";

      const text = args.trim().slice(0, 20); // limit length
      const { execSync } = await import("node:child_process");

      // Try figlet first, then toilet, then built-in
      const cmds = ["figlet", "toilet -f mono12"];
      for (const cmd of cmds) {
        try {
          const bin = cmd.split(" ")[0]!;
          execSync(`which ${bin} 2>/dev/null`, { timeout: 2000 });
          const output = execSync(`${cmd} '${text.replace(/'/g, "'\\''")}' 2>/dev/null`, { timeout: 5000 }).toString();
          const lines = [`  ASCII Art\n`];
          for (const line of output.split("\n")) {
            lines.push(`  ${line}`);
          }
          return lines.join("\n");
        } catch { /* not available */ }
      }

      // Built-in simple block letters
      const font: Record<string, string[]> = {
        A: ["  ##  ", " #  # ", " #### ", " #  # ", " #  # "],
        B: [" ### ", " #  #", " ### ", " #  #", " ### "],
        C: ["  ###", " #   ", " #   ", " #   ", "  ###"],
        D: [" ### ", " #  #", " #  #", " #  #", " ### "],
        E: [" ####", " #   ", " ### ", " #   ", " ####"],
        F: [" ####", " #   ", " ### ", " #   ", " #   "],
        G: ["  ###", " #   ", " # ##", " #  #", "  ## "],
        H: [" #  #", " #  #", " ####", " #  #", " #  #"],
        I: [" ### ", "  #  ", "  #  ", "  #  ", " ### "],
        J: ["  ###", "   # ", "   # ", " # # ", "  #  "],
        K: [" #  #", " # # ", " ##  ", " # # ", " #  #"],
        L: [" #   ", " #   ", " #   ", " #   ", " ####"],
        M: [" #   #", " ## ##", " # # #", " #   #", " #   #"],
        N: [" #  #", " ## #", " # ##", " #  #", " #  #"],
        O: ["  ## ", " #  #", " #  #", " #  #", "  ## "],
        P: [" ### ", " #  #", " ### ", " #   ", " #   "],
        Q: ["  ## ", " #  #", " # ##", " #  #", "  ## #"],
        R: [" ### ", " #  #", " ### ", " # # ", " #  #"],
        S: ["  ###", " #   ", "  ## ", "    #", " ### "],
        T: [" ####", "  #  ", "  #  ", "  #  ", "  #  "],
        U: [" #  #", " #  #", " #  #", " #  #", "  ## "],
        V: [" #  #", " #  #", " #  #", "  ## ", "  #  "],
        W: [" #   #", " #   #", " # # #", " ## ##", " #   #"],
        X: [" #  #", "  ## ", "  #  ", "  ## ", " #  #"],
        Y: [" #  #", "  ## ", "  #  ", "  #  ", "  #  "],
        Z: [" ####", "   # ", "  #  ", " #   ", " ####"],
        " ": ["     ", "     ", "     ", "     ", "     "],
        "0": ["  ## ", " #  #", " #  #", " #  #", "  ## "],
        "1": ["  #  ", " ##  ", "  #  ", "  #  ", " ### "],
        "2": ["  ## ", " #  #", "   # ", "  #  ", " ####"],
        "3": [" ### ", "    #", "  ## ", "    #", " ### "],
        "4": [" #  #", " #  #", " ####", "    #", "    #"],
        "5": [" ####", " #   ", " ### ", "    #", " ### "],
        "6": ["  ## ", " #   ", " ### ", " #  #", "  ## "],
        "7": [" ####", "    #", "   # ", "  #  ", "  #  "],
        "8": ["  ## ", " #  #", "  ## ", " #  #", "  ## "],
        "9": ["  ## ", " #  #", "  ###", "    #", "  ## "],
      };

      const upper = text.toUpperCase();
      const artLines: string[] = ["  ASCII Art\n"];
      for (let row = 0; row < 5; row++) {
        let line = "  ";
        for (const ch of upper) {
          const glyph = font[ch];
          line += glyph ? glyph[row]! : "     ";
          line += " ";
        }
        artLines.push(line);
      }
      return artLines.join("\n");
    }
    case "reverse": {
      if (!args?.trim()) return "  Usage: /reverse <text>\n  Options: --words (reverse word order), --lines (reverse line order)";

      const input = args.trim();
      let mode = "chars";
      let text = input;

      if (input.startsWith("--words ")) {
        mode = "words";
        text = input.slice(8);
      } else if (input.startsWith("--lines ")) {
        mode = "lines";
        text = input.slice(8);
      }

      let result: string;
      if (mode === "words") {
        result = text.split(/\s+/).reverse().join(" ");
      } else if (mode === "lines") {
        result = text.split("\n").reverse().join("\n");
      } else {
        result = [...text].reverse().join("");
      }

      return [
        `  Reverse (${mode})\n`,
        `  Input:  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`,
        `  Output: ${result.length > 80 ? result.slice(0, 80) + "..." : result}`,
      ].join("\n");
    }
    case "wrap": {
      if (!args?.trim()) return "  Usage: /wrap [--width N] <text>\n  Default width: 80";

      let width = 80;
      let text = args.trim();

      const widthMatch = text.match(/^--width\s+(\d+)\s+/);
      if (widthMatch) {
        width = Math.min(Math.max(parseInt(widthMatch[1]!) || 80, 10), 200);
        text = text.slice(widthMatch[0].length);
      }

      // Try reading as file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, text);

      if (existsSync(filePath)) {
        const stat = statSyncFn(filePath);
        if (stat.isFile() && stat.size <= 1024 * 1024) {
          text = readFileSync(filePath, "utf-8");
        }
      }

      // Word wrap
      const paragraphs = text.split(/\n\s*\n/);
      const wrapped = paragraphs.map(para => {
        const words = para.replace(/\n/g, " ").split(/\s+/).filter(Boolean);
        const resultLines: string[] = [];
        let currentLine = "";

        for (const word of words) {
          if (!currentLine) {
            currentLine = word;
          } else if (currentLine.length + 1 + word.length <= width) {
            currentLine += " " + word;
          } else {
            resultLines.push(currentLine);
            currentLine = word;
          }
        }
        if (currentLine) resultLines.push(currentLine);
        return resultLines.join("\n");
      });

      const result = wrapped.join("\n\n");
      const lineCount = result.split("\n").length;

      const lines = [`  Word Wrap (width: ${width})\n`];
      for (const line of result.split("\n").slice(0, 100)) {
        lines.push(`  ${line}`);
      }
      if (lineCount > 100) {
        lines.push(`  ... (${lineCount - 100} more lines)`);
      }
      lines.push(`\n  Lines: ${lineCount}  |  Width: ${width}`);

      return lines.join("\n");
    }
    case "wordfreq": {
      const input = args?.trim();
      if (!input) return "  Usage: /wordfreq <text or file path> [--top N]";

      // Parse --top N
      let topN = 20;
      let text = input;
      const topMatch = input.match(/--top\s+(\d+)/);
      if (topMatch) {
        topN = Math.min(Math.max(parseInt(topMatch[1]!) || 20, 1), 100);
        text = input.replace(/--top\s+\d+/, "").trim();
      }

      // Try to read as file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, text);

      if (existsSync(filePath)) {
        const stat = statSyncFn(filePath);
        if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
          text = readFileSync(filePath, "utf-8");
        }
      }

      // Count words
      const words = text.toLowerCase().match(/[a-zA-Z\u00C0-\u024F]+(?:'[a-zA-Z]+)?/g);
      if (!words || words.length === 0) return "  No words found.";

      const freq = new Map<string, number>();
      for (const w of words) {
        freq.set(w, (freq.get(w) || 0) + 1);
      }

      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
      const maxCount = sorted[0]![1];
      const barWidth = 20;

      const lines = [`  Word Frequency (top ${Math.min(topN, sorted.length)} of ${freq.size} unique)\n`];
      lines.push(`  Total words: ${words.length}\n`);

      const maxWordLen = Math.max(...sorted.map(([w]) => w.length), 4);
      for (const [word, count] of sorted) {
        const bar = "\u2588".repeat(Math.max(1, Math.round((count / maxCount) * barWidth)));
        lines.push(`  ${word.padEnd(maxWordLen)}  ${String(count).padStart(5)}  ${bar}`);
      }

      return lines.join("\n");
    }
    case "nato": {
      if (!args?.trim()) return "  Usage: /nato <text>\n  Example: /nato Hello";

      const NATO: Record<string, string> = {
        A: "Alfa", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo",
        F: "Foxtrot", G: "Golf", H: "Hotel", I: "India", J: "Juliet",
        K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar",
        P: "Papa", Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango",
        U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee",
        Z: "Zulu",
        "0": "Zero", "1": "One", "2": "Two", "3": "Three", "4": "Four",
        "5": "Five", "6": "Six", "7": "Seven", "8": "Eight", "9": "Niner",
      };

      const text = args.trim().slice(0, 200);
      const lines = [`  NATO Phonetic: ${text.length > 60 ? text.slice(0, 60) + "..." : text}\n`];

      const words: string[] = [];
      for (const char of text) {
        const upper = char.toUpperCase();
        if (NATO[upper]) {
          words.push(NATO[upper]!);
          lines.push(`  ${char}  \u2192  ${NATO[upper]}`);
        } else if (char === " ") {
          words.push("(space)");
          lines.push(`     \u2192  (space)`);
        }
      }

      lines.push(``);
      lines.push(`  Spoken: ${words.join(" ")}`);

      return lines.join("\n");
    }
    case "char_info": {
      const input = args?.trim();
      if (!input) return "  Usage: /char-info <character(s)>\n  Examples: /char-info A, /char-info U+1F600, /char-info \u00e9\u00f1";

      const lines = [`  Unicode Character Info\n`];

      // Check if input is U+XXXX format
      const codePointMatch = input.match(/^[Uu]\+([0-9A-Fa-f]{1,6})$/);
      let chars: string[];

      if (codePointMatch) {
        const cp = parseInt(codePointMatch[1]!, 16);
        if (cp > 0x10FFFF) return "  Invalid codepoint (max U+10FFFF).";
        chars = [String.fromCodePoint(cp)];
      } else {
        // Spread to handle surrogate pairs correctly
        chars = [...input].slice(0, 20);
      }

      for (const char of chars) {
        const cp = char.codePointAt(0)!;
        const hex = cp.toString(16).toUpperCase().padStart(4, "0");

        // UTF-8 byte representation
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(char);
        const bytesStr = [...utf8Bytes].map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

        // Category heuristic
        let category = "Other";
        if (cp >= 0x41 && cp <= 0x5A) category = "Uppercase Letter";
        else if (cp >= 0x61 && cp <= 0x7A) category = "Lowercase Letter";
        else if (cp >= 0x30 && cp <= 0x39) category = "Digit";
        else if (cp >= 0x00 && cp <= 0x1F) category = "Control";
        else if (cp >= 0x20 && cp <= 0x2F) category = "Punctuation/Symbol";
        else if (cp >= 0x3A && cp <= 0x40) category = "Punctuation/Symbol";
        else if (cp >= 0x5B && cp <= 0x60) category = "Punctuation/Symbol";
        else if (cp >= 0x7B && cp <= 0x7E) category = "Punctuation/Symbol";
        else if (cp >= 0x80 && cp <= 0xFF) category = "Latin Extended";
        else if (cp >= 0x100 && cp <= 0x24F) category = "Latin Extended";
        else if (cp >= 0x370 && cp <= 0x3FF) category = "Greek";
        else if (cp >= 0x400 && cp <= 0x4FF) category = "Cyrillic";
        else if (cp >= 0x4E00 && cp <= 0x9FFF) category = "CJK Ideograph";
        else if (cp >= 0x3040 && cp <= 0x309F) category = "Hiragana";
        else if (cp >= 0x30A0 && cp <= 0x30FF) category = "Katakana";
        else if (cp >= 0xAC00 && cp <= 0xD7AF) category = "Hangul";
        else if (cp >= 0x0600 && cp <= 0x06FF) category = "Arabic";
        else if (cp >= 0x0590 && cp <= 0x05FF) category = "Hebrew";
        else if (cp >= 0x0900 && cp <= 0x097F) category = "Devanagari";
        else if (cp >= 0x1F600 && cp <= 0x1F64F) category = "Emoji (Faces)";
        else if (cp >= 0x1F300 && cp <= 0x1F5FF) category = "Emoji (Symbols)";
        else if (cp >= 0x1F680 && cp <= 0x1F6FF) category = "Emoji (Transport)";
        else if (cp >= 0x2600 && cp <= 0x26FF) category = "Misc Symbols";
        else if (cp >= 0x2700 && cp <= 0x27BF) category = "Dingbats";
        else if (cp >= 0x2000 && cp <= 0x206F) category = "General Punctuation";
        else if (cp >= 0x2190 && cp <= 0x21FF) category = "Arrows";
        else if (cp >= 0x2200 && cp <= 0x22FF) category = "Math Operators";
        else if (cp >= 0x2500 && cp <= 0x257F) category = "Box Drawing";
        else if (cp >= 0x2580 && cp <= 0x259F) category = "Block Elements";
        else if (cp >= 0xFE00 && cp <= 0xFE0F) category = "Variation Selector";
        else if (cp >= 0xE0000 && cp <= 0xE007F) category = "Tags";

        lines.push(`  '${char}'  U+${hex}`);
        lines.push(`    Decimal:   ${cp}`);
        lines.push(`    UTF-8:     ${bytesStr} (${utf8Bytes.length} byte${utf8Bytes.length > 1 ? "s" : ""})`);
        lines.push(`    Category:  ${category}`);
        lines.push(`    HTML:      &#${cp}; / &#x${hex};`);
        lines.push(``);
      }

      return lines.join("\n");
    }
    case "slug": {
      if (!args?.trim()) return "  Usage: /slug <text>\n  Example: /slug Hello World! This is a Test";

      const text = args.trim();

      // Normalize unicode, strip diacritics, lowercase, replace non-alnum with hyphens
      const slug = text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")   // strip diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")       // non-alnum -> hyphen
        .replace(/^-+|-+$/g, "")           // trim leading/trailing hyphens
        .replace(/-{2,}/g, "-");           // collapse multiple hyphens

      return [
        `  Slug Generator\n`,
        `  Input:  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`,
        `  Slug:   ${slug}`,
        `  Length:  ${slug.length} chars`,
      ].join("\n");
    }
    case "diff_lines": {
      if (!args?.trim() || !args.includes("|")) return "  Usage: /diff-lines <string1> | <string2>";

      const pipeIdx = args.indexOf("|");
      const left = args.slice(0, pipeIdx).trim();
      const right = args.slice(pipeIdx + 1).trim();

      if (!left && !right) return "  Both strings are empty.";
      if (left === right) return "  Strings are identical.";

      // Character-level diff
      const maxLen = Math.max(left.length, right.length);
      let diffChars = 0;
      let diffMap = "";

      for (let i = 0; i < maxLen; i++) {
        const lc = left[i] ?? "";
        const rc = right[i] ?? "";
        if (lc === rc) {
          diffMap += " ";
        } else {
          diffMap += "^";
          diffChars++;
        }
      }

      const similarity = maxLen > 0 ? ((1 - diffChars / maxLen) * 100).toFixed(1) : "100.0";

      // Truncate for display
      const displayLen = 80;
      const l = left.length > displayLen ? left.slice(0, displayLen) + "..." : left;
      const r = right.length > displayLen ? right.slice(0, displayLen) + "..." : right;
      const d = diffMap.length > displayLen ? diffMap.slice(0, displayLen) + "..." : diffMap;

      return [
        `  Line Diff\n`,
        `  A: ${l}`,
        `  B: ${r}`,
        `     ${d}`,
        ``,
        `  Length A:    ${left.length}`,
        `  Length B:    ${right.length}`,
        `  Differences: ${diffChars} chars`,
        `  Similarity:  ${similarity}%`,
      ].join("\n");
    }
    case "diff_words": {
      if (!args?.trim() || !args.includes("|"))
        return "  Usage: /diff-words text1 | text2\n  Example: /diff-words the quick brown fox | the slow brown dog";

      const [left, right] = args.split("|", 2).map(s => s!.trim());
      if (!left || !right) return "  Provide two texts separated by |";

      const wordsA = left.split(/\s+/);
      const wordsB = right.split(/\s+/);

      // Simple LCS-based word diff
      const m = wordsA.length;
      const n = wordsB.length;

      // Guard against excessive input
      if (m > 500 || n > 500) return "  Input too long (max 500 words per side).";

      // Build LCS table
      const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (wordsA[i - 1] === wordsB[j - 1]) {
            dp[i]![j] = dp[i - 1]![j - 1]! + 1;
          } else {
            dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
          }
        }
      }

      // Backtrack to produce diff
      const diff: { type: string; word: string }[] = [];
      let i = m, j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && wordsA[i - 1] === wordsB[j - 1]) {
          diff.unshift({ type: " ", word: wordsA[i - 1]! });
          i--; j--;
        } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
          diff.unshift({ type: "+", word: wordsB[j - 1]! });
          j--;
        } else {
          diff.unshift({ type: "-", word: wordsA[i - 1]! });
          i--;
        }
      }

      const removed = diff.filter(d => d.type === "-").length;
      const added = diff.filter(d => d.type === "+").length;
      const unchanged = diff.filter(d => d.type === " ").length;

      const lines = [`  Word Diff\n`];
      let line = "  ";
      for (const d of diff) {
        const token = d.type === "-" ? `[-${d.word}-]` : d.type === "+" ? `{+${d.word}+}` : d.word;
        if (line.length + token.length + 1 > 100) {
          lines.push(line);
          line = "  ";
        }
        line += (line.length > 2 ? " " : "") + token;
      }
      if (line.length > 2) lines.push(line);

      lines.push(``);
      lines.push(`  Removed: ${removed}  Added: ${added}  Unchanged: ${unchanged}`);

      return lines.join("\n");
    }
    case "table_fmt": {
      if (!args?.trim()) return "  Usage: /table-fmt header1,header2 | row1col1,row1col2 | row2col1,row2col2\n  Example: /table-fmt Name,Age,City | Alice,30,NYC | Bob,25,LA";

      const sections = args.split("|").map(s => s.trim()).filter(Boolean);
      if (sections.length < 1) return "  Provide at least headers.";

      const rows = sections.map(s => s.split(",").map(c => c.trim()));
      const headers = rows[0]!;
      const dataRows = rows.slice(1);
      const numCols = headers.length;

      // Calculate column widths
      const colWidths = headers.map((h, i) => {
        const values = [h, ...dataRows.map(r => r[i] ?? "")];
        return Math.max(...values.map(v => v.length), 3);
      });

      const formatRow = (cells: string[]) =>
        "| " + cells.map((c, i) => (c ?? "").padEnd(colWidths[i]!)).join(" | ") + " |";

      const separator = "| " + colWidths.map(w => "-".repeat(w)).join(" | ") + " |";

      const lines = [`  Markdown Table\n`];
      lines.push(`  ${formatRow(headers)}`);
      lines.push(`  ${separator}`);
      for (const row of dataRows) {
        lines.push(`  ${formatRow(row)}`);
      }

      return lines.join("\n");
    }
    case "progress": {
      if (!args?.trim()) return "  Usage: /progress <value> [max] [label]\n  Examples: /progress 75, /progress 3 10 Tasks, /progress 50,80,30";

      const input = args.trim();

      // Multiple bars: comma-separated values
      if (input.includes(",") && !input.includes(" ")) {
        const values = input.split(",").map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        const max = Math.max(...values, 100);
        const barWidth = 30;

        const lines = [`  Progress Bars\n`];
        for (let i = 0; i < values.length; i++) {
          const val = values[i]!;
          const pct = Math.min(val / max * 100, 100);
          const filled = Math.round(pct / 100 * barWidth);
          const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
          lines.push(`  ${String(i + 1).padStart(3)}  ${bar}  ${val}/${max} (${pct.toFixed(0)}%)`);
        }
        return lines.join("\n");
      }

      const parts = input.split(/\s+/);
      const value = parseFloat(parts[0]!);
      if (isNaN(value)) return "  Value must be a number.";

      const max = parts[1] ? parseFloat(parts[1]) : 100;
      if (!max || max <= 0) return "  Max must be greater than 0.";
      const label = parts.slice(2).join(" ") || "";
      const pct = Math.min(value / max * 100, 100);
      const barWidth = 30;
      const filled = Math.round(pct / 100 * barWidth);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);

      return [
        `  Progress${label ? `: ${label}` : ""}\n`,
        `  ${bar}  ${value}/${max} (${pct.toFixed(1)}%)`,
        ``,
        `  ${"0".padEnd(barWidth / 2)}${"50%".padEnd(barWidth / 2)}100%`,
      ].join("\n");
    }
    case "jwt": {
      if (!args?.trim()) return "  Usage: /jwt <token>";

      const token = args.trim();
      if (token.length > 100000) return "  Token too large (max 100 KB).";
      const parts = token.split(".");

      if (parts.length !== 3) return "  Invalid JWT: expected 3 parts (header.payload.signature).";

      const decodeBase64Url = (str: string): string => {
        // Base64url to base64
        let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
        while (base64.length % 4) base64 += "=";
        return Buffer.from(base64, "base64").toString("utf-8");
      };

      try {
        const header = JSON.parse(decodeBase64Url(parts[0]!));
        const payload = JSON.parse(decodeBase64Url(parts[1]!));
        const sig = parts[2]!;

        const lines = [
          `  JWT Decode\n`,
          `  Header:`,
        ];
        for (const line of JSON.stringify(header, null, 2).split("\n")) {
          lines.push(`    ${line}`);
        }

        lines.push(`\n  Payload:`);
        for (const line of JSON.stringify(payload, null, 2).split("\n")) {
          lines.push(`    ${line}`);
        }

        // Decode common fields
        lines.push(`\n  Details:`);
        if (header.alg) lines.push(`    Algorithm: ${header.alg}`);
        if (header.typ) lines.push(`    Type:      ${header.typ}`);
        if (payload.sub) lines.push(`    Subject:   ${payload.sub}`);
        if (payload.iss) lines.push(`    Issuer:    ${payload.iss}`);
        if (payload.aud) lines.push(`    Audience:  ${Array.isArray(payload.aud) ? payload.aud.join(", ") : payload.aud}`);

        if (payload.iat) {
          const iat = new Date(payload.iat * 1000);
          lines.push(`    Issued:    ${iat.toISOString()}`);
        }
        if (payload.exp) {
          const exp = new Date(payload.exp * 1000);
          const now = new Date();
          const expired = exp < now;
          lines.push(`    Expires:   ${exp.toISOString()} ${expired ? "(EXPIRED)" : "(valid)"}`);
        }
        if (payload.nbf) {
          lines.push(`    Not Before: ${new Date(payload.nbf * 1000).toISOString()}`);
        }

        lines.push(`\n  Signature: ${sig.slice(0, 20)}...${sig.length > 20 ? ` (${sig.length} chars)` : ""}`);
        lines.push(`  \u26a0 Signature NOT verified (decode only)`);

        return lines.join("\n");
      } catch (err: any) {
        return `  Failed to decode JWT: ${err.message}`;
      }
    }
    case "crontab": {
      if (!args?.trim()) return "  Usage: /crontab <cron expression>\n  Example: /crontab */5 * * * *";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 5) return "  Invalid cron: need 5 fields (minute hour day month weekday)";

      const [minF, hourF, dayF, monthF, dowF] = parts.slice(0, 5);
      const fieldNames = ["Minute", "Hour", "Day", "Month", "Weekday"];
      const fieldRanges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
      const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const fields = [minF!, hourF!, dayF!, monthF!, dowF!];

      // Parse a single cron field into matching values
      const parseField = (field: string, min: number, max: number): number[] => {
        const values = new Set<number>();
        for (const part of field.split(",")) {
          const stepMatch = part.match(/^(.+)\/(\d+)$/);
          const step = stepMatch ? parseInt(stepMatch[2]!) : 1;
          const range = stepMatch ? stepMatch[1]! : part;

          if (range === "*") {
            for (let i = min; i <= max; i += step) values.add(i);
          } else if (range.includes("-")) {
            const [a, b] = range.split("-").map(Number);
            for (let i = a!; i <= b!; i += step) values.add(i);
          } else {
            values.add(parseInt(range));
          }
        }
        return [...values].filter(v => v >= min && v <= max).sort((a, b) => a - b);
      };

      const parsed = fields.map((f, i) => parseField(f, fieldRanges[i]![0]!, fieldRanges[i]![1]!));

      const lines = [
        `  Cron Expression: ${fields.join(" ")}\n`,
      ];

      // Describe each field
      for (let i = 0; i < 5; i++) {
        const vals = parsed[i]!;
        let desc: string;
        if (fields[i] === "*") desc = "every";
        else if (i === 4) desc = vals.map(v => dowNames[v]!).join(", ");
        else if (i === 3) desc = vals.map(v => monthNames[v]!).join(", ");
        else desc = vals.join(", ");
        lines.push(`  ${fieldNames[i]!.padEnd(8)} ${fields[i]!.padEnd(10)} \u2192 ${desc}`);
      }

      // Calculate next 5 runs
      lines.push(`\n  Next 5 runs:`);
      const now = new Date();
      let cursor = new Date(now);
      cursor.setSeconds(0, 0);
      cursor.setMinutes(cursor.getMinutes() + 1);
      let found = 0;

      for (let attempt = 0; attempt < 100000 && found < 5; attempt++) { // max ~69 days of minutes
        const m = cursor.getMinutes();
        const h = cursor.getHours();
        const d = cursor.getDate();
        const mo = cursor.getMonth() + 1;
        const dow = cursor.getDay();

        if (parsed[0]!.includes(m) && parsed[1]!.includes(h) && parsed[2]!.includes(d) && parsed[3]!.includes(mo) && parsed[4]!.includes(dow)) {
          lines.push(`    ${cursor.toLocaleString()}`);
          found++;
        }
        cursor.setMinutes(cursor.getMinutes() + 1);
      }

      if (found === 0) lines.push(`    (no matches in next 69 days)`);

      return lines.join("\n");
    }
    case "weather": {
      const city = args?.trim() || "";
      const query = city ? encodeURIComponent(city) : "";

      try {
        const urlDetail = `https://wttr.in/${query}?format=%l%n%c+%C+%t+(feels+like+%f)%nHumidity:+%h%nWind:+%w%nPrecip:+%p%nUV:+%u%nMoon:+%m+%M`;
        const respDetail = await fetch(urlDetail, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "curl/8.0" } });
        const detail = (await respDetail.text()).trim();

        const lines = [`  Weather\n`];
        for (const l of detail.split("\n")) {
          lines.push(`  ${l}`);
        }
        return lines.join("\n");
      } catch (err: any) {
        return `  Weather error: ${err.message}`;
      }
    }
    default:
      return null;
  }
}
