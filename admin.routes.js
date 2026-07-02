// ═══════════════════════════════════════════════════════════════
// src/routes/admin.routes.js
// [ADMIN] كل روتات لوحة التحكم — كل واحد محمي بـ requireAdmin.
// تسجيل الدخول، الإحصائيات، إدارة المدونة، صفحات المسارات،
// سجلات الأخطاء/الإلغاء/فشل الحجز/فشل المزامنة، الحجوزات، شرائح
// الربح، أكواد الخصم، الفواتير، إعدادات الولاء، ومعاينة التسعير.
// ═══════════════════════════════════════════════════════════════

const env = require('./env');
const log = require('./log');
const supa = require('./supabase');
const rateLimit = require('./rateLimit');
const { requireAdmin } = require('./auth');
const duffel = require('./duffel');
const { duffelAttempt } = require('./duffel');
const {
  DEFAULT_TICKET_TIERS, DEFAULT_ANCILLARY_TIERS, DEFAULT_INVOICE_CONFIG,
  getAdminConfig, setAdminConfig, clearConfigCacheKeys,
  recordCancellationEvent, markCancellationsRead,
  markBookingFailuresRead,
  markSyncFailuresRead,
  computeTieredMargin, getTicketProfitTiers, getAncillaryProfitTiers,
} = require('./adminConfig');
const { getLoyaltyConfig } = require('./loyalty');
const { haversineDistanceKm, classifyHaul, ensureCountryExists, ensureCityExists } = require('./routePages');

