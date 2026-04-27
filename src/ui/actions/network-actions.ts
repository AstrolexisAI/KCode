// Network and API actions
// Extracted from utility-actions.ts

import type { ActionContext } from "./action-helpers.js";

export async function handleNetworkAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { appConfig, args } = ctx;

  switch (action) {
    case "http": {
      if (!args?.trim()) return "  Usage: /http [GET|POST|PUT|DELETE] <url> [body]";

      const parts = args.trim().split(/\s+/);
      let method = "GET";
      let url: string;
      let body: string | undefined;

      const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
      if (httpMethods.includes(parts[0]!.toUpperCase())) {
        method = parts[0]!.toUpperCase();
        url = parts[1] ?? "";
        body = parts.slice(2).join(" ") || undefined;
      } else {
        url = parts[0]!;
        body = parts.slice(1).join(" ") || undefined;
      }

      if (!url) return "  Usage: /http [METHOD] <url> [body]";
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      try {
        const startTime = performance.now();
        const fetchOpts: RequestInit = { method, signal: AbortSignal.timeout(15000) };
        if (body && method !== "GET" && method !== "HEAD") {
          fetchOpts.body = body;
          fetchOpts.headers = { "Content-Type": "application/json" };
        }

        const resp = await fetch(url, fetchOpts);
        const elapsed = Math.round(performance.now() - startTime);
        const contentType = resp.headers.get("content-type") ?? "";
        // Limit response to 1 MB to avoid OOM
        const reader = resp.body?.getReader();
        let responseText = "";
        if (reader) {
          const decoder = new TextDecoder();
          let totalBytes = 0;
          const maxBytes = 1024 * 1024;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
              responseText += decoder.decode(value, { stream: false });
              reader.cancel();
              responseText = responseText.slice(0, maxBytes) + "\n[truncated at 1 MB]";
              break;
            }
            responseText += decoder.decode(value, { stream: true });
          }
        }

        const lines = [
          `  HTTP ${method} ${url}\n`,
          `  Status:  ${resp.status} ${resp.statusText}`,
          `  Time:    ${elapsed}ms`,
          `  Type:    ${contentType}`,
          `  Size:    ${responseText.length.toLocaleString()} chars`,
        ];

        // Show headers summary
        const headerCount = [...(resp.headers as unknown as Iterable<[string, string]>)].length;
        lines.push(`  Headers: ${headerCount}`);
        lines.push(``);

        // Preview body
        if (contentType.includes("json")) {
          try {
            const json = JSON.parse(responseText);
            const formatted = JSON.stringify(json, null, 2);
            const preview = formatted.split("\n").slice(0, 25);
            lines.push(`  Response (JSON):`);
            for (const l of preview) lines.push(`  ${l}`);
            if (formatted.split("\n").length > 25)
              lines.push(`  ... ${formatted.split("\n").length - 25} more lines`);
          } catch {
            const preview = responseText.slice(0, 500);
            lines.push(`  Response:`);
            lines.push(`  ${preview}${responseText.length > 500 ? "..." : ""}`);
          }
        } else {
          const preview = responseText.slice(0, 500);
          lines.push(`  Response:`);
          for (const l of preview.split("\n").slice(0, 15)) lines.push(`  ${l}`);
          if (responseText.length > 500) lines.push(`  ... truncated`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  HTTP error: ${err.message}`;
      }
    }
    case "headers": {
      if (!args?.trim()) return "  Usage: /headers <URL>";

      let url = args.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      const lines = [`  HTTP Headers: ${url}\n`];

      try {
        const resp = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000),
          redirect: "follow",
        });

        lines.push(`  Status: ${resp.status} ${resp.statusText}\n`);

        const headersExt = resp.headers as unknown as {
          keys(): Iterable<string>;
          entries(): Iterable<[string, string]>;
        };
        const maxKeyLen = Math.max(...[...headersExt.keys()].map((k) => k.length), 4);
        const sorted = [...headersExt.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        for (const [key, value] of sorted) {
          lines.push(`  ${key.padEnd(maxKeyLen)}  ${value}`);
        }

        lines.push(`\n  Total: ${sorted.length} headers`);
        if (resp.redirected) {
          lines.push(`  Redirected to: ${resp.url}`);
        }
      } catch (err: any) {
        lines.push(`  Error: ${err.message}`);
      }

      return lines.join("\n");
    }
    case "uptime_check": {
      if (!args?.trim()) return "  Usage: /uptime-check <URL>";

      let url = args.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      const lines = [`  Uptime Check: ${url}\n`];

      try {
        const startTime = performance.now();
        const resp = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000),
          redirect: "follow",
        });
        const latency = Math.round(performance.now() - startTime);

        const status = resp.status;
        const statusText = resp.statusText;
        const isUp = status >= 200 && status < 400;

        lines.push(`  Status:    ${isUp ? "\u2714" : "\u2718"} ${status} ${statusText}`);
        lines.push(`  Latency:   ${latency}ms`);

        // TLS info
        if (url.startsWith("https")) {
          lines.push(`  TLS:       \u2714 Secure`);
        } else {
          lines.push(`  TLS:       \u2718 Not encrypted`);
        }

        // Headers info
        const server = resp.headers.get("server");
        const contentType = resp.headers.get("content-type");
        const poweredBy = resp.headers.get("x-powered-by");
        if (server) lines.push(`  Server:    ${server}`);
        if (contentType) lines.push(`  Type:      ${contentType}`);
        if (poweredBy) lines.push(`  Powered:   ${poweredBy}`);

        // Redirects
        if (resp.redirected) {
          lines.push(`  Redirected: \u2714 (final: ${resp.url})`);
        }

        // Response size
        const contentLength = resp.headers.get("content-length");
        if (contentLength)
          lines.push(`  Size:      ${parseInt(contentLength).toLocaleString()} bytes`);

        lines.push(`\n  Verdict:   ${isUp ? "UP \u2714" : "DOWN \u2718"}`);
      } catch (err: any) {
        lines.push(`  Status:    \u2718 UNREACHABLE`);
        lines.push(`  Error:     ${err.message}`);
        lines.push(`\n  Verdict:   DOWN \u2718`);
      }

      return lines.join("\n");
    }
    case "ip": {
      const { execSync } = await import("node:child_process");
      const lines = [`  Network Info\n`];

      // Public IP
      try {
        const resp = await fetch("https://ifconfig.me/ip", {
          signal: AbortSignal.timeout(5000),
          headers: { "User-Agent": "curl/8.0" },
        });
        const publicIp = (await resp.text()).trim();
        lines.push(`  Public IP:  ${publicIp}`);
      } catch {
        lines.push(`  Public IP:  (unavailable)`);
      }

      // Local interfaces
      try {
        const output = execSync(`ip -4 addr show 2>/dev/null | grep -oP '(?<=inet\\s)\\S+'`, {
          timeout: 3000,
        })
          .toString()
          .trim();
        if (output) {
          lines.push(``);
          lines.push(`  Local Interfaces:`);
          for (const line of output.split("\n")) {
            lines.push(`    ${line}`);
          }
        }
      } catch {
        // Fallback: hostname -I
        try {
          const output = execSync(`hostname -I 2>/dev/null`, { timeout: 3000 }).toString().trim();
          if (output) {
            lines.push(`  Local IPs:  ${output}`);
          }
        } catch {
          /* skip */
        }
      }

      // Hostname
      try {
        const hostname = execSync(`hostname 2>/dev/null`, { timeout: 2000 }).toString().trim();
        lines.push(`  Hostname:   ${hostname}`);
      } catch {
        /* skip */
      }

      // Default gateway
      try {
        const gw = execSync(`ip route show default 2>/dev/null | grep -oP '(?<=via\\s)\\S+'`, {
          timeout: 3000,
        })
          .toString()
          .trim();
        if (gw) lines.push(`  Gateway:    ${gw}`);
      } catch {
        /* skip */
      }

      // DNS
      try {
        const dns = execSync(`grep '^nameserver' /etc/resolv.conf 2>/dev/null | head -3`, {
          timeout: 2000,
        })
          .toString()
          .trim();
        if (dns) {
          const servers = dns.split("\n").map((l) => l.replace("nameserver ", "").trim());
          lines.push(`  DNS:        ${servers.join(", ")}`);
        }
      } catch {
        /* skip */
      }

      return lines.join("\n");
    }
    case "ports": {
      const { execSync } = await import("node:child_process");
      const lines = [`  Listening Ports\n`];

      try {
        const output = execSync(`ss -tlnp 2>/dev/null`, { timeout: 5000 }).toString().trim();
        const rows = output.split("\n").slice(1); // skip header

        if (rows.length === 0) {
          return "  No listening TCP ports found.";
        }

        // Common dev ports
        const knownPorts: Record<number, string> = {
          3000: "React/Next.js",
          3001: "Dev server",
          4000: "GraphQL",
          4200: "Angular",
          5000: "Flask/Vite",
          5173: "Vite",
          5432: "PostgreSQL",
          6379: "Redis",
          8000: "Django/FastAPI",
          8080: "HTTP alt",
          8443: "HTTPS alt",
          9090: "Prometheus",
          10091: "KCode LLM",
          27017: "MongoDB",
        };

        const maxAddrLen = Math.max(
          ...rows.map((r) => (r.trim().split(/\s+/)[3] ?? "").length),
          10,
        );

        for (const row of rows) {
          const parts = row.trim().split(/\s+/);
          const addr = parts[3] ?? "?";
          const procInfo = parts[5] ?? "";
          const procName = procInfo.replace(/.*users:\(\("(.+?)".*/, "$1") || procInfo;
          const portMatch = addr.match(/:(\d+)$/);
          const port = portMatch ? parseInt(portMatch[1]!) : 0;
          const label = knownPorts[port] ? ` (${knownPorts[port]})` : "";
          lines.push(`  ${addr.padEnd(maxAddrLen)}  ${procName}${label}`);
        }

        lines.push(`\n  ${rows.length} port(s) listening`);
      } catch {
        // Fallback to netstat
        try {
          const output = execSync(`netstat -tlnp 2>/dev/null | tail -n +3`, { timeout: 5000 })
            .toString()
            .trim();
          if (output) {
            lines.push(output);
          } else {
            return "  Cannot detect listening ports (ss/netstat not available).";
          }
        } catch {
          return "  Cannot detect listening ports (ss/netstat not available).";
        }
      }

      return lines.join("\n");
    }
    case "serve": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const port = parseInt(args?.trim() || "10080") || 10080;

      if (port < 1024 || port > 65535) return "  Port must be between 1024 and 65535.";

      // Check if port is in use
      try {
        execSync(`ss -tlnp 2>/dev/null | grep -q ':${port} '`, { timeout: 3000 });
        return `  Port ${port} is already in use.`;
      } catch {
        /* port is free */
      }

      // Try python3 http.server, then npx serve
      const cmds = [
        { test: "which python3", cmd: `python3 -m http.server ${port}`, name: "python3" },
        { test: "which npx", cmd: `npx -y serve -l ${port}`, name: "npx serve" },
        { test: "which php", cmd: `php -S 0.0.0.0:${port}`, name: "php" },
      ];

      let serverCmd: string | null = null;
      let serverName = "";
      for (const { test, cmd, name } of cmds) {
        try {
          execSync(`${test} 2>/dev/null`, { timeout: 2000 });
          serverCmd = cmd;
          serverName = name;
          break;
        } catch {
          /* not available */
        }
      }

      if (!serverCmd) return "  No HTTP server found (install python3, npx, or php).";

      try {
        // Start in background
        execSync(`cd '${cwd.replace(/'/g, "'\\''")}' && nohup ${serverCmd} > /dev/null 2>&1 &`, {
          timeout: 3000,
          shell: "/bin/sh",
        });
        return [
          `  Static Server Started\n`,
          `  URL:     http://localhost:${port}`,
          `  Root:    ${cwd}`,
          `  Server:  ${serverName}`,
          `  Stop:    kill the ${serverName} process or use /processes`,
        ].join("\n");
      } catch (err: any) {
        return `  Failed to start server: ${err.message}`;
      }
    }
    case "extract_urls": {
      let text = args?.trim();
      if (!text) return "  Usage: /extract-urls <text or file path>";

      // Try reading as file
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

      // Extract URLs
      const urlPattern = /https?:\/\/[^\s<>"')\]},;]+/gi;
      const matches = text.match(urlPattern);

      if (!matches || matches.length === 0) return "  No URLs found.";

      // Deduplicate preserving order
      const unique = [...new Set(matches)];

      const lines = [`  Extracted URLs (${unique.length} unique, ${matches.length} total)\n`];
      for (const [i, url] of unique.slice(0, 100).entries()) {
        lines.push(`  ${String(i + 1).padStart(3)}. ${url}`);
      }
      if (unique.length > 100) {
        lines.push(`  ... and ${unique.length - 100} more`);
      }

      return lines.join("\n");
    }
    case "network_ports": {
      const PORTS: Record<number, string> = {
        20: "FTP Data",
        21: "FTP Control",
        22: "SSH",
        23: "Telnet",
        25: "SMTP",
        53: "DNS",
        67: "DHCP Server",
        68: "DHCP Client",
        69: "TFTP",
        80: "HTTP",
        110: "POP3",
        119: "NNTP",
        123: "NTP",
        135: "MS RPC",
        137: "NetBIOS Name",
        138: "NetBIOS Datagram",
        139: "NetBIOS Session",
        143: "IMAP",
        161: "SNMP",
        162: "SNMP Trap",
        179: "BGP",
        194: "IRC",
        389: "LDAP",
        443: "HTTPS",
        445: "SMB",
        465: "SMTPS",
        514: "Syslog",
        515: "LPD/LPR",
        543: "Kerberos Login",
        544: "Kerberos Shell",
        546: "DHCPv6 Client",
        547: "DHCPv6 Server",
        554: "RTSP",
        587: "SMTP Submission",
        631: "IPP/CUPS",
        636: "LDAPS",
        873: "rsync",
        993: "IMAPS",
        995: "POP3S",
        1080: "SOCKS",
        1433: "MS SQL",
        1434: "MS SQL Monitor",
        1521: "Oracle DB",
        1723: "PPTP",
        2049: "NFS",
        2181: "ZooKeeper",
        3000: "Dev Server",
        3306: "MySQL",
        3389: "RDP",
        4443: "Pharos",
        5000: "Flask/UPnP",
        5432: "PostgreSQL",
        5672: "AMQP/RabbitMQ",
        5900: "VNC",
        6379: "Redis",
        6443: "Kubernetes API",
        8000: "HTTP Alt",
        8080: "HTTP Proxy",
        8443: "HTTPS Alt",
        8888: "Jupyter",
        9090: "Prometheus",
        9200: "Elasticsearch",
        9300: "Elasticsearch Transport",
        9418: "Git",
        11211: "Memcached",
        27017: "MongoDB",
        27018: "MongoDB Shard",
        27019: "MongoDB Config",
      };

      const input = args?.trim();
      if (!input) {
        // Show all known ports
        const lines = [`  Well-Known Ports\n`];
        const sorted = Object.entries(PORTS).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
        for (const [port, name] of sorted) {
          lines.push(`  ${String(port).padStart(5)}  ${name}`);
        }
        return lines.join("\n");
      }

      // Lookup by port number
      const portNum = parseInt(input);
      if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
        const name = PORTS[portNum];
        if (name) {
          return `  Port ${portNum}: ${name}`;
        }
        return `  Port ${portNum}: Unknown (no well-known service)`;
      }

      // Lookup by service name
      const query = input.toLowerCase();
      const matches = Object.entries(PORTS).filter(([, name]) =>
        name.toLowerCase().includes(query),
      );

      if (matches.length === 0) return `  No service matching "${input}" found.`;

      const lines = [`  Services matching "${input}"\n`];
      for (const [port, name] of matches) {
        lines.push(`  ${String(port).padStart(5)}  ${name}`);
      }
      return lines.join("\n");
    }
    default:
      return null;
  }
}
