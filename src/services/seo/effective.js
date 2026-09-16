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
  return {
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
}

module.exports = { effectiveRouteSeo, nonEmpty };
