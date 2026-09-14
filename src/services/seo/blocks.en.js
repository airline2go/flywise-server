// English route SEO block pack. Written as native English copy and populated only with observed route facts.
const { pick } = require('./compose');
const INTRO_ANGLES = {
  price: [c => `${c.o} to ${c.d} is a route worth comparing on more than the headline fare. Current route signals show where price, timing and flight choice matter most.`],
  duration: [c => `For ${c.o} to ${c.d}, total travel time can be as important as the ticket price. The observed route data helps put the journey in practical context.`],
  airline: [c => `${c.o} to ${c.d} offers airline choice worth comparing carefully. Schedules, fare rules and baggage can change the best option even when headline prices look similar.`],
  business: [c => `A direct flight can change the balance between price and convenience on the ${c.o} to ${c.d} route. Here is what the observed connectivity data shows.`],
  destination: [c => `${c.o} to ${c.d} connects two markets with different travel patterns. The route data highlights the practical factors travellers should compare.`],
  seasonal: [c => `Planning ${c.o} to ${c.d} around recent route signals can help you compare price, availability and timing before booking.`],
  weekend: [c => `${c.o} to ${c.d} can suit different trip styles depending on schedules, fares and connection options. Compare the route signals before choosing.`],
  family: [c => `For longer journeys from ${c.o} to ${c.d}, connection quality, timing and comfort can matter alongside price.`],
  airport: [c => `The airports behind ${c.o} to ${c.d} are part of the journey too. Comparing the route means looking beyond the ticket price.`],
  traveler: [c => `Choosing between ${c.o} and ${c.d} flights is easier when price, timing, airline choice and connections are considered together.`],
};
const BLOCKS = [
  { id:'overview', weight:()=>100, applicable:c=>true, render:c=>({heading:'Route overview',body:`${c.o} and ${c.d} are about ${c.km} km apart by air. The route is classified as ${c.haul}. ${c.fmtDur ? `Observed flight time is around ${c.fmtDur}. ` : ''}${c.airlineCount ? `${c.airlineCount} airlines are represented in the route data. ` : ''}Use these figures as a guide and check the exact itinerary for your travel date.`}) },
  { id:'price-analysis', weight:c=>c.facts.has('price')?8:0, applicable:c=>c.facts.has('price'), render:c=>({heading:'Prices and fare context',body:`Observed fares start at about ${c.priceMin != null ? Math.round(c.priceMin) : 'the available fare'} EUR${c.priceMax && c.priceMax>c.priceMin?` and can reach around ${Math.round(c.priceMax)} EUR`:''}. ${c.priceTrend==='up'?'Recent pricing has been trending upward.':c.priceTrend==='down'?'Recent pricing has been trending downward.':'Recent pricing has been comparatively stable.'} Prices are snapshots and can change with date and availability.`}) },
  { id:'airline-analysis', weight:c=>c.facts.has('airlines')?7:0, applicable:c=>c.facts.has('airlines'), render:c=>({heading:'Airlines and choice',body:`${c.airlineCount||'Several'} airlines are represented in the route data. Compare schedules, baggage rules, fare conditions and total journey time rather than the headline fare alone.`}) },
  { id:'direct-analysis', weight:c=>c.facts.has('directness')?6:0, applicable:c=>c.facts.has('directness'), render:c=>({heading:'Direct flights and connections',body:c.directB==='all-direct'?`All observed options are direct, so there is no connection to manage.`:c.directB==='connections-only'?`The observed data does not show a direct option. Allow enough time for the connection and check the transfer airport.`:`Direct and connecting options are represented. A direct flight usually saves time, while a connection can add schedule or fare choice.`}) },
  { id:'airport-detail', weight:()=>4, applicable:c=>true, render:c=>({heading:'Airport details',body:`${c.o} uses ${c.oIata||'the origin airport'} and ${c.d} uses ${c.dIata||'the destination airport'}. Check terminal and ground-transport information close to departure.`}) },
  { id:'travel-planning', weight:()=>3, applicable:c=>true, render:c=>({heading:'Planning the trip',body:`Compare departure times, baggage, connection length and the total door-to-door journey. ${c.haul==='long-haul'?'For a long-haul trip, comfort and connection quality can matter as much as the fare.':'For a shorter route, airport access and convenient departure times can outweigh a small fare difference.'}`}) },
];
const FAQ_CANDIDATES = [
 {id:'duration',applicable:c=>c.facts.has('duration'),q:()=> 'How long is the flight?',a:c=>c.fmtDur?`The observed average flight time is around ${c.fmtDur}. Actual journey time depends on the itinerary and connections.`:'Flight time varies by itinerary; check the selected flight for the exact schedule.'},
 {id:'price-from',applicable:c=>c.facts.has('price'),q:()=> 'What price should I expect?',a:c=>`Observed fares start at about ${c.priceMin!=null?Math.round(c.priceMin):'the available fare'} EUR. The final price depends on date, availability and ticket conditions.`},
 {id:'direct',applicable:c=>c.facts.has('directness'),q:()=> 'Are there direct flights?',a:c=>c.directB==='all-direct'?'Yes. The observed options are direct.':c.directB==='connections-only'?'No direct option is currently represented in the route data.':'Yes. Direct options are represented alongside connecting flights.'},
 {id:'airlines',applicable:c=>c.facts.has('airlines'),q:()=> 'Which airlines serve the route?',a:c=>`${c.airlineCount||'Several'} airlines are represented in the available route data.`},
];
const TITLES=[c=>`${c.o} to ${c.d} flights: prices, airlines & flight time | Airpiv`];
const METAS=[c=>`Compare ${c.o} to ${c.d} flights with route data on fares, airlines, flight time and direct options. See the practical details before booking.`];
module.exports={INTRO_ANGLES,BLOCKS,FAQ_CANDIDATES,TITLES,METAS};
