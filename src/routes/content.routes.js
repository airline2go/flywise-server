// ═══════════════════════════════════════════════════════════════
// src/routes/content.routes.js
// كل محتوى SEO العام (بدون حماية أدمن): المدونة، صفحات المسارات،
// الدول، المدن، المطارات، وخريطة الموقع الديناميكية للمسارات.
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { buildRouteIntelligenceSnapshot } = require('../services/routeIntelligence');
const { effectiveRouteSeo } = require('../services/seo/effective');
const { getAdminConfig } = require('../services/adminConfig');
const {
  routeIndexable, cityIndexable, airportIndexable, countryIndexable, airlineIndexable,
  cityDestinationCount, airportDestinationCount, countryConnectivityScore,
} = require('../services/indexability');
const { getIndexabilityData } = require('../services/indexabilityData');

const MAX_PAGE = 100000;
function parsePageParam(raw) {
  if (raw == null || raw === '') return { page: 0 };
  if (!/^\d+$/.test(String(raw))) return { error: 'page must be a non-negative integer' };
  const page = Number(raw);
  if (!Number.isSafeInteger(page) || page > MAX_PAGE) return { error: `page out of range (0..${MAX_PAGE})` };
  return { page };
}

// [P0.7] Hub route lists must carry every evidence field used by routeIndexable.
// Demand/freshness are part of the fail-closed verdict and therefore cannot be
// omitted from hub SELECTs without changing the shared policy's result.
const HUB_ROUTE_EVIDENCE_COLS = 'airline_count,avg_duration_min,stop_distribution,price_sample_count,itinerary_count,intro_text,custom_faq,distance_km,route_score,weekly_flights,insights_updated_at,updated_at,created_at';
function attachHubRouteIndexable(routes) {
  return (routes || []).map((r) => {
    const indexable = routeIndexable(r);
    const { avg_duration_min, stop_distribution, price_sample_count, itinerary_count, intro_text, custom_faq, ...rest } = r;
    return { ...rest, indexable };
  });
}

module.exports = (app) => {

app.get('/blog-posts', rateLimit('content', 2500, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const lang = req.query.lang;
    if (lang && lang !== 'de') {
      const { data: parents, error: pErr } = await supa.from('blog_posts')
        .select('id,cover_image_url,author,published_at')
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(limit);
      if (pErr) throw new Error(pErr.message);
      const ids = (parents || []).map((p) => p.id);
      if (!ids.length) return res.json({ ok: true, posts: [] });
      const { data: trs, error: tErr } = await supa.from('blog_post_translations')
        .select('post_id,slug,title,excerpt').eq('language', lang).in('post_id', ids);
      if (tErr) throw new Error(tErr.message);
      const byId = new Map((trs || []).map((t) => [t.post_id, t]));
      const posts = (parents || [])
        .filter((p) => byId.has(p.id))
        .map((p) => {
          const t = byId.get(p.id);
          return { slug: t.slug, title: t.title, excerpt: t.excerpt, cover_image_url: p.cover_image_url, author: p.author, published_at: p.published_at };
        });
      return res.json({ ok: true, posts });
    }
    const { data, error } = await supa.from('blog_posts')
      .select('slug,title,excerpt,cover_image_url,author,published_at,updated_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    res.json({ ok: true, posts: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// [MULTILANG-BLOG] Actual published siblings only.
async function buildBlogAlternates(postId, germanSlug, slugEn) {
  const out = [{ language: 'de', slug: germanSlug }];
  const { data } = await supa.from('blog_post_translations').select('language,slug').eq('post_id', postId).eq('status', 'published');
  for (const row of data || []) if (row.language && row.slug && !out.some((x) => x.language === row.language)) out.push({ language: row.language, slug: row.slug });
  if (slugEn && !out.some((x) => x.language === 'en')) out.push({ language: 'en', slug: slugEn });
  return out;
}