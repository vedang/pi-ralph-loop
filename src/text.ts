export function hasCompleteSigil(text: string): boolean {
  return /^\s*<COMPLETE>\s*$/m.test(text);
}

export function stripStandaloneCompleteSigil(text: string): string {
  return text.replace(/^\s*<COMPLETE>\s*$/gm, "").trim();
}

const DEFAULT_ACHIEVED_SUMMARY_MAX_LENGTH = 320;
const DEFAULT_ACHIEVED_SUMMARY_SENTENCES = 2;

export function summarizeIterationAchievement(
  text: string,
  options: {
    maxLength?: number;
    maxSentences?: number;
  } = {},
): string {
  const compactText = text
    .replace(/^\s*<COMPLETE>\s*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compactText) {
    return "";
  }

  const maxLength = Math.max(
    1,
    Math.floor(options.maxLength ?? DEFAULT_ACHIEVED_SUMMARY_MAX_LENGTH),
  );
  const maxSentences = Math.max(
    1,
    Math.floor(options.maxSentences ?? DEFAULT_ACHIEVED_SUMMARY_SENTENCES),
  );

  const summary =
    compactText
      .match(/[^.!?]+[.!?]*/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean)
      .slice(0, maxSentences)
      .join(" ") ?? compactText;

  if (summary.length <= maxLength) {
    return summary;
  }

  if (maxLength === 1) {
    return "…";
  }

  const truncated = summary.slice(0, maxLength - 1).trimEnd();
  const boundary = truncated.lastIndexOf(" ");
  const textBody = boundary > 0 ? truncated.slice(0, boundary) : truncated;

  return `${textBody}…`;
}
