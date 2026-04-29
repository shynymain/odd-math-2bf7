export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname !== "/api/ocr") return cors(Response.json({ ok:true, message:"Rev OCR Worker FIX3", endpoint:"/api/ocr" }));
    if (request.method !== "POST") return cors(Response.json({ ok:false, error:"POST only" }, { status:405 }));

    try {
      if (!env.AI) return cors(Response.json({ ok:false, error:"Workers AI binding 'AI' がありません" }, { status:500 }));
      const form = await request.formData();
      const file = form.get("file");
      const mode = String(form.get("mode") || "auto");
      if (!file) return cors(Response.json({ ok:false, error:"画像ファイルがありません" }, { status:400 }));

      const bytes = new Uint8Array(await file.arrayBuffer());
      const ai = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
        image: bytes,
        prompt: buildPrompt(mode),
        max_tokens: 420,
        temperature: 0,
        top_p: 0.001
      });

      const rawText = typeof ai === "string" ? ai : (ai.response || ai.description || JSON.stringify(ai));
      const parsed = pickBestJson(rawText, mode);
      const merged = normalize(parsed, mode);
      return cors(Response.json({ ok: merged.ok !== false, mode, file:file.name || "image", rawText, parsed, merged }));
    } catch (e) {
      return cors(Response.json({ ok:false, error:String(e?.message || e) }, { status:500 }));
    }
  }
};

function cors(res){
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status:res.status, statusText:res.statusText, headers:h });
}

function buildPrompt(mode){
  const common = `あなたはJRA競馬画像専用OCRです。出力はJSONオブジェクト1個だけ。繰り返し禁止。解説禁止。Markdown禁止。コード禁止。サンプル生成禁止。推測禁止。読めない値は空文字。存在しない馬名・過去の有名馬名・架空の数値を作らない。画像に見えない項目は空文字/空配列。表にある馬だけ返す。馬番が読める行だけ返す。`;
  const schemas = {
    entry: `画像からレース情報と見えている馬番/枠/馬名だけ抽出。形式だけ厳守:{"ok":true,"race":{"date":"","place":"","raceNo":"","raceName":"","grade":"","condition":"","age":"","sex":"","surface":"","distance":"","headcount":""},"horses":[{"frame":"","no":"","name":""}]}`,
    runs: `前走/前2走/前3走の着順だけ抽出。last1,last2,last3は数字だけ。馬名・オッズ・人気は禁止。形式だけ厳守:{"ok":true,"horses":[{"no":"","last1":"","last2":"","last3":""}]}`,
    odds: `単勝オッズ表を抽出。行頭の数字は馬番。人気は不要。形式だけ厳守:{"ok":true,"odds":[{"no":"","name":"","odds":""}]}`,
    result: `結果と払戻を抽出。3着馬番は3連複の3頭と照合。馬連払戻と3連複払戻を取り違えない。形式だけ厳守:{"ok":true,"result":{"firstNo":"","secondNo":"","thirdNo":"","umaren":"","umarenPay":"","sanrenpuku":"","sanrenpukuPay":""}}`,
    auto: `画像内容に応じて必要なキーだけ返す。形式だけ厳守:{"ok":true,"race":{},"horses":[],"odds":[],"result":{}}`
  };
  return `${common}\nmode=${mode}\n${schemas[mode] || schemas.auto}\nJSONを1個だけ返す。複数JSON・連番テストデータ・説明文を出したら失敗。`;
}

function pickBestJson(text, mode){
  if (typeof text === "object" && text) return text;
  const s = String(text || "").trim();
  try { return validateParsed(JSON.parse(s), mode, s); } catch(e) {}
  const objs = extractJsonObjects(s).map(x => { try { return JSON.parse(x); } catch(e){ return null; } }).filter(Boolean);
  if (!objs.length) return { ok:false, error:"AI returned non-JSON text", rawText:s.slice(0, 4000) };
  objs.sort((a,b) => scoreJson(b, mode) - scoreJson(a, mode));
  return validateParsed(objs[0], mode, s);
}

function extractJsonObjects(s){
  const out = [];
  let start = -1, depth = 0, inStr = false, esc = false;
  for (let i=0; i<s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc=false; else if (ch === "\\") esc=true; else if (ch === '"') inStr=false; continue; }
    if (ch === '"') { inStr=true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i+1)); start = -1; } }
  }
  return out;
}

function scoreJson(d, mode){
  let score = 0;
  if (d?.ok === true) score += 5;
  if (mode === "entry") { score += Object.values(d?.race || {}).filter(v => String(v||"").trim()).length * 3; score += (d?.horses || []).filter(h => h.name || h.no).length; }
  if (mode === "runs") { score += (d?.horses || []).filter(h => onlyNum(h.no) && validRun(h.last1) && validRun(h.last2) && validRun(h.last3)).length * 4; }
  if (mode === "odds") { score += (d?.odds || []).filter(o => onlyNum(o.no) && cleanOdds(o.odds)).length * 5; if ((d?.odds || []).some(o => String(o.name||"").includes("サクラメガミ") || String(o.name||"").includes("ダイワスカーレット"))) score -= 100; }
  if (mode === "result") { const r=d?.result||{}; score += [r.firstNo,r.secondNo,r.thirdNo,r.umaren,r.umarenPay,r.sanrenpuku,r.sanrenpukuPay].filter(v=>String(v||"").trim()).length * 4; }
  return score;
}

