// Deterministic post-generation quality checks for route SEO.
const { hasVerifiedFlightEvidence } = require('../indexability');
const { generatedFieldIsSafe } = require('./truthfulness');

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function validateGeneratedSeo(route, content, { requireEvidence = true } = {}) {
  const title = text(content && content.title);
  const meta = text(content && content.metaDescription);
  const intro = text(content && (content.introPlain || content.intro));
  const sections = Array.isArray(content && content.sections) ? content.sections : [];
  const faq = Array.isArray(content && content.faq) ? content.faq : [];
  const origin = text(route && route.origin_city).toLowerCase();
  const destination = text(route && route.destination_city).toLowerCase();
  const reasons = [];

  if (requireEvidence && !hasVerifiedFlightEvidence(route)) reasons.push('no verified flight evidence');
  if (title.length < 30 || title.length > 70) reasons.push('title length outside 30-70');
  if (meta.length < 90 || meta.length > 170) reasons.push('meta length outside 90-170');
  if (!origin || !title.toLowerCase().includes(origin)) reasons.push('title missing origin city');
  if (!destination || !title.toLowerCase().includes(destination)) reasons.push('title missing destination city');
  if (!origin || !meta.toLowerCase().includes(origin)) reasons.push('meta missing origin city');
  if (!destination || !meta.toLowerCase().includes(destination)) reasons.push('meta missing destination city');
  if (intro.length < 120) reasons.push('intro too short');
  if (sections.length < 2) reasons.push('fewer than 2 sections');
  if (faq.length < 2) reasons.push('fewer than 2 FAQ entries');
  if (!faq.every((f) => text(f && f.question) && text(f && f.answer))) reasons.push('FAQ contains empty question/answer');
  if (!generatedFieldIsSafe(route, title)) reasons.push('unsupported title claim');
  if (!generatedFieldIsSafe(route, meta)) reasons.push('unsupported meta claim');
  if (!generatedFieldIsSafe(route, intro)) reasons.push('unsupported intro claim');
  if (sections.some((s) => !generatedFieldIsSafe(route, `${s && s.heading} ${s && s.body}`))) reasons.push('unsupported section claim');
  if (faq.some((f) => !generatedFieldIsSafe(route, `${f && f.question} ${f && f.answer}`))) reasons.push('unsupported FAQ claim');

  const faqQuestions = faq.map((f) => text(f && f.question).toLowerCase()).filter(Boolean);
  if (new Set(faqQuestions).size !== faqQuestions.length) reasons.push('duplicate FAQ questions');

  return {
    valid: reasons.length === 0,
    reasons,
    metrics: {
      titleLength: title.length,
      metaLength: meta.length,
      introLength: intro.length,
      sectionCount: sections.length,
      faqCount: faq.length,
      evidencePresent: hasVerifiedFlightEvidence(route),
    },
  };
}

module.exports = { validateGeneratedSeo };
