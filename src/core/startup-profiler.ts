// Re-export from new location for backwards compatibility
export {
  profileCheckpoint,
  isProfilingEnabled,
  getProfileReport,
  printProfileReport,
  _resetProfiler,
  StartupProfiler,
} from "./profiler/startup-profiler";

// Legacy type alias
import type { ProfileCheckpoint } from "./profiler/types";
export type ProfileEntry = ProfileCheckpoint;
