// Regression coverage for detectWebIntent — specifically the false
// positives that sent a Python+textual terminal prompt to the
// Next.js trading-dashboard scaffold.

import { describe, expect, test } from "bun:test";
import { detectWebIntent } from "./detector";

describe("detectWebIntent — false-positive regressions", () => {
  test("Python + textual + ticker prompt does NOT pick trading-dashboard", () => {
    // Reproducer from the btctop incident: a 3k-char prompt with
    // 'textual', 'terminal', 'htop', AND the word 'ticker' used
    // as a panel name. Pre-fix, this matched `ticker` alone and
    // triggered the Next.js template. Post-fix, `ticker` requires
    // a currency-type qualifier, so trading-dashboard stays cold.
    const prompt = `Build a Python 3.11+ terminal dashboard called btctop — a real-time Bitcoin
monitor styled like htop. TECH STACK: textual, httpx. PANELS include a
price ticker panel. NON-GOALS: no wallet, no trading.`;
    const intent = detectWebIntent(prompt);
    expect(intent.siteType).not.toBe("trading-dashboard");
  });

  test("'news ticker' on a landing page does NOT pick trading-dashboard", () => {
    const intent = detectWebIntent(
      "Build a landing page for a news site with a news ticker across the top",
    );
    expect(intent.siteType).not.toBe("trading-dashboard");
  });

  test("'price ticker' on a python CLI does NOT pick trading-dashboard", () => {
    const intent = detectWebIntent(
      "Python CLI that shows a price ticker for BTC and ETH in the terminal",
    );
    expect(intent.siteType).not.toBe("trading-dashboard");
  });

  test("photo portfolio website does NOT pick trading-dashboard", () => {
    // Pre-fix, 'portfolio' alone matched. Post-fix it needs "portfolio
    // tracker" / "portfolio dashboard" / "portfolio manager".
    const intent = detectWebIntent(
      "Build a photo portfolio website to showcase my work",
    );
    expect(intent.siteType).not.toBe("trading-dashboard");
  });
});

describe("detectWebIntent — actual trading apps still match", () => {
  test("explicit trading dashboard is picked up", () => {
    const intent = detectWebIntent(
      "Build a trading dashboard with candlestick charts and an order book",
    );
    expect(intent.siteType).toBe("trading-dashboard");
  });

  test("stock ticker web app matches trading-dashboard", () => {
    const intent = detectWebIntent(
      "Build a web app with a stock ticker and portfolio tracker",
    );
    expect(intent.siteType).toBe("trading-dashboard");
  });

  test("spanish bolsa/acciones still matches", () => {
    const intent = detectWebIntent(
      "Un sitio web para la bolsa con gráficos de acciones",
    );
    expect(intent.siteType).toBe("trading-dashboard");
  });

  test("crypto ticker matches", () => {
    const intent = detectWebIntent(
      "Website with a crypto ticker for BTC, ETH and a portfolio dashboard",
    );
    expect(intent.siteType).toBe("trading-dashboard");
  });

  test("portfolio tracker matches", () => {
    const intent = detectWebIntent(
      "Build a portfolio tracker for my stocks",
    );
    expect(intent.siteType).toBe("trading-dashboard");
  });
});
