/**
 * Rumination module — autonomous strategic intelligence scanning.
 * Periodically scans the web for signals mapped to user's projects.
 */

export {
  startRumination,
  stopRumination,
  triggerRumination,
} from "./scheduler.js";
export { executeRumination, type RuminationResult } from "./executor.js";
export {
  readAllBriefs,
  readBrief,
  getBriefPath,
  ensureBrief,
} from "./brief.js";
export {
  readRecentDigests,
  appendDigest,
  getDigestLogPath,
  trimDigestLog,
} from "./digest.js";
