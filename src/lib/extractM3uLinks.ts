import type { ExtractionSummary } from "../types";

const M3U_REGEX = /(https?:\/\/[^\s]+get\.php\?username=[^\s]+type=m3u[^\s]*)/gi;
const TRAILING_JUNK_REGEX = /[)\]}>,"'`]+$/g;
const SAFE_URL_REGEX = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&*+,;=%-]+/i;

function normalizeCandidate(candidate: string) {
  const asciiOnly = candidate.replace(/[^\x20-\x7E]/g, "");
  const compact = asciiOnly.replace(/\s+/g, "");
  const extracted = compact.match(SAFE_URL_REGEX)?.[0] ?? compact;
  return extracted.replace(TRAILING_JUNK_REGEX, "");
}

function isValidM3uUrl(candidate: string) {
  try {
    const parsed = new URL(candidate);
    const username = parsed.searchParams.get("username");
    const type = (parsed.searchParams.get("type") || "").toLowerCase();

    return (
      /^https?:$/i.test(parsed.protocol) &&
      /\/get\.php$/i.test(parsed.pathname) &&
      Boolean(username) &&
      type.includes("m3u")
    );
  } catch {
    return false;
  }
}

export function extractM3uLinks(rawText: string): ExtractionSummary {
  const matches = rawText.match(M3U_REGEX) ?? [];
  const uniqueLinks: string[] = [];
  const seen = new Set<string>();
  let duplicatesRemoved = 0;
  let invalidRemoved = 0;

  for (const match of matches) {
    const normalized = normalizeCandidate(match);

    if (!normalized || !isValidM3uUrl(normalized)) {
      invalidRemoved += 1;
      continue;
    }

    const dedupeKey = normalized.toLowerCase();

    if (seen.has(dedupeKey)) {
      duplicatesRemoved += 1;
      continue;
    }

    seen.add(dedupeKey);
    uniqueLinks.push(normalized);
  }

  return {
    links: uniqueLinks,
    rawMatches: matches.length,
    duplicatesRemoved,
    invalidRemoved,
    nonEmptyLineCount: rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length
  };
}
