// KCode - Update Notifier
// Non-blocking startup check that prints a one-line message if a new version is available.
// Checks at most once per week, persisting the timestamp to ~/.kcode/update-check.json.

import { checkForUpdate, shouldCheckForUpdate } from "./auto-update";
import { log } from "./logger";

/**
 * Called at startup. If enough time has passed since the last check,
 * queries GitHub for a newer version and prints a single-line notice.
 *
 * This function is non-blocking: it fires off the check in the background
 * and never delays startup. All errors are silently caught.
 *
 * @param currentVersion - The current KCode version string (e.g. "1.8.0")
 */
export async function maybeNotifyUpdate(currentVersion: string): Promise<void> {
  try {
    if (!shouldCheckForUpdate()) return;

    const info = await checkForUpdate(currentVersion);
    if (!info) return;

    // Print a single non-intrusive line
    const msg = `\x1b[33mKCode v${info.latestVersion} available.\x1b[0m Run: \x1b[1mkcode update\x1b[0m`;
    console.log(msg);
  } catch (err) {
    // Never let update checks disrupt startup
    log.debug("update-notifier", `Background update check failed: ${err}`);
  }
}
