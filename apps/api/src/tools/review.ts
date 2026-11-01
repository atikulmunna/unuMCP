import type { ProjectStatus } from "@unumcp/db";

/** The tool plan can be changed (and checked) only while it is under review. */
export const REVIEW_STATUSES: readonly ProjectStatus[] = ["TOOLS_PROPOSED", "AWAITING_USER_APPROVAL"];
