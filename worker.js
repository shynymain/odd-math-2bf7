export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname !== "/api/ocr") return cors(Response.json({ ok:false, error:"not found" }, {status:404}));
    if (request.method !== "POST") return cors(Response.json({ ok:false, error:"POST only" }, {status:405}));
    try {
      if (!env.AI) return cors(Response.json({ ok:false, error:"Workers AI binding 'AI' がありません" }));
      const form = await request.formData();
      const mode = form.get("mode") || "entry";
      const files = form.getAll("files").filter(x => x && x.arrayBuffer);
      if (!files.length) return cors(Response.json({ ok:false, error:"画像がありません" }));
      const raw = [];
      for (const file of files) raw.push(await processOne(file, mode, env));
      const merged = mergeResults(raw, mode);
      return cors(Response.json({ ok: merged.ok, mode, count: files.length, merged, raw }));
    } catch (e) {
      return cors(Response.json({ ok:false, error:String(e?.message || e) }));
    }
  }
};

function cors(res){
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin","*");
  h.set("Access-Control-Allow-Methods","POST,OPTIONS");
  h.set("Access-Control-Allow-Headers","Content-Type");
  return new Response(res.body,{status:res.status,headers:h});
}

async function processOne(file, mode, env){
  const bytes = new Uint8Array(await file.arrayBuffer());

  // 3分割実装：
  // Cloudflare Workers AIには画像crop APIがないため、1枚の画像に対して
  // 「上部だけ」「中部だけ」「下部だけ」を見るようプロンプトを分けて3回実行する。
  // これでVision側の注目範囲を固定する。
  if (mode === "entry") {
    const header = await callAI(env, bytes, promptHeader());
    const middle = await callAI(env, bytes, promptEntry());
    const data = {
      ok: true,
      race: sanitizeRace(header.data?.race || {}),
      horses: sanitizeHorses(middle.data?.horses || []),
      odds: [],
      result: emptyResult()
    };
    data.race.headcount = data.horses.length ? String(data.horses.length) : (data.race.headcount || "");
    return { ok: meaningful(data, mode), file:file.name, data, rawText:{header:header.rawText, middle:middle.rawText}, parsed:{header:header.data, middle:middle.data} };
  }

  if (mode === "runs") {
    const middle = await callAI(env, bytes, promptRuns());
    const data = { ok:true, race:emptyRace(), horses:sanitizeRuns(middle.data?.horses || []), odds:[], result:emptyResult() };
    return { ok: meaningful(data, mode), file:file.name, data, rawText:middle.rawText };
  }

  if (mode === "odds") {
    const lower = await callAI(env, bytes, promptOdds());
    const data = { ok:true, race:emptyRace(), horses:[], odds:sanitizeOdds(lower.data?.odds || []), result:emptyResult() };
    return { ok: meaningful(data, mode), file:file.name, data, rawText:lower.rawText };
  }

  if (mode === "result") {
    const lower = await callAI(env, bytes, promptResult());
    const data = { ok:true, race:emptyRace(), horses:[], odds:[], result:sanitizeResult(lower.data?.result || lower.data || {}) };
    return { ok: meaningful(data, mode), file:file.name, data, rawText:lower.rawText };
  }

  const auto = await callAI(env, bytes, promptEntry());
  return { ok:true, file:file.name, data:auto.data, rawText:auto.rawText };
}

async function callAI(env, image, prompt){
  const result = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
    image,
    temperature: 0,
    max_tokens: 1200,
    prompt
  });
  const rawText = extractText(result);
  const data = parseJson(rawText) || {};
  return { rawText, data };
}

function extractText(r){
  if (typeof r === "string") return r;
  if (r?.response) return r.response;
  if (r?.text) return r.text;
  if (r?.result) return typeof r.result === "string" ? r.result : JSON.stringify(r.result);
  return JSON.stringify(r);
}

