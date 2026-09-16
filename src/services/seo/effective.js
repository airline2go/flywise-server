// Resolves the SEO content a route page should actually render.
// Manual content always wins. Generated content is additionally passed through
// the truthfulness guard so stale generated text cannot expose unsupported
// booking, seasonality, causality or price claims.
const { generatedFieldIsSafe } = require('./truthfulness');

function nonEmpty(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

function safeGenerated(route, value) {
  return nonEmpty(value) && generatedFieldIsSafe(route, value) ? value : null;
}

function safeGeneratedFaq(route, faq) {
  if (!Array.isArray(faq)) return null;
  const out = faq.filter((f) => f && nonEmpty(f.question) && nonEmpty(f.answer)
    && generatedFieldIsSafe(route, `${f.question} ${f.answer}`));
  return out.length ? out : null;
}

function effectiveRouteSeo(route) {
  if (!route) return null;
  const manualFaq = Array.isArray(route.custom_faq) ? route.custom_faq : null;
  const generatedTitle = safeGenerated(route, route.seo_title);
  const generatedMeta = safeGenerated(route, route.seo_meta_description);
  const generatedIntro = safeGenerated(route, route.seo_intro_html);
  const generatedFaq = safeGeneratedFaq(route, route.seo_faq);

  const effective = {
    title: nonEmpty(route.custom_title) ? route.custom_title : generatedTitle,
    metaDescription: nonEmpty(route.custom_meta_description) ? route.custom_meta_description : generatedMeta,
    introHtml: nonEmpty(route.intro_text) ? route.intro_text : generatedIntro,
    faq: nonEmpty(manualFaq) ? manualFaq : generatedFaq,
    source: {
      title: nonEmpty(route.custom_title) ? 'manual' : (generatedTitle ? 'generated' : 'none'),
      metaDescription: nonEmpty(route.custom_meta_description) ? 'manual' : (generatedMeta ? 'generated' : 'none'),
      intro: nonEmpty(route.intro_text) ? 'manual' : (generatedIntro ? 'generated' : 'none'),
      faq: nonEmpty(manualFaq) ? 'manual' : (generatedFaq ? 'generated' : 'none'),
    },
    angle: route.seo_angle || null,
    generatedAt: route.seo_generated_at || null,
  };

  // [LEGACY-RENDER-CONTRACT] The public route response already exposes the
  // resolved object as `route.seo`, but the legacy SSR renderer still consumes
  // the historical flat `seo_*` fields. Keep those two representations in lock
  // step at the server boundary. This is deliberately derived-only: manual
  // overrides remain authoritative and rejected generated values become null;
  // we never write to the database and never invent fallback copy.
  //
  // The renderer receives a shallow copy of `data` in content.routes.js, so
  // mutating this request-local object here cannot persist anything to Supabase.
  route.seo_title = effective.title;
  route.seo_meta_description = effective.metaDescription;
  route.seo_intro_html = effective.introHtml;
  route.seo_faq = effective.faq;

  return effective;
}

module.exports = { effectiveRouteSeo, nonEmpty };
