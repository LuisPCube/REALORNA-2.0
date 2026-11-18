import type { Plan } from "../types";
import { AiServiceError } from "./ai-errors";
export type ContentType = "article" | "media" | "video";
export const GPT_6_2_SOL = "gpt-6.2-sol";
// The plan determines media eligibility. The content determines the model.
export function modelForContent(type: ContentType): string {
  if (type === "article") return process.env.OPENAI_TEXT_MODEL?.trim() || process.env.OPENAI_REGULAR_MODEL?.trim() || GPT_6_2_SOL;
  if (type === "media") return process.env.OPENAI_MEDIA_MODEL?.trim() || "gpt-6.1-terra";
  if (type === "video") return process.env.OPENAI_VIDEO_MODEL?.trim() || GPT_6_2_SOL;
  throw new AiServiceError("ai_unavailable", { origin: "configuration", reason: "invalid_content_type" });
}
// Kept for older callers. Media callers pass their content type explicitly.
export function modelForPlan(plan: Plan): string {
  if (plan !== "regular" && plan !== "advance") throw new AiServiceError("ai_unavailable", { origin: "configuration", reason: "invalid_plan" });
  return modelForContent("article");
}
