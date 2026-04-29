export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return cors(Response.json({ ok: true, message: "Rev OCR Worker v3 alive", ai: Boolean(env.AI) }));
    }

    if (url.pathname !== "/api/ocr" || request.method !== "POST") {
      return cors(Response.json({ ok: false, error: "Not found. Use POST /api/ocr" }, { status: 404 }));
    }

    try {
      if (!env.AI) {
        return cors(Response.json({ ok: false, error: "Workers AI binding がありません。変数名 AI を追加してください。" }));
      }

      const form = await request.formData();
      const file = form.get("file");
      const allowedFrame = String(form.get("allowedFrame") || "");
      const headcount = Number(form.get("headcount") || 18);
      const raceHint = String(form.get("raceHint") || "{}");
      if (!file) return cors(Response.json({ ok: false, error: "画像ファイルがありません" }));

      const imageBytes = new Uint8Array(await file.arrayBuffer());
      const prompt = buildPrompt({ allowedFrame, headcount, raceHint });

      const aiResult = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
        image: imageBytes,
        prompt,
        temperature: 0,
        max_tokens: 1200
      });

      const rawText = extractText(aiResult);
      const parsed = parseJsonMany(rawText);
      const allowed = expandAllowedFrames(allowedFrame);
      const horses = normalizeHorses(parsed.horses, allowed, headcount);

      return cors(Response.json({
        ok: true,
        mode: "entry-block",
        parser: "multi-json-merge-v3",
        allowedFrame,
        headcount,
        jsonObjects: parsed.objects,
        count: horses.length,
        horses,
        rawText
      }));
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
  return `あなたは日本の競馬出馬表専用OCRです。返答はJSONオブジェクト1個だけ。説明文、Markdown、複数JSON、途中経過は禁止。

対象画像は出馬表の一部です。
allowedFrame=${allowedFrame}
headcount=${headcount}
raceHint=${raceHint}

厳守ルール:
- allowedFrame の枠だけ抽出する。allowedFrame以外は出さない。
- 馬番が headcount を超える馬は出さない。
- 画像に存在しない馬名を推測で作らない。
- 不明は空文字 ""。confidence は0〜100整数。
- 出力は下の形式のJSON 1個だけ。

{"horses":[{"no":"","frame":"","name":"","last1":"","last2":"","last3":"","odds":"","confidence":0}]}`;
}

function expandAllowedFrames(s) {
  const out = [];
  for (const part of String(s || "").split(",")) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      for (let i = Math.min(a,b); i <= Math.max(a,b); i++) out.push(String(i));
    } else if (/^\d+$/.test(part.trim())) out.push(part.trim());
  }
  return [...new Set(out)];
}

// AIが {..}{..}{..} のように複数JSONを連結して返しても全部拾う。
function parseJsonMany(text) {
  const s = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const jsonStrings = extractBalancedObjects(s);
  const horses = [];
  let objects = 0;

  for (const js of jsonStrings) {
    try {
      const obj = JSON.parse(js);
      objects++;
      if (Array.isArray(obj.horses)) horses.push(...obj.horses);
      else if (obj.horse) horses.push(obj.horse);
    } catch (_) {
      // 途中で切れたJSONは捨てる。エラーにはしない。
    }
  }

  return { objects, horses };
}

function extractBalancedObjects(s) {
  const out = [];
  let start = -1, depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

function normalizeHorses(list, allowed, headcount) {
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
    if (Number(h.no) < 1 || Number(h.no) > headcount) continue;
    if (Number(h.frame) < 1 || Number(h.frame) > 8) continue;
    if (allowed.length && !allowed.includes(String(h.frame))) continue;

    // 空データだけの行は反映しない。枠・馬番だけの幻覚を抑止。
    if (!h.name && !h.last1 && !h.last2 && !h.last3 && !h.odds) continue;

    const old = seen.get(h.no);
    if (!old || score(h) >= score(old)) seen.set(h.no, h);
  }

  return [...seen.values()].sort((a,b)=>Number(a.no)-Number(b.no));
}

function onlyInt(v) { const m = String(v ?? "").match(/\d+/); return m ? m[0] : ""; }
function onlyNum(v) { const m = String(v ?? "").match(/\d+(?:\.\d+)?/); return m ? m[0] : ""; }
function cleanName(v) { return String(v ?? "").replace(/[\s　]+/g, "").replace(/[|｜]/g, "ト").replace(/ー{2,}/g, "ー"); }
function clamp(n,a,b){ return Math.max(a, Math.min(b, Number.isFinite(n)?n:0)); }
function score(h){ return Number(h.confidence||0) + (h.name?30:0) + (h.odds?10:0) + (h.last1?5:0) + (h.last2?5:0) + (h.last3?5:0); }
