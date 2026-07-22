// ═══════════════════════════════════════════════════════════════════════════
// src/services/seo/effective.js
// Resolves the SEO content a route page should actually render, applying the
// invariant "manual content always wins over generated content".
//
// The frontend/SSG build reads route.seo.{title,metaDescription,introHtml,faq}
// and never needs to know whether a field was hand-written or generated.
// ═══════════════════════════════════════════════════════════════════════════

function nonEmpty(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

function effectiveRouteSeo(route) {
  if (!route) return null;
  const manualFaq = Array.isArray(route.custom_faq) ? route.custom_faq : null;
  return {
    title: nonEmpty(route.custom_title) ? route.custom_title : (route.seo_title || null),
    metaDescription: nonEmpty(route.custom_meta_description) ? route.custom_meta_description : (route.seo_meta_description || null),
    introHtml: nonEmpty(route.intro_text) ? route.intro_text : (route.seo_intro_html || null),
    faq: nonEmpty(manualFaq) ? manualFaq : (route.seo_faq || null),
    // Provenance so the admin UI / debugging can tell where each field came from.
    source: {
      title: nonEmpty(route.custom_title) ? 'manual' : (route.seo_title ? 'generated' : 'none'),
      metaDescription: nonEmpty(route.custom_meta_description) ? 'manual' : (route.seo_meta_description ? 'generated' : 'none'),
      intro: nonEmpty(route.intro_text) ? 'manual' : (route.seo_intro_html ? 'generated' : 'none'),
      faq: nonEmpty(manualFaq) ? 'manual' : (route.seo_faq ? 'generated' : 'none'),
    },
    angle: route.seo_angle || null,
    generatedAt: route.seo_generated_at || null,
  };
}

module.exports = { effectiveRouteSeo, nonEmpty };
