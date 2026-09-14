const LOCALE = {
  en:{h:['Route overview','Prices and fares','Airlines and choice','Direct flights and stops','Airport details','Planning the trip'],intro:'Compare this route using observed fares, airlines, flight time and connectivity rather than unsupported estimates.',price:'Observed fares',air:'airlines',direct:'Direct options',airport:'Airport details',plan:'Planning the trip',faq:['How long is the flight?','What price should I expect?','Are there direct flights?','Which airlines serve the route?'],title:c=>`${c.o}–${c.d} flights: price & duration | Airpiv`,meta:c=>`Compare ${c.o} to ${c.d} flights using route data on fares, airlines, flight time and direct options. Use the available route evidence when planning your trip.`},
  fr:{h:['Vue d’ensemble','Prix et tarifs','Compagnies aériennes','Vols directs et escales','Aéroports','Préparer le voyage'],intro:'Comparez cette liaison à partir des tarifs, compagnies, durées et options de correspondance réellement observés.',price:'Tarifs observés',air:'compagnies',direct:'Options sans escale',airport:'Détails des aéroports',plan:'Préparer le voyage',faq:['Combien de temps dure le vol ?','Quel prix prévoir ?','Existe-t-il des vols directs ?','Quelles compagnies desservent la liaison ?'],title:c=>`Vols ${c.o} → ${c.d} : prix et durée | Airpiv`,meta:c=>`Comparez les vols ${c.o}–${c.d} avec les données disponibles sur prix, compagnies, durée et vols directs. Consultez les informations de route avant de réserver.`},
  es:{h:['Resumen de la ruta','Precios y tarifas','Aerolíneas','Vuelos directos y escalas','Aeropuertos','Planificar el viaje'],intro:'Compara esta ruta con datos observados sobre tarifas, aerolíneas, duración y conectividad, sin estimaciones inventadas.',price:'Precios observados',air:'aerolíneas',direct:'Opciones directas',airport:'Detalles de aeropuertos',plan:'Planificar el viaje',faq:['¿Cuánto dura el vuelo?','¿Qué precio puedo esperar?','¿Hay vuelos directos?','¿Qué aerolíneas operan la ruta?'],title:c=>`Vuelos ${c.o} → ${c.d}: precio y duración | Airpiv`,meta:c=>`Compara vuelos de ${c.o} a ${c.d} con datos de precios, aerolíneas, duración y opciones directas. Revisa los datos disponibles de la ruta antes de reservar.`},
  it:{h:['Panoramica della rotta','Prezzi e tariffe','Compagnie aeree','Voli diretti e scali','Aeroporti','Organizzare il viaggio'],intro:'Confronta questa rotta usando dati osservati su tariffe, compagnie, durata e collegamenti.',price:'Tariffe osservate',air:'compagnie',direct:'Opzioni dirette',airport:'Dettagli aeroportuali',plan:'Organizzare il viaggio',faq:['Quanto dura il volo?','Quale prezzo posso aspettarmi?','Ci sono voli diretti?','Quali compagnie operano la rotta?'],title:c=>`Voli ${c.o} → ${c.d}: prezzo e durata | Airpiv`,meta:c=>`Confronta i voli ${c.o}–${c.d} con dati verificati su prezzi, compagnie, durata e opzioni dirette. Controlla i dati disponibili sulla rotta prima di prenotare.`},
  nl:{h:['Route-overzicht','Prijzen en tarieven','Airlines en keuze','Directe vluchten en overstappen','Luchthavens','De reis plannen'],intro:'Vergelijk deze route met waargenomen gegevens over tarieven, airlines, vliegtijd en verbindingen.',price:'Waargenomen tarieven',air:'airlines',direct:'Directe opties',airport:'Luchthaveninformatie',plan:'De reis plannen',faq:['Hoe lang duurt de vlucht?','Welke prijs kan ik verwachten?','Zijn er directe vluchten?','Welke airlines vliegen deze route?'],title:c=>`${c.o}–${c.d} vluchten: prijs & duur | Airpiv`,meta:c=>`Vergelijk vluchten van ${c.o} naar ${c.d} met routegegevens over tarieven, airlines, vliegtijd en directe opties. Controleer de beschikbare routegegevens voor vertrek.`},
  tr:{h:['Rota özeti','Fiyatlar ve ücretler','Havayolları ve seçenekler','Direkt uçuşlar ve aktarmalar','Havalimanı bilgileri','Seyahati planlama'],intro:'Bu rotayı gözlemlenen ücret, havayolu, uçuş süresi ve bağlantı verileriyle karşılaştırın.',price:'Gözlemlenen fiyatlar',air:'havayolu',direct:'Direkt seçenekler',airport:'Havalimanı bilgileri',plan:'Seyahati planlama',faq:['Uçuş ne kadar sürüyor?','Hangi fiyatı beklemeliyim?','Direkt uçuş var mı?','Hangi havayolları uçuyor?'],title:c=>`${c.o} - ${c.d}: fiyat ve süre | Airpiv`,meta:c=>`${c.o} - ${c.d} uçuşlarını fiyat, havayolu, uçuş süresi ve direkt seçenek verileriyle karşılaştırın. Rezervasyondan önce mevcut rota verilerini kontrol edin.`}
};

function safeTitle(c, preferred, compact) {
  const title = preferred(c);
  if (title.length >= 30 && title.length <= 70) return title;
  const short = compact(c);
  if (short.length >= 30 && short.length <= 70) return short;
  const route = `${c.o}–${c.d}`;
  if (route.length >= 30 && route.length <= 70) return route;
  return title;
}

