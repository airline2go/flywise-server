-- ════════════════════════════════════════════════════════════
-- AIRPIV — Geo CMS: multi-language city/country/airport names
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: `cities`/`countries` already exist (auto-created on-demand
-- via ensureCityExists()/ensureCountryExists() in
-- src/services/routePages.js whenever a route page is published) but
-- each only carries ONE non-localized `name` column. There is no
-- `airports` table at all — GET /airports/:code today improvises
-- airport data live from whichever route_pages row happens to mention
-- that IATA code first. This migration adds:
--   1. `airports` — a real, authoritative table (Airport-Identity-First:
--      IATA code -> airport row -> city -> country, not the other way
--      round).
--   2. `city_translations` / `country_translations` / `airport_translations`
--      — one row per (entity, language), covering all 7 platform
--      languages (en, de, ar, es, fr, it, nl).
-- Once this is applied, `build/data.js`'s hardcoded
-- GERMAN_CITY_NAMES/ENGLISH_CITY_NAMES/ENGLISH_COUNTRY_NAMES
-- dictionaries are retired — the database becomes the single source of
-- truth, editable from the new admin "Airports & Cities" page.
-- ════════════════════════════════════════════════════════════

-- ─── airports ────────────────────────────────────────────────
create table if not exists airports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  iata_code text unique not null,
  icao_code text,
  airport_name text not null,                    -- administrative label, not per-language (see airport_translations for display names)
  city_id uuid references cities(id) on delete set null,
  country_code text references countries(code),
  latitude numeric,
  longitude numeric,
  status text not null default 'published' check (status in ('draft','published'))
);
create index if not exists airports_city_idx on airports (city_id);
create index if not exists airports_country_idx on airports (country_code);
create index if not exists airports_status_idx on airports (status);

alter table airports enable row level security;
drop policy if exists "Public can read published airports" on airports;
create policy "Public can read published airports"
  on airports for select
  using (status = 'published');

-- ─── city_translations ───────────────────────────────────────
create table if not exists city_translations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  city_id uuid not null references cities(id) on delete cascade,
  language text not null check (language in ('en','de','ar','es','fr','it','nl')),
  name text not null,
  unique (city_id, language)
);
create index if not exists city_translations_city_idx on city_translations (city_id);

alter table city_translations enable row level security;
drop policy if exists "Public can read city translations" on city_translations;
create policy "Public can read city translations"
  on city_translations for select
  using (true);
-- No public write policy — server-only writes via the service-role
-- client, same convention as admin_activity_log/error_logs.

-- ─── country_translations ────────────────────────────────────
create table if not exists country_translations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  country_code text not null references countries(code) on delete cascade,
  language text not null check (language in ('en','de','ar','es','fr','it','nl')),
  name text not null,
  unique (country_code, language)
);
create index if not exists country_translations_country_idx on country_translations (country_code);

alter table country_translations enable row level security;
drop policy if exists "Public can read country translations" on country_translations;
create policy "Public can read country translations"
  on country_translations for select
  using (true);

-- ─── airport_translations ────────────────────────────────────
-- Airport *names* are translated too (e.g. "Munich Airport" /
-- "Flughafen München" / "مطار ميونخ") — same shape as city/country
-- translations, kept as its own table rather than columns on
-- `airports` for the same reason city/country names are.
create table if not exists airport_translations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  airport_id uuid not null references airports(id) on delete cascade,
  language text not null check (language in ('en','de','ar','es','fr','it','nl')),
  name text not null,
  unique (airport_id, language)
);
create index if not exists airport_translations_airport_idx on airport_translations (airport_id);

alter table airport_translations enable row level security;
drop policy if exists "Public can read airport translations" on airport_translations;
create policy "Public can read airport translations"
  on airport_translations for select
  using (true);