module.exports = (app) => {

app.post('/admin/login', rateLimit('admin_login', 10, 60000), (req, res) => {
  if (!env.ADMIN_TOKEN) return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN nicht konfiguriert' });
  const { password } = req.body || {};
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(env.ADMIN_TOKEN);
  const valid = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  if (!valid) { log('warn', 'admin_login_failed', { ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress }); return res.status(401).json({ ok: false, error: 'Falsches Passwort' }); }
  res.json({ ok: true, token: env.ADMIN_TOKEN });
});

app.get('/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const maint = await getAdminConfig('maintenance_mode', { enabled: false, message: '' });
    res.json({ ok: true, enabled: !!maint.enabled, message: maint.message || '' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const enabled = !!(req.body && req.body.enabled);
    const message = (req.body && typeof req.body.message === 'string') ? req.body.message.slice(0, 500) : '';
    await setAdminConfig('maintenance_mode', { enabled, message });
    log('info', 'maintenance_mode_toggled', { enabled });
    res.json({ ok: true, enabled, message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    // [PROFIT-PERIOD-FIX] Optional date-range filter on created_at —
    // 'from'/'to' are ISO date strings (YYYY-MM-DD). Omitting both keeps
    // the original all-time behavior unchanged for any existing caller.
    let query = supa.from('bookings').select('*').eq('status', 'confirmed');
    if (req.query.from) query = query.gte('created_at', req.query.from);
    if (req.query.to) {
      // 'to' is a day boundary, not a timestamp — make it inclusive of the
      // entire day by treating it as start-of-NEXT-day exclusive.
      const toDate = new Date(req.query.to + 'T00:00:00Z');
      toDate.setUTCDate(toDate.getUTCDate() + 1);
      query = query.lt('created_at', toDate.toISOString());
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = data || [];
    const revenue = rows.reduce((s, b) => s + (Number(b.customer_paid) || 0), 0);
    const profit = rows.reduce((s, b) => s + (Number(b.profit_margin) || 0), 0);
    const discounts = rows.reduce((s, b) => s + (Number(b.discount_amount) || 0), 0);
    res.json({
      ok: true,
      revenue: Math.round(revenue * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      discounts: Math.round(discounts * 100) / 100,
      bookingsCount: rows.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function slugify(title) {
  const umlautMap = { 'ä':'ae','ö':'oe','ü':'ue','Ä':'Ae','Ö':'Oe','Ü':'Ue','ß':'ss' };
  let s = String(title || '').replace(/[äöüÄÖÜß]/g, (c) => umlautMap[c] || c);
  s = s.toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip remaining accents
    .replace(/[^a-z0-9\s-]/g, '')   // drop anything non-ASCII (incl. Arabic) — slug must stay URL-safe
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // A title that's entirely non-Latin (e.g. fully Arabic) collapses to ''
  // here — fall back to a short random id so the post still gets a valid,
  // unique-enough slug instead of failing to save.
  return s || ('post-' + Math.random().toString(36).slice(2, 8));
}

app.get('/admin/blog-posts', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('blog_posts').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, posts: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function autoFormatContent(raw) {
  if (!raw) return raw;
  const hasHtmlTags = /<(p|h1|h2|h3|h4|ul|ol|li|strong|em|a|br|div|blockquote)[\s>]/i.test(raw);
  if (hasHtmlTags) return raw;
  return raw
    .split(/\n\s*\n/) // blank line = paragraph break
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => '<p>' + block.replace(/\n/g, '<br>') + '</p>') // single newline within a paragraph = line break
    .join('\n');
}

app.post('/admin/blog-posts', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { title, meta_description, excerpt, content, cover_image_url, author, status } = req.body;
    if (!title || !content) return res.status(400).json({ ok: false, error: 'Titel und Inhalt sind erforderlich' });

    let baseSlug = slugify(req.body.slug || title);
    let slug = baseSlug;
    for (let attempt = 2; attempt <= 21; attempt++) {
      const { data: existing } = await supa.from('blog_posts').select('id').eq('slug', slug).maybeSingle();
      if (!existing) break;
      slug = baseSlug + '-' + attempt;
    }

    const isPublishing = status === 'published';
    const { data, error } = await supa.from('blog_posts').insert({
      slug, title,
      meta_description: meta_description || null,
      excerpt: excerpt || null,
      content: autoFormatContent(content),
      cover_image_url: cover_image_url || null,
      author: author || 'Airpiv Team',
      status: isPublishing ? 'published' : 'draft',
      published_at: isPublishing ? new Date().toISOString() : null,
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/blog-posts/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: existing, error: fetchErr } = await supa.from('blog_posts').select('*').eq('id', req.params.id).maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!existing) return res.status(404).json({ ok: false, error: 'Beitrag nicht gefunden' });

    const { title, meta_description, excerpt, content, cover_image_url, author, status } = req.body;
    const update = {
      updated_at: new Date().toISOString(),
    };
    if (title != null) update.title = title;
    if (meta_description != null) update.meta_description = meta_description;
    if (excerpt != null) update.excerpt = excerpt;
    if (content != null) update.content = autoFormatContent(content);
    if (cover_image_url != null) update.cover_image_url = cover_image_url;
    if (author != null) update.author = author;
    if (status != null) {
      update.status = status;
      if (status === 'published' && existing.status !== 'published') {
        update.published_at = new Date().toISOString();
      }
    }
    // Slug is intentionally NOT editable after creation — changing it
    // would break any link already shared/indexed by Google for this post.
    const { data, error } = await supa.from('blog_posts').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/blog-posts/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('blog_posts').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/route-pages/clear-price-cache', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('admin_config').select('key').like('key', 'route_price_%');
    if (error) throw new Error(error.message);
    const keys = (data || []).map((r) => r.key);
    if (keys.length) {
      const { error: delErr } = await supa.from('admin_config').delete().in('key', keys);
      if (delErr) throw new Error(delErr.message);
    }
    clearConfigCacheKeys(keys);
    res.json({ ok: true, cleared: keys.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/route-pages/backfill-locations', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: routes, error } = await supa.from('route_pages').select('*').eq('status', 'published');
    if (error) throw new Error(error.message);

    const iataCache = new Map(); // avoid looking up the same airport twice in one run
    async function lookupAirport(code) {
      if (iataCache.has(code)) return iataCache.get(code);
      try {
        const result = await duffel('GET', '/places/suggestions?query=' + encodeURIComponent(code));
        const match = (result.data || []).find((p) => p.iata_code === code || (p.airports || []).some((a) => a.iata_code === code));
        const info = match
          ? { country: match.iata_country_code, city: match.city_name || match.name }
          : null;
        iataCache.set(code, info);
        return info;
      } catch (e) {
        iataCache.set(code, null);
        return null;
      }
    }

    let updated = 0, skipped = 0, failed = 0;
    for (const route of (routes || [])) {
      if (route.origin_country && route.destination_country && route.origin_city_slug && route.destination_city_slug) {
        skipped++;
        continue;
      }
      try {
        const update = {};
        let originInfo = null, destInfo = null;
        if (!route.origin_country || !route.origin_city_slug) {
          originInfo = await lookupAirport(route.origin_iata);
          if (originInfo) {
            update.origin_country = originInfo.country;
            update.origin_city_slug = slugify(originInfo.city || route.origin_city);
          }
        }
        if (!route.destination_country || !route.destination_city_slug) {
          destInfo = await lookupAirport(route.destination_iata);
          if (destInfo) {
            update.destination_country = destInfo.country;
            update.destination_city_slug = slugify(destInfo.city || route.destination_city);
          }
        }
        if (Object.keys(update).length) {
          const { error: updErr } = await supa.from('route_pages').update(update).eq('id', route.id);
          if (updErr) throw new Error(updErr.message);
          updated++;
          // [MIGRATION] Same auto-creation calls a fresh route publish
          // would trigger — backfilled routes end up creating their
          // country/city pages exactly like a new route does.
          const finalOriginCountry = update.origin_country || route.origin_country;
          const finalDestCountry = update.destination_country || route.destination_country;
          const finalOriginSlug = update.origin_city_slug || route.origin_city_slug;
          const finalDestSlug = update.destination_city_slug || route.destination_city_slug;
          if (finalOriginCountry) ensureCountryExists(finalOriginCountry);
          if (finalDestCountry) ensureCountryExists(finalDestCountry);
          if (finalOriginSlug) ensureCityExists(finalOriginSlug, route.origin_city, finalOriginCountry, route.origin_iata);
          if (finalDestSlug) ensureCityExists(finalDestSlug, route.destination_city, finalDestCountry, route.destination_iata);
        } else {
          skipped++;
        }
        // Small delay between airports — stays well under Duffel's rate
        // limits even when backfilling many routes in one run.
        await new Promise((r) => setTimeout(r, 250));
      } catch (e) {
        failed++;
        log('warn', 'route_backfill_failed', { route_id: route.id, error: e.message });
      }
    }

    res.json({ ok: true, total: (routes || []).length, updated, skipped, failed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// [MISSING-ROUTES-MATRIX] بترجع بس المسارات الموجودة فعلاً ضمن مجموعة
// مطارات محددة (مش كل قاعدة البيانات) — الفرونت إند هو اللي بيقارن
// دي مع كل التوليفات الممكنة نظرياً عشان يوري "مين موجود ومين ناقص".
// محدودة بـ 40 كود كحد أقصى (40×39=1560 توليفة ممكنة) عشان الجدول
// يفضل قابل للقراءة فعلياً على الشاشة.
app.get('/admin/route-pages/matrix', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const codes = (req.query.codes || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (codes.length < 2) return res.status(400).json({ ok: false, error: 'محتاج كودين على الأقل' });
    if (codes.length > 40) return res.status(400).json({ ok: false, error: 'الحد الأقصى 40 مطار للمصفوفة الواحدة' });

    const { data, error } = await supa.from('route_pages')
      .select('origin_iata, destination_iata, status, slug')
      .in('origin_iata', codes)
      .in('destination_iata', codes);
    if (error) throw new Error(error.message);
    res.json({ ok: true, existing: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// [ADMIN-SCALE-FIX] كانت بتجيب كل المسارات دفعة واحدة (select('*') من
// غير أي حد أقصى) — مع آلاف المسارات ده هيبقى رد ضخم بطيء، والمتصفح
// هيتجمد وهو بيرسم آلاف الصفوف مرة واحدة. دلوقتي:
// - `q`: بحث نصي على اسم المدينة (مصدر أو وجهة) أو كود IATA
// - `status`: فلترة (published/draft) — اختياري
// - `page`, `limit`: صفحات حقيقية من قاعدة البيانات (مش كل شيء ثم قص من الفرونت إند)
// النتيجة برضو بترجع `total` عشان الواجهة تقدر تبني أرقام الصفحات.
app.get('/admin/route-pages', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const q = (req.query.q || '').trim();
    const statusFilter = req.query.status;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supa.from('route_pages').select('*', { count: 'exact' });
    if (statusFilter === 'published' || statusFilter === 'draft' || statusFilter === 'dead') {
      query = query.eq('status', statusFilter);
    }
    if (q) {
      // بحث على أي عمود من الخمسة دول — يغطي البحث بالاسم أو بكود المطار
      const esc = q.replace(/[%_]/g, '\\$&');
      query = query.or(
        `origin_city.ilike.%${esc}%,destination_city.ilike.%${esc}%,origin_iata.ilike.%${esc}%,destination_iata.ilike.%${esc}%,slug.ilike.%${esc}%`
      );
    }
    query = query.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    res.json({ ok: true, routes: data || [], total: count || 0, page, limit, totalPages: Math.max(1, Math.ceil((count || 0) / limit)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// [BULK-CREATE] بيستقبل قائمة مطارات (كل واحد ببياناته الحقيقية الجاية
// من نفس بحث المطارات اللي فورم الإنشاء الفردي بيستخدمه بالظبط —
// مفيش أي بيانات مُخترعة أو استعلام خارجي جديد هنا) ويولّد كل
// التوليفات الممكنة بينهم. أي زوج موجود فعلاً بيتجاهل تلقائياً (نفس
// منطق فحص التكرار). المسارات الجديدة بتتعمل كـ"مسودة" دايماً — أبداً
// منشورة تلقائياً — عشان لو حصل غلط في قائمة كبيرة، الأدمن يقدر يراجع
// ويحذف قبل ما أي حاجة تظهر للزوار.
app.post('/admin/route-pages/bulk-create', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { airports, bothDirections } = req.body;
    if (!Array.isArray(airports) || airports.length < 2) {
      return res.status(400).json({ ok: false, error: 'محتاج مطارين على الأقل' });
    }
    if (airports.length > 60) {
      return res.status(400).json({ ok: false, error: 'الحد الأقصى 60 مطار في المرة الواحدة (عشان الأداء) — قسّم القائمة على دفعات' });
    }
    for (const a of airports) {
      if (!a || !a.code || !a.city) {
        return res.status(400).json({ ok: false, error: 'كل مطار لازم يكون ليه كود ومدينة (اخترهم من نتائج البحث بس)' });
      }
    }

    // توليد كل التوليفات الممكنة (من غير نفس المطار مع نفسه)
    const pairs = [];
    for (let i = 0; i < airports.length; i++) {
      for (let j = 0; j < airports.length; j++) {
        if (i === j) continue;
        if (!bothDirections && j < i) continue; // اتجاه واحد بس: كل زوج مرة واحدة
        pairs.push([airports[i], airports[j]]);
      }
    }

    // فحص الموجود فعلاً بطلب واحد بدل ما نسأل عن كل زوج لوحده
    const { data: existingRoutes, error: existErr } = await supa.from('route_pages').select('origin_iata, destination_iata, slug');
    if (existErr) throw new Error(existErr.message);
    const existingSet = new Set((existingRoutes || []).map((r) => r.origin_iata + '_' + r.destination_iata));

    const toInsert = [];
    // [SLUG-DUPLICATE-FIX] كانت بتتأكد بس من الروابط اللي اتولدت جوه
    // نفس الدفعة الحالية — لو رابط بنفس الاسم موجود بالفعل من دفعة
    // سابقة أو مسار اتضاف يدوي قبل كده، السيرفر كان بيحاول يعمل نفس
    // الاسم تاني ويفشل بالكامل برسالة قاعدة بيانات مش مفهومة، بدل ما
    // يتجاهل المسار ده بهدوء ويكمل الباقي. دلوقتي بتبدأ من كل الروابط
    // الموجودة فعلاً في قاعدة البيانات كاملة، مش من الصفر.
    const usedSlugs = new Set((existingRoutes || []).map((r) => r.slug));
    let skippedExisting = 0;
    for (const [o, d] of pairs) {
      const oCode = o.code.toUpperCase(), dCode = d.code.toUpperCase();
      const pairKey = oCode + '_' + dCode;
      if (existingSet.has(pairKey)) { skippedExisting++; continue; }

      let baseSlug = slugify(o.city + '-' + d.city);
      let slug = baseSlug, n = 2;
      while (usedSlugs.has(slug)) { slug = baseSlug + '-' + (n++); }
      usedSlugs.add(slug);

      let distance_km = null, haul_type = null;
      if (o.lat != null && o.lng != null && d.lat != null && d.lng != null) {
        distance_km = haversineDistanceKm(Number(o.lat), Number(o.lng), Number(d.lat), Number(d.lng));
        haul_type = classifyHaul(distance_km);
      }

      toInsert.push({
        slug,
        origin_iata: oCode, destination_iata: dCode,
        origin_city: o.city, destination_city: d.city,
        origin_city_slug: slugify(o.city), destination_city_slug: slugify(d.city),
        origin_lat: o.lat != null ? Number(o.lat) : null,
        origin_lng: o.lng != null ? Number(o.lng) : null,
        destination_lat: d.lat != null ? Number(d.lat) : null,
        destination_lng: d.lng != null ? Number(d.lng) : null,
        origin_country: o.country || null,
        destination_country: d.country || null,
        distance_km, haul_type,
        status: 'draft', // [SAFE-DEFAULT] أبداً منشور تلقائياً — الأدمن بيراجع وينشر يدوياً
      });
    }

    if (!toInsert.length) {
      return res.json({ ok: true, created: 0, skippedExisting, message: 'كل التوليفات دي موجودة بالفعل — مفيش حاجة جديدة اتعملت' });
    }

    // [SLUG-DUPLICATE-FIX] upsert مع ignoreDuplicates بدل insert العادي —
    // حتى لو حصل تعارض نادر (زي فتح الإنشاء بالجملة مرتين في نفس
    // اللحظة بالظبط)، قاعدة البيانات نفسها بتتجاهل الصف المكرر بهدوء
    // بدل ما تفشّل الدفعة كلها برسالة خطأ. onConflict:'slug' لأن ده
    // العمود اللي عليه قيد التفرد (route_pages_slug_key).
    const { data: inserted, error: insertErr } = await supa.from('route_pages')
      .upsert(toInsert, { onConflict: 'slug', ignoreDuplicates: true })
      .select('id');
    if (insertErr) throw new Error(insertErr.message);

    log('info', 'bulk_route_pages_created', { count: inserted.length, skippedExisting });
    res.json({ ok: true, created: inserted.length, skippedExisting, totalPairs: pairs.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// [DEAD-ROUTES-HEALTH-CHECK] بيفحص دفعة صغيرة من المسارات (10 في
// المرة) عن طريق سؤال Duffel فعلياً — مش من الكاش — هل فيه رحلات
// حقيقية على المسار ده ولا لأ. أي مسار مفيهوش رحلات خالص بيتحوّل
// لحالة "dead" تلقائياً (بيختفي من الموقع للزوار فوراً، لأن endpoint
// عرض المسار للزوار بيطلب status=published بس). دفعة صغيرة عمداً —
// عشان الطلب الواحد مايستغرقش وقت طويل يخلي المتصفح يستنى أو الطلب
// يفشل بـ timeout؛ الواجهة الأمامية هي اللي بتنده على الـ endpoint
// ده بشكل متكرر لحد ما كل المسارات تتفحص.
app.post('/admin/route-pages/health-check-batch', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const BATCH_SIZE = 10;

    // [ONLY-UNCHECKED-FIX] بس المسارات اللي معندهاش last_health_check_at
    // خالص (NULL) — أي مسار اتفحص قبل كده وطلع سليم، أبداً مش هيترجع
    // يتفحص تاني في أي تشغيل جاي، مهما كان بعيد. المسارات "الميتة"
    // مستبعدة أصلاً (status != dead) فمش هتترجع تتفحص تاني هي كمان.
    // يعني تشغيل الأداة دي كذا مرة على مدار الوقت آمن 100% — هتفحص
    // بس اللي جديد فعلاً (زي مسارات اتضافت بعدين بالإنشاء بالجملة).
    const { data: batch, error: fetchErr } = await supa.from('route_pages')
      .select('id, origin_iata, destination_iata, status')
      .neq('status', 'dead')
      .is('last_health_check_at', null)
      .limit(BATCH_SIZE);
    if (fetchErr) throw new Error(fetchErr.message);

    if (!batch || !batch.length) {
      return res.json({ ok: true, checked: 0, dead: 0, remaining: 0, message: 'كل المسارات اتفحصت بالفعل — مفيش مسارات جديدة محتاجة فحص' });
    }

    const searchDate = new Date();
    searchDate.setDate(searchDate.getDate() + 21);
    const departure_date = searchDate.toISOString().slice(0, 10);

    async function checkOne(route) {
      try {
        // [HEALTH-CHECK-ISOLATION] duffelAttempt مباشرة، مش duffel() —
        // عشان فشل مسار فاضي (طبيعي جداً هنا) مايتسجّلش على الـ
        // circuit breaker المشترك ويوقف الخدمة عن عملاء حقيقيين
        // بيدوروا في نفس اللحظة.
        const result = await duffelAttempt('POST', '/air/offer_requests?return_offers=true', {
          data: {
            slices: [{ origin: route.origin_iata, destination: route.destination_iata, departure_date }],
            passengers: [{ type: 'adult' }],
            cabin_class: 'economy',
          },
        });
        const hasOffers = !!(result.data?.offers && result.data.offers.length);
        return { id: route.id, alive: hasOffers };
      } catch (e) {
        // [FAIL-SAFE] خطأ في الاتصال بـ Duffel (مش "مفيش رحلات" فعلياً)
        // — منسيبش المسار يتعلّم "ميت" بسبب مشكلة شبكة مؤقتة، بنسيبه
        // زي ما هو ونحاول تاني في الدفعة الجاية.
        log('warn', 'health_check_error', { route_id: route.id, error: e.message });
        return { id: route.id, alive: null };
      }
    }

    // [RATE-LIMIT-FIX] كانت 3 متزامنين من غير أي فاصل — ده اللي ضرب
    // Duffel بسرعة كبيرة وشغّل الـ circuit breaker. دلوقتي 2 بس في
    // المرة، مع فاصل نص ثانية بين كل دفعة فرعية — أبطأ شوية بس أأمن
    // بكتير على استقرار الموقع للعملاء الحقيقيين.
    const results = [];
    for (let i = 0; i < batch.length; i += 2) {
      const sub = batch.slice(i, i + 2);
      const subResults = await Promise.all(sub.map(checkOne));
      results.push(...subResults);
      if (i + 2 < batch.length) await new Promise((r) => setTimeout(r, 500));
    }

    let deadCount = 0;
    const now = new Date().toISOString();
    for (const r of results) {
      if (r.alive === null) continue; // خطأ مؤقت — نسيبه من غير تحديث، هيتحاول تاني بعدين
      const update = { last_health_check_at: now };
      if (!r.alive) { update.status = 'dead'; deadCount++; }
      await supa.from('route_pages').update(update).eq('id', r.id);
    }

    const { count: remaining } = await supa.from('route_pages').select('id', { count: 'exact', head: true }).neq('status', 'dead').is('last_health_check_at', null);
    const { count: remainingTotal } = await supa.from('route_pages').select('id', { count: 'exact', head: true }).neq('status', 'dead');

    log('info', 'route_health_check_batch', { checked: results.length, dead: deadCount });
    res.json({ ok: true, checked: results.length, dead: deadCount, remaining: remaining || 0, remainingTotal: remainingTotal || 0 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/route-pages', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { origin_iata, destination_iata, origin_city, destination_city, intro_text, status, origin_lat, origin_lng, destination_lat, destination_lng, origin_country, destination_country, custom_title, custom_meta_description, custom_faq } = req.body;
    if (!origin_iata || !destination_iata || !origin_city || !destination_city) {
      return res.status(400).json({ ok: false, error: 'IATA-Codes und Stadtnamen sind erforderlich' });
    }

    // [DUPLICATE-ROUTE-FIX] Real duplicate check based on the actual
    // identity of a route — the IATA code pair, not the slug (which
    // could be created differently depending on how the city name was
    // typed). Hamburg→London and London→Hamburg are checked separately
    // since they're legitimately different routes (the duplicate is only
    // the SAME direction, same pair). Matches regardless of status
    // (draft or published) — a draft is still a real row occupying that
    // route slot, not a free pass to create a second one.
    const dupOriginIata = origin_iata.toUpperCase();
    const dupDestIata = destination_iata.toUpperCase();
    const { data: dup } = await supa.from('route_pages')
      .select('id, slug, status')
      .eq('origin_iata', dupOriginIata)
      .eq('destination_iata', dupDestIata)
      .maybeSingle();
    if (dup) {
      return res.status(409).json({
        ok: false,
        error: 'هذا المسار موجود فعلاً (' + dupOriginIata + ' → ' + dupDestIata + ') — الحالة: ' + (dup.status === 'published' ? 'منشور' : 'مسودة') + '. عدّله من القائمة بدل إنشاء نسخة جديدة.',
        duplicate: true,
        existing_slug: dup.slug,
      });
    }

    // [ROUTE-PAGES] Reuses the exact same slugify() used for blog posts —
    // same umlaut-transliteration and non-Latin fallback behavior, just
    // seeded from the city names instead of a post title.
    let baseSlug = slugify(origin_city + '-' + destination_city);
    let slug = baseSlug;
    for (let attempt = 2; attempt <= 21; attempt++) {
      const { data: existing } = await supa.from('route_pages').select('id').eq('slug', slug).maybeSingle();
      if (!existing) break;
      slug = baseSlug + '-' + attempt;
    }

    // [ROUTE-PAGES-DISTANCE] Computed once here, server-side, from
    // coordinates the airport autocomplete supplied — never user-entered,
    // never re-guessed later. Left null if coordinates are missing for any
    // reason (rare — only some unusual/private airports lack them in
    // Duffel's data) rather than blocking route creation entirely.
    let distance_km = null, haul_type = null;
    if (origin_lat != null && origin_lng != null && destination_lat != null && destination_lng != null) {
      distance_km = haversineDistanceKm(Number(origin_lat), Number(origin_lng), Number(destination_lat), Number(destination_lng));
      haul_type = classifyHaul(distance_km);
    }

    const isPublishing = status === 'published';
    // [CITY-PAGES] Computed server-side via the same slugify() used for
    // blog/route slugs — never trusts free-text city name matching.
    const originCitySlug = slugify(origin_city);
    const destCitySlug = slugify(destination_city);
    const { data, error } = await supa.from('route_pages').insert({
      slug,
      origin_iata: origin_iata.toUpperCase(),
      destination_iata: destination_iata.toUpperCase(),
      origin_city, destination_city,
      origin_city_slug: originCitySlug,
      destination_city_slug: destCitySlug,
      origin_lat: origin_lat != null ? Number(origin_lat) : null,
      origin_lng: origin_lng != null ? Number(origin_lng) : null,
      destination_lat: destination_lat != null ? Number(destination_lat) : null,
      destination_lng: destination_lng != null ? Number(destination_lng) : null,
      origin_country: origin_country || null,
      destination_country: destination_country || null,
      distance_km, haul_type,
      intro_text: intro_text || null,
      custom_title: custom_title || null,
      custom_meta_description: custom_meta_description || null,
      custom_faq: Array.isArray(custom_faq) && custom_faq.length ? custom_faq : null,
      status: isPublishing ? 'published' : 'draft',
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    // [COUNTRY-PAGES / CITY-PAGES] Only auto-create country/city pages
    // for PUBLISHED routes — a draft isn't publicly visible yet, so its
    // countries/cities shouldn't appear on the public site either.
    if (isPublishing) {
      if (origin_country) ensureCountryExists(origin_country);
      if (destination_country) ensureCountryExists(destination_country);
      ensureCityExists(originCitySlug, origin_city, origin_country, origin_iata.toUpperCase());
      ensureCityExists(destCitySlug, destination_city, destination_country, destination_iata.toUpperCase());
    }
    res.json({ ok: true, route: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/route-pages/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { origin_iata, destination_iata, origin_city, destination_city, intro_text, status, origin_lat, origin_lng, destination_lat, destination_lng, origin_country, destination_country, custom_title, custom_meta_description, custom_faq } = req.body;
    const update = { updated_at: new Date().toISOString() };
    if (origin_iata != null) update.origin_iata = origin_iata.toUpperCase();
    if (destination_iata != null) update.destination_iata = destination_iata.toUpperCase();
    if (origin_city != null) { update.origin_city = origin_city; update.origin_city_slug = slugify(origin_city); }
    if (destination_city != null) { update.destination_city = destination_city; update.destination_city_slug = slugify(destination_city); }
    if (origin_country != null) update.origin_country = origin_country || null;
    if (destination_country != null) update.destination_country = destination_country || null;
    if (intro_text != null) update.intro_text = intro_text;
    if (custom_title != null) update.custom_title = custom_title || null;
    if (custom_meta_description != null) update.custom_meta_description = custom_meta_description || null;
    if (custom_faq != null) update.custom_faq = Array.isArray(custom_faq) && custom_faq.length ? custom_faq : null;
    if (status != null) update.status = status;
    // [ROUTE-PAGES-DISTANCE] Recompute whenever fresh coordinates are
    // supplied (i.e. the admin re-selected an airport while editing) — so
    // editing a route's endpoints never leaves a stale distance/haul_type
    // from whatever the original creation computed.
    if (origin_lat != null && origin_lng != null && destination_lat != null && destination_lng != null) {
      update.origin_lat = Number(origin_lat);
      update.origin_lng = Number(origin_lng);
      update.destination_lat = Number(destination_lat);
      update.destination_lng = Number(destination_lng);
      update.distance_km = haversineDistanceKm(Number(origin_lat), Number(origin_lng), Number(destination_lat), Number(destination_lng));
      update.haul_type = classifyHaul(update.distance_km);
    }
    // Slug is intentionally NOT editable after creation — same reasoning
    // as blog posts: changing it breaks any already-shared/indexed link.
    const { data, error } = await supa.from('route_pages').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw new Error(error.message);
    // [COUNTRY-PAGES / CITY-PAGES] Covers both: editing airports on an
    // already-published route, and the common "save as draft, publish
    // later" flow — country/city data saved at creation time is still
    // on the row, so publishing later still triggers creation correctly.
    if (status === 'published' && data) {
      if (data.origin_country) ensureCountryExists(data.origin_country);
      if (data.destination_country) ensureCountryExists(data.destination_country);
      if (data.origin_city_slug) ensureCityExists(data.origin_city_slug, data.origin_city, data.origin_country, data.origin_iata);
      if (data.destination_city_slug) ensureCityExists(data.destination_city_slug, data.destination_city, data.destination_country, data.destination_iata);
    }
    res.json({ ok: true, route: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// [BULK-PUBLISH] نشر كل المسودات دفعة واحدة — نفس بالظبط اللي بيحصل
// لما تنشر مسار واحد يدوي (تفعيل صفحات الدول والمدن المرتبطة)، بس
// بكفاءة أعلى: كل دولة/مدينة بتتفعّل مرة واحدة بس حتى لو عشرات
// المسارات بتشاركها، مش مرة لكل مسار.
app.post('/admin/route-pages/publish-all-drafts', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });

    const { data: drafts, error: fetchErr } = await supa.from('route_pages')
      .select('id, origin_iata, destination_iata, origin_city, destination_city, origin_city_slug, destination_city_slug, origin_country, destination_country')
      .eq('status', 'draft');
    if (fetchErr) throw new Error(fetchErr.message);
    if (!drafts || !drafts.length) {
      return res.json({ ok: true, published: 0, message: 'مفيش مسودات خالص حالياً' });
    }

    const ids = drafts.map((d) => d.id);
    const { error: updateErr } = await supa.from('route_pages')
      .update({ status: 'published', updated_at: new Date().toISOString() })
      .in('id', ids);
    if (updateErr) throw new Error(updateErr.message);

    // تجميع كل الدول/المدن الفريدة قبل التفعيل — لو 500 مسار كلهم من
    // برلين، برلين بتتفعّل مرة واحدة بس مش 500 مرة.
    const countriesSeen = new Set();
    const citiesSeen = new Set();
    for (const d of drafts) {
      if (d.origin_country && !countriesSeen.has(d.origin_country)) { countriesSeen.add(d.origin_country); ensureCountryExists(d.origin_country); }
      if (d.destination_country && !countriesSeen.has(d.destination_country)) { countriesSeen.add(d.destination_country); ensureCountryExists(d.destination_country); }
      if (d.origin_city_slug && !citiesSeen.has(d.origin_city_slug)) { citiesSeen.add(d.origin_city_slug); ensureCityExists(d.origin_city_slug, d.origin_city, d.origin_country, d.origin_iata); }
      if (d.destination_city_slug && !citiesSeen.has(d.destination_city_slug)) { citiesSeen.add(d.destination_city_slug); ensureCityExists(d.destination_city_slug, d.destination_city, d.destination_country, d.destination_iata); }
    }

    log('info', 'bulk_published_drafts', { count: drafts.length });
    res.json({ ok: true, published: drafts.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/route-pages/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('route_pages').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/error-logs', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    let query = supa.from('error_logs').select('*').order('created_at', { ascending: false }).limit(200);
    if (req.query.level) query = query.eq('level', req.query.level);
    if (req.query.source) query = query.eq('source', req.query.source);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ ok: true, logs: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/error-logs', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('error_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/cancellations', requireAdmin, async (req, res) => {
  try {
    const events = await getAdminConfig('cancellation_events', []);
    let bookingsByOrderId = {};
    if (supa && events.length) {
      const orderIds = events.map((e) => e.order_id).filter(Boolean);
      const { data } = await supa.from('bookings').select('duffel_order_id,booking_reference,route_label,customer_email,customer_name,customer_paid').in('duffel_order_id', orderIds);
      (data || []).forEach((b) => { bookingsByOrderId[b.duffel_order_id] = b; });
    }
    const enriched = events.map((e) => ({ ...e, booking: bookingsByOrderId[e.order_id] || null }));
    res.json({ ok: true, events: enriched, unreadCount: events.filter((e) => !e.read).length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/cancellations/mark-read', requireAdmin, async (req, res) => {
  try {
    await markCancellationsRead();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/booking-failures', requireAdmin, async (req, res) => {
  try {
    const events = await getAdminConfig('booking_failure_events', []);
    res.json({ ok: true, events, unreadCount: events.filter((e) => !e.read).length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/booking-failures/mark-read', requireAdmin, async (req, res) => {
  try {
    await markBookingFailuresRead();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/sync-failures', requireAdmin, async (req, res) => {
  try {
    const events = await getAdminConfig('sync_failure_events', []);
    let bookingsByOrderId = {};
    if (supa && events.length) {
      const orderIds = events.map((e) => e.order_id).filter(Boolean);
      const { data } = await supa.from('bookings').select('duffel_order_id,booking_reference,route_label,customer_email,customer_name,customer_paid,status').in('duffel_order_id', orderIds);
      (data || []).forEach((b) => { bookingsByOrderId[b.duffel_order_id] = b; });
    }
    const enriched = events.map((e) => ({ ...e, booking: bookingsByOrderId[e.order_id] || null }));
    res.json({ ok: true, events: enriched, unreadCount: events.filter((e) => !e.read).length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/sync-failures/mark-read', requireAdmin, async (req, res) => {
  try {
    await markSyncFailuresRead();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/sync-failures/:order_id/resolve', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('bookings').update({ status: 'cancelled' }).eq('duffel_order_id', req.params.order_id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/bookings', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    let query = supa.from('bookings').select('*').order('created_at', { ascending: false }).limit(limit);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ ok: true, bookings: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('bookings').update({ status: 'cancelled' }).eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/profit-tiers', requireAdmin, async (req, res) => {
  try {
    const tiers = await getAdminConfig('ticket_profit_tiers', DEFAULT_TICKET_TIERS);
    res.json({ ok: true, tiers });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/profit-tiers', requireAdmin, async (req, res) => {
  try {
    const tiers = validateTiersPayload(req.body && req.body.tiers);
    await setAdminConfig('ticket_profit_tiers', tiers);
    log('info', 'admin_ticket_tiers_updated', { count: tiers.length });
    res.json({ ok: true, tiers });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});

app.get('/admin/ancillary-margin', requireAdmin, async (req, res) => {
  try {
    const tiers = await getAdminConfig('ancillary_profit_tiers', DEFAULT_ANCILLARY_TIERS);
    res.json({ ok: true, tiers });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/ancillary-margin', requireAdmin, async (req, res) => {
  try {
    const tiers = validateTiersPayload(req.body && req.body.tiers);
    await setAdminConfig('ancillary_profit_tiers', tiers);
    log('info', 'admin_ancillary_tiers_updated', { count: tiers.length });
    res.json({ ok: true, tiers });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});

function validateTiersPayload(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) {
    throw Object.assign(new Error('tiers muss ein nicht-leeres Array sein'), { status: 400 });
  }
  return tiers.map((t, i) => {
    const from = Number(t.from);
    const to = (t.to === null || t.to === undefined || t.to === '') ? null : Number(t.to);
    const pct = Number(t.pct);
    const fixed = Number(t.fixed);
    if (!Number.isFinite(from) || from < 0) throw Object.assign(new Error(`Tier ${i + 1}: "von" ungültig`), { status: 400 });
    if (to !== null && (!Number.isFinite(to) || to <= from)) throw Object.assign(new Error(`Tier ${i + 1}: "bis" muss größer als "von" sein`), { status: 400 });
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw Object.assign(new Error(`Tier ${i + 1}: Prozentsatz muss zwischen 0 und 100 liegen`), { status: 400 });
    if (!Number.isFinite(fixed) || fixed < 0) throw Object.assign(new Error(`Tier ${i + 1}: Fixbetrag ungültig`), { status: 400 });
    return { from, to, pct, fixed };
  });
}

app.get('/admin/promos', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('promo_codes').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, promos: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/promos/usage-log', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { data, error } = await supa.from('bookings')
      .select('booking_reference, promo_code, discount_amount, customer_email, created_at')
      .not('promo_code', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    res.json({ ok: true, usage: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/promos', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { code, type, value, max_uses, expires_at } = req.body || {};
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return res.status(400).json({ ok: false, error: 'Code erforderlich' });
    if (!['percent', 'fixed'].includes(type)) return res.status(400).json({ ok: false, error: 'type muss "percent" oder "fixed" sein' });
    const numValue = Number(value);
    if (!Number.isFinite(numValue) || numValue <= 0) return res.status(400).json({ ok: false, error: 'value ungültig' });
    if (type === 'percent' && numValue > 100) return res.status(400).json({ ok: false, error: 'Prozentsatz darf 100 nicht überschreiten' });
    const { data, error } = await supa.from('promo_codes').insert({
      code: normalized, type, value: numValue,
      max_uses: max_uses != null && max_uses !== '' ? Number(max_uses) : null,
      expires_at: expires_at || null,
      active: true,
    }).select().maybeSingle();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ ok: false, error: 'Dieser Code existiert bereits' });
      throw new Error(error.message);
    }
    log('info', 'admin_promo_created', { code: normalized });
    res.json({ ok: true, promo: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/promos/:id/toggle', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: row } = await supa.from('promo_codes').select('active').eq('id', req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ ok: false, error: 'Code nicht gefunden' });
    const { error } = await supa.from('promo_codes').update({ active: !row.active }).eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true, active: !row.active });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/promos/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('promo_codes').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/invoice-config', requireAdmin, async (req, res) => {
  try {
    const cfg = await getAdminConfig('invoice_config', DEFAULT_INVOICE_CONFIG);
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/invoice-config', requireAdmin, async (req, res) => {
  try {
    const incoming = req.body || {};
    const cfg = {
      prefix: String(incoming.prefix || DEFAULT_INVOICE_CONFIG.prefix).slice(0, 20),
      nextNumber: Number.isFinite(Number(incoming.nextNumber)) ? Math.max(1, parseInt(incoming.nextNumber, 10)) : DEFAULT_INVOICE_CONFIG.nextNumber,
      companyName: String(incoming.companyName || '').slice(0, 200),
      companyAddress: String(incoming.companyAddress || '').slice(0, 500),
      steuernummer: String(incoming.steuernummer || '').slice(0, 50),
      taxMode: ['kleinunternehmer', 'regular'].includes(incoming.taxMode) ? incoming.taxMode : DEFAULT_INVOICE_CONFIG.taxMode,
    };
    await setAdminConfig('invoice_config', cfg);
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/invoices/issue', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { booking_id, booking_reference, customer_name, customer_address, amount, currency, fields } = req.body || {};
    if (!customer_name) return res.status(400).json({ ok: false, error: 'customer_name erforderlich' });
    const cfg = await getAdminConfig('invoice_config', DEFAULT_INVOICE_CONFIG);
    const { data, error } = await supa.rpc('issue_invoice', {
      p_prefix: cfg.prefix || 'AIRPIV',
      p_booking_id: booking_id || null,
      p_booking_reference: booking_reference || null,
      p_customer_name: customer_name,
      p_customer_address: customer_address || '',
      p_amount: Number(amount) || 0,
      p_currency: currency || 'EUR',
      p_fields: fields || {},
    });
    if (error) throw new Error(error.message);
    log('info', 'admin_invoice_issued', { invoice_number: data.invoice_number });
    res.json({ ok: true, invoice: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/invoices', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const { data, error } = await supa.from('invoices').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    res.json({ ok: true, invoices: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/invoices/:invoiceNumber', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('invoices').select('*').eq('invoice_number', req.params.invoiceNumber).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Rechnung nicht gefunden' });
    res.json({ ok: true, invoice: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/loyalty-config', requireAdmin, async (req, res) => {
  try {
    const cfg = await getLoyaltyConfig();
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/loyalty-config', requireAdmin, async (req, res) => {
  try {
    const incoming = req.body || {};
    const welcomeCreditEur = Number(incoming.welcomeCreditEur);
    const welcomePoints = Number(incoming.welcomePoints);
    const pointsPerEuro = Number(incoming.pointsPerEuro);
    const maxCreditPerBooking = Number(incoming.maxCreditPerBooking);
    if (!Number.isFinite(welcomeCreditEur) || welcomeCreditEur < 0) return res.status(400).json({ ok: false, error: 'welcomeCreditEur ungültig' });
    if (!Number.isFinite(welcomePoints) || welcomePoints < 0) return res.status(400).json({ ok: false, error: 'welcomePoints ungültig' });
    if (!Number.isFinite(pointsPerEuro) || pointsPerEuro < 0) return res.status(400).json({ ok: false, error: 'pointsPerEuro ungültig' });
    if (!Number.isFinite(maxCreditPerBooking) || maxCreditPerBooking < 0) return res.status(400).json({ ok: false, error: 'maxCreditPerBooking ungültig' });
    // Reuse the same tier validator as profit tiers, but tiers here use
    // `creditEur` instead of `pct`/`fixed` — validate shape separately.
    const tiersIn = incoming.tiers;
    if (!Array.isArray(tiersIn) || !tiersIn.length) return res.status(400).json({ ok: false, error: 'tiers muss ein nicht-leeres Array sein' });
    const tiers = tiersIn.map((t, i) => {
      const from = Number(t.from);
      const to = (t.to === null || t.to === undefined || t.to === '') ? null : Number(t.to);
      const creditEur = Number(t.creditEur);
      if (!Number.isFinite(from) || from < 0) throw Object.assign(new Error(`Tier ${i + 1}: "von" ungültig`), { status: 400 });
      if (to !== null && (!Number.isFinite(to) || to <= from)) throw Object.assign(new Error(`Tier ${i + 1}: "bis" muss größer als "von" sein`), { status: 400 });
      if (!Number.isFinite(creditEur) || creditEur < 0) throw Object.assign(new Error(`Tier ${i + 1}: Guthaben ungültig`), { status: 400 });
      return { from, to, creditEur };
    });
    const cfg = { welcomeCreditEur, welcomePoints, pointsPerEuro, maxCreditPerBooking, tiers };
    await setAdminConfig('loyalty_config', cfg);
    log('info', 'admin_loyalty_config_updated', {});
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/pricing-preview', requireAdmin, async (req, res) => {
  try {
    const price = Number(req.query.price) || 0;
    const kind = req.query.kind === 'ancillary' ? 'ancillary' : 'ticket';
    const tiers = kind === 'ancillary' ? await getAncillaryProfitTiers() : await getTicketProfitTiers();
    const margin = computeTieredMargin(price, tiers);
    res.json({ ok: true, price, margin, total: Math.round((price + margin) * 100) / 100 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
};
