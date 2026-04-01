// Re-export from new location for backwards compatibility
export {
  _resetProfiler,
  getProfileReport,
  isProfilingEnabled,
  printProfileReport,
  profileCheckpoint,
  StartupProfiler,
} from "./profiler/startup-profiler";

// Legacy type alias
import type { ProfileCheckpoint } from "./profiler/types";
export type ProfileEntry = ProfileCheckpoint;
