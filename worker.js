export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname !== "/api/ocr") return cors(Response.json({ ok: true, message: "Rev OCR Worker", endpoint: "/api/ocr" }));
    if (request.method !== "POST") return cors(Response.json({ ok: false, error: "POST only" }, { status: 405 }));
    try {
      if (!env.AI) return cors(Response.json({ ok:false, error:"Workers AI binding 'AI' がありません" }));
      const form = await request.formData();
      const mode = String(form.get("mode") || "entry");
      const files = form.getAll("files").length ? form.getAll("files") : [form.get("file")].filter(Boolean);
      const raw = [];
      for (const file of files) {
        const image = [...new Uint8Array(await file.arrayBuffer())];
        const prompt = buildPrompt(mode);
        const ai = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { image, prompt, max_tokens: 1800, temperature: 0 });
        const rawText = typeof ai === "string" ? ai : (ai.response || ai.text || JSON.stringify(ai));
        raw.push({ ok:true, file:file.name || "image", rawText, parsed: safeParseJson(rawText) });
      }
      const merged = mergeRaw(raw, mode);
      return cors(Response.json({ ok: merged.ok, mode, count: files.length, merged, raw }));
    } catch (e) {
      return cors(Response.json({ ok:false, error:String(e && e.message || e) }, { status: 500 }));
    }
  }
};
function cors(res){ const h=new Headers(res.headers); h.set("Access-Control-Allow-Origin","*"); h.set("Access-Control-Allow-Methods","GET,POST,OPTIONS"); h.set("Access-Control-Allow-Headers","Content-Type"); return new Response(res.body,{status:res.status,headers:h}); }
function buildPrompt(mode){
  const common = "あなたは競馬画像OCRです。説明文、例文、Markdownは禁止。画像から読める事実だけを1個のJSONで返す。不明は空文字。存在しない馬番や架空データは禁止。馬番は1〜18中心、最大30まで。";
  if(mode==="runs") return common + ' 形式:{"ok":true,"horses":[{"no":"1","last1":"","last2":"","last3":""}]}';
  if(mode==="odds") return common + ' 形式:{"ok":true,"odds":[{"no":"1","name":"","odds":""}]} 単勝オッズ0.0など画像に無い値は禁止。';
  if(mode==="result") return common + ' 形式:{"ok":true,"result":{"firstNo":"","secondNo":"","thirdNo":"","umaren":"","umarenPay":"","sanrenpuku":"","sanrenpukuPay":""}}';
  return common + ' 形式:{"ok":true,"race":{"date":"","place":"","raceNo":"","raceName":"","grade":"","condition":"","age":"","sex":"","surface":"","distance":"","headcount":""},"horses":[{"frame":"","no":"1","name":""}]}';
}
function safeParseJson(text){ try{return JSON.parse(text)}catch(e){} const arr=extractJsonObjects(String(text||"")); return arr[0] || {}; }
function extractJsonObjects(text){ const out=[]; let d=0,s=-1,q=false,esc=false; for(let i=0;i<text.length;i++){const c=text[i]; if(q){ if(esc){esc=false;continue} if(c==='\\'){esc=true;continue} if(c==='"')q=false; continue } if(c==='"'){q=true;continue} if(c==='{'){if(d===0)s=i;d++} if(c==='}'){d--; if(d===0&&s>=0){try{out.push(JSON.parse(text.slice(s,i+1)))}catch(e){} s=-1}}} return out; }
function mergeRaw(raw, mode){ const merged={ok:false,race:{},horses:[],odds:[],result:{}}; const hm=new Map(), om=new Map(); for(const r of raw){ const objs=[r.parsed,...extractJsonObjects(r.rawText||"")]; for(const o of objs){ if(o.race) Object.assign(merged.race,o.race); if(o.result) Object.assign(merged.result,o.result); for(const h of (o.horses||[])){ const no=String(h.no||h.number||"").match(/\d+/)?.[0]; if(!no||+no>30) continue; hm.set(no,{...(hm.get(no)||{no}),...h,no}); } for(const od of (o.odds||[])){ const no=String(od.no||od.number||"").match(/\d+/)?.[0]; if(!no||+no>30) continue; om.set(no,{...(om.get(no)||{no}),...od,no}); } } } merged.horses=[...hm.values()].sort((a,b)=>+a.no-+b.no); merged.odds=[...om.values()].sort((a,b)=>+a.no-+b.no); merged.ok=!!(Object.keys(merged.race).length||merged.horses.length||merged.odds.length||Object.keys(merged.result).length); return merged; }
