export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname !== "/api/ocr") return cors(Response.json({ ok:true, message:"Rev OCR Worker", endpoint:"/api/ocr" }));
    if (request.method !== "POST") return cors(Response.json({ ok:false, error:"POST only" }, { status:405 }));
    try {
      if (!env.AI) return cors(Response.json({ ok:false, error:"Workers AI binding 'AI' がありません" }, { status:500 }));
      const form = await request.formData();
      const file = form.get("file");
      const mode = String(form.get("mode") || "auto");
      if (!file) return cors(Response.json({ ok:false, error:"画像ファイルがありません" }, { status:400 }));
      const bytes = new Uint8Array(await file.arrayBuffer());
      const prompt = buildPrompt(mode);
      const ai = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
        image: bytes,
        prompt,
        max_tokens: 2200,
        temperature: 0
      });
      const text = typeof ai === "string" ? ai : (ai.response || ai.description || JSON.stringify(ai));
      const parsed = extractJson(text);
      return cors(Response.json({ ok:true, mode, file:file.name || "image", rawText:text, parsed, merged:normalize(parsed, mode) }));
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
  const common = `あなたはJRA競馬画像専用OCRです。必ずJSONだけを返してください。説明文、Markdown、解説は禁止。読めない値は空文字。馬番は必ず数字文字列。馬名は推測しすぎない。`;
  const schemas = {
    entry: `形式:{"ok":true,"race":{"date":"2026/4/25","place":"東京","raceNo":"8","raceName":"4歳以上1勝クラス","grade":"1勝クラス","condition":"4歳以上","age":"4歳以上","sex":"混合","surface":"芝","distance":"1600m","headcount":""},"horses":[{"frame":"1","no":"1","name":"馬名"}]}`,
    runs: `形式:{"ok":true,"horses":[{"no":"1","last1":"5","last2":"8","last3":"12"}]}。last1,last2,last3は着順数字だけ。馬名やオッズを入れない。`,
    odds: `形式:{"ok":true,"odds":[{"no":"1","name":"馬名","odds":"2.0"}]}。先頭の数字は馬番として扱う。人気は返さない。`,
    result: `形式:{"ok":true,"result":{"firstNo":"3","secondNo":"4","thirdNo":"7","umaren":"3-4","umarenPay":"8090","sanrenpuku":"3-4-7","sanrenpukuPay":""}}。3連複は1着2着3着の組み合わせ。払戻金額は馬連と3連複を取り違えない。`,
    auto: `画像内容に応じて entry/runs/odds/result のうち必要なキーだけ返す。形式:{"ok":true,"race":{},"horses":[],"odds":[],"result":{}}`
  };
  return `${common}\nモード:${mode}\n${schemas[mode] || schemas.auto}`;
}
function extractJson(text){
  if (typeof text === "object" && text) return text;
  const s = String(text || "").trim();
  try { return JSON.parse(s); } catch(e) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch(e) {} }
  return { ok:false, error:"AI returned non-JSON text", rawText:s };
}
function onlyNum(v){ return String(v ?? "").replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0)-0xFEE0)).match(/\d+/)?.[0] || ""; }
function cleanPay(v){ return String(v ?? "").replace(/[円\s,，]/g, ""); }
function combo(v){ return String(v ?? "").split(/[-－ー,、\s]+/).map(onlyNum).filter(Boolean).sort((a,b)=>Number(a)-Number(b)).join("-"); }
function normalize(d, mode){
  const out = { ok: d?.ok !== false, race:{}, horses:[], odds:[], result:{} };
  if (d?.race) out.race = d.race;
  if (Array.isArray(d?.horses)) out.horses = d.horses.map(h => ({...h, no:onlyNum(h.no ?? h.number), frame:onlyNum(h.frame), last1:onlyNum(h.last1), last2:onlyNum(h.last2), last3:onlyNum(h.last3)}));
  if (Array.isArray(d?.odds)) out.odds = d.odds.map(o => ({...o, no:onlyNum(o.no ?? o.number), odds:String(o.odds ?? "").replace(/[^0-9.]/g, "")}));
  if (d?.result) {
    const r=d.result;
    out.result = { firstNo:onlyNum(r.firstNo ?? r.first), secondNo:onlyNum(r.secondNo ?? r.second), thirdNo:onlyNum(r.thirdNo ?? r.third), umaren:combo(r.umaren), umarenPay:cleanPay(r.umarenPay), sanrenpuku:combo(r.sanrenpuku), sanrenpukuPay:cleanPay(r.sanrenpukuPay) };
    const expected = [out.result.firstNo,out.result.secondNo,out.result.thirdNo].filter(Boolean).sort((a,b)=>Number(a)-Number(b)).join("-");
    if (expected && out.result.sanrenpuku && out.result.sanrenpuku !== expected) {
      const san = out.result.sanrenpuku.split("-");
      if (san.length === 3 && san.includes(out.result.firstNo) && san.includes(out.result.secondNo)) out.result.thirdNo = san.find(x => x !== out.result.firstNo && x !== out.result.secondNo) || out.result.thirdNo;
    }
  }
  return out;
}
