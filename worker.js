export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null,{status:204}));
    if (url.pathname !== "/api/ocr") return cors(Response.json({ok:false,error:"not found"},{status:404}));
    if (request.method !== "POST") return cors(Response.json({ok:false,error:"POST only"},{status:405}));
    try{
      if(!env.AI) return cors(Response.json({ok:false,error:"Workers AI binding AI がありません"}));
      const form=await request.formData();
      const mode=String(form.get("mode")||"entry");
      const raw=[];
      if(mode==="entry"){
        const headerFiles=form.getAll("headerFiles").filter(f=>f&&f.arrayBuffer);
        const middleFiles=form.getAll("middleFiles").filter(f=>f&&f.arrayBuffer);
        for(let i=0;i<Math.max(headerFiles.length,middleFiles.length);i++){
          raw.push(await processEntry(headerFiles[i],middleFiles[i],env));
        }
      }else{
        const files=form.getAll("files").filter(f=>f&&f.arrayBuffer);
        for(const f of files) raw.push(await processOne(f,mode,env));
      }
      const merged=merge(raw,mode);
      return cors(Response.json({ok:merged.ok,mode,count:raw.length,merged,raw}));
    }catch(e){ return cors(Response.json({ok:false,error:String(e?.message||e)})); }
  }
};
function cors(res){const h=new Headers(res.headers);h.set("Access-Control-Allow-Origin","*");h.set("Access-Control-Allow-Methods","POST,OPTIONS");h.set("Access-Control-Allow-Headers","Content-Type");return new Response(res.body,{status:res.status,headers:h});}

async function processEntry(headerFile,middleFile,env){
  const race = headerFile ? await ai(env, await bytes(headerFile), promptHeader()) : {data:{}};
  const horses = middleFile ? await ai(env, await bytes(middleFile), promptEntry()) : {data:{}};
  const data={ok:true,race:sRace(race.data.race||{}),horses:sHorses(horses.data.horses||[]),odds:[],result:emptyResult()};
  data.race.headcount = data.horses.length ? String(data.horses.length) : data.race.headcount;
  return {ok:data.horses.length>0,file:(middleFile?.name||headerFile?.name||""),data,rawText:{header:race.rawText,middle:horses.rawText},parsed:{header:race.data,middle:horses.data}};
}
async function processOne(file,mode,env){
  const b=await bytes(file);
  const p = mode==="runs"?promptRuns():mode==="odds"?promptOdds():promptResult();
  const r=await ai(env,b,p);
  let data={ok:true,race:emptyRace(),horses:[],odds:[],result:emptyResult()};
  if(mode==="runs") data.horses=sRuns(r.data.horses||[]);
  if(mode==="odds") data.odds=sOdds(r.data.odds||[]);
  if(mode==="result") data.result=sResult(r.data.result||r.data||{});
  return {ok:meaningful(data,mode),file:file.name,data,rawText:r.rawText,parsed:r.data};
}
async function bytes(file){return new Uint8Array(await file.arrayBuffer());}
async function ai(env,image,prompt){
  const result=await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct",{image,temperature:0,max_tokens:700,prompt});
  const rawText=extractText(result);
  return {rawText,data:parseJSON(rawText)||{}};
}
function extractText(r){if(typeof r==="string")return r;if(r?.response)return r.response;if(r?.text)return r.text;if(r?.result)return typeof r.result==="string"?r.result:JSON.stringify(r.result);return JSON.stringify(r);}
function parseJSON(text){
  if(!text)return null;
  let t=String(text).replace(/```json/gi,"").replace(/```/g,"");
  const s=t.indexOf("{"), e=t.lastIndexOf("}");
  if(s<0||e<s)return null;
  t=t.slice(s,e+1);
  try{return JSON.parse(t);}catch(_){}
  return null;
}

