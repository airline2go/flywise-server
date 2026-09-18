const LOCALE={
  en:{h:['Route overview','Prices and fares','Airlines and choice','Direct flights and stops','Airport details','Planning the trip'],intro:'Compare this route using observed fares, airlines, flight time and connectivity rather than unsupported estimates.',price:'Observed fares',air:'airlines',direct:'Direct options',airport:'Airport details',plan:'Planning the trip',faq:['How long is the flight?','What price should I expect?','Are there direct flights?','Which airlines serve the route?'],title:c=>`${c.o}–${c.d} flights: price & duration | Airpiv`,meta:c=>`Compare ${c.o} to ${c.d} flights using route data on fares, airlines, flight time and direct options. Use the available route evidence when planning your trip.`},
  fr:{h:['Vue d’ensemble','Prix et tarifs','Compagnies aériennes','Vols directs et escales','Aéroports','Préparer le voyage'],intro:'Comparez cette liaison à partir des tarifs, compagnies, durées et options de correspondance réellement observés.',price:'Tarifs observés',air:'compagnies',direct:'Options sans escale',airport:'Détails des aéroports',plan:'Préparer le voyage',faq:['Combien de temps dure le vol ?','Quel prix prévoir ?','Existe-t-il des vols directs ?','Quelles compagnies desservent la liaison ?'],title:c=>`Vols ${c.o} → ${c.d} : prix et durée | Airpiv`,meta:c=>`Comparez les vols ${c.o}–${c.d} avec les données disponibles sur prix, compagnies, durée et vols directs. Consultez les informations de route avant de réserver.`},
  es:{h:['Resumen de la ruta','Precios y tarifas','Aerolíneas','Vuelos directos y escalas','Aeropuertos','Planificar el viaje'],intro:'Compara esta ruta con datos observados sobre tarifas, aerolíneas, duración y conectividad, sin estimaciones inventadas.',price:'Precios observados',air:'aerolíneas',direct:'Opciones directas',airport:'Detalles de aeropuertos',plan:'Planificar el viaje',faq:['¿Cuánto dura el vuelo?','¿Qué precio puedo esperar?','¿Hay vuelos directos?','¿Qué aerolíneas operan la ruta?'],title:c=>`Vuelos ${c.o} → ${c.d}: precio y duración | Airpiv`,meta:c=>`Compara vuelos de ${c.o} a ${c.d} con datos de precios, aerolíneas, duración y opciones directas. Revisa los datos disponibles de la ruta antes de reservar.`},
  it:{h:['Panoramica della rotta','Prezzi e tariffe','Compagnie aeree','Voli diretti e scali','Aeroporti','Organizzare il viaggio'],intro:'Confronta questa rotta usando dati osservati su tariffe, compagnie, durata e collegamenti.',price:'Tariffe osservate',air:'compagnie',direct:'Opzioni dirette',airport:'Dettagli aeroportuali',plan:'Organizzare il viaggio',faq:['Quanto dura il volo?','Quale prezzo posso aspettarmi?','Ci sono voli diretti?','Quali compagnie operano la rotta?'],title:c=>`Voli ${c.o} → ${c.d}: prezzo e durata | Airpiv`,meta:c=>`Confronta i voli ${c.o}–${c.d} con dati verificati su prezzi, compagnie, durata e opzioni dirette. Controlla i dati disponibili sulla rotta prima di prenotare.`},
  nl:{h:['Route-overzicht','Prijzen en tarieven','Airlines en keuze','Directe vluchten en overstappen','Luchthavens','De reis plannen'],intro:'Vergelijk deze route met waargenomen gegevens over tarieven, airlines, vliegtijd en verbindingen.',price:'Waargenomen tarieven',air:'airlines',direct:'Directe opties',airport:'Luchthaveninformatie',plan:'De reis plannen',faq:['Hoe lang duurt de vlucht?','Welke prijs kan ik verwachten?','Zijn er directe vluchten?','Welke airlines vliegen deze route?'],title:c=>`${c.o}–${c.d} vluchten: prijs & duur | Airpiv`,meta:c=>`Vergelijk vluchten van ${c.o} naar ${c.d} met routegegevens over tarieven, airlines, vliegtijd en directe opties. Controleer de beschikbare routegegevens voor vertrek.`},
  tr:{h:['Rota özeti','Fiyatlar ve ücretler','Havayolları ve seçenekler','Direkt uçuşlar ve aktarmalar','Havalimanı bilgileri','Seyahati planlama'],intro:'Bu rotayı gözlemlenen ücret, havayolu, uçuş süresi ve bağlantı verileriyle karşılaştırın.',price:'Gözlemlenen fiyatlar',air:'havayolu',direct:'Direkt seçenekler',airport:'Havalimanı bilgileri',plan:'Seyahati planlama',faq:['Uçuş ne kadar sürüyor?','Hangi fiyatı beklemeliyim?','Direkt uçuş var mı?','Hangi havayolları uçuyor?'],title:c=>`${c.o} - ${c.d}: fiyat ve süre | Airpiv`,meta:c=>`${c.o} - ${c.d} uçuşlarını fiyat, havayolu, uçuş süresi ve direkt seçenek verileriyle karşılaştırın. Rezervasyondan önce mevcut rota verilerini kontrol edin.`}
};
function safeTitle(c,preferred,compact){const title=preferred(c);if(title.length>=30&&title.length<=70)return title;const short=compact(c);if(short.length>=30&&short.length<=70)return short;return title;}
function safeMeta(c,preferred,compact,suffix){const meta=preferred(c);if(meta.length>=90&&meta.length<=170)return meta;const short=`${compact(c)} ${suffix}`;return short.length>=90&&short.length<=170?short:meta;}
function makePack(lang){const l=LOCALE[lang];if(!l)return null;function formatDuration(lang, min) {
  if (!Number.isFinite(Number(min)) || Number(min) <= 0) return null;
  const total = Math.round(Number(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (lang === 'en') return h ? (m ? h + 'h ' + m + 'm' : h + 'h') : m + 'm';
  if (lang === 'fr') return h ? (m ? h + ' h ' + m + ' min' : h + ' h') : m + ' min';
  if (lang === 'es') return h ? (m ? h + ' h ' + m + ' min' : h + ' h') : m + ' min';
  if (lang === 'it') return h ? (m ? h + ' h ' + m + ' min' : h + ' h') : m + ' min';
  if (lang === 'nl') return h ? (m ? h + ' u ' + m + ' min' : h + ' u') : m + ' min';
  if (lang === 'tr') return h ? (m ? h + ' sa ' + m + ' dk' : h + ' sa') : m + ' dk';
  return h ? (m ? h + ' h ' + m + ' min' : h + ' h') : m + ' min';
}

const airPlural = {
  en: 'airlines',
  fr: 'compagnies aériennes',
  es: 'aerolíneas',
  it: 'compagnie aeree',
  nl: 'airlines',
  tr: 'havayolu şirketi',
}[lang] || l.air;

const overviewCopy = {
  en: c => c.o + ' and ' + c.d + ' are about ' + Math.round(c.km) + ' km apart by air. ' + (formatDuration(lang, c.durMin) ? 'Observed flight time is around ' + formatDuration(lang, c.durMin) + '. ' : '') + (c.airlineCount ? c.airlineCount + ' ' + airPlural + ' are represented in the route data. ' : '') + 'The route is classified as ' + c.haul + '.',
  fr: c => c.o + ' et ' + c.d + ' sont séparées d’environ ' + Math.round(c.km) + ' km à vol d’oiseau. ' + (formatDuration(lang, c.durMin) ? 'La durée de vol observée est d’environ ' + formatDuration(lang, c.durMin) + '. ' : '') + (c.airlineCount ? c.airlineCount + ' ' + airPlural + ' apparaissent dans les données de la liaison. ' : '') + 'La liaison est classée comme ' + c.haul + '.',
  es: c => c.o + ' y ' + c.d + ' están a unos ' + Math.round(c.km) + ' km de distancia por aire. ' + (formatDuration(lang, c.durMin) ? 'El tiempo de vuelo observado es de unos ' + formatDuration(lang, c.durMin) + '. ' : '') + (c.airlineCount ? c.airlineCount + ' ' + airPlural + ' aparecen en los datos de la ruta. ' : '') + 'La ruta está clasificada como ' + c.haul + '.',
  it: c => c.o + ' e ' + c.d + ' distano circa ' + Math.round(c.km) + ' km in linea d’aria. ' + (formatDuration(lang, c.durMin) ? 'Il tempo di volo osservato è di circa ' + formatDuration(lang, c.durMin) + '. ' : '') + (c.airlineCount ? c.airlineCount + ' ' + airPlural + ' sono presenti nei dati della rotta. ' : '') + 'La rotta è classificata come ' + c.haul + '.',
  nl: c => c.o + ' en ' + c.d + ' liggen ongeveer ' + Math.round(c.km) + ' km van elkaar over de lucht. ' + (formatDuration(lang, c.durMin) ? 'De waargenomen vliegtijd is ongeveer ' + formatDuration(lang, c.durMin) + '. ' : '') + (c.airlineCount ? c.airlineCount + ' ' + airPlural + ' zijn in de routegegevens vertegenwoordigd. ' : '') + 'De route is ingedeeld als ' + c.haul + '.',
  tr: c => c.o + ' ile ' + c.d + ' kuş uçuşu yaklaşık ' + Math.round(c.km) + ' km uzaklıktadır. ' + (formatDuration(lang, c.durMin) ? 'Gözlemlenen uçuş süresi yaklaşık ' + formatDuration(lang, c.durMin) + '. ' : '') + (c.airlineCount ? c.airlineCount + ' ' + airPlural + ' rota verilerinde yer alıyor. ' : '') + 'Rota ' + c.haul + ' olarak sınıflandırılmıştır.',
}[lang];

const priceCopy = {
  en: c => c.priceMin != null ? l.price + ' start at about ' + Math.round(c.priceMin) + ' EUR' + (c.priceMax && c.priceMax > c.priceMin ? ' and can reach about ' + Math.round(c.priceMax) + ' EUR' : '') + '. ' + (c.priceTrend === 'up' ? 'Recent pricing has been trending upward.' : c.priceTrend === 'down' ? 'Recent pricing has been trending downward.' : 'Recent pricing has been comparatively stable.') : 'Verified fare observations are currently limited for this route.',
  fr: c => c.priceMin != null ? l.price + ' à partir d’environ ' + Math.round(c.priceMin) + ' EUR' + (c.priceMax && c.priceMax > c.priceMin ? ' et peuvent atteindre environ ' + Math.round(c.priceMax) + ' EUR' : '') + '. ' + (c.priceTrend === 'up' ? 'Les tarifs observés sont récemment orientés à la hausse.' : c.priceTrend === 'down' ? 'Les tarifs observés sont récemment orientés à la baisse.' : 'Les tarifs observés sont restés relativement stables récemment.') : 'Les observations tarifaires vérifiées sont actuellement limitées pour cette liaison.',
  es: c => c.priceMin != null ? l.price + ' parten de unos ' + Math.round(c.priceMin) + ' EUR' + (c.priceMax && c.priceMax > c.priceMin ? ' y pueden alcanzar unos ' + Math.round(c.priceMax) + ' EUR' : '') + '. ' + (c.priceTrend === 'up' ? 'Los precios observados muestran una tendencia al alza.' : c.priceTrend === 'down' ? 'Los precios observados muestran una tendencia a la baja.' : 'Los precios observados se han mantenido relativamente estables.') : 'Las observaciones de tarifas verificadas son actualmente limitadas para esta ruta.',
  it: c => c.priceMin != null ? l.price + ' partono da circa ' + Math.round(c.priceMin) + ' EUR' + (c.priceMax && c.priceMax > c.priceMin ? ' e possono arrivare a circa ' + Math.round(c.priceMax) + ' EUR' : '') + '. ' + (c.priceTrend === 'up' ? 'I prezzi osservati mostrano una tendenza al rialzo.' : c.priceTrend === 'down' ? 'I prezzi osservati mostrano una tendenza al ribasso.' : 'I prezzi osservati sono rimasti relativamente stabili.') : 'Le osservazioni tariffarie verificate sono attualmente limitate per questa rotta.',
  nl: c => c.priceMin != null ? l.price + ' beginnen bij ongeveer ' + Math.round(c.priceMin) + ' EUR' + (c.priceMax && c.priceMax > c.priceMin ? ' en kunnen oplopen tot ongeveer ' + Math.round(c.priceMax) + ' EUR' : '') + '. ' + (c.priceTrend === 'up' ? 'De waargenomen tarieven laten recent een stijgende trend zien.' : c.priceTrend === 'down' ? 'De waargenomen tarieven laten recent een dalende trend zien.' : 'De waargenomen tarieven zijn recent relatief stabiel gebleven.') : 'Betrouwbare tariefwaarnemingen zijn momenteel beperkt voor deze route.',
  tr: c => c.priceMin != null ? l.price + ' yaklaşık ' + Math.round(c.priceMin) + ' EUR seviyesinden başlar' + (c.priceMax && c.priceMax > c.priceMin ? ' ve yaklaşık ' + Math.round(c.priceMax) + ' EUR seviyesine ulaşabilir' : '') + '. ' + (c.priceTrend === 'up' ? 'Gözlemlenen fiyatlarda son dönemde artış eğilimi vardır.' : c.priceTrend === 'down' ? 'Gözlemlenen fiyatlarda son dönemde düşüş eğilimi vardır.' : 'Gözlemlenen fiyatlar son dönemde görece istikrarlı kalmıştır.') : 'Doğrulanmış ücret gözlemleri şu anda bu rota için sınırlıdır.',
}[lang];

const airlineCopy = {
  en: c => (c.airlineCount || 'Several') + ' ' + airPlural + ' are represented in the available route data. Compare schedules, baggage rules and total journey time as well as headline price.',
  fr: c => (c.airlineCount || 'Plusieurs') + ' ' + airPlural + ' apparaissent dans les données disponibles de la liaison. Comparez les horaires, les règles bagages et le temps total de trajet en plus du tarif.',
  es: c => (c.airlineCount || 'Varias') + ' ' + airPlural + ' aparecen en los datos disponibles de la ruta. Compara horarios, equipaje y tiempo total de viaje además del precio.',
  it: c => (c.airlineCount || 'Diverse') + ' ' + airPlural + ' sono presenti nei dati disponibili della rotta. Confronta orari, bagagli e tempo totale di viaggio oltre al prezzo.',
  nl: c => (c.airlineCount || 'Meerdere') + ' ' + airPlural + ' zijn vertegenwoordigd in de beschikbare routegegevens. Vergelijk dienstregelingen, bagage en totale reistijd naast de prijs.',
  tr: c => (c.airlineCount || 'Birden fazla') + ' ' + airPlural + ' rota verilerinde yer alıyor. Fiyatın yanı sıra sefer saatlerini, bagaj kurallarını ve toplam seyahat süresini karşılaştırın.',
}[lang];

const directCopy = {
  en: c => c.directB === 'all-direct' ? l.direct + ' are represented without a connection in the observed data.' : c.directB === 'connections-only' ? 'The observed route data does not show a direct option. Check connection time and airport carefully.' : 'The observed route data includes direct and connecting itineraries. Compare elapsed time and schedule details.',
  fr: c => c.directB === 'all-direct' ? l.direct + ' sont représentées sans correspondance dans les données observées.' : c.directB === 'connections-only' ? 'Les données observées ne montrent pas d’option sans escale. Vérifiez la durée de correspondance et l’aéroport.' : 'Les données observées comprennent des itinéraires directs et avec correspondance. Comparez la durée totale et les horaires.',
  es: c => c.directB === 'all-direct' ? l.direct + ' aparecen sin escala en los datos observados.' : c.directB === 'connections-only' ? 'Los datos observados no muestran una opción directa. Comprueba el tiempo de conexión y el aeropuerto.' : 'Los datos observados incluyen itinerarios directos y con escala. Compara la duración total y los horarios.',
  it: c => c.directB === 'all-direct' ? l.direct + ' sono rappresentate senza scalo nei dati osservati.' : c.directB === 'connections-only' ? 'I dati osservati non mostrano un’opzione diretta. Verifica i tempi di scalo e l’aeroporto.' : 'I dati osservati includono itinerari diretti e con scalo. Confronta la durata totale e gli orari.',
  nl: c => c.directB === 'all-direct' ? l.direct + ' zijn zonder overstap vertegenwoordigd in de waargenomen gegevens.' : c.directB === 'connections-only' ? 'De waargenomen routegegevens tonen geen directe optie. Controleer de overstaptijd en luchthaven.' : 'De waargenomen gegevens bevatten zowel directe vluchten als vluchten met overstap. Vergelijk totale reistijd en dienstregelingen.',
  tr: c => c.directB === 'all-direct' ? l.direct + ' gözlemlenen verilerde aktarmasız olarak yer alıyor.' : c.directB === 'connections-only' ? 'Gözlemlenen rota verilerinde direkt seçenek görünmüyor. Aktarma süresini ve havalimanını kontrol edin.' : 'Gözlemlenen verilerde hem direkt hem aktarmalı seçenekler bulunuyor. Toplam süreyi ve sefer saatlerini karşılaştırın.',
}[lang];

const airportCopy = {
  en: c => c.o + ' uses ' + (c.oIata || 'the origin airport') + ' and ' + c.d + ' uses ' + (c.dIata || 'the destination airport') + '. Check terminal and ground-transport details close to departure.',
  fr: c => c.o + ' utilise ' + (c.oIata || 'l’aéroport de départ') + ' et ' + c.d + ' utilise ' + (c.dIata || 'l’aéroport de destination') + '. Vérifiez les informations sur le terminal et les transports terrestres avant le départ.',
  es: c => c.o + ' utiliza ' + (c.oIata || 'el aeropuerto de origen') + ' y ' + c.d + ' utiliza ' + (c.dIata || 'el aeropuerto de destino') + '. Comprueba el terminal y los transportes terrestres antes de la salida.',
  it: c => c.o + ' utilizza ' + (c.oIata || 'l’aeroporto di partenza') + ' e ' + c.d + ' utilizza ' + (c.dIata || 'l’aeroporto di arrivo') + '. Verifica i dettagli del terminal e dei trasporti terrestri prima della partenza.',
  nl: c => c.o + ' gebruikt ' + (c.oIata || 'de luchthaven van vertrek') + ' en ' + c.d + ' gebruikt ' + (c.dIata || 'de luchthaven van bestemming') + '. Controleer terminal- en vervoersinformatie vlak voor vertrek.',
  tr: c => c.o + ', ' + (c.oIata || 'kalkış havalimanını') + '; ' + c.d + ' ise ' + (c.dIata || 'varış havalimanını') + ' kullanır. Terminal ve kara ulaşımı bilgilerini kalkıştan önce kontrol edin.',
}[lang];

const planCopy = {
  en: c => 'Compare departure times, baggage, connection length and total journey time. ' + (c.haul === 'long-haul' ? 'Review comfort and connection details alongside fare.' : 'Review airport access and departure times alongside fare.'),
  fr: c => 'Comparez les horaires de départ, les bagages, la durée des correspondances et le temps total de trajet. ' + (c.haul === 'long-haul' ? 'Pour les longs trajets, regardez aussi le confort et les détails des correspondances.' : 'Pour les trajets plus courts, regardez aussi l’accès à l’aéroport et les horaires de départ.'),
  es: c => 'Compara los horarios de salida, el equipaje, la duración de las escalas y el tiempo total de viaje. ' + (c.haul === 'long-haul' ? 'En rutas largas, revisa también el confort y los detalles de las escalas.' : 'En rutas más cortas, revisa también el acceso al aeropuerto y los horarios de salida.'),
  it: c => 'Confronta gli orari di partenza, il bagaglio, la durata degli scali e il tempo totale di viaggio. ' + (c.haul === 'long-haul' ? 'Sulle rotte lunghe, considera anche il comfort e i dettagli degli scali.' : 'Sulle rotte più brevi, considera anche l’accesso all’aeroporto e gli orari di partenza.'),
  nl: c => 'Vergelijk vertrektijden, bagage, overstaptijden en de totale reistijd. ' + (c.haul === 'long-haul' ? 'Bij lange routes zijn comfort en overstapdetails ook relevant.' : 'Bij kortere routes zijn bereikbaarheid van de luchthaven en vertrektijden ook relevant.'),
  tr: c => 'Kalkış saatlerini, bagajı, aktarma süresini ve toplam seyahat süresini karşılaştırın. ' + (c.haul === 'long-haul' ? 'Uzun rotalarda konforu ve aktarma ayrıntılarını da değerlendirin.' : 'Daha kısa rotalarda havalimanına erişimi ve kalkış saatlerini de değerlendirin.'),
}[lang];

const faq = [
  {
    id: 'duration',
    applicable: c => c.facts.has('duration'),
    q: () => l.faq[0],
    a: c => ({
      en: formatDuration(lang, c.durMin) ? 'The observed average flight time is around ' + formatDuration(lang, c.durMin) + '.' : 'No reliable observed flight time is currently available.',
      fr: formatDuration(lang, c.durMin) ? 'La durée moyenne de vol observée est d’environ ' + formatDuration(lang, c.durMin) + '.' : 'Aucune durée de vol observée fiable n’est actuellement disponible.',
      es: formatDuration(lang, c.durMin) ? 'El tiempo medio de vuelo observado es de unos ' + formatDuration(lang, c.durMin) + '.' : 'No hay un tiempo de vuelo observado fiable disponible actualmente.',
      it: formatDuration(lang, c.durMin) ? 'Il tempo medio di volo osservato è di circa ' + formatDuration(lang, c.durMin) + '.' : 'Al momento non è disponibile una durata di volo osservata affidabile.',
      nl: formatDuration(lang, c.durMin) ? 'De waargenomen gemiddelde vliegtijd is ongeveer ' + formatDuration(lang, c.durMin) + '.' : 'Er is momenteel geen betrouwbare waargenomen vliegtijd beschikbaar.',
      tr: formatDuration(lang, c.durMin) ? 'Gözlemlenen ortalama uçuş süresi yaklaşık ' + formatDuration(lang, c.durMin) + '.' : 'Şu anda güvenilir bir gözlemlenen uçuş süresi bulunmuyor.',
    }[lang]),
  },
  {
    id: 'price-from',
    applicable: c => c.facts.has('price'),
    q: () => l.faq[1],
    a: c => ({
      en: c.priceMin != null ? 'Observed fares start at about ' + Math.round(c.priceMin) + ' EUR. Final prices depend on date and availability.' : 'No verified minimum fare is currently available.',
      fr: c.priceMin != null ? 'Les tarifs observés commencent autour de ' + Math.round(c.priceMin) + ' EUR. Le prix final dépend de la date et des disponibilités.' : 'Aucun tarif minimum vérifié n’est actuellement disponible.',
      es: c.priceMin != null ? 'Las tarifas observadas parten de unos ' + Math.round(c.priceMin) + ' EUR. El precio final depende de la fecha y la disponibilidad.' : 'No hay una tarifa mínima verificada disponible actualmente.',
      it: c.priceMin != null ? 'Le tariffe osservate partono da circa ' + Math.round(c.priceMin) + ' EUR. Il prezzo finale dipende dalla data e dalla disponibilità.' : 'Al momento non è disponibile una tariffa minima verificata.',
      nl: c.priceMin != null ? 'De waargenomen tarieven beginnen bij ongeveer ' + Math.round(c.priceMin) + ' EUR. De uiteindelijke prijs hangt af van datum en beschikbaarheid.' : 'Er is momenteel geen geverifieerd minimumtarief beschikbaar.',
      tr: c.priceMin != null ? 'Gözlemlenen ücretler yaklaşık ' + Math.round(c.priceMin) + ' EUR seviyesinden başlıyor. Nihai fiyat tarihe ve müsaitliğe bağlıdır.' : 'Şu anda doğrulanmış bir minimum ücret bulunmuyor.',
    }[lang]),
  },
  {
    id: 'direct',
    applicable: c => c.facts.has('directness'),
    q: () => l.faq[2],
    a: c => ({
      en: c.directB === 'all-direct' ? 'Yes. The observed options are direct.' : c.directB === 'connections-only' ? 'No direct option is currently represented.' : 'Direct options are represented alongside connecting flights.',
      fr: c.directB === 'all-direct' ? 'Oui. Les options observées sont directes.' : c.directB === 'connections-only' ? 'Aucune option sans escale n’est actuellement représentée.' : 'Des options directes et avec correspondance sont représentées.',
      es: c.directB === 'all-direct' ? 'Sí. Las opciones observadas son directas.' : c.directB === 'connections-only' ? 'No hay actualmente una opción directa representada.' : 'Hay opciones directas y con escala representadas.',
      it: c.directB === 'all-direct' ? 'Sì. Le opzioni osservate sono dirette.' : c.directB === 'connections-only' ? 'Al momento non è rappresentata alcuna opzione diretta.' : 'Sono rappresentate opzioni dirette e con scalo.',
      nl: c.directB === 'all-direct' ? 'Ja. De waargenomen opties zijn direct.' : c.directB === 'connections-only' ? 'Er is momenteel geen directe optie vertegenwoordigd.' : 'Er zijn zowel directe als vluchten met overstap vertegenwoordigd.',
      tr: c.directB === 'all-direct' ? 'Evet. Gözlemlenen seçenekler direkt uçuşlardır.' : c.directB === 'connections-only' ? 'Şu anda temsil edilen direkt bir seçenek yok.' : 'Direkt ve aktarmalı seçenekler temsil ediliyor.',
    }[lang]),
  },
  {
    id: 'airlines',
    applicable: c => c.facts.has('airlines'),
    q: () => l.faq[3],
    a: c => ({
      en: String(c.airlineCount || 'Several') + ' ' + airPlural + ' are represented in the available route data.',
      fr: String(c.airlineCount || 'Plusieurs') + ' ' + airPlural + ' apparaissent dans les données disponibles de la liaison.',
      es: String(c.airlineCount || 'Varias') + ' ' + airPlural + ' aparecen en los datos disponibles de la ruta.',
      it: String(c.airlineCount || 'Diverse') + ' ' + airPlural + ' sono presenti nei dati disponibili della rotta.',
      nl: String(c.airlineCount || 'Meerdere') + ' ' + airPlural + ' zijn in de beschikbare routegegevens vertegenwoordigd.',
      tr: String(c.airlineCount || 'Birden fazla') + ' ' + airPlural + ' rota verilerinde yer alıyor.',
    }[lang]),
  },
];
const compact={en:c=>`${c.o}–${c.d} flights: price & duration | Airpiv`,fr:c=>`Vols ${c.o} → ${c.d} : prix et durée | Airpiv`,es:c=>`Vuelos ${c.o} → ${c.d}: precio y duración | Airpiv`,it:c=>`Voli ${c.o} → ${c.d}: prezzo e durata | Airpiv`,nl:c=>`${c.o}–${c.d} vluchten: prijs & duur | Airpiv`,tr:c=>`${c.o} - ${c.d}: fiyat ve süre | Airpiv`}[lang];const suffix={en:'Review the available route data before booking.',fr:'Vérifiez les données disponibles avant de réserver.',es:'Revisa los datos disponibles antes de reservar.',it:'Controlla i dati disponibili prima di prenotare.',nl:'Controleer de beschikbare routegegevens voor vertrek.',tr:'Rezervasyondan önce mevcut rota verilerini kontrol edin.'}[lang];return {INTRO_ANGLES:{traveler:[c=>l.intro],price:[c=>l.intro],duration:[c=>l.intro],airline:[c=>l.intro],business:[c=>l.intro],destination:[c=>l.intro],seasonal:[c=>l.intro],weekend:[c=>l.intro],family:[c=>l.intro],airport:[c=>l.intro]},BLOCKS:[{id:'overview',weight:()=>100,applicable:()=>true,render:c=>({heading:l.h[0],body:overviewCopy[lang](c)})},{id:'price-analysis',weight:c=>c.facts.has('price')?8:0,applicable:c=>c.facts.has('price'),render:c=>({heading:l.h[1],body:priceCopy[lang](c)})},{id:'airline-analysis',weight:c=>c.facts.has('airlines')?7:0,applicable:c=>c.facts.has('airlines'),render:c=>({heading:l.h[2],body:airlineCopy[lang](c)})},{id:'direct-analysis',weight:c=>c.facts.has('directness')?6:0,applicable:c=>c.facts.has('directness'),render:c=>({heading:l.h[3],body:directCopy[lang](c)})},{id:'airport-detail',weight:()=>4,applicable:()=>true,render:c=>({heading:l.h[4],body:airportCopy[lang](c)})},{id:'travel-planning',weight:()=>3,applicable:()=>true,render:c=>({heading:l.h[5],body:planCopy[lang](c)})}],FAQ_CANDIDATES:faq,TITLES:[c=>safeTitle(c,l.title,compact)],METAS:[c=>safeMeta(c,l.meta,compact,suffix)]};}
module.exports={makePack,LOCALE};