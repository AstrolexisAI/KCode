// KCode - Benchmark Tasks
// Self-contained coding tasks for measuring model performance.

import type { BenchmarkTask } from "./suite";

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    id: "fix-type-error",
    name: "Fix a simple TypeScript type error",
    category: "coding",
    prompt: `Fix the TypeScript type error in this code:

\`\`\`typescript
interface User {
  id: number;
  name: string;
  email: string;
}

function getUser(id: string): User {
  return {
    id: id,  // Error: Type 'string' is not assignable to type 'number'
    name: "John",
    email: "john@example.com"
  };
}
\`\`\`

Provide the corrected code.`,
    expectedBehavior: "parseInt;Number;number;id: Number(id);parseInt(id",
    maxTimeMs: 30000,
  },
  {
    id: "add-error-handling",
    name: "Add error handling to a function",
    category: "coding",
    prompt: `Add proper error handling to this function:

\`\`\`typescript
async function fetchUserData(userId: string) {
  const response = await fetch(\`https://api.example.com/users/\${userId}\`);
  const data = await response.json();
  return data;
}
\`\`\`

Add try/catch, check response status, and handle network errors.`,
    expectedBehavior: "try;catch;response.ok;throw;error;status",
    maxTimeMs: 30000,
  },
  {
    id: "write-unit-test",
    name: "Write a unit test for a function",
    category: "coding",
    prompt: `Write unit tests for this function:

\`\`\`typescript
function calculateDiscount(price: number, discountPercent: number): number {
  if (price < 0) throw new Error("Price cannot be negative");
  if (discountPercent < 0 || discountPercent > 100) throw new Error("Invalid discount");
  return price * (1 - discountPercent / 100);
}
\`\`\`

Write at least 4 test cases covering normal operation and edge cases.`,
    expectedBehavior: "test;expect;throw;calculateDiscount;100;0",
    maxTimeMs: 30000,
  },
  {
    id: "refactor-async-await",
    name: "Refactor a function to use async/await",
    category: "coding",
    prompt: `Refactor this callback-based function to use async/await:

\`\`\`typescript
function processFiles(files: string[], callback: (err: Error | null, results?: string[]) => void) {
  const results: string[] = [];
  let index = 0;

  function next() {
    if (index >= files.length) {
      callback(null, results);
      return;
    }
    readFile(files[index], (err, content) => {
      if (err) {
        callback(err);
        return;
      }
      results.push(content);
      index++;
      next();
    });
  }
  next();
}
\`\`\`

Convert to async/await with proper error handling.`,
    expectedBehavior: "async;await;Promise;for;try;catch",
    maxTimeMs: 30000,
  },
  {
    id: "find-bug",
    name: "Find a bug in a code snippet",
    category: "coding",
    prompt: `Find and fix the bug in this code:

\`\`\`typescript
function removeDuplicates(arr: number[]): number[] {
  const seen = new Set();
  const result = [];
  for (let i = 0; i <= arr.length; i++) {
    if (!seen.has(arr[i])) {
      seen.add(arr[i]);
      result.push(arr[i]);
    }
  }
  return result;
}
\`\`\`

Explain the bug and provide the fix.`,
    expectedBehavior: "<=;off-by-one;<;length;undefined;i < arr.length",
    maxTimeMs: 30000,
  },
  {
    id: "explain-function",
    name: "Explain what a function does",
    category: "context",
    prompt: `Explain what this function does in plain English:

\`\`\`typescript
function mystery(s: string): string {
  const stack: string[] = [];
  const map: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

  for (const char of s) {
    if ('([{'.includes(char)) {
      stack.push(char);
    } else if (')]}'.includes(char)) {
      if (stack.length === 0 || stack[stack.length - 1] !== map[char]) {
        return 'invalid';
      }
      stack.pop();
    }
  }
  return stack.length === 0 ? 'valid' : 'invalid';
}
\`\`\`

Provide a clear explanation.`,
    expectedBehavior: "bracket;parenthes;balanced;valid;stack;matching",
    maxTimeMs: 30000,
  },
  {
    id: "generate-sql",
    name: "Generate a SQL query from description",
    category: "coding",
    prompt: `Write a SQL query that:
1. Gets all orders from the last 30 days
2. Joins with the customers table
3. Groups by customer name
4. Shows total order amount per customer
5. Only includes customers with total > $100
6. Orders by total descending

Tables:
- orders(id, customer_id, amount, created_at)
- customers(id, name, email)`,
    expectedBehavior: "SELECT;JOIN;GROUP BY;HAVING;ORDER BY;SUM",
    maxTimeMs: 30000,
  },
  {
    id: "create-rest-endpoint",
    name: "Create a REST API endpoint",
    category: "coding",
    prompt: `Create an Express.js REST API endpoint for a TODO app:

- POST /api/todos - Create a new todo
- GET /api/todos - List all todos (with optional ?status=completed filter)
- PUT /api/todos/:id - Update a todo
- DELETE /api/todos/:id - Delete a todo

Include input validation, proper HTTP status codes, and error handling.
Use TypeScript.`,
    expectedBehavior: "router;post;get;put;delete;status;json;400;404;201",
    maxTimeMs: 45000,
  },
  {
    id: "callback-to-promise",
    name: "Convert callback to promise",
    category: "coding",
    prompt: `Convert this callback-based function to return a Promise:

\`\`\`typescript
function readConfig(path: string, callback: (err: Error | null, config?: Record<string, string>) => void): void {
  fs.readFile(path, 'utf-8', (err, data) => {
    if (err) {
      callback(err);
      return;
    }
    try {
      const config = JSON.parse(data);
      callback(null, config);
    } catch (parseErr) {
      callback(parseErr as Error);
    }
  });
}
\`\`\`

Provide the promisified version using \`new Promise\` and also a version using \`util.promisify\` or \`fs.promises\`.`,
    expectedBehavior: "Promise;resolve;reject;async;await;fs.promises;readFile",
    maxTimeMs: 30000,
  },
  {
    id: "optimize-loop",
    name: "Optimize a slow loop",
    category: "coding",
    prompt: `Optimize this slow function. It finds all pairs of numbers in an array that sum to a target:

\`\`\`typescript
function findPairs(nums: number[], target: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      if (nums[i] + nums[j] === target) {
        pairs.push([nums[i], nums[j]]);
      }
    }
  }
  return pairs;
}
\`\`\`

The current implementation is O(n^2). Optimize it to O(n) using a hash set/map approach.`,
    expectedBehavior: "Map;Set;has;get;set;O(n);complement;target - ",
    maxTimeMs: 30000,
  },
  {
    id: "context-large-file",
    name: "Understand context from a large code block",
    category: "context",
    prompt: `Given this configuration system, what would happen if a user sets both KCODE_MODEL env var and --model CLI flag? Which takes priority and why?

\`\`\`typescript
interface Config {
  model: string;
  apiBase: string;
  apiKey: string;
}

function resolveConfig(cliFlags: Partial<Config>, env: Record<string, string>, fileConfig: Partial<Config>): Config {
  return {
    model: cliFlags.model ?? env.KCODE_MODEL ?? fileConfig.model ?? "default-model",
    apiBase: cliFlags.apiBase ?? env.KCODE_API_BASE ?? fileConfig.apiBase ?? "http://localhost:10091",
    apiKey: cliFlags.apiKey ?? env.KCODE_API_KEY ?? fileConfig.apiKey ?? "",
  };
}
\`\`\`

Explain the priority chain.`,
    expectedBehavior: "CLI;flag;priority;env;override;nullish;??;file;first",
    maxTimeMs: 30000,
  },
  {
    id: "speed-simple-response",
    name: "Fast response to a simple question",
    category: "speed",
    prompt: "What is the difference between `let` and `const` in TypeScript?",
    expectedBehavior: "let;const;reassign;mutable;immutable;block;scope",
    maxTimeMs: 15000,
  },
];