function promptHeader(){return `JSONのみ。説明禁止。コード禁止。反復禁止。
画像からレース情報だけ読む。馬名、オッズ、結果は読まない。
形式:
{"ok":true,"race":{"date":"","place":"","raceNo":"","raceName":"","grade":"","condition":"","age":"","sex":"","surface":"","distance":"","headcount":""}}
開催地は東京/中山/京都/阪神/新潟/福島/中京/小倉/札幌/函館のみ。
グレードは1勝/2勝/3勝/特別/オープン/G3/G2/G1。
条件は定量/別定/ハンデ。年齢は2歳/3歳/3歳以上/4歳以上。対象は牝馬/混合。`; }
function promptEntry(){return `JSONのみ。説明禁止。コード禁止。反復禁止。
画像から出馬表の枠、馬番、馬名だけ読む。
形式:
{"ok":true,"horses":[{"frame":"","no":"","name":""}]}
1行1頭。馬番が読めない行は返さない。推測で同じ馬名を補完しない。`; }
function promptRuns(){return `JSONのみ。説明禁止。コード禁止。反復禁止。
画像から馬番ごとの前走、前2走、前3走だけ読む。
形式:
{"ok":true,"horses":[{"no":"","last1":"","last2":"","last3":""}]}
全馬に同じ値を入れない。読めない値は空文字。`; }
function promptOdds(){return `JSONのみ。説明禁止。コード禁止。反復禁止。
画像から馬番、馬名、単勝オッズだけ読む。
形式:
{"ok":true,"odds":[{"no":"","name":"","odds":""}]}
オッズは2.0や150.9の小数。払戻金は読まない。`; }
function promptResult(){return `JSONのみ。説明禁止。コード禁止。反復禁止。
画像から結果だけ読む。race/horses/oddsは返さない。
形式:
{"ok":true,"result":{"firstNo":"","secondNo":"","thirdNo":"","umaren":"","umarenPay":"","sanrenpuku":"","sanrenpukuPay":""}}
1着2着3着は馬番のみ。馬連は2頭、3連複は3頭。払戻は数字のみ。`; }

