// ═══════════════════════════════════════════════════════════════════════════
// src/services/seoContentGenerator.js
// World-class SEO content generator for flight booking pages.
// Creates unique, human-quality content for routes, cities, countries, airports.
// ═══════════════════════════════════════════════════════════════════════════

// Content templates vary by haul type, language, and page type.
// Each template is designed to feel naturally written, never templated.

const HAUL_DESCRIPTIONS = {
  'en': {
    'short-haul': 'short-haul flight connecting nearby European cities',
    'medium-haul': 'medium-distance European flight',
    'long-haul': 'long-haul intercontinental journey'
  },
  'de': {
    'short-haul': 'Kurzstreckenflug zwischen nahegelegenen europäischen Städten',
    'medium-haul': 'Mittelstreckenflug über Europa',
    'long-haul': 'Langstreckenflug zu internationalen Destinationen'
  },
  'fr': {
    'short-haul': 'vol court-courrier reliant des villes européennes proches',
    'medium-haul': 'vol de moyenne distance à travers l\'Europe',
    'long-haul': 'vol long-courrier vers une destination internationale'
  },
  'es': {
    'short-haul': 'vuelo de corta distancia entre ciudades europeas cercanas',
    'medium-haul': 'vuelo de media distancia dentro de Europa',
    'long-haul': 'vuelo de largo recorrido hacia un destino internacional'
  },
  'it': {
    'short-haul': 'volo di breve durata tra città europee vicine',
    'medium-haul': 'volo di media distanza in Europa',
    'long-haul': 'volo intercontinentale verso una destinazione internazionale'
  },
  'nl': {
    'short-haul': 'korte vlucht tussen nabijgelegen Europese steden',
    'medium-haul': 'middellange vlucht door Europa',
    'long-haul': 'langeafstandsvlucht naar een internationale bestemming'
  },
  'ar': {
    'short-haul': 'رحلة قصيرة المدى بين مدن أوروبية قريبة',
    'medium-haul': 'رحلة متوسطة المدى عبر أوروبا',
    'long-haul': 'رحلة طويلة المدى إلى وجهة دولية'
  },
  'tr': {
    'short-haul': 'yakındaki Avrupa şehirleri arasında kısa mesafeli uçuş',
    'medium-haul': 'Avrupa\'da orta mesafeli uçuş',
    'long-haul': 'uluslararası bir destinasyona uzun mesafeli uçuş'
  }
};

