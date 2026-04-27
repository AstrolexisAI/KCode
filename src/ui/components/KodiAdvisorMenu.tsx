// KCode - Kodi Advisor Menu
//
// TUI menu for managing the dedicated Kodi LLM. Opens via the
// `/kodi-advisor` slash command, and auto-opens the first time an
// enterprise user starts KCode without having made a choice yet.
//
// The menu is a small state machine driven by kodi-model's status
// report. Keyboard-only — we pick single-letter shortcuts so users
// never need arrow keys.
//
//   not_installed      → pick a candidate to download
//   downloading        → live progress (stays modal, can't cancel mid-download cleanly)
//   installed_stopped  → [s]tart / [d]elete / [esc] close
//   running            → [x] stop / [d]elete (auto-stops) / [esc]
//
// The "No thanks" branch only exists in the not_installed state
// because that's the first-run moment where we need to persist a
// "don't ask again" decision to settings.

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import {
  deleteKodiModel,
  downloadKodiModel,
  getKodiStatusReport,
  KODI_CANDIDATES,
  type KodiCandidate,
  type KodiStatusReport,
  pickDefaultCandidate,
  startKodiServer,
  stopKodiServer,
} from "../../core/kodi-model.js";
import { useTheme } from "../ThemeContext.js";

export type KodiAdvisorMenuResult =
  | { action: "declined" }
  | { action: "downloaded"; candidateId: string }
  | { action: "started" }
  | { action: "stopped" }
  | { action: "deleted" }
  | { action: "close" };

interface Props {
  /** Called when the user finishes (closes the menu or takes an action that resolves it). */
  onClose: (result: KodiAdvisorMenuResult) => void;
  /**
   * True when this menu was shown automatically on first enterprise
   * start. Controls copy ("Enable Kodi Advisor?" vs "Kodi Advisor"
   * generic management).
   */
  firstRun?: boolean;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "not_installed"; recommended: KodiCandidate | null }
  | { kind: "downloading"; candidate: KodiCandidate; progress: string }
  | { kind: "downloaded"; candidate: KodiCandidate }
  | { kind: "installed_stopped"; candidate: KodiCandidate; sizeMB: number | null }
  | {
      kind: "running";
      candidate: KodiCandidate;
      port: number;
      pid: number | null;
      sizeMB: number | null;
    }
  | { kind: "busy"; message: string }
  | { kind: "error"; message: string };

function toView(report: KodiStatusReport): ViewState {
  switch (report.status) {
    case "not_installed":
      return { kind: "not_installed", recommended: pickDefaultCandidate() };
    case "installed_stopped":
      return {
        kind: "installed_stopped",
        candidate: report.installedCandidate!,
        sizeMB: report.modelFileSizeMB,
      };
    case "running":
      return {
        kind: "running",
        candidate: report.installedCandidate!,
        port: report.port ?? 0,
        pid: report.pid,
        sizeMB: report.modelFileSizeMB,
      };
    default:
      return { kind: "error", message: `Unknown status: ${report.status}` };
  }
}

