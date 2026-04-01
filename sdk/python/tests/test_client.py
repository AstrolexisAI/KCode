"""Tests for kcode_sdk.KCodeClient"""

import json
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread
from typing import Any, Dict, Optional

from kcode_sdk import KCodeClient, KCodeError


class MockHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that returns canned responses per path."""

    routes: Dict[str, Any] = {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in self.routes:
            status, body = self.routes[path]
            self._respond(status, body)
        else:
            self._respond(404, {"error": "Not found", "code": 404})

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(content_len) if content_len else b""

        path = self.path.split("?")[0]
        key = f"POST {path}"
        if key in self.routes:
            status, body = self.routes[key]
            if callable(body):
                body = body(json.loads(raw) if raw else {}, dict(self.headers))
            self._respond(status, body)
        else:
            self._respond(404, {"error": "Not found", "code": 404})

    def _respond(self, status: int, body: Any):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def log_message(self, format, *args):
        pass  # Suppress logs during tests


def start_mock_server(routes: Dict[str, Any], port: int = 0):
    MockHandler.routes = routes
    server = HTTPServer(("127.0.0.1", port), MockHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class TestKCodeClient(unittest.TestCase):
    """Test suite for KCodeClient using a local mock HTTP server."""

    server: Optional[HTTPServer] = None
    client: Optional[KCodeClient] = None

    @classmethod
    def setUpClass(cls):
        routes = {
            "/api/health": (200, {"ok": True, "version": "1.7.0", "model": "test-model"}),
            "/api/status": (
                200,
                {
                    "model": "test-model",
                    "sessionId": None,
                    "tokenCount": 500,
                    "toolUseCount": 3,
                    "runningAgents": 0,
                    "contextUsage": {
                        "messageCount": 10,
                        "tokenEstimate": 500,
                        "contextWindow": 32000,
                        "usagePercent": 2,
                    },
                    "uptime": 120,
                },
            ),
            "/api/tools": (
                200,
                {
                    "tools": [
                        {"name": "Read", "description": "Read a file"},
                        {"name": "Grep", "description": "Search files"},
                    ]
                },
            ),
            "/api/sessions": (
                200,
                {
                    "active": [
                        {
                            "sessionId": "sess-1",
                            "model": "test-model",
                            "active": True,
                            "createdAt": "2026-01-01T00:00:00Z",
                            "lastActivity": "2026-01-01T00:01:00Z",
                            "messageCount": 5,
                            "toolUseCount": 2,
                            "tokenCount": 300,
                        }
                    ],
                    "recent": [],
                },
            ),
            "/api/context": (
                200,
                {
                    "sessionId": "sess-1",
                    "messageCount": 10,
                    "tokenEstimate": 500,
                    "contextWindow": 32000,
                    "usagePercent": 2,
                },
            ),
            "/api/plan": (200, {"sessionId": "sess-1", "plan": None}),
            "/api/mcp": (200, {"servers": [], "tools": []}),
            "/api/agents": (200, {"available": [], "running": []}),
            "POST /api/prompt": (
                200,
                lambda body, headers: {
                    "id": "resp-1",
                    "sessionId": headers.get("X-Session-Id", "new-sess"),
                    "response": f"Echo: {body.get('prompt', '')}",
                    "toolCalls": [],
                    "usage": {"inputTokens": 10, "outputTokens": 5},
                    "model": body.get("model", "test-model"),
                },
            ),
            "POST /api/tool": (
                200,
                lambda body, headers: {
                    "name": body.get("name", ""),
                    "content": f"result for {body.get('name', '')}",
                    "isError": False,
                },
            ),
            "POST /api/compact": (
                200,
                {
                    "sessionId": "sess-1",
                    "compacted": True,
                    "messagesBefore": 20,
                    "messagesAfter": 8,
                    "tokensBefore": 5000,
                    "tokensAfter": 2000,
                },
            ),
        }

        cls.server = start_mock_server(routes)
        port = cls.server.server_address[1]
        cls.client = KCodeClient(base_url=f"http://127.0.0.1:{port}", timeout=5)

    @classmethod
    def tearDownClass(cls):
        if cls.server:
            cls.server.shutdown()

    def test_health(self):
        result = self.client.health()
        self.assertTrue(result["ok"])
        self.assertEqual(result["version"], "1.7.0")
        self.assertEqual(result["model"], "test-model")

    def test_status(self):
        result = self.client.status()
        self.assertEqual(result["model"], "test-model")
        self.assertEqual(result["tokenCount"], 500)
        self.assertIn("contextUsage", result)

    def test_prompt(self):
        result = self.client.prompt("Hello")
        self.assertEqual(result["text"], "Echo: Hello")
        self.assertEqual(result["usage"]["inputTokens"], 10)
        self.assertIsInstance(result["toolCalls"], list)

    def test_prompt_with_session_id(self):
        result = self.client.prompt("Hi", session_id="my-session")
        self.assertEqual(result["sessionId"], "my-session")

    def test_prompt_with_options(self):
        result = self.client.prompt("Test", model="gpt-4", no_tools=True)
        self.assertEqual(result["text"], "Echo: Test")

    def test_tools(self):
        result = self.client.tools()
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["name"], "Read")
        self.assertEqual(result[1]["name"], "Grep")

    def test_execute_tool(self):
        result = self.client.execute_tool("Read", {"file_path": "/tmp/test"})
        self.assertEqual(result["name"], "Read")
        self.assertFalse(result["isError"])
        self.assertIn("Read", result["content"])

    def test_sessions(self):
        result = self.client.sessions()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["sessionId"], "sess-1")

    def test_context(self):
        result = self.client.context()
        self.assertEqual(result["messageCount"], 10)
        self.assertEqual(result["usagePercent"], 2)

    def test_compact(self):
        result = self.client.compact()
        self.assertTrue(result["compacted"])
        self.assertEqual(result["messagesBefore"], 20)

    def test_plan(self):
        result = self.client.plan()
        self.assertIsNone(result["plan"])

    def test_mcp(self):
        result = self.client.mcp()
        self.assertIn("servers", result)
        self.assertIn("tools", result)

    def test_agents(self):
        result = self.client.agents()
        self.assertIn("available", result)
        self.assertIn("running", result)

    def test_models(self):
        result = self.client.models()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "test-model")

    def test_auth_header(self):
        """Verify that api_key produces an Authorization header."""
        # We test indirectly -- the mock server doesn't validate tokens,
        # but we ensure the client constructs headers correctly.
        client = KCodeClient(
            base_url=self.client.base_url,
            api_key="secret-token",
            timeout=5,
        )
        headers = client._headers()
        self.assertEqual(headers["Authorization"], "Bearer secret-token")

    def test_no_auth_header(self):
        """Verify no Authorization header when api_key is None."""
        headers = self.client._headers()
        self.assertNotIn("Authorization", headers)

    def test_connection_error(self):
        bad_client = KCodeClient(base_url="http://127.0.0.1:1", timeout=1)
        with self.assertRaises(KCodeError):
            bad_client.health()


if __name__ == "__main__":
    unittest.main()