function z2h(s){ return String(s ?? "").replace(/[０-９．]/g, c => c === "．" ? "." : String.fromCharCode(c.charCodeAt(0)-0xFEE0)); }
function onlyNum(v){ return (z2h(v).match(/\d+/) || [""])[0]; }
function cleanOdds(v){ return z2h(v).replace(/[^0-9.]/g, ""); }
function cleanPay(v){ return z2h(v).replace(/[円\s,，]/g, ""); }
function validRun(v){ const n = Number(onlyNum(v)); return n >= 0 && n <= 30; }
function combo(v){ return String(v ?? "").split(/[-－ー,、\s]+/).map(onlyNum).filter(Boolean).sort((a,b)=>Number(a)-Number(b)).join("-"); }


function isSyntheticEntry(d, raw=""){
  const race=d?.race||{}; const hs=d?.horses||[]; const t=String(raw||"");
  const objs=extractJsonObjects(t).map(x=>{try{return JSON.parse(x)}catch(e){return null}}).filter(Boolean);
  const raceNos=[...new Set(objs.map(o=>onlyNum(o?.race?.raceNo)).filter(Boolean))];
  const raceNames=[...new Set(objs.map(o=>String(o?.race?.raceName||"").trim()).filter(Boolean))];
  if(raceNos.length>=5 && raceNames.length<=2) return true;
  if(hs.length<=1 && /メイショウハリオ|スプリングステークス|2023\/03\/18/.test(JSON.stringify(d))) return true;
  return false;
}
function isSyntheticRuns(d, raw=""){
  const hs=d?.horses||[]; if(!hs.length) return false;
  let seq=0; hs.forEach((h,i)=>{const a=[h.last1,h.last2,h.last3].map(onlyNum).map(Number); if(a[0]===i*3+1 && a[1]===i*3+2 && a[2]===i*3+3) seq++;});
  return seq>=Math.min(3,hs.length) || /"last1":"1","last2":"2","last3":"3"/.test(String(raw||""));
}
function isSyntheticOdds(d, raw=""){
  const os=d?.odds||[]; if(!os.length) return false;
  const names=os.map(o=>String(o.name||"").trim()).filter(Boolean);
  const odds=os.map(o=>cleanOdds(o.odds)).filter(Boolean);
  const count=a=>a.reduce((m,x)=>(m[x]=(m[x]||0)+1,m),{});
  const maxName=Math.max(...Object.values(count(names)),0), maxOdds=Math.max(...Object.values(count(odds)),0);
  if(os.length>=4 && (maxName>=os.length-1 || maxOdds>=os.length-1)) return true;
  return /メイショウダッフィー|サクラメガミ|ダイワスカーレット|メイショウドトウ/.test(JSON.stringify(d));
}
function validateParsed(d, mode, raw=""){
  if(!d || d.ok===false) return d;
  if(mode==="entry" && isSyntheticEntry(d, raw)) { d._syntheticEntry = true; d._warning = "レース情報は架空疑いのため反映停止。出馬表だけ返します。"; return d; }
  if(mode==="runs" && isSyntheticRuns(d, raw)) return {ok:false,error:"前走着順の架空連番データを検出したため反映停止",rawText:String(raw||"").slice(0,3000)};
  if(mode==="odds" && isSyntheticOdds(d, raw)) return {ok:false,error:"オッズの架空/重複データを検出したため反映停止",rawText:String(raw||"").slice(0,3000)};
  return d;
}

function normalize(d, mode){
  const out = { ok: d?.ok !== false, race:{}, horses:[], odds:[], result:{} };
  if (!d || d.ok === false) return { ...out, ok:false, error:d?.error || "parse failed", rawText:d?.rawText||"" };
  if (d.race && !d._syntheticEntry) out.race = d.race;
  if (d._syntheticEntry) out.warning = d._warning || "レース情報は架空疑いのため未反映";
  if (Array.isArray(d.horses)) {
    out.horses = d.horses.map(h => {
      const base = { no:onlyNum(h.no ?? h.number), frame:onlyNum(h.frame), name:String(h.name ?? "").trim() };
      if (mode === "runs" || h.last1 || h.last2 || h.last3) {
        base.last1 = validRun(h.last1) ? onlyNum(h.last1) : "";
        base.last2 = validRun(h.last2) ? onlyNum(h.last2) : "";
        base.last3 = validRun(h.last3) ? onlyNum(h.last3) : "";
      }
      return base;
    }).filter(h => h.no || h.name || h.last1 || h.last2 || h.last3)
      .filter(h => !(d._syntheticEntry && /メイショウハリオ|メイショウダッフィー|サクラメガミ|ダイワスカーレット|メイショウドトウ/.test(h.name)));
  }
  if (Array.isArray(d.odds)) out.odds = d.odds.map(o => ({ no:onlyNum(o.no ?? o.number), name:String(o.name ?? "").trim(), odds:cleanOdds(o.odds) })).filter(o => o.no && o.odds);
  if (d.result) {
    const r=d.result;
    out.result = { firstNo:onlyNum(r.firstNo ?? r.first), secondNo:onlyNum(r.secondNo ?? r.second), thirdNo:onlyNum(r.thirdNo ?? r.third), umaren:combo(r.umaren), umarenPay:cleanPay(r.umarenPay), sanrenpuku:combo(r.sanrenpuku), sanrenpukuPay:cleanPay(r.sanrenpukuPay) };
    const san = out.result.sanrenpuku.split("-").filter(Boolean);
    if (san.length === 3 && out.result.firstNo && out.result.secondNo && san.includes(out.result.firstNo) && san.includes(out.result.secondNo) && !san.includes(out.result.thirdNo)) {
      out.result.thirdNo = san.find(x => x !== out.result.firstNo && x !== out.result.secondNo) || out.result.thirdNo;
    }
  }
  return out;
}