const BEST_TIME_ADVICE = {
  'en': {
    'short-haul': 'Book 2-3 weeks in advance for the best fares on short European routes. Mid-week departures often offer savings compared to weekend flights.',
    'medium-haul': 'Medium-distance European flights are most affordable when booked 3-4 weeks ahead. Tuesday and Wednesday departures typically have better prices.',
    'long-haul': 'Long-haul flights require more advance planning—aim for 6-8 weeks before your desired travel date. Prices tend to drop mid-week, especially Tuesday through Thursday.'
  },
  'de': {
    'short-haul': 'Kurzstreckenflüge sollten 2-3 Wochen im Voraus gebucht werden. Flüge unter der Woche sind oft günstiger als am Wochenende.',
    'medium-haul': 'Mittelstreckenflüge sind am günstigsten, wenn sie 3-4 Wochen im Voraus gebucht werden. Flüge von Dienstag bis Donnerstag haben bessere Preise.',
    'long-haul': 'Langstreckenflüge sollten 6-8 Wochen im Voraus geplant werden. Die Preise sind unter der Woche am niedrigsten, besonders von Dienstag bis Donnerstag.'
  },
  'fr': {
    'short-haul': 'Les vols court-courrier doivent être réservés 2-3 semaines à l\'avance. Les départs en semaine offrent généralement de meilleurs prix.',
    'medium-haul': 'Les vols de moyenne distance sont plus abordables quand ils sont réservés 3-4 semaines avant. Mardi et mercredi offrent les meilleurs tarifs.',
    'long-haul': 'Les vols long-courrier nécessitent une planification 6-8 semaines avant le voyage. Les prix baissent généralement entre mardi et jeudi.'
  },
  'es': {
    'short-haul': 'Los vuelos de corta distancia deben reservarse 2-3 semanas antes. Los vuelos entre semana suelen tener mejores precios que los fines de semana.',
    'medium-haul': 'Los vuelos de media distancia son más económicos cuando se reservan 3-4 semanas antes. Martes y miércoles tienen los mejores precios.',
    'long-haul': 'Los vuelos internacionales requieren planificación 6-8 semanas antes. Los precios bajan generalmente de martes a jueves.'
  },
  'it': {
    'short-haul': 'I voli di breve durata dovrebbero essere prenotati 2-3 settimane prima. I voli tra settimana hanno spesso prezzi migliori.',
    'medium-haul': 'I voli di media distanza sono più convenienti se prenotati 3-4 settimane prima. Martedì e mercoledì offrono i migliori prezzi.',
    'long-haul': 'I voli a lungo raggio richiedono una pianificazione 6-8 settimane prima. I prezzi generalmente calano da martedì a giovedì.'
  },
  'nl': {
    'short-haul': 'Korte vluchten moeten 2-3 weken van tevoren worden geboekt. Vluchten doordeweeks hebben vaak betere prijzen dan in het weekend.',
    'medium-haul': 'Middellange vluchten zijn goedkoper wanneer ze 3-4 weken vooruit worden geboekt. Dinsdag en woensdag hebben de beste prijzen.',
    'long-haul': 'Langeafstandsvluchten vereisen planning 6-8 weken vooruit. Prijzen dalen gewoonlijk van dinsdag tot donderdag.'
  },
  'ar': {
    'short-haul': 'احجز رحلات قصيرة المدى قبل 2-3 أسابيع. الرحلات في أيام الأسبوع عادة ما تكون أرخص من عطلة نهاية الأسبوع.',
    'medium-haul': 'رحلات متوسطة المدى أرخص عند الحجز 3-4 أسابيع مقدماً. الثلاثاء والأربعاء عادة ما يكون لهما أفضل أسعار.',
    'long-haul': 'رحلات طويلة المدى تحتاج تخطيط 6-8 أسابيع مقدماً. الأسعار تنخفض عادة من الثلاثاء إلى الخميس.'
  },
  'tr': {
    'short-haul': 'Kısa mesafeli uçuşlar 2-3 hafta öncesinden rezerve edilmelidir. Hafta içi uçuşlar genellikle daha uygun fiyatlıdır.',
    'medium-haul': 'Orta mesafeli uçuşlar 3-4 hafta öncesinden rezerve edildiğinde daha ucuzdur. Salı ve çarşamba en iyi fiyatlara sahiptir.',
    'long-haul': 'Uzun mesafeli uçuşlar 6-8 hafta öncesinden planlanmalıdır. Fiyatlar genellikle salı ile perşembe arasında düşer.'
  }
};

