// KCode - Extension API OpenAPI Schema
// Generates OpenAPI 3.0 specification for the Extension API

/**
 * Generates the full OpenAPI 3.0 specification for the Extension API.
 */
export function generateOpenAPISchema(): object {
  return {
    openapi: "3.0.3",
    info: {
      title: "KCode Extension API",
      description: "API for extending KCode with external tools, IDE integrations, and automation.",
      version: "1.0.0",
      contact: {
        name: "Astrolexis",
      },
      license: {
        name: "Apache-2.0",
      },
    },
    servers: [
      {
        url: "http://localhost:19300/api/ext/v1",
        description: "Local Extension API server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "token",
          description: "Optional auth token configured in Extension API settings",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            code: { type: "string" },
          },
          required: ["error", "code"],
        },
        HealthResponse: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["ok"] },
            version: { type: "string" },
            uptime: { type: "number", description: "Uptime in milliseconds" },
            model: { type: "string" },
            sessionId: { type: "string", nullable: true },
          },
          required: ["status", "version", "uptime", "model", "sessionId"],
        },
        InfoResponse: {
          type: "object",
          properties: {
            version: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
            models: { type: "array", items: { type: "string" } },
            features: { type: "array", items: { type: "string" } },
          },
          required: ["version", "tools", "models", "features"],
        },
        SessionStats: {
          type: "object",
          properties: {
            tokensUsed: { type: "number" },
            costUsd: { type: "number" },
            toolCalls: { type: "number" },
            durationMs: { type: "number" },
          },
          required: ["tokensUsed", "costUsd", "toolCalls", "durationMs"],
        },
        Message: {
          type: "object",
          properties: {
            id: { type: "string" },
            role: { type: "string", enum: ["user", "assistant", "system"] },
            content: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
          },
          required: ["id", "role", "content"],
        },
        Tool: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            parameters: { type: "object" },
          },
          required: ["name", "description"],
        },
        Memory: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
          required: ["id", "type", "title", "content"],
        },
        Session: {
          type: "object",
          properties: {
            id: { type: "string" },
            model: { type: "string" },
            startedAt: { type: "string", format: "date-time" },
            stats: { $ref: "#/components/schemas/SessionStats" },
          },
          required: ["id", "model", "startedAt"],
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          operationId: "getHealth",
          tags: ["System"],
          security: [],
          responses: {
            "200": {
              description: "Server is healthy",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } },
              },
            },
          },
        },
      },
      "/info": {
        get: {
          summary: "Server information",
          operationId: "getInfo",
          tags: ["System"],
          security: [],
          responses: {
            "200": {
              description: "Server information",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/InfoResponse" } },
              },
            },
          },
        },
      },
      "/messages": {
        get: {
          summary: "List messages in current session",
          operationId: "listMessages",
          tags: ["Messages"],
          responses: {
            "200": {
              description: "List of messages",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Message" } },
                },
              },
            },
          },
        },
        post: {
          summary: "Send a message",
          operationId: "sendMessage",
          tags: ["Messages"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    content: { type: "string" },
                    model: { type: "string" },
                    tools: { type: "array", items: { type: "string" } },
                  },
                  required: ["content"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Message accepted",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } },
            },
          },
        },
      },
      "/cancel": {
        post: {
          summary: "Cancel current response",
          operationId: "cancelResponse",
          tags: ["Messages"],
          responses: {
            "200": {
              description: "Cancellation acknowledged",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
      "/stream": {
        get: {
          summary: "SSE event stream",
          operationId: "streamEvents",
          tags: ["Events"],
          responses: {
            "200": {
              description: "Server-Sent Events stream",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/tools": {
        get: {
          summary: "List available tools",
          operationId: "listTools",
          tags: ["Tools"],
          responses: {
            "200": {
              description: "List of tools",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Tool" } },
                },
              },
            },
          },
        },
      },
      "/tools/{name}": {
        post: {
          summary: "Execute a tool by name",
          operationId: "executeTool",
          tags: ["Tools"],
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", description: "Tool input parameters" },
              },
            },
          },
          responses: {
            "200": {
              description: "Tool execution result",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "404": {
              description: "Tool not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/memories": {
        get: {
          summary: "List memories",
          operationId: "listMemories",
          tags: ["Memory"],
          responses: {
            "200": {
              description: "List of memories",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Memory" } },
                },
              },
            },
          },
        },
        post: {
          summary: "Create a memory",
          operationId: "createMemory",
          tags: ["Memory"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    title: { type: "string" },
                    content: { type: "string" },
                  },
                  required: ["type", "title", "content"],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Memory created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Memory" } } },
            },
          },
        },
      },
      "/memories/{id}": {
        put: {
          summary: "Update a memory",
          operationId: "updateMemory",
          tags: ["Memory"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    title: { type: "string" },
                    content: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Memory updated",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Memory" } } },
            },
            "404": {
              description: "Memory not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
        delete: {
          summary: "Delete a memory",
          operationId: "deleteMemory",
          tags: ["Memory"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Memory deleted",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
            "404": {
              description: "Memory not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/config": {
        get: {
          summary: "Read configuration",
          operationId: "getConfig",
          tags: ["Config"],
          responses: {
            "200": {
              description: "Current configuration",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
        patch: {
          summary: "Update configuration",
          operationId: "updateConfig",
          tags: ["Config"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", description: "Partial config to merge" },
              },
            },
          },
          responses: {
            "200": {
              description: "Configuration updated",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/sessions": {
        get: {
          summary: "List sessions",
          operationId: "listSessions",
          tags: ["Sessions"],
          responses: {
            "200": {
              description: "List of sessions",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Session" } },
                },
              },
            },
          },
        },
        post: {
          summary: "Create a new session",
          operationId: "createSession",
          tags: ["Sessions"],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Session created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Session" } } },
            },
          },
        },
      },
      "/sessions/{id}": {
        get: {
          summary: "Get session details",
          operationId: "getSession",
          tags: ["Sessions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Session details",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Session" } } },
            },
            "404": {
              description: "Session not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI schema",
          operationId: "getOpenAPISchema",
          tags: ["System"],
          security: [],
          responses: {
            "200": {
              description: "OpenAPI 3.0 specification",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  };
}