export default function KodiAdvisorMenu({ onClose, firstRun }: Props) {
  const { theme } = useTheme();
  const [view, setView] = useState<ViewState>({ kind: "loading" });

  const refresh = React.useCallback(async () => {
    try {
      const report = await getKodiStatusReport();
      setView(toView(report));
    } catch (err) {
      setView({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doDownload = async (candidate: KodiCandidate) => {
    setView({ kind: "downloading", candidate, progress: "starting..." });
    try {
      await downloadKodiModel(candidate.id, (msg) => {
        setView({ kind: "downloading", candidate, progress: msg });
      });
      setView({ kind: "downloaded", candidate });
      // Auto-refresh so the menu flips to installed_stopped / lets
      // the user start right after a download.
      setTimeout(() => void refresh(), 400);
    } catch (err) {
      setView({
        kind: "error",
        message: `Download failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const doStart = async () => {
    setView({ kind: "busy", message: "Starting Kodi server..." });
    try {
      await startKodiServer();
      onClose({ action: "started" });
    } catch (err) {
      setView({
        kind: "error",
        message: `Start failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const doStop = async () => {
    setView({ kind: "busy", message: "Stopping Kodi server..." });
    try {
      await stopKodiServer();
      onClose({ action: "stopped" });
    } catch (err) {
      setView({
        kind: "error",
        message: `Stop failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const doDelete = async () => {
    setView({ kind: "busy", message: "Deleting Kodi model..." });
    try {
      await deleteKodiModel();
      onClose({ action: "deleted" });
    } catch (err) {
      setView({
        kind: "error",
        message: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  useInput((input, key) => {
    const lower = input.toLowerCase();

    if (view.kind === "not_installed") {
      if (lower === "1" && KODI_CANDIDATES[0]) return void doDownload(KODI_CANDIDATES[0]);
      if (lower === "2" && KODI_CANDIDATES[1]) return void doDownload(KODI_CANDIDATES[1]);
      if (lower === "3" && KODI_CANDIDATES[2]) return void doDownload(KODI_CANDIDATES[2]);
      if (lower === "n" || key.escape) return onClose({ action: "declined" });
      return;
    }
    if (view.kind === "installed_stopped") {
      if (lower === "s") return void doStart();
      if (lower === "d") return void doDelete();
      if (key.escape) return onClose({ action: "close" });
      return;
    }
    if (view.kind === "running") {
      if (lower === "x") return void doStop();
      if (lower === "d") return void doDelete();
      if (key.escape) return onClose({ action: "close" });
      return;
    }
    if (view.kind === "error" || view.kind === "downloaded") {
      if (key.escape || key.return) {
        void refresh();
      }
      return;
    }
    // loading / downloading / busy: swallow input except escape on busy
    if (view.kind === "busy" && key.escape) return onClose({ action: "close" });
  });

  // ─── Render ─────────────────────────────────────────────────

  const headerTitle = firstRun ? "Enable Kodi Advisor?" : "Kodi Advisor";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.info ?? theme.primary}
      paddingX={1}
      marginY={0}
      width={process.stdout.columns || 80}
    >
      <Text bold color={theme.info ?? theme.primary}>
        ✦ {headerTitle}
      </Text>

      {view.kind === "loading" && (
        <Box marginTop={1}>
          <Text color={theme.dimmed}>Checking status...</Text>
        </Box>
      )}

      {view.kind === "not_installed" && (
        <>
          <Box marginTop={1} flexDirection="column">
            <Text>
              A small uncensored LLM runs in the background to power Kodi's autonomous reactions.
              Pick a model to download:
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {KODI_CANDIDATES.map((c, idx) => {
              const recommended = view.recommended?.id === c.id;
              return (
                <Box key={c.id} gap={1}>
                  <Text bold color={theme.success}>
                    [{idx + 1}]
                  </Text>
                  <Text>{c.label}</Text>
                  <Text color={theme.dimmed}>
                    — {c.sizeMB} MB disk, ~{c.ramMB} MB RAM
                  </Text>
                  {recommended && (
                    <Text bold color={theme.warning}>
                      recommended
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1} flexDirection="column">
            {KODI_CANDIDATES.map((c) => (
              <Text key={c.id} color={theme.dimmed}>
                • {c.id}: {c.note}
              </Text>
            ))}
          </Box>
          <Box marginTop={1} gap={2}>
            <Text>
              <Text bold color={theme.error}>
                [n]
              </Text>
              <Text> No thanks</Text>
              <Text color={theme.dimmed}> (don't ask again)</Text>
            </Text>
            <Text color={theme.dimmed}>esc also works</Text>
          </Box>
        </>
      )}

      {view.kind === "downloading" && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Downloading <Text bold>{view.candidate.label}</Text>...
          </Text>
          <Text color={theme.dimmed}>{view.progress}</Text>
          <Text color={theme.dimmed}>Saving to ~/.kcode/models/kodi/{view.candidate.filename}</Text>
        </Box>
      )}

      {view.kind === "downloaded" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.success}>✓ Download complete.</Text>
          <Text color={theme.dimmed}>Press Enter to manage the server.</Text>
        </Box>
      )}

      {view.kind === "installed_stopped" && (
        <>
          <Box marginTop={1} flexDirection="column">
            <Text>
              Installed: <Text bold>{view.candidate.label}</Text>
            </Text>
            {view.sizeMB != null && (
              <Text color={theme.dimmed}>On disk: {view.sizeMB} MB — Server: stopped</Text>
            )}
          </Box>
          <Box marginTop={1} gap={2}>
            <Text>
              <Text bold color={theme.success}>
                [s]
              </Text>
              <Text> Start advisor</Text>
            </Text>
            <Text>
              <Text bold color={theme.error}>
                [d]
              </Text>
              <Text> Delete model</Text>
            </Text>
            <Text color={theme.dimmed}>[esc] close</Text>
          </Box>
        </>
      )}

      {view.kind === "running" && (
        <>
          <Box marginTop={1} flexDirection="column">
            <Text>
              Running: <Text bold>{view.candidate.label}</Text>
            </Text>
            <Text color={theme.dimmed}>
              Port {view.port} {view.pid != null ? `• pid ${view.pid}` : ""}{" "}
              {view.sizeMB != null ? `• ${view.sizeMB} MB on disk` : ""}
            </Text>
          </Box>
          <Box marginTop={1} gap={2}>
            <Text>
              <Text bold color={theme.warning}>
                [x]
              </Text>
              <Text> Stop advisor</Text>
            </Text>
            <Text>
              <Text bold color={theme.error}>
                [d]
              </Text>
              <Text> Delete model</Text>
            </Text>
            <Text color={theme.dimmed}>[esc] close</Text>
          </Box>
        </>
      )}

      {view.kind === "busy" && (
        <Box marginTop={1}>
          <Text color={theme.dimmed}>{view.message}</Text>
        </Box>
      )}

      {view.kind === "error" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.error}>✗ {view.message}</Text>
          <Text color={theme.dimmed}>Press Enter/Esc to refresh.</Text>
        </Box>
      )}
    </Box>
  );
}