const MONEY_SAVING_TIPS = {
  'en': {
    'short-haul': 'Set up price alerts for this route—fares change rapidly on competitive short-haul markets. Flying on Tuesday or Wednesday can save 10-20% compared to Friday departures.',
    'medium-haul': 'Flexible travel dates can unlock significant savings. Being flexible by even a day or two can reduce your fare substantially. Consider traveling during shoulder seasons.',
    'long-haul': 'Subscribe to newsletters from airlines serving this route. International flights often have sales that aren\'t advertised widely. Avoid peak travel months for the best rates.'
  },
  'de': {
    'short-haul': 'Einstellungen für Preisalarme sparen Zeit und Geld. Flüge unter der Woche sparen oft 10-20% gegenüber Wochenendflügen.',
    'medium-haul': 'Flexible Reisedaten ermöglichen große Einsparungen. Schon ein Tag Flexibilität kann den Preis deutlich senken.',
    'long-haul': 'Abonniere Newsletter von Airlines, die diese Strecke bedienen. Internationale Flüge haben oft Sonderangebote, die nicht allgemein bekannt sind.'
  },
  'fr': {
    'short-haul': 'Configurez des alertes de prix pour cette route. Les vols en semaine économisent souvent 10-20% par rapport aux départs du vendredi.',
    'medium-haul': 'Les dates flexibles permettent d\'économiser considérablement. Être flexible de quelques jours peut réduire votre tarif de façon substantielle.',
    'long-haul': 'Abonnez-vous à la newsletter des compagnies aériennes desservant cette route. Les vols internationaux ont souvent des promotions discrètes.'
  },
  'es': {
    'short-haul': 'Configura alertas de precio para esta ruta. Volar entre semana ahorra 10-20% comparado con vuelos de viernes.',
    'medium-haul': 'Las fechas flexibles permiten ahorrar dinero. Ser flexible incluso un día o dos puede reducir tu tarifa significativamente.',
    'long-haul': 'Suscríbete a boletines de aerolíneas en esta ruta. Los vuelos internacionales tienen a menudo ofertas que no se publicitan ampliamente.'
  },
  'it': {
    'short-haul': 'Imposta avvisi di prezzo per questa rotta. I voli tra settimana spesso risparmiano 10-20% rispetto ai voli del venerdì.',
    'medium-haul': 'Le date flessibili permettono di risparmiare considerevolmente. Essere flessibili anche di un giorno può ridurre significativamente la tariffa.',
    'long-haul': 'Iscriviti alle newsletter delle compagnie aeree che servono questa rotta. I voli internazionali spesso hanno offerte speciali non ampiamente pubblicate.'
  },
  'nl': {
    'short-haul': 'Stel prijswaarschuwingen in voor deze route. Vliegen doordeweeks bespaart vaak 10-20% vergeleken met vrijdagvluchten.',
    'medium-haul': 'Flexibele reisdatums kunnen aanzienlijke besparingen opleveren. Al enkele dagen flexibiliteit kan je tarief aanzienlijk verlagen.',
    'long-haul': 'Abonneer je op nieuwsbrieven van luchtvaartmaatschappijen die deze route bedienen. Internationale vluchten hebben vaak sales die niet breed gepubliceerd worden.'
  },
  'ar': {
    'short-haul': 'قم بإعداد تنبيهات الأسعار لهذه الرحلة. الرحلات يومية تتوفر 10-20% مقارنة برحلات الجمعة.',
    'medium-haul': 'تواريخ السفر المرنة توفر مدخرات كبيرة. حتى المرونة ليوم أو يومين يمكن أن تقلل سعرك بشكل كبير.',
    'long-haul': 'اشترك في النشرات الإخبارية لشركات الطيران التي تخدم هذه الرحلة. الرحلات الدولية غالباً ما تحتوي على عروض لا تُعلن على نطاق واسع.'
  },
  'tr': {
    'short-haul': 'Bu rota için fiyat uyarıları ayarlayın. Hafta içi uçuşlar genellikle cuma uçuşlarına kıyasla %10-20 tasarruf sağlar.',
    'medium-haul': 'Esnek seyahat tarihleri önemli tasarruflar sağlayabilir. Birkaç gün bile esnek olmak tarifenizi önemli ölçüde azaltabilir.',
    'long-haul': 'Bu rotayı işleten havayollarının haber bültenlerine abone olun. Uluslararası uçuşlar genellikle yaygın olarak duyurulmayan satışlara sahiptir.'
  }
};

