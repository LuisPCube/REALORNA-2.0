import type { Plan } from "../types";
import { AiServiceError } from "./ai-errors";
export type ContentType = "article" | "media";
// Route by actual input, not price. Even an Advance article uses LUNA.
// Old OPENAI_MODEL / OPENAI_ADVANCE_MODEL cannot silently restore SOL.
export function modelForContent(type: ContentType): string {
  if (type === "article") return process.env.OPENAI_TEXT_MODEL?.trim() || process.env.OPENAI_REGULAR_MODEL?.trim() || "gpt-6-luna";
  if (type === "media") return process.env.OPENAI_MEDIA_MODEL?.trim() || "gpt-6.1-terra";
  throw new AiServiceError("ai_unavailable", { origin: "configuration", reason: "invalid_content_type" });
}
// Kept for older callers. Media callers pass their content type explicitly.
export function modelForPlan(plan: Plan): string {
  if (plan !== "regular" && plan !== "advance") throw new AiServiceError("ai_unavailable", { origin: "configuration", reason: "invalid_plan" });
  return modelForContent("article");
}
