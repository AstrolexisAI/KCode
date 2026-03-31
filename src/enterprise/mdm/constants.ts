// KCode - MDM Constants
// Platform-specific paths and identifiers for MDM/device management integration

/** macOS preference domain for managed preferences */
export const MACOS_PLIST_DOMAIN = "com.kulvex.kcode";

/** macOS managed preferences directories (user-level, then device-level) */
export function macosPlistPaths(username: string): string[] {
  return [
    `/Library/Managed Preferences/${username}/${MACOS_PLIST_DOMAIN}.plist`,
    `/Library/Managed Preferences/${MACOS_PLIST_DOMAIN}.plist`,
  ];
}

/** Windows registry paths (HKLM has higher priority than HKCU) */
export const WINDOWS_REGISTRY_PATHS = [
  "HKLM\\SOFTWARE\\Policies\\KCode",
  "HKCU\\SOFTWARE\\Policies\\KCode",
] as const;

/** Windows registry value name containing JSON settings */
export const WINDOWS_REGISTRY_VALUE = "Settings";

/** Linux managed settings paths */
export const LINUX_MANAGED_SETTINGS_PATH = "/etc/kcode/managed-settings.json";
export const LINUX_MANAGED_SETTINGS_DIR = "/etc/kcode/managed-settings.d";

/** Subprocess timeout in milliseconds */
export const SUBPROCESS_TIMEOUT_MS = 5_000;
