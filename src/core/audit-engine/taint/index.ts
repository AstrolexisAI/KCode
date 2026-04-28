// Public entry for the audit-engine taint flow module.

export {
  classifyJavaCandidate,
  isSinkStylePattern,
  shouldClassifyForTaint,
} from "./java";
export type { ClassifyContext, ClassifyResult, VarOrigin } from "./types";