function parseJson(text){
  if (!text) return null;
  let t = String(text).replace(/```json/gi,"```").replace(/```/g,"");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  t = t.slice(start,end+1);
  try { return JSON.parse(t); } catch(e) {}
  // 複数JSONや説明文混入時、最初に成立するJSONだけを拾う
  for (let i=end; i>start; i--) {
    try { return JSON.parse(t.slice(0,i-start+1)); } catch(e) {}
  }
  return null;
}

function promptHeader(){ return `
あなたは競馬画像OCRです。
画像の「上部ヘッダー」だけを見てください。表の馬名・オッズ・結果は読まない。
出力はJSON 1個だけ。説明禁止。推測禁止。読めない項目は空文字。

返すJSON:
{
 "ok": true,
 "race": {
   "date": "",
   "place": "",
   "raceNo": "",
   "raceName": "",
   "grade": "",
   "condition": "",
   "age": "",
   "sex": "",
   "surface": "",
   "distance": "",
   "headcount": ""
 }
}

抽出ルール:
- 開催地は画像上部にある競馬場名だけ。東京/中山/京都/阪神/新潟/福島/中京/小倉/札幌/函館。
- raceNameに馬名を入れない。
- gradeは 1勝/2勝/3勝/特別/オープン/G3/G2/G1 のどれか。
- conditionは 定量/別定/ハンデ のどれか。
- ageは 2歳/3歳/3歳以上/4歳以上 のどれか。
- sexは 牝馬限定なら牝馬、それ以外は混合。
- surfaceは 芝/ダート/障害。
- distanceは 1600m の形式。
`; }

function promptEntry(){ return `
あなたは競馬出馬表OCRです。
画像の「中央の出馬表」だけを見てください。上部ヘッダー・下部オッズ・結果は無視。
出力はJSON 1個だけ。説明禁止。推測禁止。読めない馬名は空文字。

返すJSON:
{
 "ok": true,
 "horses": [
   {"frame":"","no":"","name":""}
 ]
}

抽出ルール:
- 1行=1頭。
- 枠、馬番、馬名だけ返す。
- 着順、オッズ、払戻は返さない。
- 同じ馬名を勝手に補完しない。
- 馬番が読めない行は返さない。
`; }

function promptRuns(){ return `
あなたは競馬出馬表OCRです。
画像の「着順欄」だけを見てください。
出力はJSON 1個だけ。説明禁止。推測禁止。読めない値は空文字。

返すJSON:
{
 "ok": true,
 "horses": [
   {"no":"","last1":"","last2":"","last3":""}
 ]
}

抽出ルール:
- 馬番ごとの前走、前2走、前3走だけ返す。
- 馬名、オッズ、結果、レース情報は返さない。
- 全馬に同じ着順を入れない。
`; }

function promptOdds(){ return `
あなたは単勝オッズOCRです。
画像の「単勝オッズ一覧」だけを見てください。
出力はJSON 1個だけ。説明禁止。推測禁止。

返すJSON:
{
 "ok": true,
 "odds": [
   {"no":"","name":"","odds":""}
 ]
}

抽出ルール:
- 馬番、馬名、単勝オッズだけ返す。
- 人気は返さない。
- 払戻金や着順は単勝オッズに入れない。
- オッズは 2.0 / 150.9 のような小数で返す。
`; }

function promptResult(){ return `
あなたは競馬結果OCRです。
画像の「結果・払戻」だけを見てください。
出力はJSON 1個だけ。説明禁止。推測禁止。
race/horses/oddsは絶対に返さない。

返すJSON:
{
 "ok": true,
 "result": {
   "firstNo": "",
   "secondNo": "",
   "thirdNo": "",
   "umaren": "",
   "umarenPay": "",
   "sanrenpuku": "",
   "sanrenpukuPay": ""
 }
}

抽出ルール:
- 1着、2着、3着は馬番だけ。
- 馬連は必ず2頭の組み合わせ。例: 3-7
- 3連複は必ず3頭の組み合わせ。例: 3-4-7
- 払戻は円記号なしの数字。
- 馬名、枠、単勝、人気、レース情報は返さない。
`; }

function emptyRace(){ return {date:"",place:"",raceNo:"",raceName:"",grade:"",condition:"",age:"",sex:"",surface:"",distance:"",headcount:""}; }
function emptyResult(){ return {firstNo:"",secondNo:"",thirdNo:"",umaren:"",umarenPay:"",sanrenpuku:"",sanrenpukuPay:""}; }

function sanitizeRace(r){
  const out = emptyRace();
  for (const k of Object.keys(out)) if (r?.[k]) out[k] = clean(String(r[k]));
  if (r?.name && !out.raceName && !looksHorseName(r.name)) out.raceName = clean(String(r.name));
  if (looksHorseName(out.raceName)) out.raceName = "";
  out.place = normalizePlace(out.place);
  out.grade = normalizeGrade(out.grade || out.raceName);
  out.condition = normalizeCondition(out.condition || out.raceName);
  out.age = normalizeAge(out.age || out.raceName);
  out.sex = normalizeSex(out.sex || out.raceName);
  out.surface = normalizeSurface(out.surface);
  out.distance = normalizeDistance(out.distance);
  return out;
}
function sanitizeHorses(arr){
  const seen = new Set();
  return (Array.isArray(arr)?arr:[]).map(h=>({
    frame: digits(h.frame).slice(0,1),
    no: digits(h.no).slice(0,2),
    name: clean(h.name || "")
  })).filter(h=>h.no && !seen.has(h.no) && seen.add(h.no));
}
function sanitizeRuns(arr){
  return (Array.isArray(arr)?arr:[]).map(h=>({
    no: digits(h.no).slice(0,2),
    last1: digits(h.last1).slice(0,2),
    last2: digits(h.last2).slice(0,2),
    last3: digits(h.last3).slice(0,2)
  })).filter(h=>h.no);
}
function sanitizeOdds(arr){
  return (Array.isArray(arr)?arr:[]).map(o=>({
    no: digits(o.no).slice(0,2),
    name: clean(o.name || ""),
    odds: normalizeOdds(o.odds)
  })).filter(o=>o.no && o.odds);
}
function sanitizeResult(r){
  const out = emptyResult();
  out.firstNo = digits(r.firstNo || r.first || "").slice(0,2);
  out.secondNo = digits(r.secondNo || r.second || "").slice(0,2);
  out.thirdNo = digits(r.thirdNo || r.third || "").slice(0,2);
  const u = normalizeCombo(r.umaren);
  const s = normalizeCombo(r.sanrenpuku);
  out.umaren = comboLen(u)===2 ? u : "";
  out.sanrenpuku = comboLen(s)===3 ? s : "";
  out.umarenPay = digits(r.umarenPay);
  out.sanrenpukuPay = digits(r.sanrenpukuPay);
  return out;
}

function mergeResults(raw, mode){
  const merged = { ok:false, race:emptyRace(), horses:[], odds:[], result:emptyResult() };
  const good = raw.filter(x=>x.ok && x.data);
  if (mode==="entry") {
    for (const x of good) {
      merged.race = {...merged.race, ...nonEmpty(x.data.race)};
      merged.horses = mergeByNo(merged.horses, x.data.horses || []);
    }
    merged.race.headcount = merged.horses.length ? String(merged.horses.length) : merged.race.headcount;
  }
  if (mode==="runs") for (const x of good) merged.horses = mergeByNo(merged.horses, x.data.horses || []);
  if (mode==="odds") for (const x of good) merged.odds = mergeByNo(merged.odds, x.data.odds || []);
  if (mode==="result") for (const x of good) merged.result = {...merged.result, ...nonEmpty(x.data.result)};
  merged.ok = meaningful(merged, mode);
  return merged;
}
function mergeByNo(a,b){
  const m = new Map();
  [...a,...b].forEach(x=>{ if(x?.no) m.set(String(x.no), {...(m.get(String(x.no))||{}), ...nonEmpty(x)}); });
  return [...m.values()].sort((x,y)=>Number(x.no)-Number(y.no));
}
function nonEmpty(o){ const r={}; for(const [k,v] of Object.entries(o||{})) if(v!=="" && v!==null && v!==undefined) r[k]=v; return r; }
function meaningful(d,mode){
  if(mode==="entry") return (d.horses||[]).length>0;
  if(mode==="runs") return (d.horses||[]).some(h=>h.last1||h.last2||h.last3);
  if(mode==="odds") return (d.odds||[]).length>0;
  if(mode==="result") return !!(d.result?.firstNo || d.result?.umaren || d.result?.sanrenpuku);
  return true;
}
function clean(v){ return String(v||"").replace(/[ \t\r\n　]/g,"").trim(); }
function digits(v){ return String(v||"").replace(/[^\d]/g,""); }
function normalizeCombo(v){ return String(v||"").replace(/[^\d\-]/g,"").replace(/--+/g,"-").replace(/^-|-$/g,""); }
function comboLen(v){ return normalizeCombo(v).split("-").filter(Boolean).length; }
function normalizeOdds(v){
  let s = String(v||"").replace(/[^\d.]/g,"");
  if (!s) return "";
  if (!s.includes(".") && s.length>=2 && Number(s)>99) {
    // 405 -> 40.5, 1509 -> 150.9 の補正。ただし払戻のような4桁以上は除外気味
    if (s.length <= 4) s = s.slice(0,-1)+"."+s.slice(-1);
  }
  return s;
}
function normalizePlace(v){ const s=clean(v); const m=s.match(/(東京|中山|京都|阪神|新潟|福島|中京|小倉|札幌|函館)/); return m?m[1]:""; }
function normalizeSurface(v){ const s=clean(v); if(s.includes("障"))return"障害"; if(s.includes("ダ"))return"ダート"; if(s.includes("芝"))return"芝"; return ""; }
function normalizeDistance(v){ const m=String(v||"").match(/(\d{3,4})\s*m?/i); return m?m[1]+"m":""; }
function normalizeGrade(v){ const s=clean(v); if(/G1|Ｇ1|GI|ＧⅠ|GⅠ/.test(s))return"G1"; if(/G2|Ｇ2|GⅡ|ＧⅡ/.test(s))return"G2"; if(/G3|Ｇ3|GⅢ|ＧⅢ/.test(s))return"G3"; if(s.includes("オープン")||s.includes("OP"))return"オープン"; if(s.includes("特別"))return"特別"; if(s.includes("3勝"))return"3勝"; if(s.includes("2勝"))return"2勝"; if(s.includes("1勝"))return"1勝"; return ""; }
function normalizeCondition(v){ const s=clean(v); if(s.includes("ハンデ"))return"ハンデ"; if(s.includes("別定"))return"別定"; if(s.includes("定量"))return"定量"; return ""; }
function normalizeAge(v){ const s=clean(v); if(s.includes("4歳以上"))return"4歳以上"; if(s.includes("3歳以上"))return"3歳以上"; if(s.includes("3歳"))return"3歳"; if(s.includes("2歳"))return"2歳"; return ""; }
function normalizeSex(v){ const s=clean(v); if(s.includes("牝"))return"牝馬"; if(s) return "混合"; return ""; }
function looksHorseName(v){ const s=clean(v); return /ライン|チャペル|ピークス|ビュー|ブルーム|ナク|チャイ|トロピカル|アセン/.test(s); }
