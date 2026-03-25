const DYNAMIC_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, // ISO timestamps
  /\b\d{10,13}\b/g, // unix timestamps / ids
  /\b(?:[a-f0-9]{24,64})\b/gi, // hashes, ids, tokens
  /\b(session|token|nonce|csrf)[-_]?[a-z0-9]*=["'][^"']+["']/gi
];

export function cleanHtml(html) {
  let cleaned = html ?? "";

  cleaned = cleaned
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  for (const pattern of DYNAMIC_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }

  cleaned = cleaned
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();

  return cleaned;
}