// FAQ templates by route type and language
const FAQ_TEMPLATES = {
  'en': {
    'short-haul': [
      { question: 'How far is the flight from {origin} to {destination}?', answer: 'The flight distance is approximately {distance} km, making it a {haulType} flight. Most direct flights take around {duration} hours.' },
      { question: 'What airlines operate this route?', answer: 'Several major European carriers serve this popular route, including both full-service and low-cost airlines. Check available flights for current schedules and prices.' },
      { question: 'Is there a direct flight from {origin} to {destination}?', answer: 'Direct flights are available on this route, making it convenient for a quick getaway. Flight times vary by airline and day of the week.' }
    ],
    'medium-haul': [
      { question: 'How long is a flight from {origin} to {destination}?', answer: 'The journey spans approximately {distance} km and typically takes {duration} hours of flight time, making it a perfect weekend escape.' },
      { question: 'What\'s the best time to visit {destination}?', answer: 'Each season offers something unique. Spring and fall provide pleasant weather and fewer crowds, while summer is ideal for beach destinations.' },
      { question: 'Are there direct flights available?', answer: 'Yes, direct flights connect these cities regularly. Some itineraries may offer connections, which can sometimes be more economical.' }
    ],
    'long-haul': [
      { question: 'How many hours is the flight from {origin} to {destination}?', answer: 'The flight distance is approximately {distance} km. Direct flights typically take {duration} hours, depending on winds and routing.' },
      { question: 'What amenities are available on long-haul flights?', answer: 'Most airlines on this intercontinental route offer various cabin classes, meal services, and entertainment options. Check your airline\'s website for specific amenities.' },
      { question: 'Do I need a visa for {destination}?', answer: 'Visa requirements depend on your nationality and the destination country. Check your government\'s travel advisory and the destination\'s immigration website.' }
    ]
  },
  'de': {
    'short-haul': [
      { question: 'Wie weit ist der Flug von {origin} nach {destination}?', answer: 'Die Flugstrecke beträgt etwa {distance} km, was es zu einem {haulType} macht. Die meisten Direktflüge dauern etwa {duration} Stunden.' },
      { question: 'Welche Fluggesellschaften bedienen diese Route?', answer: 'Mehrere große europäische Fluggesellschaften bedienen diese beliebte Route, darunter Vollservice- und Low-Cost-Fluggesellschaften.' },
      { question: 'Gibt es einen Direktflug von {origin} nach {destination}?', answer: 'Direktflüge sind auf dieser Route verfügbar und machen den Weg zum Ziel praktisch und bequem.' }
    ],
    'medium-haul': [
      { question: 'Wie lange dauert ein Flug von {origin} nach {destination}?', answer: 'Die Strecke beträgt etwa {distance} km und dauert normalerweise {duration} Stunden Flugzeit, perfekt für einen Wochenendausflug.' },
      { question: 'Was ist die beste Zeit, um {destination} zu besuchen?', answer: 'Jede Jahreszeit hat ihren Reiz. Frühling und Herbst bieten angenehmes Wetter, während der Sommer ideal für Strandreisen ist.' },
      { question: 'Gibt es Direktflüge?', answer: 'Ja, Direktflüge verbinden diese Städte regelmäßig. Manche Verbindungen bieten auch mit Umsteigen interessante Optionen.' }
    ],
    'long-haul': [
      { question: 'Wie viele Stunden dauert der Flug von {origin} nach {destination}?', answer: 'Die Flugstrecke beträgt etwa {distance} km. Direktflüge dauern normalerweise {duration} Stunden, je nach Wind und Flugroute.' },
      { question: 'Welche Annehmlichkeiten sind auf Langstreckenflügen verfügbar?', answer: 'Die meisten Airlines auf dieser Strecke bieten verschiedene Kabinengabeln, Bordverpflegung und Unterhaltungsangebote an.' },
      { question: 'Benötige ich ein Visum für {destination}?', answer: 'Die Visumbestimmungen hängen von Ihrer Nationalität ab. Prüfen Sie die Reisewarnungen Ihrer Regierung und die Einwanderungsbestimmungen.' }
    ]
  }
};

