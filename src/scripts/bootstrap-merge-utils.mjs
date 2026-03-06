// Utility helpers for consolidated merge behavior in bootstrap.mjs

export function stripHeader(content) {
  // Strip everything before the first ## heading (the actual user content).
  // This avoids fragile exact-match regexes on boilerplate text that the agent may edit.
  const firstH2 = content.search(/^## /m);
  return firstH2 >= 0 ? content.slice(firstH2) : "";
}

export function stripCrossPlanNote(content) {
  // Match both old format ("...and plans/DECISIONS.md") and new format
  // ("...plans/DECISIONS.md, and plans/LESSONS.md")
  return content.replace(/\n?\*Cross-plan context: see plans\/FINDINGS\.md[^*]*\*\n?/g, "\n");
}
