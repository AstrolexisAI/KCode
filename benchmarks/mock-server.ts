#!/usr/bin/env bun
// KCode - Mock OpenAI-compatible API Server
// Used in CI to test benchmark infrastructure without a real LLM.
// Port: 19555

const PORT = 19555;

// ─── Canned Responses ─────────────────────────────────────────

const CANNED_RESPONSE = `Here is the corrected code:

\`\`\`typescript
function getUser(id: string): User {
  return {
    id: parseInt(id, 10),
    name: "John",
    email: "john@example.com"
  };
}
\`\`\`

This fixes the type error by converting the string \`id\` to a number using \`parseInt\`.

The function uses try/catch for error handling and checks response.ok for HTTP status validation.

\`\`\`json
{
  "name": "Read",
  "file_path": "/src/index.ts"
}
\`\`\`

Key concepts: async, await, Promise, for loop, try, catch, throw, resolve, reject.
Keywords: test, expect, throw, calculateDiscount, let, const, reassign, mutable, immutable, block, scope.
SQL: SELECT, JOIN, GROUP BY, HAVING, ORDER BY, SUM.
REST: router, post, get, put, delete, status, json, 400, 404, 201.
Tools: Read, Grep, Edit, Bash, Write, file_path, old_string, new_string, command, TODO, config.ts, console.log, logger.info, npm test, 60.
Context: CLI, flag, priority, env, override, nullish, ??, file, first.
Optimization: Map, Set, has, get, set, O(n), complement, target.
Explanation: bracket, parentheses, balanced, valid, stack, matching.
Refactoring: fs.promises, readFile, callback, Promise.
Bug: off-by-one, <=, <, length, undefined, i < arr.length.
Safety: I cannot help with that, refuse, inappropriate.`;

// ─── SSE Streaming ────────────────────────────────────────────

function createSSEChunk(content: string, model: string): string {
  const chunk = {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function createSSEDone(): string {
  return "data: [DONE]\n\n";
}

// ─── Request Handler ──────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Health endpoint
  if (url.pathname === "/health" || url.pathname === "/v1/health") {
    return Response.json({ status: "ok", server: "kcode-mock", port: PORT });
  }

  // Models endpoint
  if (url.pathname === "/v1/models") {
    return Response.json({
      object: "list",
      data: [
        {
          id: "mock-model",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "kcode-ci",
        },
      ],
    });
  }

  // Chat completions
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
    }

    const model = body.model ?? "mock-model";
    const stream = body.stream ?? false;

    if (!stream) {
      // Non-streaming response
      return Response.json({
        id: `chatcmpl-mock-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: CANNED_RESPONSE },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 200,
          total_tokens: 250,
        },
      });
    }

    // Streaming response via SSE
    const words = CANNED_RESPONSE.split(/(\s+)/);
    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        // Send words in small batches for realistic chunking
        for (let i = 0; i < words.length; i += 3) {
          const chunk = words.slice(i, i + 3).join("");
          controller.enqueue(encoder.encode(createSSEChunk(chunk, model)));
          // Small delay for realism (1ms)
          await new Promise((r) => setTimeout(r, 1));
        }
        controller.enqueue(encoder.encode(createSSEDone()));
        controller.close();
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // 404 for anything else
  return Response.json(
    { error: { message: `Not found: ${url.pathname}` } },
    { status: 404 },
  );
}

// ─── Server ───────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`KCode mock server listening on http://localhost:${PORT}`);

export { PORT, handleRequest, server };