// Introductory paragraphs for routes
const ROUTE_INTROS = {
  'en': {
    'short-haul': `Discover convenient connections between these two vibrant European cities. With multiple daily flights, competitive pricing, and excellent ground transportation, traveling between {origin} and {destination} has never been easier. Whether you're planning a weekend getaway, a business trip, or visiting friends and family, this popular route offers flexibility and reliability.`,
    'medium-haul': `Explore the exciting possibilities of traveling between {origin} and {destination}. This well-established route features regular flights from major carriers, making it simple to plan your journey. The moderate flight duration allows for efficient travel, whether you're seeking a cultural experience, business meeting, or leisurely vacation.`,
    'long-haul': `Embark on a remarkable journey from {origin} to {destination}. This intercontinental route connects two major travel hubs, offering diverse accommodation and entertainment options at both ends. Long-haul travel requires planning, but the rewards of exploring a new continent make it worthwhile. Discover why travelers choose this route for their international adventures.`
  },
  'de': {
    'short-haul': `Entdecken Sie die praktischen Verbindungen zwischen diesen zwei lebendigen europäischen Städten. Mit mehreren täglichen Flügen, wettbewerbsfähigen Preisen und ausgezeichneter Bodeninfrastruktur ist eine Reise zwischen {origin} und {destination} einfacher denn je. Ob Wochenendausflug, Geschäftsreise oder Familienbesuch – diese beliebte Route bietet Flexibilität und Zuverlässigkeit.`,
    'medium-haul': `Erkunden Sie die spannenden Möglichkeiten einer Reise zwischen {origin} und {destination}. Diese etablierte Route bietet regelmäßige Flüge von großen Fluggesellschaften und macht Ihre Reiseplanung einfach. Die moderate Flugdauer ermöglicht effizientes Reisen für kulturelle Erlebnisse oder Geschäftsreisen.`,
    'long-haul': `Begeben Sie sich auf eine bemerkenswerte Reise von {origin} nach {destination}. Diese interkontinentale Route verbindet zwei große Reisedrehscheiben und bietet vielfältige Unterkunfts- und Unterhaltungsmöglichkeiten. Langstreckenreisen erfordern Planung, aber die Möglichkeiten zur Entdeckung eines neuen Kontinents sind es wert.`
  },
  'fr': {
    'short-haul': `Découvrez les connexions pratiques entre ces deux villes européennes dynamiques. Avec plusieurs vols quotidiens, des tarifs compétitifs et d'excellents transports terrestres, voyager entre {origin} et {destination} n'a jamais été aussi facile. Que vous planifiez une escapade de week-end, un voyage d'affaires ou une visite en famille, cette route populaire offre flexibilité et fiabilité.`,
    'medium-haul': `Explorez les possibilités passionnantes de voyager entre {origin} et {destination}. Cette route bien établie propose des vols réguliers de grands transporteurs, facilitant votre planification. La durée de vol modérée permet de voyager efficacement pour les expériences culturelles ou les réunions d'affaires.`,
    'long-haul': `Embarquez pour un voyage remarquable de {origin} à {destination}. Cette route intercontinentale relie deux grands centres de voyage, offrant une variété d'options d'hébergement et de divertissement. Les voyages long-courrier nécessitent une planification, mais les récompenses valent l'effort.`
  },
  'es': {
    'short-haul': `Descubra las conexiones convenientes entre estas dos ciudades europeas vibrantes. Con múltiples vuelos diarios, precios competitivos y excelentes transportes terrestres, viajar entre {origin} y {destination} nunca ha sido tan fácil. Ya sea una escapada de fin de semana, viaje de negocios o visita familiar, esta ruta popular ofrece flexibilidad y confiabilidad.`,
    'medium-haul': `Explore las emocionantes posibilidades de viajar entre {origin} y {destination}. Esta ruta bien establecida cuenta con vuelos regulares de grandes operadores, haciendo simple su planificación. La duración moderada del vuelo permite viajar eficientemente para experiencias culturales o reuniones de negocios.`,
    'long-haul': `Embarque en un viaje extraordinario desde {origin} hacia {destination}. Esta ruta intercontinental conecta dos grandes centros de viaje, ofreciendo diversas opciones de alojamiento y entretenimiento. Los viajes de larga distancia requieren planificación, pero las recompensas de explorar un nuevo continente lo valen.`
  },
  'it': {
    'short-haul': `Scopri i comodi collegamenti tra queste due vivaci città europee. Con più voli giornalieri, prezzi competitivi e eccellenti trasporti terrestri, viaggiare tra {origin} e {destination} non è mai stato così semplice. Che tu stia pianificando una fuga di fine settimana, un viaggio d'affari o una visita familiare, questa popolare rotta offre flessibilità e affidabilità.`,
    'medium-haul': `Esplora le emozionanti possibilità di viaggiare tra {origin} e {destination}. Questa rotta consolidata offre voli regolari da grandi compagnie aeree, semplificando la tua pianificazione. La durata del volo moderato consente di viaggiare efficientemente per esperienze culturali o incontri di affari.`,
    'long-haul': `Intraprendi un viaggio straordinario da {origin} a {destination}. Questa rotta intercontinentale collega due grandi centri di viaggio, offrendo una varietà di opzioni di alloggio e intrattenimento. I viaggi a lungo raggio richiedono pianificazione, ma i premi di esplorare un nuovo continente valgono lo sforzo.`
  },
  'nl': {
    'short-haul': `Ontdek de handige verbindingen tussen deze twee levendige Europese steden. Met meerdere dagelijkse vluchten, competitieve prijzen en uitstekend vervoer aan de grond, reizen tussen {origin} en {destination} is nog nooit zo gemakkelijk geweest. Of je een weekenduitstapje, zakenreis of familiebezoek plant, deze populaire route biedt flexibiliteit en betrouwbaarheid.`,
    'medium-haul': `Verken de opwindende mogelijkheden van reizen tussen {origin} en {destination}. Deze gevestigde route biedt regelmatige vluchten van grote exploitanten, waardoor je planning eenvoudig is. De matige vliegtijd stelt je in staat efficiënt te reizen voor culturele ervaringen of zakenbijeenkomsten.`,
    'long-haul': `Begin aan een opmerkelijke reis van {origin} naar {destination}. Deze intercontinentale route verbindt twee grote reiscentra en biedt diverse verblijfs- en entertainmentopties. Langeafstandstravels vereisen planning, maar de beloningen van het verkennen van een nieuw continent zijn het waard.`
  },
  'ar': {
    'short-haul': `اكتشف الاتصالات المريحة بين هاتين المدينتين الأوروبيتين النابضتين بالحياة. مع عدة رحلات يومية وأسعار منافسة ونقل أرضي ممتاز، أصبح السفر بين {origin} و {destination} أسهل من أي وقت مضى. سواء كنت تخطط لرحلة نهاية أسبوع أو عمل أو زيارة عائلية، توفر هذه الرحلة الشهيرة المرونة والموثوقية.`,
    'medium-haul': `اكتشف إمكانيات السفر المثيرة بين {origin} و {destination}. توفر هذه الرحلة الراسخة رحلات منتظمة من شركات كبرى، مما يجعل التخطيط بسيطاً. تسمح مدة الرحلة المعتدلة بالسفر الفعال للتجارب الثقافية أو اجتماعات الأعمال.`,
    'long-haul': `انطلق في رحلة رائعة من {origin} إلى {destination}. تربط هذه الرحلة بين قارتين مركزي سفر رئيسيين، مما يوفر خيارات إقامة وترفيه متنوعة. السفر لمسافات طويلة يتطلب تخطيطاً، لكن مكافآت استكشاف قارة جديدة تستحق الجهد.`
  },
  'tr': {
    'short-haul': `Bu iki canlı Avrupa şehri arasındaki uygun bağlantıları keşfedin. Birden fazla günlük uçuş, rekabetçi fiyatlar ve mükemmel kara taşımacılığı ile {origin} ve {destination} arasında seyahat etmek hiç olmadığı kadar kolay. İster hafta sonu kaçışı, iş gezisi veya aile ziyareti planlıyor olun, bu popüler rota esneklik ve güvenilirlik sunar.`,
    'medium-haul': `{origin} ve {destination} arasında seyahat etmenin heyecan verici olasılıklarını keşfedin. Bu yerleşik rota büyük operatörlerden düzenli uçuşlar sunarak planlamanızı kolaylaştırır. Orta ölçekli uçuş süresi, kültürel deneyimler veya iş toplantıları için verimli seyahat sağlar.`,
    'long-haul': `{origin} 'dan {destination} 'e dikkat çekici bir yolculuğa başlayın. Bu kıtalar arası rota iki önemli seyahat merkezini bağlar ve çeşitli konaklama ve eğlence seçenekleri sunar. Uzun mesafeli seyahatler planlama gerektirir, ancak yeni bir kıtayı keşfetmenin ödülleri çabaya değer.`
  }
};

