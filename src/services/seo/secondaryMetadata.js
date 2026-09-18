const LOCALE = {
  en: { flight: 'flights', titleTail: 'route data', meta: (o, d) => `Compare ${o} to ${d} using the available Airpiv route record and the information shown on this route page before booking.`, intro: (o, d) => `This route page summarizes the stored route record for ${o} and ${d}. Use the available route information on this page when comparing travel options.` },
  fr: { flight: 'vols', titleTail: 'données de route', meta: (o, d) => `Comparez les vols entre ${o} et ${d} avec la fiche de route Airpiv et les informations affichées sur cette page avant de réserver.`, intro: (o, d) => `Cette page résume la fiche de route enregistrée pour ${o} et ${d}. Utilisez les informations disponibles ici pour comparer les options de voyage.` },
  es: { flight: 'vuelos', titleTail: 'datos de ruta', meta: (o, d) => `Compara vuelos entre ${o} y ${d} con la ficha de ruta de Airpiv y la información disponible en esta página antes de reservar.`, intro: (o, d) => `Esta página resume la ficha de ruta registrada para ${o} y ${d}. Usa la información disponible aquí para comparar opciones de viaje.` },
  it: { flight: 'voli', titleTail: 'dati della rotta', meta: (o, d) => `Confronta i voli tra ${o} e ${d} con la scheda rotta Airpiv e le informazioni disponibili in questa pagina prima di prenotare.`, intro: (o, d) => `Questa pagina riassume la scheda rotta registrata per ${o} e ${d}. Usa le informazioni disponibili qui per confrontare le opzioni di viaggio.` },
  nl: { flight: 'vluchten', titleTail: 'routegegevens', meta: (o, d) => `Vergelijk vluchten tussen ${o} en ${d} met het Airpiv-routeoverzicht en de informatie op deze pagina voordat je boekt.`, intro: (o, d) => `Deze pagina vat het opgeslagen routeoverzicht voor ${o} en ${d} samen. Gebruik de beschikbare route-informatie hier om reisopties te vergelijken.` },
  tr: { flight: 'uçuşlar', titleTail: 'rota verileri', meta: (o, d) => `${o} ile ${d} arasındaki uçuşları Airpiv rota kaydı ve bu sayfadaki bilgilerle karşılaştırın; rezervasyondan önce mevcut ayrıntıları inceleyin.`, intro: (o, d) => `Bu sayfa ${o} ile ${d} için kayıtlı rota verilerini özetler. Seyahat seçeneklerini karşılaştırırken bu sayfadaki mevcut bilgileri kullanın.` },
};

function buildSecondaryTitle(route, language) {
  const l = LOCALE[language] || LOCALE.en;
  const base = `${route.origin_city}–${route.destination_city}`;
  let title = `${base} ${l.flight} | Airpiv ${l.titleTail}`;
  if (title.length < 30) title = `${base} ${l.flight} | Airpiv route`;
  return title;
}

function buildSecondaryMeta(route, language) {
  const l = LOCALE[language] || LOCALE.en;
  return l.meta(route.origin_city, route.destination_city);
}

function buildSecondaryIntro(route, language) {
  const l = LOCALE[language] || LOCALE.en;
  return l.intro(route.origin_city, route.destination_city);
}

module.exports = { buildSecondaryTitle, buildSecondaryMeta, buildSecondaryIntro };
