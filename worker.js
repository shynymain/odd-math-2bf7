export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null,{status:204}));
    if (url.pathname === '/' || url.pathname === '/api/health') return cors(Response.json({ok:true,name:'rev-ocr-worker-split-buttons-v4',version:'2026-04-29'}));
    if (url.pathname !== '/api/ocr') return cors(Response.json({ok:false,error:'Not found'},{status:404}));
    if (request.method !== 'POST') return cors(Response.json({ok:false,error:'POST only'},{status:405}));
    try{
      if(!env.AI) return cors(Response.json({ok:false,error:'Cloudflare Workers AI binding AI がありません'},{status:500}));
      const form=await request.formData();
      const files=form.getAll('files').length?form.getAll('files'):[form.get('file')].filter(Boolean);
      const mode=String(form.get('mode')||'auto');
      const headcount=String(form.get('headcount')||'');
      if(!files.length) return cors(Response.json({ok:false,error:'画像ファイルがありません'},{status:400}));
      const raw=[]; for(const file of files) raw.push(await recognizeOne(env,file,mode,headcount));
      const merged=mergeAll(raw); const ok=raw.some(r=>r.ok)&&(merged.horses.length||merged.odds.length||hasResult(merged.result)||hasRace(merged.race));
      return cors(Response.json({ok,mode,count:files.length,merged,raw}));
    }catch(e){return cors(Response.json({ok:false,error:String(e?.message||e)},{status:500}));}
  }
};
async function recognizeOne(env,file,mode,headcount){
  const image=[...new Uint8Array(await file.arrayBuffer())];
  const prompt=buildPrompt(mode,headcount);
  let aiResult; try{aiResult=await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct',{image,prompt,temperature:0,max_tokens:1800});}catch(e){return{ok:false,file:file.name||'',error:'AI run failed: '+String(e?.message||e),data:emptyData()};}
  const text=normalizeAIText(aiResult); const parsed=parseSingleJSON(text);
  if(!parsed) return{ok:false,file:file.name||'',error:'AI returned non-JSON text',rawText:text.slice(0,3000),data:emptyData()};
  const data=normalizeData(parsed); const meaningful=hasMeaningfulData(data,mode);
  if(!meaningful) return{ok:false,file:file.name||'',error:'JSONにはなりましたが対象データが空です',rawText:text.slice(0,3000),data};
  return{ok:true,file:file.name||'',data,rawText:text.slice(0,3000)};
}
function emptyData(){return{ok:false,race:{name:'',place:'',grade:'',surface:'',distance:''},horses:[],odds:[],result:{firstNo:'',first:'',secondNo:'',second:'',thirdNo:'',third:'',umaren:'',umarenPay:'',sanrenpuku:'',sanrenpukuPay:''}}}
function hasMeaningfulData(d,mode){const h=Array.isArray(d.horses)&&d.horses.some(x=>x.no||x.name||x.last1||x.last2||x.last3),o=Array.isArray(d.odds)&&d.odds.some(x=>x.no||x.name||x.odds),r=hasResult(d.result),rc=hasRace(d.race); if(mode==='race')return rc;if(mode==='entry'||mode==='runs'||mode==='horses')return h;if(mode==='odds')return o;if(mode==='result')return r;return h||o||r||rc;}
function buildPrompt(mode,headcount){
  let target='',required='';
  if(mode==='race'){target='レース情報だけを読む。レース名、開催地、グレード、馬場、距離。';required='raceだけに入れる。開催地は画像に明記された1つだけ。東京と中山など2場を同時に入れない。';}
  else if(mode==='entry'){target='枠番・馬番・馬名だけを読む。';required='horses配列に frame,no,name だけを入れる。last1,last2,last3は空文字。';}
  else if(mode==='runs'||mode==='horses'){target='馬番・馬名・前走着順・前2走着順・前3走着順だけを読む。';required='horses配列に no,name,last1,last2,last3 を入れる。全頭に同じ着順をコピー禁止。見えない着順は空文字。';}
  else if(mode==='odds'){target='単勝オッズだけを読む。馬番・馬名・単勝オッズ。';required='odds配列に no,name,odds を入れる。先頭の数字は必ず馬番。人気は不要。';}
  else if(mode==='result'){target='レース結果と払戻だけを読む。1着、2着、3着、馬連、3連複、払戻金。';required='resultだけに入れる。出馬表や単勝オッズを結果として扱わない。払戻が見えない場合は空文字。';}
  else{target='競馬画像です。読める項目だけ読む。';required='見えるデータだけ返す。補完しない。';}
  return ['競馬画像OCR。JSONオブジェクト1個だけ返す。','説明文、例、Markdown、```、コメント、同じJSONの繰り返しは禁止。','最初は { 、最後は } 。','空テンプレートは禁止。画像に文字が見える場合、必ず実データを入れる。','推測で補完しない。読めない項目は空文字。','表は左から右、上から下。1行=1頭。','同じ馬名や同じ着順列を大量生成しない。','画像に見えない馬番を作らない。8頭なら8頭だけ。',`mode=${mode}`,`headcount=${headcount||''}`,target,required,'返すキーは ok,race,horses,odds,result の5つだけ。','race: name,place,grade,surface,distance','horses要素: frame,no,name,last1,last2,last3','odds要素: no,name,odds','result: firstNo,first,secondNo,second,thirdNo,third,umaren,umarenPay,sanrenpuku,sanrenpukuPay','対象データが全く見えない場合だけ ok:false。'].join('\n');
}
function normalizeAIText(v){if(v==null)return'';if(typeof v==='string')return v.trim();if(typeof v==='number'||typeof v==='boolean')return String(v);if(Array.isArray(v))return v.map(normalizeAIText).filter(Boolean).join('\n').trim();if(typeof v==='object'){if(v.ok!==undefined||v.race||v.horses||v.odds||v.result){try{return JSON.stringify(v)}catch{return''}}for(const k of ['response','result','text','output','content','message','data'])if(v[k]!=null){const x=normalizeAIText(v[k]);if(x)return x}try{return JSON.stringify(v)}catch{return''}}return''}
function parseSingleJSON(text){if(!text)return null;let t=text.trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();try{return JSON.parse(t)}catch{}for(const c of extractJSONObjects(t)){try{return JSON.parse(c)}catch{}}return null}
function extractJSONObjects(text){const out=[];let depth=0,start=-1,inStr=false,esc=false;for(let i=0;i<text.length;i++){const ch=text[i];if(inStr){if(esc)esc=false;else if(ch==='\\')esc=true;else if(ch==='"')inStr=false;continue}if(ch==='"'){inStr=true;continue}if(ch==='{'){if(depth===0)start=i;depth++}if(ch==='}'){depth--;if(depth===0&&start>=0){out.push(text.slice(start,i+1));start=-1}}}return out}
function normalizeData(d){const race=d.race||{},result=d.result||{};let horses=Array.isArray(d.horses)?d.horses.map(h=>({frame:cleanNum(h.frame),no:cleanNum(h.no||h.number),name:cleanName(h.name),last1:cleanNum(h.last1),last2:cleanNum(h.last2),last3:cleanNum(h.last3)})).filter(h=>h.no||h.name):[];horses=removeBadHorses(horses);const odds=Array.isArray(d.odds)?d.odds.map(o=>({no:cleanNum(o.no||o.number),name:cleanName(o.name),odds:cleanOdds(o.odds)})).filter(o=>o.no||o.name||o.odds):[];return{ok:d.ok!==false,race:{name:String(race.name||''),place:String(race.place||''),grade:String(race.grade||''),surface:String(race.surface||''),distance:String(race.distance||'')},horses,odds,result:{firstNo:cleanNum(result.firstNo),first:cleanName(result.first),secondNo:cleanNum(result.secondNo),second:cleanName(result.second),thirdNo:cleanNum(result.thirdNo),third:cleanName(result.third),umaren:cleanTicket(result.umaren),umarenPay:cleanPay(result.umarenPay),sanrenpuku:cleanTicket(result.sanrenpuku),sanrenpukuPay:cleanPay(result.sanrenpukuPay)}}}
function removeBadHorses(horses){if(!Array.isArray(horses)||horses.length<4)return horses||[];const seq=new Map();for(const h of horses){const s=[h.last1,h.last2,h.last3].join('-');if(s!=='--')seq.set(s,(seq.get(s)||0)+1)}const max=Math.max(0,...seq.values());if(max>=Math.ceil(horses.length*.7))return horses.map(h=>({...h,last1:'',last2:'',last3:''}));return horses.filter(h=>Number(h.no||0)>0&&Number(h.no||0)<=30)}
function cleanNum(v){return String(v??'').replace(/[０-９]/g,s=>String.fromCharCode(s.charCodeAt(0)-0xFEE0)).replace(/[^0-9]/g,'')} function cleanOdds(v){return String(v??'').replace(/[０-９．]/g,s=>s==='．'?'.':String.fromCharCode(s.charCodeAt(0)-0xFEE0)).replace(/[^0-9.]/g,'')} function cleanPay(v){return String(v??'').replace(/[０-９]/g,s=>String.fromCharCode(s.charCodeAt(0)-0xFEE0)).replace(/[^0-9]/g,'')} function cleanName(v){return String(v??'').replace(/[《》\[\]{}]/g,'').trim()} function cleanTicket(v){return String(v??'').replace(/[－ー―–]/g,'-').replace(/[^0-9\-]/g,'')} function hasRace(r){return Object.values(r||{}).some(Boolean)} function hasResult(r){return Object.values(r||{}).some(Boolean)}
function mergeAll(raw){const m={race:{name:'',place:'',grade:'',surface:'',distance:''},horses:[],odds:[],result:{firstNo:'',first:'',secondNo:'',second:'',thirdNo:'',third:'',umaren:'',umarenPay:'',sanrenpuku:'',sanrenpukuPay:''}},hm=new Map(),om=new Map();for(const r of raw){if(!r.ok||!r.data)continue;for(const k of Object.keys(m.race))if(!m.race[k]&&r.data.race?.[k])m.race[k]=r.data.race[k];for(const h of r.data.horses||[]){const key=h.no||h.name;if(!key)continue;hm.set(key,{...(hm.get(key)||{}),...Object.fromEntries(Object.entries(h).filter(([,v])=>v))})}for(const o of r.data.odds||[]){const key=o.no||o.name;if(!key)continue;om.set(key,{...(om.get(key)||{}),...Object.fromEntries(Object.entries(o).filter(([,v])=>v))})}for(const k of Object.keys(m.result))if(!m.result[k]&&r.data.result?.[k])m.result[k]=r.data.result[k]}m.horses=[...hm.values()].sort((a,b)=>Number(a.no||999)-Number(b.no||999));m.odds=[...om.values()].sort((a,b)=>Number(a.no||999)-Number(b.no||999));return m}
function cors(res){const h=new Headers(res.headers);h.set('Access-Control-Allow-Origin','*');h.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');h.set('Access-Control-Allow-Headers','Content-Type');return new Response(res.body,{status:res.status,headers:h})}