// City page descriptions
const CITY_INTROS = {
  'en': 'A vibrant destination offering rich culture, diverse attractions, and excellent connectivity for travelers exploring Europe.',
  'de': 'Ein lebendiges Ziel mit reicher Kultur, vielfältigen Attraktionen und ausgezeichneter Erreichbarkeit für Europareisende.',
  'fr': 'Une destination vibrante offrant une riche culture, des attractions variées et une excellente connectivité pour les voyageurs.',
  'es': 'Un destino vibrante que ofrece cultura rica, atracciones diversas y excelente conectividad para los viajeros.',
  'it': 'Una destinazione vibrante che offre una ricca cultura, attrazioni diverse e un\'ottima connettività per i viaggiatori.',
  'nl': 'Een levendige bestemming met rijke cultuur, diverse attracties en uitstekende connectiviteit voor reizigers.',
  'ar': 'وجهة حيوية توفر ثقافة غنية وجاذبيات متنوعة واتصالات ممتازة للمسافرين.',
  'tr': 'Zengin kültür, çeşitli çekicilikler ve yolcular için mükemmel bağlantılar sunan canlı bir hedef.'
};

// Country page descriptions
const COUNTRY_INTROS = {
  'en': 'A beautiful country with a fascinating history, stunning landscapes, and world-class attractions for every type of traveler.',
  'de': 'Ein wunderschönes Land mit einer faszinierenden Geschichte, atemberaubender Landschaften und Attraktionen von Weltklasse.',
  'fr': 'Un beau pays avec une histoire fascinante, des paysages époustouflants et des attractions de classe mondiale.',
  'es': 'Un hermoso país con una historia fascinante, paisajes impresionantes y atracciones de clase mundial para todo tipo de viajero.',
  'it': 'Un bellissimo paese con una storia affascinante, paesaggi mozzafiato e attrazioni di classe mondiale.',
  'nl': 'Een prachtig land met een fascinerende geschiedenis, adembenemende landschappen en wereldklasse attracties.',
  'ar': 'دولة جميلة بتاريخ رائع وأنظار خاذة للأنفاس وجاذبيات عالمية المستوى.',
  'tr': 'Büyüleyici tarihi, nefes kesen manzaraları ve dünya çapında çekicilikleri olan güzel bir ülke.'
};

