// ═══════════════════════════════════════════════════════════════
// src/services/blogTranslation.js
// [MULTILANG-BLOG] Translates a German blog post into every other site
// language via Claude and stores each in blog_post_translations. German is
// the source (blog_posts itself); this handles en/ar/es/fr/it/nl/tr.
//
// HTML tags and URLs are preserved verbatim by the prompt — internal links
// are localized to the right language at RENDER time in the frontend, not
// here, so one canonical set of links works for every language.
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');
const log = require('../utils/log');

// German is the source language and is NOT listed here. Adding a language =
// one entry (code + human-readable name used in the translation prompt).
const BLOG_TARGET_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ar', name: 'Arabic' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'tr', name: 'Turkish' },
];

// Mirrors admin.routes.js's slugify — ASCII-safe URL slug, umlaut-aware, with
// a random fallback for titles that collapse to empty (e.g. fully Arabic).
function slugify(title) {
  const umlautMap = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' };
  let s = String(title || '').replace(/[äöüÄÖÜß]/g, (c) => umlautMap[c] || c);
  s = s.toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || ('post-' + Math.random().toString(36).slice(2, 8));
}

function buildTranslationPrompt(langName, title, metaDescription, contentHtml) {
  return `Translate this German blog article into ${langName} (natural, professional travel-blog ${langName}, not a word-for-word translation).\n\n` +
    'IMPORTANT: In the "content_html" field, ALL HTML tags and attributes (e.g. <h2>, <ul>, <li>, <a href="...">) must be preserved EXACTLY unchanged — translate ONLY the human-readable text between the tags, never the tags or the URLs themselves.\n\n' +
    'Reply ONLY with a valid JSON object, without a markdown code block, in exactly this form:\n' +
    '{"title": "...", "content_html": "...", "meta_description": "..."}\n\n' +
    `Title: ${title}\n\nMeta-Description: ${metaDescription || ''}\n\nContent (HTML):\n${contentHtml}`;
}

// Tolerant parse of the model reply: strips an optional ```json fence, JSON-
// parses, and validates the required fields. Returns null on any problem so a
// bad reply for one language never throws.
function parseTranslationResponse(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return null; }
  if (!parsed || !parsed.title || !parsed.content_html) return null;
  return {
    title: String(parsed.title).trim(),
    content: String(parsed.content_html).trim(),
    meta_description: parsed.meta_description ? String(parsed.meta_description).trim() : null,
  };
}

async function translateBlogPost({ title, contentHtml, metaDescription }, langName) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: buildTranslationPrompt(langName, title, metaDescription, contentHtml) }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const text = json.content && json.content[0] && json.content[0].text;
    return parseTranslationResponse(text);
  } catch (e) {
    log('warn', 'blog_translate_failed', { lang: langName, error: e.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A slug unique within a language. Reuses this post's already-stored slug if
// present (never moves an already-indexed URL just because the title changed).
async function resolveSlugForLanguage(supa, language, postId, title) {
  const { data: current } = await supa.from('blog_post_translations')
    .select('slug').eq('post_id', postId).eq('language', language).maybeSingle();
  if (current && current.slug) return current.slug;
  const base = slugify(title);
  let slug = base;
  for (let attempt = 2; attempt <= 21; attempt++) {
    const { data: clash } = await supa.from('blog_post_translations')
      .select('post_id').eq('language', language).eq('slug', slug).maybeSingle();
    if (!clash || clash.post_id === postId) break;
    slug = `${base}-${attempt}`;
  }
  return slug;
}

// Translate the German source post into every target language and upsert each
// into blog_post_translations. Fire-and-forget from the caller (never blocks
// the admin request); onLanguageStored fires per language as it lands so the
// caller can revalidate that language's page immediately.
async function translateAndStoreAllLanguages(post, supa, { onLanguageStored } = {}) {
  if (!post || !post.id || !post.title || !post.content) return;
  for (const { code, name } of BLOG_TARGET_LANGUAGES) {
    try {
      const t = await translateBlogPost(
        { title: post.title, contentHtml: post.content, metaDescription: post.meta_description },
        name,
      );
      if (!t) continue;
      const slug = await resolveSlugForLanguage(supa, code, post.id, t.title);
      const { error } = await supa.from('blog_post_translations').upsert({
        post_id: post.id,
        language: code,
        slug,
        title: t.title,
        meta_description: t.meta_description,
        excerpt: t.meta_description,
        content: t.content,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'post_id,language' });
      if (error) throw new Error(error.message);
      if (onLanguageStored) onLanguageStored({ code, slug });
    } catch (e) {
      log('warn', 'blog_translate_store_failed', { lang: code, error: e.message });
    }
  }
}

module.exports = {
  BLOG_TARGET_LANGUAGES,
  slugify,
  buildTranslationPrompt,
  parseTranslationResponse,
  translateBlogPost,
  resolveSlugForLanguage,
  translateAndStoreAllLanguages,
};
