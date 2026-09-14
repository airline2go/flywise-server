// Deterministic post-generation quality checks for route SEO.
// This gate is intentionally conservative: passing means the generated page
// is structurally complete AND grounded in the route's verified data.
function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
function hasEvidence(route) {
  return !!(route && (
    (route.airline_count != null && Number(route.airline_count) > 0) ||
    (route.avg_duration_min != null && Number(route.avg_duration_min) > 0) ||
    (route.price_sample_count != null && Number(route.price_sample_count) > 0) ||
    (route.itinerary_count != null && Number(route.itinerary_count) > 0) ||
    (route.stop_distribution && typeof route.stop_distribution === 'object' && Object.keys(route.stop_distribution).length > 0)
  ));
}
function validateGeneratedSeo(route, content, options = {}) {
  const title = text(content && content.title);
  const meta = text(content && content.metaDescription);
  const intro = text(content && (content.introPlain || content.intro));
  const sections = Array.isArray(content && content.sections) ? content.sections : [];
  const faq = Array.isArray(content && content.faq) ? content.faq : [];
  const origin = text(route && route.origin_city).toLowerCase();
  const destination = text(route && route.destination_city).toLowerCase();
  const titleLower = title.toLowerCase();
  const metaLower = meta.toLowerCase();
  const reasons = [];
  if (options.requireEvidence !== false && !hasEvidence(route)) reasons.push('no verified flight evidence');
  if (title.length < 30 || title.length > 70) reasons.push('title length outside 30-70');
  if (meta.length < 90 || meta.length > 170) reasons.push('meta length outside 90-170');
  if (!origin || !titleLower.includes(origin)) reasons.push('title missing origin city');
  if (!destination || !titleLower.includes(destination)) reasons.push('title missing destination city');
  if (!origin || !metaLower.includes(origin)) reasons.push('meta missing origin city');
  if (!destination || !metaLower.includes(destination)) reasons.push('meta missing destination city');
  if (intro.length < 120) reasons.push('intro too short');
  if (sections.length < 2) reasons.push('fewer than 2 sections');
  if (faq.length < 2) reasons.push('fewer than 2 FAQ entries');
  if (!faq.every((f) => text(f && f.question) && text(f && f.answer))) reasons.push('FAQ contains empty question/answer');
  const questions = faq.map((f) => text(f && f.question).toLowerCase()).filter(Boolean);
  if (new Set(questions).size !== questions.length) reasons.push('duplicate FAQ questions');
  return { valid: reasons.length === 0, reasons, metrics: { titleLength: title.length, metaLength: meta.length, introLength: intro.length, sectionCount: sections.length, faqCount: faq.length, evidencePresent: hasEvidence(route) } };
}
module.exports = { validateGeneratedSeo, hasEvidence };