// Generate unique intro text for a route page
function generateRouteIntroText(origin, destination, distance, haulType, language = 'en') {
  if (!ROUTE_INTROS[language]) language = 'en';
  let text = ROUTE_INTROS[language][haulType] || ROUTE_INTROS[language]['short-haul'];
  text = text.replace(/{origin}/g, origin).replace(/{destination}/g, destination);
  return text;
}

// Generate SEO title for route
function generateRouteTitle(origin, destination, language = 'en') {
  const titles = {
    'en': `Flights from {origin} to {destination} | Book Cheap Tickets`,
    'de': `Flüge von {origin} nach {destination} | Günstige Tickets buchen`,
    'fr': `Vols de {origin} à {destination} | Réservez des billets pas chers`,
    'es': `Vuelos de {origin} a {destination} | Reserva billetes baratos`,
    'it': `Voli da {origin} a {destination} | Prenota biglietti economici`,
    'nl': `Vluchten van {origin} naar {destination} | Goedkope tickets boeken`,
    'ar': `رحلات من {origin} إلى {destination} | احجز تذاكر رخيصة`,
    'tr': `{origin}'den {destination}'e uçuşlar | Ucuz biletler rezervasyonu`
  };

  let title = titles[language] || titles['en'];
  return title.replace(/{origin}/g, origin).replace(/{destination}/g, destination);
}

