import { readFileSync } from "node:fs";
import path from "node:path";

const plannerPromptPath = path.resolve(process.cwd(), "prompts", "planner", "system.md");

export function loadPlannerSystemPrompt() {
  return readFileSync(plannerPromptPath, "utf8").trim();
}
