function empty(){return {ok:false,race:{date:"",place:"",surface:"",raceNo:"",name:"",grade:"",condition:"",distance:""},horses:[],odds:[],result:{firstNo:"",secondNo:"",thirdNo:"",umaren:"",umarenPay:"",sanrenpuku:"",sanrenpukuPay:""}}}
function cors(r){r.headers.set('Access-Control-Allow-Origin','*');r.headers.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');r.headers.set('Access-Control-Allow-Headers','Content-Type');return r}
function textFromAI(x){ if(typeof x==='string')return x; if(x?.response)return x.response; if(x?.result?.response)return x.result.response; if(x?.description)return x.description; return JSON.stringify(x); }
function extractJSON(t){ const s=String(t||''); const fence=s.match(/```json\s*([\s\S]*?)```/i)||s.match(/```\s*([\s\S]*?)```/); const src=fence?fence[1]:s; const a=src.indexOf('{'), b=src.lastIndexOf('}'); if(a<0||b<a)return null; try{return JSON.parse(src.slice(a,b+1));}catch{return null;} }
function meaningful(mode,d){ if(!d)return false; if(mode==='entry')return Array.isArray(d.horses)&&d.horses.some(h=>h.no&&h.name); if(mode==='runs')return Array.isArray(d.horses)&&d.horses.some(h=>h.no&&(h.last1||h.last2||h.last3)); if(mode==='odds')return Array.isArray(d.odds)&&d.odds.some(o=>o.no&&o.odds); if(mode==='result')return d.result&&(d.result.firstNo||d.result.umaren||d.result.sanrenpuku); return false; }
function sanitize(mode,d){ const e=empty(); d=d||{}; if(mode==='entry'){
  e.ok=true; e.race={...e.race,...(d.race||{})}; e.horses=(d.horses||[]).map(h=>({frame:String(h.frame||''),no:String(h.no||h.number||''),name:String(h.name||'')})).filter(h=>h.no||h.name);
 }
 if(mode==='runs'){ e.ok=true; e.horses=(d.horses||[]).map(h=>({no:String(h.no||h.number||''),last1:String(h.last1||''),last2:String(h.last2||''),last3:String(h.last3||'')})).filter(h=>h.no); }
 if(mode==='odds'){ e.ok=true; e.odds=(d.odds||[]).map(o=>({no:String(o.no||o.number||''),name:String(o.name||''),odds:String(o.odds||'').replace(/,/g,'')})).filter(o=>o.no&&o.odds); }
 if(mode==='result'){ const r=d.result||{}; e.ok=true; e.result={firstNo:String(r.firstNo||''),secondNo:String(r.secondNo||''),thirdNo:String(r.thirdNo||''),umaren:String(r.umaren||''),umarenPay:String(r.umarenPay||'').replace(/,/g,''),sanrenpuku:String(r.sanrenpuku||''),sanrenpukuPay:String(r.sanrenpukuPay||'').replace(/,/g,'')}; }
 return e;
}
function prompt(mode){
 const base='You are a Japanese horse racing OCR extractor. Return ONE valid JSON object only. No markdown. No explanation. Do not infer unseen values. Empty string for unreadable.';
 if(mode==='entry')return `${base}\nExtract entry table only plus race info visible in the entry image. JSON keys: ok,race,horses. race:{date,place,surface,raceNo,name,grade,condition,distance}. horses:[{frame,no,name}]. place must be actual visible racecourse such as Tokyo/Nakayama/Kyoto etc, not horse name. condition must be one of 定量, 別定, ハンデ only when visible.`;
 if(mode==='runs')return `${base}\nExtract previous finish positions only. JSON keys: ok,horses. horses:[{no,last1,last2,last3}]. Do not output race, odds, result.`;
 if(mode==='odds')return `${base}\nExtract win odds list only. JSON keys: ok,odds. odds:[{no,name,odds}]. The first number in each row is horse number. Do not output result.`;
 return `${base}\nExtract race result and payouts only. JSON keys: ok,result. result:{firstNo,secondNo,thirdNo,umaren,umarenPay,sanrenpuku,sanrenpukuPay}. Do not output race,horses,odds. Umaren must be exactly two horse numbers. Sanrenpuku exactly three.`;
}
export default {async fetch(request,env){
 if(request.method==='OPTIONS')return cors(new Response(null,{status:204}));
 if(new URL(request.url).pathname!='/api/ocr')return cors(Response.json({ok:true,service:'rev-ocr-v10'}));
 try{
  if(!env.AI)return cors(Response.json({ok:false,error:'AI binding missing'}));
  const fd=await request.formData(); const mode=fd.get('mode')||'entry'; const files=fd.getAll('files').length?fd.getAll('files'):[fd.get('file')].filter(Boolean);
  const raw=[]; let merged=empty(); merged.ok=true;
  for(const file of files){
   const image=new Uint8Array(await file.arrayBuffer()); const ai=await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct',{image,prompt:prompt(mode),temperature:0,max_tokens:1600});
   const rawText=textFromAI(ai); const parsed=extractJSON(rawText); const data=sanitize(mode,parsed);
   if(!meaningful(mode,data)){ raw.push({ok:false,file:file.name,error:'not meaningful',rawText,data}); continue; }
   raw.push({ok:true,file:file.name,data,rawText});
   if(mode==='entry'){ merged.race={...merged.race,...data.race}; merged.horses.push(...data.horses); }
   if(mode==='runs') merged.horses.push(...data.horses);
   if(mode==='odds') merged.odds.push(...data.odds);
   if(mode==='result') merged.result={...merged.result,...data.result};
  }
  const okCount=raw.filter(x=>x.ok).length; return cors(Response.json({ok:okCount||false,mode,count:files.length,merged,raw}));
 }catch(e){return cors(Response.json({ok:false,error:String(e?.message||e)}));}
}};
