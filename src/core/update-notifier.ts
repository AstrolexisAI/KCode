// KCode - Update Notifier
//
// Non-blocking startup check that prints a one-line message if a new
// version is available. Cache-aware: hits the manifest at most once per
// the configured interval (default 7 days), but reads the cached result
// every startup so the user keeps seeing the nag until they upgrade.
//
// Suppressed in non-interactive / scripted contexts so piped output
// stays clean and CI runs don't get noise.

import { checkForUpdate, isAutoUpdateEnabled, shouldCheckForUpdate } from "./auto-update";
import { log } from "./logger";

/**
 * argv-based subcommand list where a startup nag is wrong: the user is
 * either asking for clean machine-readable output, already running an
 * updater command, or doing one of the other commands that prints its
 * own banner.
 */
const SUPPRESSED_FIRST_ARGS = new Set([
  "update",
  "license",
  "-v",
  "--version",
  "-h",
  "--help",
  "completions",
  "doctor",
]);

function isNotificationSuppressed(): boolean {
  // Honor the autoUpdate=false setting — same flag governs whether we
  // even check; if the user opted out we never nag.
  if (!isAutoUpdateEnabled()) return true;

  // Piped or scripted runs should keep stdout/stderr clean.
  if (!process.stdout.isTTY) return true;

  const firstArg = process.argv[2];
  if (firstArg && SUPPRESSED_FIRST_ARGS.has(firstArg)) return true;

  // Any process running with --ci or --quiet is asking for machine
  // output. We scan all of argv (not just argv[2]) because these can
  // appear after subcommand names like `kcode audit . --ci`.
  for (const a of process.argv) {
    if (a === "--ci" || a === "--quiet" || a === "--print" || a === "-q") return true;
  }

  // KCODE_QUIET=1 escape hatch for users who want the binary to never
  // print a startup nag (envs that don't expose a TTY but aren't a real
  // CI either, like terminal multiplexers in some configs).
  if (process.env.KCODE_QUIET === "1") return true;

  return false;
}

/**
 * Called at startup. If enough time has passed since the last manifest
 * fetch, queries kulvex.ai for a newer version and prints a one-line
 * notice. The actual notification text uses the cached result so it
 * keeps appearing on every startup until the user upgrades.
 *
 * Non-blocking: errors are silently logged at debug.
 */
export async function maybeNotifyUpdate(currentVersion: string): Promise<void> {
  try {
    if (isNotificationSuppressed()) return;
    if (!shouldCheckForUpdate()) return;

    const info = await checkForUpdate(currentVersion);
    if (!info.updateAvailable) return;

    const msg = `\x1b[33mKCode v${info.latestVersion} available.\x1b[0m Run: \x1b[1mkcode update\x1b[0m`;
    console.log(msg);
  } catch (err) {
    log.debug("update-notifier", `Background update check failed: ${err}`);
  }
}
