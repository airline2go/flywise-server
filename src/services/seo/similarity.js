// ═══════════════════════════════════════════════════════════════════════════
// src/services/seo/similarity.js
// Measures content overlap between generated pages (rule #9: keep pairwise
// similarity well under 40%). Uses word-level k-shingling + Jaccard, which is
// how duplicate-content detectors approximate near-duplication.
//
// Crucially, comparison is done on the CITY-NEUTRALIZED text: origin and
// destination names/IATA are masked before shingling, so "same paragraph with
// names swapped" scores as identical (~1.0) and is caught — exactly the
// failure mode the rules forbid. Real structural/data-driven variation is what
// brings the score down.
// ═══════════════════════════════════════════════════════════════════════════

function normalize(text) {
  return text
    .replace(/<[^>]+>/g, ' ')       // strip HTML tags
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // drop punctuation (unicode-aware)
    .replace(/\s+/g, ' ')
    .trim();
}

// Replace this route's own identifiers with placeholders so that two pages
// differing ONLY by city name are correctly detected as duplicates.
function neutralize(text, tokens) {
  let out = text;
  for (const t of tokens.filter(Boolean)) {
    out = out.replace(new RegExp(escapeRe(t), 'gi'), ' _ent_ ');
  }
  return out;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function shingles(text, k = 3) {
  const words = normalize(text).split(' ').filter(Boolean);
  const set = new Set();
  if (words.length < k) { if (words.length) set.add(words.join(' ')); return set; }
  for (let i = 0; i <= words.length - k; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
}

function jaccard(aSet, bSet) {
  if (!aSet.size && !bSet.size) return 1;
  let inter = 0;
  const [small, large] = aSet.size < bSet.size ? [aSet, bSet] : [bSet, aSet];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}

// Similarity between two page texts, neutralizing each page's own city tokens.
function pageSimilarity(pageA, pageB, k = 3) {
  const a = shingles(neutralize(pageA.text, pageA.tokens), k);
  const b = shingles(neutralize(pageB.text, pageB.tokens), k);
  return jaccard(a, b);
}

// Report over a set of pages: [{text, tokens}]. Returns mean/max/p95 pairwise
// similarity and the count of pairs above the given threshold.
function similarityReport(pages, { k = 3, threshold = 0.4, maxPairs = 20000 } = {}) {
  const shs = pages.map((p) => shingles(neutralize(p.text, p.tokens), k));
  const sims = [];
  let over = 0, maxSim = 0, worst = null;
  let pairs = 0;
  const stride = Math.max(1, Math.floor((pages.length * (pages.length - 1)) / 2 / maxPairs));
  let counter = 0;
  for (let i = 0; i < shs.length; i++) {
    for (let j = i + 1; j < shs.length; j++) {
      if (counter++ % stride !== 0) continue;
      const s = jaccard(shs[i], shs[j]);
      sims.push(s);
      if (s > threshold) over++;
      if (s > maxSim) { maxSim = s; worst = [i, j]; }
      pairs++;
    }
  }
  sims.sort((x, y) => x - y);
  const mean = sims.reduce((a, b) => a + b, 0) / (sims.length || 1);
  const p95 = sims.length ? sims[Math.floor(sims.length * 0.95)] : 0;
  return { pairs, mean, p95, max: maxSim, worstPair: worst, overThreshold: over, threshold };
}

module.exports = { pageSimilarity, similarityReport, shingles, jaccard, normalize, neutralize };
