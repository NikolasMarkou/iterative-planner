import { readFileSync, writeFileSync, renameSync } from "fs";

export const CONSOLIDATED_COMPRESS_THRESHOLD = 500;
export const MAX_CONSOLIDATED_PLANS = 8;
export const COMPRESSED_SUMMARY_OPEN = "<!-- COMPRESSED-SUMMARY -->";
export const COMPRESSED_SUMMARY_CLOSE = "<!-- /COMPRESSED-SUMMARY -->";

export function prependToConsolidated(filePath, planDirName, newSection) {
  // Insert new section after the header (H1 + boilerplate + compressed summary if present),
  // before existing plan sections. Newest plans appear first.
  let existing = "";
  try { existing = readFileSync(filePath, "utf-8"); } catch { /* file may not exist */ }

  // Dedup guard: skip if this plan was already merged
  if (existing.includes(`\n## ${planDirName}\n`)) return;

  // Skip past compressed summary block if present
  const closeMarker = existing.indexOf(COMPRESSED_SUMMARY_CLOSE);
  const searchFrom = closeMarker >= 0
    ? existing.indexOf("\n", closeMarker + COMPRESSED_SUMMARY_CLOSE.length)
    : 0;

  // Find first ## plan section after the header (and after compressed summary)
  const firstH2 = searchFrom >= 0 ? existing.indexOf("\n## ", searchFrom) : -1;
  let header;
  let body;
  if (firstH2 >= 0) {
    header = existing.slice(0, firstH2).trimEnd();
    body = existing.slice(firstH2);
  } else {
    header = existing.trimEnd();
    body = "";
  }
  const merged = header + `\n\n## ${planDirName}\n${newSection}\n` + body;
  writeFileSync(filePath + ".tmp", merged);
  renameSync(filePath + ".tmp", filePath);
}

export function checkConsolidatedSize(filePath, label) {
  // After merge, warn the agent if a consolidated file exceeds the compression threshold.
  // The agent (not this script) performs the actual summarization per SKILL.md protocol.
  try {
    const content = readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    if (lineCount > CONSOLIDATED_COMPRESS_THRESHOLD) {
      const hasSummary = content.includes(COMPRESSED_SUMMARY_OPEN);
      if (hasSummary) {
        console.log(`  ACTION NEEDED: ${label} is ${lineCount} lines (>${CONSOLIDATED_COMPRESS_THRESHOLD}). Update existing compressed summary.`);
      } else {
        console.log(`  ACTION NEEDED: ${label} is ${lineCount} lines (>${CONSOLIDATED_COMPRESS_THRESHOLD}). Create compressed summary — see protocol.`);
      }
    }
  } catch { /* file may not exist */ }
}

export function trimConsolidatedWindow(filePath) {
  // Keep only the MAX_CONSOLIDATED_PLANS most recent plan sections.
  // Old data is still in per-plan directories — no information lost.
  let content;
  try { content = readFileSync(filePath, "utf-8"); } catch { return; }
  // Find all ## plan_ section positions
  const positions = [];
  const re = /\n## plan_/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    positions.push(match.index);
  }
  if (positions.length <= MAX_CONSOLIDATED_PLANS) return;
  // Truncate after the Nth section (keep first N, they're the newest)
  const cutoff = positions[MAX_CONSOLIDATED_PLANS];
  const trimmed = content.slice(0, cutoff).trimEnd() + "\n";
  writeFileSync(filePath + ".tmp", trimmed);
  renameSync(filePath + ".tmp", filePath);
}