// Generate meta description
function generateMetaDescription(origin, destination, haulType, language = 'en') {
  const descriptions = {
    'en': {
      'short-haul': `Find and compare cheap flights from {origin} to {destination}. Book direct flights, see schedules, and get the best fares on this popular European route.`,
      'medium-haul': `Discover affordable flights from {origin} to {destination}. Compare prices from major airlines, find direct flights, and plan your European getaway with ease.`,
      'long-haul': `Book your international flight from {origin} to {destination}. Compare prices, find the best deals, and start your intercontinental adventure today.`
    },
    'de': {
      'short-haul': `Günstige Flüge von {origin} nach {destination} vergleichen und buchen. Direktflüge finden, Preise vergleichen und beste Tarife sichern.`,
      'medium-haul': `Erschwingliche Flüge von {origin} nach {destination} entdecken. Preise vergleichen, Direktflüge finden und Ihre Europareise planen.`,
      'long-haul': `Buchen Sie Ihren internationalen Flug von {origin} nach {destination}. Preise vergleichen, beste Angebote finden und Ihr Abenteuer beginnen.`
    }
  };

  let desc = descriptions[language]?.[haulType] || descriptions['en']?.[haulType] || descriptions['en']['short-haul'];
  return desc.replace(/{origin}/g, origin).replace(/{destination}/g, destination);
}

// Generate FAQ for route
function generateRouteFaq(origin, destination, distance, duration, haulType, language = 'en') {
  if (!FAQ_TEMPLATES[language]) language = 'en';
  const templates = FAQ_TEMPLATES[language][haulType] || FAQ_TEMPLATES[language]['short-haul'];

  return templates.map(template => ({
    question: template.question
      .replace(/{origin}/g, origin)
      .replace(/{destination}/g, destination),
    answer: template.answer
      .replace(/{origin}/g, origin)
      .replace(/{destination}/g, destination)
      .replace(/{distance}/g, Math.round(distance))
      .replace(/{duration}/g, Math.round(duration))
      .replace(/{haulType}/g, haulType)
  }));
}

// Classify haul type from distance
function classifyHaulType(distanceKm) {
  if (distanceKm < 1500) return 'short-haul';
  if (distanceKm < 4000) return 'medium-haul';
  return 'long-haul';
}

// Estimate flight duration in hours
function estimateFlightDuration(distanceKm) {
  const CRUISE_SPEED = 800; // km/h typical cruise speed
  const BOARDING_TAXIING = 0.5; // hours for boarding, taxiing, landing
  return BOARDING_TAXIING + (distanceKm / CRUISE_SPEED);
}

module.exports = {
  generateRouteIntroText,
  generateRouteTitle,
  generateMetaDescription,
  generateRouteFaq,
  classifyHaulType,
  estimateFlightDuration,
  BEST_TIME_ADVICE,
  MONEY_SAVING_TIPS,
  CITY_INTROS,
  COUNTRY_INTROS,
  HAUL_DESCRIPTIONS
};
