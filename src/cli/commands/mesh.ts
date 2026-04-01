// KCode CLI - mesh subcommand
// P2P Agent Mesh: start node, manage team tokens, view peers, submit tasks.

import type { Command } from "commander";

export function registerMeshCommand(program: Command): void {
  const mesh = program
    .command("mesh")
    .description("P2P Agent Mesh: collaborate across KCode instances on the LAN");

  // ─── mesh start ──────────────────────────────────────────────

  mesh
    .command("start")
    .description("Start a mesh node and begin peer discovery")
    .option("-p, --port <port>", "Port to listen on (default: 19200)", (v: string) =>
      parseInt(v, 10),
    )
    .option("-d, --discovery <method>", "Discovery method: mdns, manual, shared-file", "mdns")
    .action(async (opts: { port?: number; discovery?: string }) => {
      try {
        const { getMeshNode } = await import("../../core/mesh/node");

        const node = getMeshNode({
          settings: {
            port: opts.port,
            discovery: (opts.discovery as "mdns" | "manual" | "shared-file") ?? "mdns",
          },
        });

        await node.start();

        console.log(`Mesh node started: ${node.nodeId}`);
        console.log(`Port: ${node.getLocalPeerInfo().port}`);
        console.log(`Team token: ${node.teamToken}`);
        console.log("\nPress Ctrl+C to stop.");

        // Keep process alive
        await new Promise<void>(() => {});
      } catch (err) {
        console.error(`Failed to start mesh node: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ─── mesh init-team ──────────────────────────────────────────

  mesh
    .command("init-team")
    .description("Generate a new team token for mesh authentication")
    .action(async () => {
      const { generateTeamToken } = await import("../../core/mesh/security");
      const token = generateTeamToken();
      console.log(`Team token: ${token}`);
      console.log("\nShare this token with team members via a secure channel.");
      console.log("They can join with: kcode mesh join <token>");
    });

  // ─── mesh join ───────────────────────────────────────────────

  mesh
    .command("join <team-token>")
    .description("Join a team mesh using a shared token")
    .action(async (teamToken: string) => {
      const { isValidTeamToken } = await import("../../core/mesh/security");

      if (!isValidTeamToken(teamToken)) {
        console.error("Invalid team token format. Expected 64 hex characters.");
        process.exit(1);
      }

      const { getMeshNode } = await import("../../core/mesh/node");
      const node = getMeshNode();
      node.joinTeam(teamToken);
      console.log(`Joined team. Token set on node ${node.nodeId}.`);
    });

  // ─── mesh peers ──────────────────────────────────────────────

  mesh
    .command("peers")
    .description("List known mesh peers")
    .action(async () => {
      const { getMeshNode } = await import("../../core/mesh/node");
      const node = getMeshNode();
      const peers = node.getPeers();

      if (peers.length === 0) {
        console.log("No peers discovered yet. Start the mesh node first.");
        return;
      }

      console.log(`Known peers (${peers.length}):\n`);
      for (const p of peers) {
        const models = p.capabilities.models.length > 0 ? p.capabilities.models.join(", ") : "none";
        console.log(
          `  ${p.nodeId.slice(0, 8)}  ${p.hostname}  ${p.ip}:${p.port}  ` +
            `[${p.status}]  VRAM: ${p.capabilities.gpuVram}GB  Models: ${models}`,
        );
      }
    });

  // ─── mesh status ─────────────────────────────────────────────

  mesh
    .command("status")
    .description("Show mesh node status")
    .action(async () => {
      const { getMeshNode } = await import("../../core/mesh/node");
      const node = getMeshNode();
      const info = node.getLocalPeerInfo();

      console.log(`Node ID:    ${node.nodeId}`);
      console.log(`Status:     ${node.status}`);
      console.log(`Port:       ${info.port}`);
      console.log(`Hostname:   ${info.hostname}`);
      console.log(`GPU VRAM:   ${info.capabilities.gpuVram} GB`);
      console.log(`CPU Cores:  ${info.capabilities.cpuCores}`);
      console.log(`Models:     ${info.capabilities.models.join(", ") || "none"}`);
      console.log(
        `Peers:      ${node.getPeers().length} known, ${node.getAvailablePeers().length} available`,
      );
      console.log(`Active:     ${node.activeTaskCount} tasks`);
    });
}
