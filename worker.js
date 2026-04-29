export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/" || url.pathname === "/api/health") {
      return cors(Response.json({ ok: true, message: "Rev OCR Worker alive", ai: Boolean(env.AI) }));
    }
    if (url.pathname !== "/api/ocr" || request.method !== "POST") {
      return cors(Response.json({ ok: false, error: "Not found. Use POST /api/ocr" }, { status: 404 }));
    }
    try {
      if (!env.AI) return cors(Response.json({ ok: false, error: "Workers AI binding がありません。変数名 AI を追加してください。" }));
      const form = await request.formData();
      const file = form.get("file");
      const allowedFrame = String(form.get("allowedFrame") || "");
      const headcount = String(form.get("headcount") || "18");
      const raceHint = String(form.get("raceHint") || "{}");
      if (!file) return cors(Response.json({ ok: false, error: "画像ファイルがありません" }));
      const imageBytes = new Uint8Array(await file.arrayBuffer());
      const prompt = buildPrompt({ allowedFrame, headcount, raceHint });
      const aiResult = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
        image: imageBytes,
        prompt,
        temperature: 0,
        max_tokens: 2400
      });
      const rawText = extractText(aiResult);
      const parsed = parseJsonLoose(rawText);
      if (!parsed.ok) return cors(Response.json({ ok: false, error: parsed.error, rawText }));
      const allowed = allowedFrame.split(/[,-]/).map(x => x.trim()).filter(Boolean);
      const horses = normalizeHorses(parsed.data.horses || [], allowed, Number(headcount));
      return cors(Response.json({ ok: true, mode: "entry-block", allowedFrame, count: horses.length, horses, rawText }));
    } catch (e) {
      return cors(Response.json({ ok: false, error: String(e && e.stack || e) }));
    }
  }
};

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
function extractText(aiResult) {
  if (!aiResult) return "";
  if (typeof aiResult === "string") return aiResult;
  return aiResult.response || aiResult.text || aiResult.result || JSON.stringify(aiResult);
}
function buildPrompt({ allowedFrame, headcount, raceHint }) {
  return `あなたは日本の競馬出馬表専用OCRです。必ずJSONだけで返してください。説明文、Markdown、コードブロックは禁止。

対象画像は出馬表の一部です。
allowedFrame=${allowedFrame}
headcount=${headcount}
raceHint=${raceHint}

厳守ルール:
1. 画像内から allowedFrame の枠だけを抽出する。
2. allowedFrame以外の枠は絶対に出さない。
3. 馬番が headcount を超える馬は出さない。
4. 1頭ごとに no, frame, name, last1, last2, last3, odds, confidence を返す。
5. last1/last2/last3 は直近3走の着順。取消/中止/除外は 0。
6. odds は単勝オッズ。人気は返さなくてよい。
7. confidence は0〜100の整数。自信がなければ低くする。
8. 不明は空文字 ""。
9. 画像に存在しない馬名を推測で作らない。
10. JSON形式は次だけ。

{"horses":[{"no":"","frame":"","name":"","last1":"","last2":"","last3":"","odds":"","confidence":0}]}`;
}
function parseJsonLoose(text) {
  const s = String(text || "").trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  try { return { ok: true, data: JSON.parse(s) }; } catch (_) {}
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const sub = s.slice(first, last + 1);
    try { return { ok: true, data: JSON.parse(sub) }; } catch (e) { return { ok: false, error: "JSON解析失敗: " + e.message }; }
  }
  return { ok: false, error: "JSON抽出失敗" };
}
function normalizeHorses(list, allowed, headcount) {
  const out = [];
  const seen = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    const h = {
      no: onlyInt(x.no ?? x.number ?? x.horseNo),
      frame: onlyInt(x.frame ?? x.waku),
      name: cleanName(x.name ?? x.horseName),
      last1: onlyInt(x.last1 ?? x.prev1 ?? x.run1),
      last2: onlyInt(x.last2 ?? x.prev2 ?? x.run2),
      last3: onlyInt(x.last3 ?? x.prev3 ?? x.run3),
      odds: onlyNum(x.odds ?? x.winOdds),
      confidence: clamp(Number(x.confidence || 0), 0, 100)
    };
    if (!h.no) continue;
    if (Number(h.no) > headcount) continue;
    if (allowed.length && !allowed.includes(String(h.frame))) continue;
    const old = seen.get(h.no);
    if (!old || score(h) >= score(old)) seen.set(h.no, h);
  }
  for (const [, h] of seen) out.push(h);
  return out.sort((a,b)=>Number(a.no)-Number(b.no));
}
function onlyInt(v) { const m = String(v ?? "").match(/\d+/); return m ? m[0] : ""; }
function onlyNum(v) { const m = String(v ?? "").match(/\d+(?:\.\d+)?/); return m ? m[0] : ""; }
function cleanName(v) { return String(v ?? "").replace(/[\s　]+/g, "").replace(/[|｜]/g, "ト").replace(/ー{2,}/g, "ー"); }
function clamp(n,a,b){ return Math.max(a, Math.min(b, Number.isFinite(n)?n:0)); }
function score(h){ return Number(h.confidence||0) + (h.name?20:0) + (h.odds?10:0) + (h.last1?5:0) + (h.last2?5:0) + (h.last3?5:0); }
