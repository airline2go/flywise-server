-- ═══════════════════════════════════════════════════════════════
-- [DEAD-ROUTES] إضافة حالة "ميتة" (dead) لجدول المسارات — لمسارات
-- اتفحصت فعلياً ولقينا مفيش رحلات حقيقية عليها من Duffel (مختلفة
-- عن "مسودة" اللي معناها "لسه ما اتراجعتش"، دي معناها "اتفحصت
-- وأكدنا إنها فاضية"). القيد الحالي كان بيسمح بـ draft/published
-- بس، فأي محاولة نضيف dead كانت هترفض من قاعدة البيانات نفسها.
-- ═══════════════════════════════════════════════════════════════

do $$
begin
  -- شيل القيد القديم لو موجود (اسمه المولّد تلقائياً)
  if exists (select 1 from pg_constraint where conname = 'route_pages_status_check') then
    alter table route_pages drop constraint route_pages_status_check;
  end if;
  -- ضيف القيد الجديد بالقيمة التالتة
  alter table route_pages
    add constraint route_pages_status_check
    check (status in ('draft', 'published', 'dead'));
end $$;

-- [PERFORMANCE] فهرس على الحالة — هيتفحص بكثرة أثناء أداة الفحص
-- الصحي (فلترة المسارات اللي لسه ما اتفحصتش)
create index if not exists route_pages_status_idx on route_pages (status);

-- [HEALTH-CHECK] وقت آخر فحص حقيقي حصل للمسار ده — عشان أداة الفحص
-- تقدر تبدأ من الأقدم (أو اللي لسه ما اتفحصش خالص، NULL)، مش تعيد
-- فحص نفس المسارات كل مرة من الأول.
alter table route_pages add column if not exists last_health_check_at timestamptz;
create index if not exists route_pages_health_check_idx on route_pages (last_health_check_at);
