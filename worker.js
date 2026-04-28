export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (request.method === "GET") {
      return Response.json({ ok: true, message: "Rev OCR Worker is running", path: url.pathname }, { headers: cors });
    }

    if (request.method !== "POST") {
      return Response.json({ ok: false, error: "POST only" }, { status: 405, headers: cors });
    }

    try {
      if (!env.AI) {
        return Response.json({ ok: false, error: "Workers AI binding がありません。Cloudflareで変数名 AI の binding を追加してください。" }, { status: 500, headers: cors });
      }

      const formData = await request.formData();
      const mode = String(formData.get("mode") || "auto");
      const files = [];
      for (const [key, value] of formData.entries()) {
        if ((key === "file" || key === "files") && value && typeof value.arrayBuffer === "function") files.push(value);
      }

      const unique = [];
      const seen = new Set();
      for (const f of files) {
        const id = `${f.name || "image"}-${f.size || 0}`;
        if (!seen.has(id)) { seen.add(id); unique.push(f); }
      }

      if (!unique.length) {
        return Response.json({ ok: false, error: "画像ファイルがありません" }, { status: 400, headers: cors });
      }

      const raw = [];
      for (let i = 0; i < unique.length; i++) {
        const file = unique[i];
        const bytes = new Uint8Array(await file.arrayBuffer());
        const prompt = buildPrompt(mode, i + 1, unique.length);

        let aiResult;
        try {
          aiResult = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
            image: bytes,
            prompt,
            temperature: 0,
            max_tokens: 1800
          });
        } catch (e) {
          raw.push({ ok: false, file: file.name || `image-${i + 1}`, error: String(e.message || e) });
          continue;
        }

        const rawText = extractAiText(aiResult);
        const parsed = extractJson(rawText);
        if (parsed) raw.push({ ok: true, file: file.name || `image-${i + 1}`, data: normalizeData(parsed), rawText });
        else raw.push({ ok: false, file: file.name || `image-${i + 1}`, error: "AI returned non-JSON text", rawText });
      }

      const merged = mergeAll(raw.filter(x => x.ok && x.data).map(x => x.data));
      const ok = raw.some(x => x.ok);
      return Response.json({ ok, mode, count: unique.length, merged, raw }, { headers: cors });
    } catch (e) {
      return Response.json({ ok: false, error: String(e.message || e) }, { status: 500, headers: cors });
    }
  }
};

function buildPrompt(mode, index, total) {
  return `あなたは日本の競馬画像専用OCRです。必ずJSONだけを返してください。説明文、Markdown、コードブロックは禁止です。
画像 ${index}/${total}、mode=${mode}

重要ルール:
- 馬番は先頭の数字を優先する。
- 「h枠」「H枠」は誤読なので「枠」として扱い、frameは数字だけにする。
- 取消/中止/除外は前走値を0にする。
- 不明は空文字にする。推測で埋めない。
- オッズ一覧は並びがバラバラでも、先頭の数字を馬番として読む。
- 返却は下記スキーマのJSONのみ。

{
  "race": { "name": "", "place": "", "grade": "", "surface": "", "distance": "" },
  "horses": [
    { "frame": "", "no": "", "name": "", "last1": "", "last2": "", "last3": "", "odds": "" }
  ],
  "odds": [
    { "no": "", "name": "", "odds": "" }
  ],
  "result": {
    "firstNo": "", "first": "",
    "secondNo": "", "second": "",
    "thirdNo": "", "third": "",
    "umaren": "", "umarenPay": "",
    "sanrenpuku": "", "sanrenpukuPay": ""
  }
}`;
}

function extractAiText(aiResult) {
  if (typeof aiResult === "string") return aiResult;
  if (aiResult?.response) return aiResult.response;
  if (aiResult?.result?.response) return aiResult.result.response;
  if (aiResult?.text) return aiResult.text;
  return JSON.stringify(aiResult || "");
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function normalizeData(data) {
  const d = data || {};
  return {
    race: d.race || {},
    horses: Array.isArray(d.horses) ? d.horses.map(normalizeHorse) : [],
    odds: Array.isArray(d.odds) ? d.odds.map(normalizeOdds) : [],
    result: d.result || {}
  };
}

function normalizeHorse(h) {
  return {
    frame: cleanFrame(h.frame),
    no: cleanNo(h.no || h.number || h.horseNo),
    name: cleanText(h.name || h.horse),
    last1: cleanRank(h.last1 || h.prev1 || h.run1),
    last2: cleanRank(h.last2 || h.prev2 || h.run2),
    last3: cleanRank(h.last3 || h.prev3 || h.run3),
    odds: cleanOdds(h.odds)
  };
}

function normalizeOdds(o) {
  return { no: cleanNo(o.no || o.number || o.horseNo), name: cleanText(o.name || o.horse), odds: cleanOdds(o.odds) };
}
function cleanNo(v) { return String(v || "").replace(/[^0-9]/g, ""); }
function cleanFrame(v) { return String(v || "").replace(/[枠hH]/g, "").replace(/[^0-9]/g, ""); }
function cleanRank(v) { return String(v || "").replace(/[^0-9]/g, ""); }
function cleanOdds(v) { return String(v || "").replace(/[倍\s]/g, "").replace(/[^0-9.]/g, ""); }
function cleanText(v) { return String(v || "").trim(); }

function mergeAll(list) {
  const merged = { race: { name: "", place: "", grade: "", surface: "", distance: "" }, horses: [], odds: [], result: { firstNo: "", first: "", secondNo: "", second: "", thirdNo: "", third: "", umaren: "", umarenPay: "", sanrenpuku: "", sanrenpukuPay: "" } };
  for (const data of list) {
    for (const k of Object.keys(merged.race)) if (!merged.race[k] && data.race?.[k]) merged.race[k] = String(data.race[k]);
    for (const h of data.horses || []) { if (!h.no) continue; const old = merged.horses.find(x => x.no === h.no); if (old) mergeItem(old, h); else merged.horses.push(h); }
    for (const o of data.odds || []) { if (!o.no) continue; const old = merged.odds.find(x => x.no === o.no); if (old) mergeItem(old, o); else merged.odds.push(o); }
    for (const k of Object.keys(merged.result)) if (!merged.result[k] && data.result?.[k]) merged.result[k] = String(data.result[k]);
  }
  merged.horses.sort((a,b)=>Number(a.no)-Number(b.no));
  merged.odds.sort((a,b)=>Number(a.no)-Number(b.no));
  return merged;
}

function mergeItem(base, item) {
  for (const k of Object.keys(item)) {
    if (!base[k] && item[k]) base[k] = item[k];
    if (k === "odds" && item[k]) base[k] = item[k];
    if (k === "name" && item[k] && String(item[k]).length > String(base[k] || "").length) base[k] = item[k];
  }
}
