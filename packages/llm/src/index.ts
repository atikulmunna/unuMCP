export { NimClient, NIM_DEFAULT_BASE_URL } from "./nim-client";
export type { NimClientOptions } from "./nim-client";
export { proposeToolDescription, parseDescription } from "./propose";
export type { ToolProposalInput, ToolProposal } from "./propose";
export { repairCode, parseRepairFiles } from "./repair";
export type { RepairInput, RepairResult, RepairFile } from "./repair";
export { diffLines, unifiedDiff } from "./diff";
export type { DiffLine } from "./diff";
export type {
  LlmClient,
  LlmRequest,
  LlmCompletion,
  LlmMessage,
  LlmRole,
  LlmUsage,
  FetchLike,
} from "./types";
