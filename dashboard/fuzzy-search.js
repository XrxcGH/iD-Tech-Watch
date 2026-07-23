/*
 * Small dependency-free fuzzy matcher used by every dashboard search field.
 *
 * Scores are higher for consecutive characters, word beginnings, early
 * matches, exact prefixes, and exact matches. A null score means no match.
 */
(function exposeFuzzySearch(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.IDTFuzzySearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createFuzzySearch() {
  "use strict";

  const NO_SCORE = Number.NEGATIVE_INFINITY;

  function normalize(value) {
    return String(value == null ? "" : value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function isWordBeginning(text, index) {
    return index === 0 || /[\s\-_/\\.:()[\]{}]/.test(text[index - 1]);
  }

  function scoreText(query, candidate) {
    const needle = normalize(query).trim();
    const haystack = normalize(candidate);
    if (!needle) return 0;
    if (!haystack || needle.length > haystack.length) return null;

    let previous = new Array(haystack.length).fill(NO_SCORE);
    for (let qi = 0; qi < needle.length; qi++) {
      const current = new Array(haystack.length).fill(NO_SCORE);
      for (let hi = 0; hi < haystack.length; hi++) {
        if (needle[qi] !== haystack[hi]) continue;
        const boundaryBonus = isWordBeginning(haystack, hi) ? 8 : 0;

        if (qi === 0) {
          current[hi] = 10 + boundaryBonus - hi * 0.35;
          continue;
        }

        for (let prev = qi - 1; prev < hi; prev++) {
          if (previous[prev] === NO_SCORE) continue;
          const gap = hi - prev - 1;
          const consecutiveBonus = gap === 0 ? 14 : 0;
          const next = previous[prev] + 10 + boundaryBonus + consecutiveBonus - gap * 0.7;
          if (next > current[hi]) current[hi] = next;
        }
      }
      previous = current;
    }

    let best = NO_SCORE;
    for (let i = 0; i < previous.length; i++) {
      if (previous[i] === NO_SCORE) continue;
      best = Math.max(best, previous[i] - (haystack.length - i - 1) * 0.04);
    }
    if (best === NO_SCORE) return null;

    if (haystack.startsWith(needle)) best += 65;
    if (haystack === needle) best += 130;
    return best;
  }

  function score(query, value) {
    if (!Array.isArray(value)) return scoreText(query, value);
    let best = null;
    for (const field of value) {
      const fieldScore = scoreText(query, field);
      if (fieldScore !== null && (best === null || fieldScore > best)) best = fieldScore;
    }
    return best;
  }

  function rank(query, items, getValue) {
    const source = Array.isArray(items) ? items : [];
    const read = typeof getValue === "function" ? getValue : (item) => item;
    const emptyQuery = !normalize(query).trim();

    return source
      .map((item, originalIndex) => {
        const itemScore = emptyQuery ? 0 : score(query, read(item));
        return {
          item,
          score: itemScore,
          matched: emptyQuery || itemScore !== null,
          originalIndex,
        };
      })
      .sort((a, b) => {
        if (a.matched !== b.matched) return a.matched ? -1 : 1;
        if (a.matched && b.matched && a.score !== b.score) return b.score - a.score;
        return a.originalIndex - b.originalIndex;
      });
  }

  return { normalize, score, rank };
});
