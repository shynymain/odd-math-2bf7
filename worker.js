export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/" || url.pathname === "/api/health") return json({ ok: true, service: "rev-full-auto-ocr-worker", time: new Date().toISOString() });
    if (url.pathname !== "/api/ocr") return json({ ok: false, error: "Not found. Use /api/ocr" }, 404);
    if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
    if (!env.AI) return json({ ok: false, error: "Workers AI binding がありません。Cloudflareで binding 名 AI を追加してください。" }, 500);

    try {
      const form = await request.formData();
      const mode = String(form.get("mode") || "auto");
      const headcount = Number(form.get("headcount") || 0);
      const files = [...form.getAll("files"), ...form.getAll("file")].filter(v => v && typeof v.arrayBuffer === "function");
      if (!files.length) return json({ ok: false, error: "画像ファイルがありません" }, 400);

      const raw = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const bytes = new Uint8Array(await file.arrayBuffer());
        const prompt = buildPrompt({ mode, index: i + 1, total: files.length, headcount });
        const ai = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
          image: bytes,
          prompt,
          temperature: 0,
          max_tokens: 2200
        });
        const text = normalizeAIText(ai);
        const parsed = extractJSON(text);
        if (parsed) raw.push({ ok: true, file: file.name || `image-${i+1}`, data: sanitize(parsed), rawText: text.slice(0, 4000) });
        else raw.push({ ok: false, file: file.name || `image-${i+1}`, error: "AI returned non-JSON text", rawText: text.slice(0, 6000) });
      }
      const merged = mergeData(raw.map(r => r.data).filter(Boolean));
      const ok = raw.some(r => r.ok) && (merged.horses.length || merged.odds.length || hasResult(merged.result) || hasRace(merged.race));
      return json({ ok, mode, count: files.length, merged, raw });
    } catch (e) {
      return json({ ok: false, error: e.message, stack: e.stack }, 500);
    }
  }
};

function cors(res){
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}
function json(obj, status=200){ return cors(Response.json(obj, { status })); }
function normalizeAIText(ai){
  if (typeof ai === "string") return ai;
  if (ai?.response) return String(ai.response);
  if (ai?.result) return typeof ai.result === "string" ? ai.result : JSON.stringify(ai.result);
  if (ai?.text) return String(ai.text);
  return JSON.stringify(ai);
}
function extractJSON(text){
  if (!text) return null;
  let t = String(text).trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/,"").trim();
  try { return JSON.parse(t); } catch {}
  const first = t.indexOf("{"); const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const sub = t.slice(first, last + 1);
    try { return JSON.parse(sub); } catch {}
  }
  return null;
}
function buildPrompt({mode,index,total,headcount}){
  return `あなたは競馬画像専用OCRです。\n\n【絶対ルール】\n・出力はJSONのみ。説明文、例、Markdown、コードブロックは禁止。\n・先頭は必ず {、末尾は必ず }。\n・読めない値は空文字 ""。推測しない。\n・同じ数字や同じ馬名を連続で増殖させない。\n・1行=1頭で処理する。\n・馬番と馬名を必ず同じ行のセットとして扱う。\n・mode=${mode}、画像 ${index}/${total}、頭数=${headcount || "不明"}。\n\n【返却JSON】\n{\n  "ok": true,\n  "race": {"name":"", "place":"", "grade":"", "surface":"", "distance":""},\n  "horses": [\n    {"frame":"", "no":"", "name":"", "last1":"", "last2":"", "last3":""}\n  ],\n  "odds": [\n    {"no":"", "name":"", "odds":""}\n  ],\n  "result": {\n    "firstNo":"", "first":"",\n    "secondNo":"", "second":"",\n    "thirdNo":"", "third":"",\n    "umaren":"", "umarenPay":"",\n    "sanrenpuku":"", "sanrenpukuPay":""\n  }\n}\n\n【抽出ルール】\n・出馬表なら horses を埋める。\n・単勝オッズなら odds を埋める。人気は返さなくてよい。\n・結果なら result を埋める。同着や馬連/3連複が複数ある場合はカンマ区切り。\n・画像に存在しない項目は空配列または空文字。\n・JSON以外は絶対に返さない。`;
}
function sanitize(d){
  const z = { ok: !!d.ok, race: d.race || {}, horses: Array.isArray(d.horses)?d.horses:[], odds: Array.isArray(d.odds)?d.odds:[], result: d.result || {} };
  z.horses = z.horses.map(h=>({ frame:s(h.frame||h.waku), no:n(h.no||h.number||h.horseNo), name:s(h.name||h.horse), last1:n(h.last1||h.run1), last2:n(h.last2||h.run2), last3:n(h.last3||h.run3), odds:s(h.odds) })).filter(h=>h.no || h.name);
  z.odds = z.odds.map(o=>({ no:n(o.no||o.number||o.horseNo), name:s(o.name), odds:s(o.odds||o.tansho||o.winOdds).replace(/倍/g,"") })).filter(o=>o.no || o.name || o.odds);
  z.race = { name:s(z.race.name), place:s(z.race.place), grade:s(z.race.grade), surface:s(z.race.surface), distance:s(z.race.distance) };
  z.result = { firstNo:n(z.result.firstNo), first:s(z.result.first), secondNo:n(z.result.secondNo), second:s(z.result.second), thirdNo:n(z.result.thirdNo), third:s(z.result.third), umaren:s(z.result.umaren), umarenPay:s(z.result.umarenPay), sanrenpuku:s(z.result.sanrenpuku), sanrenpukuPay:s(z.result.sanrenpukuPay) };
  return z;
}
function s(v){ return String(v ?? "").trim(); }
function n(v){ return s(v).replace(/[０-９]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0xFEE0)).replace(/[^0-9]/g,""); }
function mergeData(list){
  const race = {name:"",place:"",grade:"",surface:"",distance:""};
  const horseMap = new Map(); const oddsMap = new Map();
  const result = {firstNo:"",first:"",secondNo:"",second:"",thirdNo:"",third:"",umaren:"",umarenPay:"",sanrenpuku:"",sanrenpukuPay:""};
  for (const d of list) {
    for (const k of Object.keys(race)) if (!race[k] && d.race?.[k]) race[k] = d.race[k];
    for (const h of d.horses || []) {
      const key = h.no || h.name; if (!key) continue;
      const cur = horseMap.get(key) || {};
      horseMap.set(key, { ...cur, ...emptySafe(cur,h) });
    }
    for (const o of d.odds || []) {
      const key = o.no || o.name; if (!key) continue;
      const cur = oddsMap.get(key) || {};
      oddsMap.set(key, { ...cur, ...emptySafe(cur,o) });
    }
    for (const k of Object.keys(result)) if (!result[k] && d.result?.[k]) result[k] = d.result[k];
  }
  const horses = [...horseMap.values()].sort((a,b)=>Number(a.no||999)-Number(b.no||999));
  const odds = [...oddsMap.values()].sort((a,b)=>Number(a.no||999)-Number(b.no||999));
  return { race, horses, odds, result };
}
function emptySafe(cur,next){ const out={}; for(const [k,v] of Object.entries(next||{})) out[k] = cur[k] ? cur[k] : v; return out; }
function hasResult(r){ return Object.values(r||{}).some(Boolean); }
function hasRace(r){ return Object.values(r||{}).some(Boolean); }