function safeMeta(c, preferred, compact, suffix) {
  const meta = preferred(c);
  if (meta.length >= 90 && meta.length <= 170) return meta;
  const short = `${compact(c)} ${suffix}`;
  if (short.length >= 90 && short.length <= 170) return short;
  return meta;
}

function makePack(lang){
  const l=LOCALE[lang]; if(!l)return null;
  const overview=c=>`${c.o} and ${c.d} are about ${Math.round(c.km)} km apart by air. ${c.fmtDur?`Observed flight time is around ${c.fmtDur}. `:''}${c.airlineCount?`${c.airlineCount} ${l.air} are represented in the route data. `:''}The route is classified as ${c.haul}.`;
  const price=c=>c.priceMin!=null?`${l.price} start at about ${Math.round(c.priceMin)} EUR${c.priceMax&&c.priceMax>c.priceMin?` and can reach about ${Math.round(c.priceMax)} EUR`:''}. ${c.priceTrend==='up'?'Recent pricing has been trending upward.':c.priceTrend==='down'?'Recent pricing has been trending downward.':'Recent pricing has been comparatively stable.'}`:'Verified fare observations are currently limited for this route.';
  const airline=c=>`${c.airlineCount||'Several'} ${l.air} are represented in the available route data. Compare schedules, baggage rules and total journey time as well as headline price.`;
  const direct=c=>c.directB==='all-direct'?`${l.direct} are represented without a connection in the observed data.`:c.directB==='connections-only'?'The observed route data does not show a direct option. Check connection time and airport carefully.':'Direct and connecting options are represented. A direct itinerary can save time, while a connection can widen schedule choice.';
  const airport=c=>`${c.o} uses ${c.oIata||'the origin airport'} and ${c.d} uses ${c.dIata||'the destination airport'}. Check terminal and ground-transport details close to departure.`;
  const plan=c=>`Compare departure times, baggage, connection length and total journey time. ${c.haul==='long-haul'?'For long-haul travel, comfort and connection quality can matter as much as fare.':'For shorter routes, convenient airport access and departure times can outweigh a small fare difference.'}`;
  const faq=[
    {id:'duration',applicable:c=>c.facts.has('duration'),q:()=>l.faq[0],a:c=>c.fmtDur?`The observed average flight time is around ${c.fmtDur}.`:'No reliable observed flight time is currently available.'},
    {id:'price-from',applicable:c=>c.facts.has('price'),q:()=>l.faq[1],a:c=>c.priceMin!=null?`Observed fares start at about ${Math.round(c.priceMin)} EUR. Final prices depend on date and availability.`:'No verified minimum fare is currently available.'},
    {id:'direct',applicable:c=>c.facts.has('directness'),q:()=>l.faq[2],a:c=>c.directB==='all-direct'?'Yes. The observed options are direct.':c.directB==='connections-only'?'No direct option is currently represented.':'Direct options are represented alongside connecting flights.'},
    {id:'airlines',applicable:c=>c.facts.has('airlines'),q:()=>l.faq[3],a:c=>`${c.airlineCount||'Several'} ${l.air} are represented in the available route data.`}
  ];
  const compact={en:c=>`${c.o}–${c.d} flights: price & duration | Airpiv`,fr:c=>`Vols ${c.o} → ${c.d} : prix et durée | Airpiv`,es:c=>`Vuelos ${c.o} → ${c.d}: precio y duración | Airpiv`,it:c=>`Voli ${c.o} → ${c.d}: prezzo e durata | Airpiv`,nl:c=>`${c.o}–${c.d} vluchten: prijs & duur | Airpiv`,tr:c=>`${c.o} - ${c.d}: fiyat ve süre | Airpiv`}[lang];
  const suffix={en:'Review the available route data before booking.',fr:'Vérifiez les données disponibles avant de réserver.',es:'Revisa los datos disponibles antes de reservar.',it:'Controlla i dati disponibili prima di prenotare.',nl:'Controleer de beschikbare routegegevens voor vertrek.',tr:'Rezervasyondan önce mevcut rota verilerini kontrol edin.'}[lang];
  return {INTRO_ANGLES:{traveler:[c=>l.intro],price:[c=>l.intro],duration:[c=>l.intro],airline:[c=>l.intro],business:[c=>l.intro],destination:[c=>l.intro],seasonal:[c=>l.intro],weekend:[c=>l.intro],family:[c=>l.intro],airport:[c=>l.intro]},BLOCKS:[
    {id:'overview',weight:()=>100,applicable:()=>true,render:c=>({heading:l.h[0],body:overview(c)})},
    {id:'price-analysis',weight:c=>c.facts.has('price')?8:0,applicable:c=>c.facts.has('price'),render:c=>({heading:l.h[1],body:price(c)})},
    {id:'airline-analysis',weight:c=>c.facts.has('airlines')?7:0,applicable:c=>c.facts.has('airlines'),render:c=>({heading:l.h[2],body:airline(c)})},
    {id:'direct-analysis',weight:c=>c.facts.has('directness')?6:0,applicable:c=>c.facts.has('directness'),render:c=>({heading:l.h[3],body:direct(c)})},
    {id:'airport-detail',weight:()=>4,applicable:()=>true,render:c=>({heading:l.h[4],body:airport(c)})},
    {id:'travel-planning',weight:()=>3,applicable:()=>true,render:c=>({heading:l.h[5],body:plan(c)})}
  ],FAQ_CANDIDATES:faq,TITLES:[c=>safeTitle(c,l.title,compact)],METAS:[c=>safeMeta(c,l.meta,compact,suffix)]};
}
module.exports={makePack,LOCALE};