function emptyRace(){return{date:"",place:"",raceNo:"",raceName:"",grade:"",condition:"",age:"",sex:"",surface:"",distance:"",headcount:""}}
function emptyResult(){return{firstNo:"",secondNo:"",thirdNo:"",umaren:"",umarenPay:"",sanrenpuku:"",sanrenpukuPay:""}}
function clean(v){return String(v||"").replace(/[ \t\r\n　]/g,"").trim();}
function digits(v){return String(v||"").replace(/[^\d]/g,"");}
function sRace(r){const o=emptyRace();for(const k of Object.keys(o))if(r?.[k])o[k]=clean(r[k]);o.place=place(o.place);o.surface=surface(o.surface);o.distance=dist(o.distance);o.grade=grade(o.grade||o.raceName);o.condition=cond(o.condition||o.raceName);o.age=age(o.age||o.raceName);o.sex=sex(o.sex||o.raceName);if(horseLike(o.raceName))o.raceName="";return o;}
function sHorses(a){const seen=new Set();return (Array.isArray(a)?a:[]).map(h=>({frame:digits(h.frame).slice(0,1),no:digits(h.no).slice(0,2),name:clean(h.name)})).filter(h=>h.no&&!seen.has(h.no)&&seen.add(h.no));}
function sRuns(a){return (Array.isArray(a)?a:[]).map(h=>({no:digits(h.no).slice(0,2),last1:digits(h.last1).slice(0,2),last2:digits(h.last2).slice(0,2),last3:digits(h.last3).slice(0,2)})).filter(h=>h.no);}
function sOdds(a){return (Array.isArray(a)?a:[]).map(o=>({no:digits(o.no).slice(0,2),name:clean(o.name),odds:odds(o.odds)})).filter(o=>o.no&&o.odds);}
function sResult(r){const o=emptyResult();o.firstNo=digits(r.firstNo||r.first).slice(0,2);o.secondNo=digits(r.secondNo||r.second).slice(0,2);o.thirdNo=digits(r.thirdNo||r.third).slice(0,2);const u=combo(r.umaren),s=combo(r.sanrenpuku);o.umaren=len(u)===2?u:"";o.sanrenpuku=len(s)===3?s:"";o.umarenPay=digits(r.umarenPay);o.sanrenpukuPay=digits(r.sanrenpukuPay);return o;}
function combo(v){return String(v||"").replace(/[^\d-]/g,"").replace(/--+/g,"-").replace(/^-|-$/g,"")}
function len(v){return combo(v).split("-").filter(Boolean).length}
function odds(v){let s=String(v||"").replace(/[^\d.]/g,"");if(!s)return"";if(!s.includes(".")&&s.length>=2&&s.length<=4&&Number(s)>99)s=s.slice(0,-1)+"."+s.slice(-1);return s}
function place(v){const m=clean(v).match(/東京|中山|京都|阪神|新潟|福島|中京|小倉|札幌|函館/);return m?m[0]:""}
function surface(v){const s=clean(v);if(s.includes("障"))return"障害";if(s.includes("ダ"))return"ダート";if(s.includes("芝"))return"芝";return""}
function dist(v){const m=String(v||"").match(/(\d{3,4})/);return m?m[1]+"m":""}
function grade(v){const s=clean(v);if(/G1|Ｇ1|GⅠ|GI/.test(s))return"G1";if(/G2|Ｇ2|GⅡ/.test(s))return"G2";if(/G3|Ｇ3|GⅢ/.test(s))return"G3";if(s.includes("オープン")||s.includes("OP"))return"オープン";if(s.includes("特別"))return"特別";if(s.includes("3勝"))return"3勝";if(s.includes("2勝"))return"2勝";if(s.includes("1勝"))return"1勝";return""}
function cond(v){const s=clean(v);if(s.includes("ハンデ"))return"ハンデ";if(s.includes("別定"))return"別定";if(s.includes("定量"))return"定量";return""}
function age(v){const s=clean(v);if(s.includes("4歳以上"))return"4歳以上";if(s.includes("3歳以上"))return"3歳以上";if(s.includes("3歳"))return"3歳";if(s.includes("2歳"))return"2歳";return""}
function sex(v){const s=clean(v);if(s.includes("牝"))return"牝馬";if(s)return"混合";return""}
function horseLike(s){return /ライン|チャペル|ピークス|ビュー|ブルーム|チャイ|ナク|トロピカル|アセン/.test(clean(s))}
function meaningful(d,m){if(m==="entry")return(d.horses||[]).length>0;if(m==="runs")return(d.horses||[]).some(h=>h.last1||h.last2||h.last3);if(m==="odds")return(d.odds||[]).length>0;if(m==="result")return!!(d.result.firstNo||d.result.umaren||d.result.sanrenpuku);return true}
function merge(raw,mode){const m={ok:false,race:emptyRace(),horses:[],odds:[],result:emptyResult()};for(const x of raw.filter(x=>x.ok)){if(mode==="entry"){m.race={...m.race,...nonEmpty(x.data.race)};m.horses=mergeNo(m.horses,x.data.horses)}if(mode==="runs")m.horses=mergeNo(m.horses,x.data.horses);if(mode==="odds")m.odds=mergeNo(m.odds,x.data.odds);if(mode==="result")m.result={...m.result,...nonEmpty(x.data.result)}}m.ok=meaningful(m,mode);return m}
function mergeNo(a,b=[]){const map=new Map();[...a,...b].forEach(x=>{if(x?.no)map.set(String(x.no),{...(map.get(String(x.no))||{}),...nonEmpty(x)})});return[...map.values()].sort((x,y)=>Number(x.no)-Number(y.no))}
function nonEmpty(o){const r={};for(const[k,v]of Object.entries(o||{}))if(v!==""&&v!=null)r[k]=v;return r}
