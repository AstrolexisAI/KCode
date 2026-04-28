"""KCode SDK -- Python client for KCode HTTP API"""

import json
import urllib.request
import urllib.error
from typing import Any, Dict, Generator, List, Optional

__version__ = "1.0.0"


class KCodeError(Exception):
    """Error raised by the KCode API."""

    def __init__(self, message: str, status_code: int = 0):
        super().__init__(message)
        self.status_code = status_code


class KCodeClient:
    """Client for the KCode HTTP API.

    Args:
        base_url: Base URL of the KCode server. Default: http://localhost:10101
        api_key: Bearer token for authentication. Optional.
        timeout: Request timeout in seconds. Default: 30.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:10101",
        api_key: Optional[str] = None,
        timeout: int = 30,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if extra:
            headers.update(extra)
        return headers

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=data,
            headers=self._headers(extra_headers),
            method=method,
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                err_body = json.loads(e.read().decode("utf-8"))
                msg = err_body.get("error", e.reason)
            except Exception:
                msg = e.reason
            raise KCodeError(f"KCode API error {e.code}: {msg}", e.code) from e
        except urllib.error.URLError as e:
            raise KCodeError(f"Connection error: {e.reason}") from e

    # ── Core ─────────────────────────────────────────────────────────

    def prompt(
        self,
        message: str,
        stream: bool = False,
        model: Optional[str] = None,
        no_tools: bool = False,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a prompt and return the full response.

        Args:
            message: The prompt text.
            stream: If True, use prompt_stream() instead.
            model: Override model for this request.
            no_tools: Disable tool execution.
            session_id: Session ID for conversation continuity.

        Returns:
            Dict with keys: text, toolCalls, usage, sessionId.
        """
        if stream:
            # Collect streamed chunks into a single response
            text = "".join(self.prompt_stream(
                message, model=model, no_tools=no_tools, session_id=session_id
            ))
            return {
                "text": text,
                "toolCalls": [],
                "usage": {"inputTokens": 0, "outputTokens": 0},
                "sessionId": session_id or "",
            }

        extra_headers = {}
        if session_id:
            extra_headers["X-Session-Id"] = session_id

        body: Dict[str, Any] = {"prompt": message, "stream": False}
        if model:
            body["model"] = model
        if no_tools:
            body["noTools"] = True

        raw = self._request("POST", "/api/prompt", body, extra_headers or None)

        return {
            "text": raw.get("response", ""),
            "toolCalls": raw.get("toolCalls", []),
            "usage": raw.get("usage", {"inputTokens": 0, "outputTokens": 0}),
            "sessionId": raw.get("sessionId", ""),
        }

    def prompt_stream(
        self,
        message: str,
        model: Optional[str] = None,
        no_tools: bool = False,
        session_id: Optional[str] = None,
    ) -> Generator[str, None, None]:
        """Send a prompt and yield text chunks via SSE streaming.

        Args:
            message: The prompt text.
            model: Override model for this request.
            no_tools: Disable tool execution.
            session_id: Session ID for conversation continuity.

        Yields:
            Text chunks as they arrive from the server.
        """
        url = f"{self.base_url}/api/prompt"
        extra_headers: Dict[str, str] = {}
        if session_id:
            extra_headers["X-Session-Id"] = session_id

        body: Dict[str, Any] = {"prompt": message, "stream": True}
        if model:
            body["model"] = model
        if no_tools:
            body["noTools"] = True

        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers=self._headers(extra_headers),
            method="POST",
        )

        try:
            resp = urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            raise KCodeError(f"KCode API error {e.code}: {e.reason}", e.code) from e
        except urllib.error.URLError as e:
            raise KCodeError(f"Connection error: {e.reason}") from e

        try:
            buffer = ""
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8")
                lines = buffer.split("\n")
                buffer = lines[-1]

                for line in lines[:-1]:
                    if line.startswith("data: "):
                        payload = line[6:]
                        if payload == "[DONE]":
                            return
                        try:
                            parsed = json.loads(payload)
                            if parsed.get("type") == "text" and "text" in parsed:
                                yield parsed["text"]
                        except json.JSONDecodeError:
                            yield payload
        finally:
            resp.close()

    # ── Health ───────────────────────────────────────────────────────

    def health(self) -> Dict[str, Any]:
        """Check server health.

        Returns:
            Dict with keys: ok, version, model.
        """
        return self._request("GET", "/api/health")

    def status(self) -> Dict[str, Any]:
        """Get detailed server status.

        Returns:
            Dict with keys: model, sessionId, tokenCount, toolUseCount,
            runningAgents, contextUsage, uptime.
        """
        return self._request("GET", "/api/status")

    # ── Models ───────────────────────────────────────────────────────

    def models(self) -> List[Dict[str, Any]]:
        """List available models.

        Returns:
            List of model info dicts with id and provider.
        """
        res = self._request("GET", "/api/status")
        if "models" in res:
            return res["models"]
        return [{"id": res.get("model", "unknown"), "provider": "unknown"}]

    # ── Sessions ─────────────────────────────────────────────────────

    def sessions(self, limit: int = 20) -> List[Dict[str, Any]]:
        """List active sessions.

        Args:
            limit: Maximum number of recent sessions to return.

        Returns:
            List of session dicts.
        """
        res = self._request("GET", f"/api/sessions?limit={limit}")
        return res.get("active", [])

    def session(self, filename: str) -> Dict[str, Any]:
        """Get a specific session transcript.

        Args:
            filename: Session transcript filename.

        Returns:
            Dict with keys: filename, messageCount, messages.
        """
        return self._request("GET", f"/api/session/{filename}")

    # ── Tools ────────────────────────────────────────────────────────

    def tools(self) -> List[Dict[str, Any]]:
        """List available tools.

        Returns:
            List of tool dicts with name, description, and input_schema.
        """
        res = self._request("GET", "/api/tools")
        return res.get("tools", [])

    def execute_tool(self, name: str, input_data: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a read-only tool.

        Args:
            name: Tool name (Read, Glob, Grep, LS, DiffView, GitStatus, GitLog, ToolSearch).
            input_data: Tool input parameters.

        Returns:
            Dict with keys: name, content, isError.
        """
        return self._request("POST", "/api/tool", {"name": name, "input": input_data})

    # ── Context & Plan ───────────────────────────────────────────────

    def context(
        self, session_id: Optional[str] = None, last_n: Optional[int] = None
    ) -> Dict[str, Any]:
        """Get conversation context summary.

        Args:
            session_id: Target session ID.
            last_n: Number of recent messages to include.
        """
        params = []
        if session_id:
            params.append(f"sessionId={session_id}")
        if last_n is not None:
            params.append(f"lastN={last_n}")
        qs = "&".join(params)
        path = f"/api/context?{qs}" if qs else "/api/context"
        return self._request("GET", path)

    def compact(self, session_id: Optional[str] = None) -> Dict[str, Any]:
        """Trigger context compaction.

        Args:
            session_id: Session to compact.
        """
        extra_headers = {}
        if session_id:
            extra_headers["X-Session-Id"] = session_id
        return self._request("POST", "/api/compact", extra_headers=extra_headers or None)

    def plan(self, session_id: Optional[str] = None) -> Dict[str, Any]:
        """Get the active plan for a session.

        Args:
            session_id: Target session ID.
        """
        qs = f"?sessionId={session_id}" if session_id else ""
        return self._request("GET", f"/api/plan{qs}")

    # ── Integrations ─────────────────────────────────────────────────

    def mcp(self) -> Dict[str, Any]:
        """List MCP servers and tools."""
        return self._request("GET", "/api/mcp")

    def agents(self) -> Dict[str, Any]:
        """List available and running agents."""
        return self._request("GET", "/api/agents")
