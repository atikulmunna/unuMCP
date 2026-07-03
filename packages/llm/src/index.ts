export { OpenAiCompatibleClient } from "./openai-compatible";
export type { OpenAiCompatibleOptions } from "./openai-compatible";
export { NimClient, NIM_DEFAULT_BASE_URL } from "./nim-client";
export type { NimClientOptions } from "./nim-client";
export { GeminiClient, GEMINI_DEFAULT_BASE_URL } from "./gemini-client";
export type { GeminiClientOptions } from "./gemini-client";
export {
  proposeToolDescription,
  proposeToolDescriptions,
  parseDescription,
  parseBatchDescriptions,
} from "./propose";
export type { ToolProposalInput, ToolProposal, BatchToolProposal } from "./propose";
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