-- ════════════════════════════════════════════════════════════
-- BACKFILL — must run EXACTLY ONCE, ever (marker-row pattern, same as
-- route_refresh_tier.sql's backfill), so re-running this file later
-- (or an admin deliberately clearing a translation back to look "empty")
-- never silently re-clobbers a real edit.
--
-- Step 1 (always reliable): seed the 'de' translation for every
-- existing city/country from its own `name` column — that column has
-- always held the German display name on this German-market platform,
-- so this is a direct, guess-free copy.
--
-- Step 2 (best-effort): seed 'en'/'ar'/'es'/'fr'/'it'/'nl' for the
-- specific set of ~62 cities / 32 countries already known today from
-- flywise-app's build/data.js dictionaries, matched by city_slug /
-- country code. This is a genuine, hand-authored translation pass (not
-- machine-literal), but it can only cover cities/countries that exist
-- in the database AND match one of these known slugs — any city/country
-- auto-created later from a new route (or one whose stored city_slug
-- doesn't match the guessed slug here) simply won't get a Step 2 seed;
-- it still works fine, falling back to German/English via the
-- application's normal translation fallback chain until filled in via
-- the new "Airports & Cities" admin page. `on conflict do nothing`
-- makes every one of these inserts a safe no-op if the row doesn't
-- exist or was already seeded.
-- ════════════════════════════════════════════════════════════
do $$
begin
  if not exists (select 1 from admin_config where key = 'geo_i18n_backfill_done') then

    insert into city_translations (city_id, language, name)
    select id, 'de', name from cities
    on conflict (city_id, language) do nothing;

    insert into country_translations (country_code, language, name)
    select code, 'de', name from countries
    on conflict (country_code, language) do nothing;

    insert into city_translations (city_id, language, name)
    select c.id, v.language, v.name
    from (values
      ('berlin','en','Berlin'), ('berlin','ar','برلين'), ('berlin','es','Berlín'), ('berlin','fr','Berlin'), ('berlin','it','Berlino'), ('berlin','nl','Berlijn'),
      ('muenchen','en','Munich'), ('muenchen','ar','ميونخ'), ('muenchen','es','Múnich'), ('muenchen','fr','Munich'), ('muenchen','it','Monaco di Baviera'), ('muenchen','nl','München'),
      ('frankfurt','en','Frankfurt'), ('frankfurt','ar','فرانكفورت'), ('frankfurt','es','Fráncfort'), ('frankfurt','fr','Francfort'), ('frankfurt','it','Francoforte'), ('frankfurt','nl','Frankfurt'),
      ('hamburg','en','Hamburg'), ('hamburg','ar','هامبورغ'), ('hamburg','es','Hamburgo'), ('hamburg','fr','Hambourg'), ('hamburg','it','Amburgo'), ('hamburg','nl','Hamburg'),
      ('duesseldorf','en','Dusseldorf'), ('duesseldorf','ar','دوسلدورف'), ('duesseldorf','es','Düsseldorf'), ('duesseldorf','fr','Düsseldorf'), ('duesseldorf','it','Düsseldorf'), ('duesseldorf','nl','Düsseldorf'),
      ('koeln','en','Cologne'), ('koeln','ar','كولونيا'), ('koeln','es','Colonia'), ('koeln','fr','Cologne'), ('koeln','it','Colonia'), ('koeln','nl','Keulen'),
      ('stuttgart','en','Stuttgart'), ('stuttgart','ar','شتوتغارت'), ('stuttgart','es','Stuttgart'), ('stuttgart','fr','Stuttgart'), ('stuttgart','it','Stoccarda'), ('stuttgart','nl','Stuttgart'),
      ('hannover','en','Hanover'), ('hannover','ar','هانوفر'), ('hannover','es','Hannover'), ('hannover','fr','Hanovre'), ('hannover','it','Hannover'), ('hannover','nl','Hannover'),
      ('leipzig','en','Leipzig'), ('leipzig','ar','لايبزيغ'), ('leipzig','es','Leipzig'), ('leipzig','fr','Leipzig'), ('leipzig','it','Lipsia'), ('leipzig','nl','Leipzig'),
      ('nuernberg','en','Nuremberg'), ('nuernberg','ar','نورمبرغ'), ('nuernberg','es','Núremberg'), ('nuernberg','fr','Nuremberg'), ('nuernberg','it','Norimberga'), ('nuernberg','nl','Neurenberg'),
      ('dortmund','en','Dortmund'), ('dortmund','ar','دورتموند'), ('dortmund','es','Dortmund'), ('dortmund','fr','Dortmund'), ('dortmund','it','Dortmund'), ('dortmund','nl','Dortmund'),
      ('bremen','en','Bremen'), ('bremen','ar','بريمن'), ('bremen','es','Bremen'), ('bremen','fr','Brême'), ('bremen','it','Brema'), ('bremen','nl','Bremen'),
      ('wien','en','Vienna'), ('wien','ar','فيينا'), ('wien','es','Viena'), ('wien','fr','Vienne'), ('wien','it','Vienna'), ('wien','nl','Wenen'),
      ('zuerich','en','Zurich'), ('zuerich','ar','زيورخ'), ('zuerich','es','Zúrich'), ('zuerich','fr','Zurich'), ('zuerich','it','Zurigo'), ('zuerich','nl','Zürich'),
      ('genf','en','Geneva'), ('genf','ar','جنيف'), ('genf','es','Ginebra'), ('genf','fr','Genève'), ('genf','it','Ginevra'), ('genf','nl','Genève'),
      ('london','en','London'), ('london','ar','لندن'), ('london','es','Londres'), ('london','fr','Londres'), ('london','it','Londra'), ('london','nl','Londen'),
      ('paris','en','Paris'), ('paris','ar','باريس'), ('paris','es','París'), ('paris','fr','Paris'), ('paris','it','Parigi'), ('paris','nl','Parijs'),
      ('rom','en','Rome'), ('rom','ar','روما'), ('rom','es','Roma'), ('rom','fr','Rome'), ('rom','it','Roma'), ('rom','nl','Rome'),
      ('mailand','en','Milan'), ('mailand','ar','ميلانو'), ('mailand','es','Milán'), ('mailand','fr','Milan'), ('mailand','it','Milano'), ('mailand','nl','Milaan'),
      ('venedig','en','Venice'), ('venedig','ar','البندقية'), ('venedig','es','Venecia'), ('venedig','fr','Venise'), ('venedig','it','Venezia'), ('venedig','nl','Venetië'),
      ('neapel','en','Naples'), ('neapel','ar','نابولي'), ('neapel','es','Nápoles'), ('neapel','fr','Naples'), ('neapel','it','Napoli'), ('neapel','nl','Napels'),
      ('madrid','en','Madrid'), ('madrid','ar','مدريد'), ('madrid','es','Madrid'), ('madrid','fr','Madrid'), ('madrid','it','Madrid'), ('madrid','nl','Madrid'),
      ('barcelona','en','Barcelona'), ('barcelona','ar','برشلونة'), ('barcelona','es','Barcelona'), ('barcelona','fr','Barcelone'), ('barcelona','it','Barcellona'), ('barcelona','nl','Barcelona'),
      ('valencia','en','Valencia'), ('valencia','ar','فالنسيا'), ('valencia','es','Valencia'), ('valencia','fr','Valence'), ('valencia','it','Valencia'), ('valencia','nl','Valencia'),
      ('sevilla','en','Seville'), ('sevilla','ar','إشبيلية'), ('sevilla','es','Sevilla'), ('sevilla','fr','Séville'), ('sevilla','it','Siviglia'), ('sevilla','nl','Sevilla'),
      ('malaga','en','Malaga'), ('malaga','ar','ملقة'), ('malaga','es','Málaga'), ('malaga','fr','Malaga'), ('malaga','it','Málaga'), ('malaga','nl','Málaga'),
      ('lissabon','en','Lisbon'), ('lissabon','ar','لشبونة'), ('lissabon','es','Lisboa'), ('lissabon','fr','Lisbonne'), ('lissabon','it','Lisbona'), ('lissabon','nl','Lissabon'),
      ('porto','en','Porto'), ('porto','ar','بورتو'), ('porto','es','Oporto'), ('porto','fr','Porto'), ('porto','it','Porto'), ('porto','nl','Porto'),
      ('amsterdam','en','Amsterdam'), ('amsterdam','ar','أمستردام'), ('amsterdam','es','Ámsterdam'), ('amsterdam','fr','Amsterdam'), ('amsterdam','it','Amsterdam'), ('amsterdam','nl','Amsterdam'),
      ('bruessel','en','Brussels'), ('bruessel','ar','بروكسل'), ('bruessel','es','Bruselas'), ('bruessel','fr','Bruxelles'), ('bruessel','it','Bruxelles'), ('bruessel','nl','Brussel'),
      ('luxemburg','en','Luxembourg'), ('luxemburg','ar','لوكسمبورغ'), ('luxemburg','es','Luxemburgo'), ('luxemburg','fr','Luxembourg'), ('luxemburg','it','Lussemburgo'), ('luxemburg','nl','Luxemburg'),
      ('kopenhagen','en','Copenhagen'), ('kopenhagen','ar','كوبنهاغن'), ('kopenhagen','es','Copenhague'), ('kopenhagen','fr','Copenhague'), ('kopenhagen','it','Copenaghen'), ('kopenhagen','nl','Kopenhagen'),
      ('oslo','en','Oslo'), ('oslo','ar','أوسلو'), ('oslo','es','Oslo'), ('oslo','fr','Oslo'), ('oslo','it','Oslo'), ('oslo','nl','Oslo'),
      ('stockholm','en','Stockholm'), ('stockholm','ar','ستوكهولم'), ('stockholm','es','Estocolmo'), ('stockholm','fr','Stockholm'), ('stockholm','it','Stoccolma'), ('stockholm','nl','Stockholm'),
      ('helsinki','en','Helsinki'), ('helsinki','ar','هلسنكي'), ('helsinki','es','Helsinki'), ('helsinki','fr','Helsinki'), ('helsinki','it','Helsinki'), ('helsinki','nl','Helsinki'),
      ('dublin','en','Dublin'), ('dublin','ar','دبلن'), ('dublin','es','Dublín'), ('dublin','fr','Dublin'), ('dublin','it','Dublino'), ('dublin','nl','Dublin'),
      ('warschau','en','Warsaw'), ('warschau','ar','وارسو'), ('warschau','es','Varsovia'), ('warschau','fr','Varsovie'), ('warschau','it','Varsavia'), ('warschau','nl','Warschau'),
      ('krakau','en','Krakow'), ('krakau','ar','كراكوف'), ('krakau','es','Cracovia'), ('krakau','fr','Cracovie'), ('krakau','it','Cracovia'), ('krakau','nl','Krakau'),
      ('prag','en','Prague'), ('prag','ar','براغ'), ('prag','es','Praga'), ('prag','fr','Prague'), ('prag','it','Praga'), ('prag','nl','Praag'),
      ('budapest','en','Budapest'), ('budapest','ar','بودابست'), ('budapest','es','Budapest'), ('budapest','fr','Budapest'), ('budapest','it','Budapest'), ('budapest','nl','Boedapest'),
      ('athen','en','Athens'), ('athen','ar','أثينا'), ('athen','es','Atenas'), ('athen','fr','Athènes'), ('athen','it','Atene'), ('athen','nl','Athene'),
      ('istanbul','en','Istanbul'), ('istanbul','ar','إسطنبول'), ('istanbul','es','Estambul'), ('istanbul','fr','Istanbul'), ('istanbul','it','Istanbul'), ('istanbul','nl','Istanbul'),
      ('kairo','en','Cairo'), ('kairo','ar','القاهرة'), ('kairo','es','El Cairo'), ('kairo','fr','Le Caire'), ('kairo','it','Il Cairo'), ('kairo','nl','Caïro'),
      ('dubai','en','Dubai'), ('dubai','ar','دبي'), ('dubai','es','Dubái'), ('dubai','fr','Dubaï'), ('dubai','it','Dubai'), ('dubai','nl','Dubai'),
      ('doha','en','Doha'), ('doha','ar','الدوحة'), ('doha','es','Doha'), ('doha','fr','Doha'), ('doha','it','Doha'), ('doha','nl','Doha'),
      ('bangkok','en','Bangkok'), ('bangkok','ar','بانكوك'), ('bangkok','es','Bangkok'), ('bangkok','fr','Bangkok'), ('bangkok','it','Bangkok'), ('bangkok','nl','Bangkok'),
      ('singapur','en','Singapore'), ('singapur','ar','سنغافورة'), ('singapur','es','Singapur'), ('singapur','fr','Singapour'), ('singapur','it','Singapore'), ('singapur','nl','Singapore'),
      ('hongkong','en','Hong Kong'), ('hongkong','ar','هونغ كونغ'), ('hongkong','es','Hong Kong'), ('hongkong','fr','Hong Kong'), ('hongkong','it','Hong Kong'), ('hongkong','nl','Hongkong'),
      ('tokio','en','Tokyo'), ('tokio','ar','طوكيو'), ('tokio','es','Tokio'), ('tokio','fr','Tokyo'), ('tokio','it','Tokyo'), ('tokio','nl','Tokio'),
      ('new-york','en','New York'), ('new-york','ar','نيويورك'), ('new-york','es','Nueva York'), ('new-york','fr','New York'), ('new-york','it','New York'), ('new-york','nl','New York'),
      ('los-angeles','en','Los Angeles'), ('los-angeles','ar','لوس أنجلوس'), ('los-angeles','es','Los Ángeles'), ('los-angeles','fr','Los Angeles'), ('los-angeles','it','Los Angeles'), ('los-angeles','nl','Los Angeles'),
      ('san-francisco','en','San Francisco'), ('san-francisco','ar','سان فرانسيسكو'), ('san-francisco','es','San Francisco'), ('san-francisco','fr','San Francisco'), ('san-francisco','it','San Francisco'), ('san-francisco','nl','San Francisco'),
      ('miami','en','Miami'), ('miami','ar','ميامي'), ('miami','es','Miami'), ('miami','fr','Miami'), ('miami','it','Miami'), ('miami','nl','Miami'),
      ('toronto','en','Toronto'), ('toronto','ar','تورونتو'), ('toronto','es','Toronto'), ('toronto','fr','Toronto'), ('toronto','it','Toronto'), ('toronto','nl','Toronto'),
      ('sao-paulo','en','São Paulo'), ('sao-paulo','ar','ساو باولو'), ('sao-paulo','es','São Paulo'), ('sao-paulo','fr','São Paulo'), ('sao-paulo','it','San Paolo'), ('sao-paulo','nl','São Paulo'),
      ('kapstadt','en','Cape Town'), ('kapstadt','ar','كيب تاون'), ('kapstadt','es','Ciudad del Cabo'), ('kapstadt','fr','Le Cap'), ('kapstadt','it','Città del Capo'), ('kapstadt','nl','Kaapstad'),
      ('johannesburg','en','Johannesburg'), ('johannesburg','ar','جوهانسبرغ'), ('johannesburg','es','Johannesburgo'), ('johannesburg','fr','Johannesburg'), ('johannesburg','it','Johannesburg'), ('johannesburg','nl','Johannesburg'),
      ('sydney','en','Sydney'), ('sydney','ar','سيدني'), ('sydney','es','Sídney'), ('sydney','fr','Sydney'), ('sydney','it','Sydney'), ('sydney','nl','Sydney'),
      ('melbourne','en','Melbourne'), ('melbourne','ar','ملبورن'), ('melbourne','es','Melbourne'), ('melbourne','fr','Melbourne'), ('melbourne','it','Melbourne'), ('melbourne','nl','Melbourne'),
      ('dubrovnik','en','Dubrovnik'), ('dubrovnik','ar','دوبروفنيك'), ('dubrovnik','es','Dubrovnik'), ('dubrovnik','fr','Dubrovnik'), ('dubrovnik','it','Dubrovnik'), ('dubrovnik','nl','Dubrovnik'),
      ('split','en','Split'), ('split','ar','سبليت'), ('split','es','Split'), ('split','fr','Split'), ('split','it','Spalato'), ('split','nl','Split'),
      ('zagreb','en','Zagreb'), ('zagreb','ar','زغرب'), ('zagreb','es','Zagreb'), ('zagreb','fr','Zagreb'), ('zagreb','it','Zagabria'), ('zagreb','nl','Zagreb')
    ) as v(slug, language, name)
    join cities c on c.city_slug = v.slug
    on conflict (city_id, language) do nothing;

    insert into country_translations (country_code, language, name)
    select v.code, v.language, v.name
    from (values
      ('DE','en','Germany'), ('DE','ar','ألمانيا'), ('DE','es','Alemania'), ('DE','fr','Allemagne'), ('DE','it','Germania'), ('DE','nl','Duitsland'),
      ('AT','en','Austria'), ('AT','ar','النمسا'), ('AT','es','Austria'), ('AT','fr','Autriche'), ('AT','it','Austria'), ('AT','nl','Oostenrijk'),
      ('CH','en','Switzerland'), ('CH','ar','سويسرا'), ('CH','es','Suiza'), ('CH','fr','Suisse'), ('CH','it','Svizzera'), ('CH','nl','Zwitserland'),
      ('GB','en','United Kingdom'), ('GB','ar','المملكة المتحدة'), ('GB','es','Reino Unido'), ('GB','fr','Royaume-Uni'), ('GB','it','Regno Unito'), ('GB','nl','Verenigd Koninkrijk'),
      ('FR','en','France'), ('FR','ar','فرنسا'), ('FR','es','Francia'), ('FR','fr','France'), ('FR','it','Francia'), ('FR','nl','Frankrijk'),
      ('IT','en','Italy'), ('IT','ar','إيطاليا'), ('IT','es','Italia'), ('IT','fr','Italie'), ('IT','it','Italia'), ('IT','nl','Italië'),
      ('ES','en','Spain'), ('ES','ar','إسبانيا'), ('ES','es','España'), ('ES','fr','Espagne'), ('ES','it','Spagna'), ('ES','nl','Spanje'),
      ('PT','en','Portugal'), ('PT','ar','البرتغال'), ('PT','es','Portugal'), ('PT','fr','Portugal'), ('PT','it','Portogallo'), ('PT','nl','Portugal'),
      ('NL','en','Netherlands'), ('NL','ar','هولندا'), ('NL','es','Países Bajos'), ('NL','fr','Pays-Bas'), ('NL','it','Paesi Bassi'), ('NL','nl','Nederland'),
      ('BE','en','Belgium'), ('BE','ar','بلجيكا'), ('BE','es','Bélgica'), ('BE','fr','Belgique'), ('BE','it','Belgio'), ('BE','nl','België'),
      ('LU','en','Luxembourg'), ('LU','ar','لوكسمبورغ'), ('LU','es','Luxemburgo'), ('LU','fr','Luxembourg'), ('LU','it','Lussemburgo'), ('LU','nl','Luxemburg'),
      ('DK','en','Denmark'), ('DK','ar','الدنمارك'), ('DK','es','Dinamarca'), ('DK','fr','Danemark'), ('DK','it','Danimarca'), ('DK','nl','Denemarken'),
      ('NO','en','Norway'), ('NO','ar','النرويج'), ('NO','es','Noruega'), ('NO','fr','Norvège'), ('NO','it','Norvegia'), ('NO','nl','Noorwegen'),
      ('SE','en','Sweden'), ('SE','ar','السويد'), ('SE','es','Suecia'), ('SE','fr','Suède'), ('SE','it','Svezia'), ('SE','nl','Zweden'),
      ('FI','en','Finland'), ('FI','ar','فنلندا'), ('FI','es','Finlandia'), ('FI','fr','Finlande'), ('FI','it','Finlandia'), ('FI','nl','Finland'),
      ('IE','en','Ireland'), ('IE','ar','أيرلندا'), ('IE','es','Irlanda'), ('IE','fr','Irlande'), ('IE','it','Irlanda'), ('IE','nl','Ierland'),
      ('PL','en','Poland'), ('PL','ar','بولندا'), ('PL','es','Polonia'), ('PL','fr','Pologne'), ('PL','it','Polonia'), ('PL','nl','Polen'),
      ('CZ','en','Czech Republic'), ('CZ','ar','التشيك'), ('CZ','es','República Checa'), ('CZ','fr','République tchèque'), ('CZ','it','Repubblica Ceca'), ('CZ','nl','Tsjechië'),
      ('HU','en','Hungary'), ('HU','ar','المجر'), ('HU','es','Hungría'), ('HU','fr','Hongrie'), ('HU','it','Ungheria'), ('HU','nl','Hongarije'),
      ('GR','en','Greece'), ('GR','ar','اليونان'), ('GR','es','Grecia'), ('GR','fr','Grèce'), ('GR','it','Grecia'), ('GR','nl','Griekenland'),
      ('TR','en','Turkey'), ('TR','ar','تركيا'), ('TR','es','Turquía'), ('TR','fr','Turquie'), ('TR','it','Turchia'), ('TR','nl','Turkije'),
      ('EG','en','Egypt'), ('EG','ar','مصر'), ('EG','es','Egipto'), ('EG','fr','Égypte'), ('EG','it','Egitto'), ('EG','nl','Egypte'),
      ('AE','en','United Arab Emirates'), ('AE','ar','الإمارات العربية المتحدة'), ('AE','es','Emiratos Árabes Unidos'), ('AE','fr','Émirats arabes unis'), ('AE','it','Emirati Arabi Uniti'), ('AE','nl','Verenigde Arabische Emiraten'),
      ('QA','en','Qatar'), ('QA','ar','قطر'), ('QA','es','Catar'), ('QA','fr','Qatar'), ('QA','it','Qatar'), ('QA','nl','Qatar'),
      ('TH','en','Thailand'), ('TH','ar','تايلاند'), ('TH','es','Tailandia'), ('TH','fr','Thaïlande'), ('TH','it','Tailandia'), ('TH','nl','Thailand'),
      ('SG','en','Singapore'), ('SG','ar','سنغافورة'), ('SG','es','Singapur'), ('SG','fr','Singapour'), ('SG','it','Singapore'), ('SG','nl','Singapore'),
      ('HK','en','Hong Kong'), ('HK','ar','هونغ كونغ'), ('HK','es','Hong Kong'), ('HK','fr','Hong Kong'), ('HK','it','Hong Kong'), ('HK','nl','Hongkong'),
      ('JP','en','Japan'), ('JP','ar','اليابان'), ('JP','es','Japón'), ('JP','fr','Japon'), ('JP','it','Giappone'), ('JP','nl','Japan'),
      ('US','en','United States'), ('US','ar','الولايات المتحدة'), ('US','es','Estados Unidos'), ('US','fr','États-Unis'), ('US','it','Stati Uniti'), ('US','nl','Verenigde Staten'),
      ('CA','en','Canada'), ('CA','ar','كندا'), ('CA','es','Canadá'), ('CA','fr','Canada'), ('CA','it','Canada'), ('CA','nl','Canada'),
      ('BR','en','Brazil'), ('BR','ar','البرازيل'), ('BR','es','Brasil'), ('BR','fr','Brésil'), ('BR','it','Brasile'), ('BR','nl','Brazilië'),
      ('ZA','en','South Africa'), ('ZA','ar','جنوب أفريقيا'), ('ZA','es','Sudáfrica'), ('ZA','fr','Afrique du Sud'), ('ZA','it','Sudafrica'), ('ZA','nl','Zuid-Afrika'),
      ('AU','en','Australia'), ('AU','ar','أستراليا'), ('AU','es','Australia'), ('AU','fr','Australie'), ('AU','it','Australia'), ('AU','nl','Australië'),
      ('HR','en','Croatia'), ('HR','ar','كرواتيا'), ('HR','es','Croacia'), ('HR','fr','Croatie'), ('HR','it','Croazia'), ('HR','nl','Kroatië')
    ) as v(code, language, name)
    join countries co on co.code = v.code
    on conflict (country_code, language) do nothing;

    insert into admin_config (key, value) values ('geo_i18n_backfill_done', 'true'::jsonb)
      on conflict (key) do nothing;
  end if;
end $$;

select 'geo i18n migration applied!' as status;
