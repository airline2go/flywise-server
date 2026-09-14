const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { effectiveLocalizedRouteSeo } = require('../services/seo/localizedEffective');
const { getRouteSeoLocales, isSupportedRouteSeoLocale } = require('../services/seo/multilingual');
const SITE = String(process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'https://airpiv.com').replace(/\/+$/, '');
const pathFor = (lang, slug) => lang === 'de' ? `/flights/${slug}` : `/${lang}/flights/${slug}`;
async function alternates(id, slug) {
  const out = [{ language:'de', hrefLang:'de', href:`${SITE}${pathFor('de',slug)}` }];
  const { data, error } = await supa.from('route_seo_locales').select('language').eq('route_page_id',id).not('seo_generated_at','is',null);
  if (error) throw new Error(error.message);
  for (const r of data || []) if (isSupportedRouteSeoLocale(r.language) && r.language !== 'de') out.push({language:r.language,hrefLang:r.language,href:`${SITE}${pathFor(r.language,slug)}`});
  out.push({language:'x-default',hrefLang:'x-default',href:`${SITE}${pathFor('de',slug)}`});
  return out;
}
module.exports = (app) => {
  const limit = rateLimit('content',2500,60000);
  app.get('/route-pages/:slug/localized',limit,async(req,res)=>{try{
    const lang=String(req.query.lang||'').toLowerCase();
    if(!isSupportedRouteSeoLocale(lang)||lang==='de') return res.status(400).json({ok:false,error:'unsupported localized route language'});
    const {data:route,error:e1}=await supa.from('route_pages').select('*').eq('slug',req.params.slug).eq('status','published').maybeSingle();
    if(e1) throw new Error(e1.message); if(!route) return res.status(404).json({ok:false,error:'Route nicht gefunden'});
    const {data:row,error:e2}=await supa.from('route_seo_locales').select('*').eq('route_page_id',route.id).eq('language',lang).not('seo_generated_at','is',null).maybeSingle();
    if(e2) throw new Error(e2.message); if(!row) return res.status(404).json({ok:false,error:'Localized SEO not generated'});
    res.json({ok:true,route:{...route,language:lang,seo:effectiveLocalizedRouteSeo(row),hreflang:await alternates(route.id,route.slug)},languages:getRouteSeoLocales()});
  }catch(e){res.status(500).json({ok:false,error:e.message});}});
  app.get('/route-pages/:slug/hreflang',limit,async(req,res)=>{try{
    const {data:route,error}=await supa.from('route_pages').select('id,slug').eq('slug',req.params.slug).eq('status','published').maybeSingle();
    if(error) throw new Error(error.message); if(!route) return res.status(404).json({ok:false,error:'Route nicht gefunden'});
    res.json({ok:true,hreflang:await alternates(route.id,route.slug)});
  }catch(e){res.status(500).json({ok:false,error:e.message});}});
};
