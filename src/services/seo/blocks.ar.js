const AR = {
  h:['نظرة عامة على المسار','الأسعار والتعريفات','شركات الطيران والخيارات','الرحلات المباشرة والتوقفات','تفاصيل المطارات','التخطيط للرحلة'],
  intro:'قارن هذا المسار بالاعتماد على الأسعار وشركات الطيران ومدة الرحلة وخيارات الاتصال المرصودة، دون افتراضات غير مدعومة.',
  price:'الأسعار المرصودة', air:'شركة طيران', direct:'الخيارات المباشرة', airport:'تفاصيل المطارات', plan:'التخطيط للرحلة',
  faq:['كم تستغرق الرحلة؟','ما السعر المتوقع؟','هل توجد رحلات مباشرة؟','ما شركات الطيران التي تشغّل هذا المسار؟'],
  title:c=>`${c.o} إلى ${c.d}: الأسعار وشركات الطيران والمدة | Airpiv`,
  meta:c=>`قارن رحلات ${c.o} إلى ${c.d} باستخدام بيانات المسار المتاحة عن الأسعار وشركات الطيران ومدة الرحلة والخيارات المباشرة.`
};

function makeArabicPack(){
  const l=AR;
  const overview=c=>`${c.o} و${c.d} تفصل بينهما مسافة جوية تقارب ${Math.round(c.km)} كم. ${c.fmtDur?`ومتوسط مدة الرحلة المرصودة نحو ${c.fmtDur}. `:''}${c.airlineCount?`وتظهر ${c.airlineCount} ${l.air} في بيانات المسار. `:''}ويُصنّف المسار ضمن رحلات ${c.haul}.`;
  const price=c=>c.priceMin!=null?`${l.price} تبدأ من نحو ${Math.round(c.priceMin)} يورو${c.priceMax&&c.priceMax>c.priceMin?` وقد تصل إلى نحو ${Math.round(c.priceMax)} يورو`:''}. ${c.priceTrend==='up'?'وتشير البيانات الحديثة إلى ارتفاع الأسعار.':c.priceTrend==='down'?'وتشير البيانات الحديثة إلى انخفاض الأسعار.':'وتبدو الأسعار الحديثة مستقرة نسبيًا.'}`:'بيانات الأسعار المرصودة الموثوقة محدودة حاليًا لهذا المسار.';
  const airline=c=>`تظهر ${c.airlineCount||'عدة'} ${l.air} في بيانات المسار المتاحة. قارن مواعيد الرحلات وسياسة الأمتعة ومدة الرحلة الإجمالية إلى جانب السعر.`;
  const direct=c=>c.directB==='all-direct'?`${l.direct} ممثلة في البيانات المرصودة من دون توقف.`:c.directB==='connections-only'?'لا تُظهر بيانات المسار المرصودة خيارًا مباشرًا حاليًا. انتبه إلى مدة التوقف والمطار.':'توجد خيارات مباشرة وخيارات مع توقف. الرحلة المباشرة قد توفر الوقت، بينما قد يوسع التوقف خيارات المواعيد.';
  const airport=c=>`${c.o} يستخدم ${c.oIata||'مطار المغادرة'} و${c.d} يستخدم ${c.dIata||'مطار الوصول'}. تحقق من مبنى المطار ووسائل النقل الأرضية قبل المغادرة.`;
  const plan=c=>`قارن مواعيد المغادرة والأمتعة ومدة التوقف ووقت الرحلة الإجمالي. ${c.haul==='long-haul'?'في الرحلات الطويلة قد تكون الراحة وجودة التوقف مهمة بقدر أهمية السعر.':'في الرحلات الأقصر قد تكون سهولة الوصول إلى المطار وملاءمة المواعيد أهم من فرق بسيط في السعر.'}`;
  const faq=[
    {id:'duration',applicable:c=>c.facts.has('duration'),q:()=>l.faq[0],a:c=>c.fmtDur?`متوسط مدة الرحلة المرصودة نحو ${c.fmtDur}.`:'لا تتوفر حاليًا مدة رحلة مرصودة موثوقة.'},
    {id:'price-from',applicable:c=>c.facts.has('price'),q:()=>l.faq[1],a:c=>c.priceMin!=null?`تبدأ الأسعار المرصودة من نحو ${Math.round(c.priceMin)} يورو. ويتغير السعر النهائي حسب التاريخ والتوافر.`:'لا يتوفر حاليًا سعر أدنى موثوق.'},
    {id:'direct',applicable:c=>c.facts.has('directness'),q:()=>l.faq[2],a:c=>c.directB==='all-direct'?'نعم، الخيارات المرصودة مباشرة.':c.directB==='connections-only'?'لا يوجد خيار مباشر ممثل حاليًا.':'توجد خيارات مباشرة إلى جانب الرحلات التي تتضمن توقفًا.'},
    {id:'airlines',applicable:c=>c.facts.has('airlines'),q:()=>l.faq[3],a:c=>`تظهر ${c.airlineCount||'عدة'} ${l.air} في بيانات المسار المتاحة.`}
  ];
  const intro=c=>l.intro;
  return {INTRO_ANGLES:{traveler:[intro],price:[intro],duration:[intro],airline:[intro],business:[intro],destination:[intro],seasonal:[intro],weekend:[intro],family:[intro],airport:[intro]},BLOCKS:[
    {id:'overview',weight:()=>100,applicable:()=>true,render:c=>({heading:l.h[0],body:overview(c)})},
    {id:'price-analysis',weight:c=>c.facts.has('price')?8:0,applicable:c=>c.facts.has('price'),render:c=>({heading:l.h[1],body:price(c)})},
    {id:'airline-analysis',weight:c=>c.facts.has('airlines')?7:0,applicable:c=>c.facts.has('airlines'),render:c=>({heading:l.h[2],body:airline(c)})},
    {id:'direct-analysis',weight:c=>c.facts.has('directness')?6:0,applicable:c=>c.facts.has('directness'),render:c=>({heading:l.h[3],body:direct(c)})},
    {id:'airport-detail',weight:()=>4,applicable:()=>true,render:c=>({heading:l.h[4],body:airport(c)})},
    {id:'travel-planning',weight:()=>3,applicable:()=>true,render:c=>({heading:l.h[5],body:plan(c)})}
  ],FAQ_CANDIDATES:faq,TITLES:[l.title],METAS:[l.meta]};
}
module.exports={makeArabicPack};
