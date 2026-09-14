function nonEmpty(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

function effectiveLocalizedRouteSeo(row) {
  if (!row) return null;
  return {
    title: nonEmpty(row.seo_title) ? row.seo_title : null,
    metaDescription: nonEmpty(row.seo_meta_description) ? row.seo_meta_description : null,
    introHtml: nonEmpty(row.seo_intro_html) ? row.seo_intro_html : null,
    faq: nonEmpty(row.seo_faq) ? row.seo_faq : null,
    language: row.language || null,
    angle: row.seo_angle || null,
    generatedAt: row.seo_generated_at || null,
    dataCoverage: row.seo_data_coverage || null,
    source: 'localized-generated',
  };
}

module.exports = { effectiveLocalizedRouteSeo, nonEmpty };
