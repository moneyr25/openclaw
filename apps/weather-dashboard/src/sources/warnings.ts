import { fetchText } from "../http.ts";
import type { Warning } from "../types.ts";

/**
 * Met Office National Severe Weather Warnings, read from the public RSS feed.
 *
 * There is no free JSON API for warnings, so this parses the feed directly.
 * The feed URL is configurable (`MET_OFFICE_WARNINGS_URL`) precisely because a
 * scraped surface can move; a failure here never fails the forecast, it just
 * hides the warnings strip.
 */

const decodeEntities = (input: string): string =>
  input
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");

const stripTags = (input: string): string =>
  decodeEntities(input.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();

/** Pull the text of the first `<tag>` inside a chunk, CDATA aware. */
const tagText = (chunk: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "iu").exec(chunk);
  if (!match?.[1]) return undefined;
  const raw = match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/u, "$1");
  const text = stripTags(raw);
  return text === "" ? undefined : text;
};

const levelFromText = (text: string): Warning["level"] => {
  const lower = text.toLowerCase();
  if (lower.includes("red warning")) return "red";
  if (lower.includes("amber warning")) return "amber";
  if (lower.includes("yellow warning")) return "yellow";
  // Feeds sometimes only carry the colour word.
  if (/\bred\b/u.test(lower)) return "red";
  if (/\bamber\b/u.test(lower)) return "amber";
  if (/\byellow\b/u.test(lower)) return "yellow";
  return "unknown";
};

export const parseWarningsFeed = (xml: string): Warning[] => {
  const warnings: Warning[] = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/giu) ?? [];

  for (const [index, item] of items.entries()) {
    const title = tagText(item, "title");
    if (!title) continue;
    // Feeds publish a placeholder item when nothing is in force.
    if (/there are currently no severe weather warnings/iu.test(title)) continue;

    const summary = tagText(item, "description");
    const link = tagText(item, "link");
    const published = tagText(item, "pubDate");
    const guid = tagText(item, "guid");

    warnings.push({
      id: guid ?? link ?? `metoffice-warning-${index}`,
      title,
      level: levelFromText(`${title} ${summary ?? ""}`),
      source: "Met Office",
      ...(summary ? { summary } : {}),
      ...(link ? { link } : {}),
      ...(published ? { published } : {}),
    });
  }

  return warnings;
};

export const fetchMetOfficeWarnings = async (options: {
  url: string;
  userAgent: string;
  signal?: AbortSignal;
}): Promise<Warning[]> => {
  const xml = await fetchText(options.url, {
    headers: { "user-agent": options.userAgent, accept: "application/rss+xml, application/xml, text/xml" },
    timeoutMs: 8000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return parseWarningsFeed(xml);
};
