/**
 * Subsequence fuzzy matcher for the command bar.
 * Returns a score (lower = better) or null when query is not a subsequence.
 * Bonuses: consecutive matches, word-start matches. Penalty: gap length.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  let score = 0
  let ti = 0
  let lastMatch = -2
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti)
    if (found === -1) return null
    score += found - ti
    if (found === lastMatch + 1) score -= 1
    if (found === 0 || /[\s\-_/.:]/.test(t[found - 1])) score -= 2
    lastMatch = found
    ti = found + 1
  }
  return score
}
