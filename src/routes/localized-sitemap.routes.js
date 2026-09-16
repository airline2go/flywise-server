const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { isSupportedRouteSeoLocale } = require('../services/seo/multilingual');
const PAGE_SIZE = 1000;
function lastmod(...values){for(const v of values){if(!v)continue;const d=new Date(v);if(!Number.isNaN(d.getTime()))return d.toISOString().slice(0,10);}return null;}
module.exports = (app) => app.get('/sitemap-data/routes-localized',rateLimit('content',2500,60000),async(req,res)=>{try{
  const language=String(req.query.lang||'').toLowerCase();
  if(!isSupportedRouteSeoLocale(language)||language==='de')return res.status(400).json({ok:false,error:'unsupported localized route language'});
  const raw=String(req.query.page==null?'0':req.query.page);
  if(!/^\d+$/.test(raw))return res.status(400).json({ok:false,error:'page must be a non-negative integer'});
  const page=Number(raw); if(!Number.isSafeInteger(page))return res.status(400).json({ok:false,error:'page out of range'});

  // Join route_pages in the same PostgREST query. The previous implementation
  // fetched up to 1000 locale rows and then issued a second `.in(id, ids)` query;
  // the generated URL could become too large and surface as HTTP 500. The
  // foreign-key relationship is already authoritative, so an embedded inner
  // join is both smaller and guarantees that only published routes are emitted.
  const {data,error}=await supa
    .from('route_seo_locales')
    .select('route_page_id,language,seo_generated_at,updated_at,route_pages!inner(id,slug,status,updated_at,insights_updated_at,created_at)')
    .eq('language',language)
    .not('seo_generated_at','is',null)
    .eq('route_pages.status','published')
    .order('route_page_id',{ascending:true})
    .range(page*PAGE_SIZE,page*PAGE_SIZE+PAGE_SIZE-1);
  if(error)throw new Error(error.message);

  const rows=data||[];
  const items=rows.map(r=>{
    const route=r.route_pages;
    if(!route)return null;
    return {
      id:route.slug,
      language,
      lastmod:lastmod(r.updated_at,r.seo_generated_at,route.updated_at,route.insights_updated_at,route.created_at),
    };
  }).filter(Boolean);
  res.json({ok:true,page,hasMore:rows.length===PAGE_SIZE,language,items});
}catch(e){res.status(500).json({ok:false,error:e.message});}});
