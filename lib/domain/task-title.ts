const DEFAULT_TASK_TITLE = "新任务";
const TITLE_CODE_POINT_LIMIT = 80;

/**
 * Build a stable task name from a chat prompt without another model call.
 */
export function taskTitleFromPrompt(prompt: string): string {
  const normalized = prompt
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return DEFAULT_TASK_TITLE;
  const firstSentence = normalized.split(/(?<=[。！？!?])\s*/u)[0] ?? normalized;
  const codePoints = Array.from(firstSentence);
  if (codePoints.length <= TITLE_CODE_POINT_LIMIT) return firstSentence;
  return `${codePoints.slice(0, TITLE_CODE_POINT_LIMIT - 1).join("")}…`;
}
