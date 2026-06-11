export function matchTokens(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const h = haystack.toLowerCase();
  return tokens.every((t) => h.includes(t));
}
