export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(json({ ok: true }));
    if (url.pathname === "/" || url.pathname === "/health") {
      return cors(json({ ok: true, service: "odd-math-2bf7", endpoint: "/api/ocr" }));
    }
    if (url.pathname !== "/api/ocr") return cors(json({ ok: false, error: "Not found" }, 404));
    if (request.method !== "POST") return cors(json({ ok: false, error: "POST only" }, 405));
    if (!env.AI) return cors(json({ ok: false, error: "Workers AI binding AI is missing" }, 500));

    try {
      const form = await request.formData();
      const file = form.get("file");
      const mode = String(form.get("mode") || "auto");
      const headcount = String(form.get("headcount") || "");
      const raceHint = safeJSON(form.get("raceHint")) || {};

      if (!file || typeof file.arrayBuffer !== "function") {
        return cors(json({ ok: false, error: "画像ファイルがありません" }, 400));
      }

      const bytes = [...new Uint8Array(await file.arrayBuffer())];
      const prompt = buildPrompt(mode, headcount, raceHint);

      const aiResult = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
        image: bytes,
        prompt,
        temperature: 0,
        max_tokens: 1200
      });

      const raw = normalizeAIText(aiResult);
      const parsed = extractStrictJSON(raw);

      if (!parsed) {
        return cors(json({
          ok: true,
          data: raw,
          warning: "JSON parse failed. Frontend fallback parser will try."
        }));
      }

      const cleaned = normalizePayload(parsed);
      return cors(json({ ok: true, data: cleaned, rawText: raw }));
    } catch (err) {
      return cors(json({ ok: false, error: String(err && err.message ? err.message : err) }, 500));
    }
  }
};

function buildPrompt(mode, headcount, raceHint) {
  const hint = raceHint && typeof raceHint === "object" ? JSON.stringify(raceHint) : "{}";
  return `
あなたはOCRではなく、競馬画像からJSONを作る抽出器です。

最重要禁止事項:
- Pythonコードを書くな
- JavaScriptコードを書くな
- Markdownを書くな
- 説明文を書くな
- \\`\\`\\` を使うな
- 例を出すな
- 手順を書くな
- 文章で解説するな
- 推測で補足するな

必ずJSONオブジェクト1個だけを返せ。
先頭文字は必ず { にする。
最後の文字は必ず } にする。
JSON以外を1文字でも出したら失敗。

入力条件:
mode=${mode}
headcount=${headcount}
raceHint=${hint}

返すJSON形式:
{
  "race": {
    "name": "",
    "place": "",
    "grade": "",
    "surface": "",
    "distance": ""
  },
  "horses": [],
  "odds": [],
  "result": {}
}

horses は出馬表・前走着順画像から読める場合だけ入れる:
[
  {"frame":"","no":"","name":"","last1":"","last2":"","last3":"","odds":""}
]

odds は単勝オッズ画像から読める場合だけ入れる:
[
  {"no":"","name":"","odds":""}
]

result は結果・払戻画像から読める場合だけ入れる:
{
  "firstNo":"",
  "first":"",
  "secondNo":"",
  "second":"",
  "thirdNo":"",
  "third":"",
  "umaren":"",
  "umarenPay":"",
  "sanrenpuku":"",
  "sanrenpukuPay":""
}

読み取りルール:
- 画像に存在しない項目は ""。
- 不明な文字は "?"。
- 馬番、枠番、着順、オッズ、払戻は半角数字で返す。
- 馬名は画像の表記を優先する。
- 単勝オッズは人気順ではなく、先頭の数字を馬番として扱う。
- mode が odds の場合は odds を最優先。
- mode が horses/runs の場合は horses を最優先。
- mode が result の場合は result を最優先。
- 頭数 headcount がある場合、horses/odds は最大その頭数まで。
`;
}

function normalizeAIText(aiResult) {
  if (typeof aiResult === "string") return aiResult.trim();
  if (!aiResult || typeof aiResult !== "object") return String(aiResult || "").trim();
  const candidates = [
    aiResult.response,
    aiResult.result,
    aiResult.text,
    aiResult.output,
    aiResult.content,
    aiResult.data
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  try { return JSON.stringify(aiResult); } catch { return String(aiResult); }
}

function extractStrictJSON(text) {
  if (!text || typeof text !== "string") return null;
  let s = text.trim();

  // Markdown fence removal
  s = s.replace(/^```(?:json|javascript|js|python)?/i, "").replace(/```$/i, "").trim();

  // Direct parse first
  try { return JSON.parse(s); } catch {}

  // Extract first balanced JSON object only
  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

function normalizePayload(obj) {
  const out = {
    race: normalizeRace(obj.race),
    horses: Array.isArray(obj.horses) ? obj.horses.map(normalizeHorse).filter(x => x.no || x.name) : [],
    odds: Array.isArray(obj.odds) ? obj.odds.map(normalizeOdd).filter(x => x.no || x.name || x.odds) : [],
    result: normalizeResult(obj.result)
  };
  return out;
}

function normalizeRace(r = {}) {
  return {
    name: clean(r.name),
    place: clean(r.place),
    grade: clean(r.grade),
    surface: clean(r.surface),
    distance: clean(r.distance)
  };
}

function normalizeHorse(h = {}) {
  return {
    frame: digits(h.frame),
    no: digits(h.no || h.number || h.horseNo),
    name: clean(h.name),
    last1: digitsOrZero(h.last1),
    last2: digitsOrZero(h.last2),
    last3: digitsOrZero(h.last3),
    odds: decimal(h.odds)
  };
}

function normalizeOdd(o = {}) {
  return {
    no: digits(o.no || o.number || o.horseNo),
    name: clean(o.name),
    odds: decimal(o.odds)
  };
}

function normalizeResult(r = {}) {
  return {
    firstNo: digits(r.firstNo || r.first_no || r.firstNumber),
    first: clean(r.first),
    secondNo: digits(r.secondNo || r.second_no || r.secondNumber),
    second: clean(r.second),
    thirdNo: digits(r.thirdNo || r.third_no || r.thirdNumber),
    third: clean(r.third),
    umaren: combo(r.umaren),
    umarenPay: money(r.umarenPay || r.umaren_pay),
    sanrenpuku: combo(r.sanrenpuku),
    sanrenpukuPay: money(r.sanrenpukuPay || r.sanrenpuku_pay)
  };
}

function clean(v) { return v == null ? "" : String(v).replace(/[\r\n\t]+/g, " ").trim(); }
function digits(v) { return clean(v).replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).match(/\d+/)?.[0] || ""; }
function digitsOrZero(v) { const d = digits(v); return d === "" ? "" : d; }
function decimal(v) { return clean(v).replace(/[０-９．]/g, d => d === "．" ? "." : String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).match(/\d+(?:\.\d+)?/)?.[0] || ""; }
function money(v) { return clean(v).replace(/[０-９,，円]/g, d => d === "，" ? "," : d === "円" ? "" : String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/[^0-9]/g, ""); }
function combo(v) { return clean(v).replace(/[－ー―–]/g, "-").replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/\s+/g, ""); }
function safeJSON(v) { try { return v ? JSON.parse(String(v)) : null; } catch { return null; } }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
