export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (url.pathname === "/" || url.pathname === "/api/health") return json({ ok: true, service: "rev-complete-auto-ocr-fixed", ai: !!env.AI });
    if (url.pathname !== "/api/ocr") return json({ ok: false, error: "Not Found", path: url.pathname }, 404);
    if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
    if (!env.AI) return json({ ok: false, error: "Workers AI binding がありません。Cloudflareで Binding 名 AI を追加してください。" }, 500);

    try {
      const form = await request.formData();
      const file = form.get("file");
      const mode = form.get("mode") || "auto";
      const headcount = form.get("headcount") || "18";
      const raceHint = safeJSON(form.get("race")) || {};
      if (!file) return json({ ok: false, error: "画像ファイルがありません" }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const prompt = buildPrompt(mode, headcount, raceHint);

      const result = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
        image: bytes,
        temperature: 0,
        max_tokens: 1800,
        prompt
      });
      const text = extractText(result);
      const parsed = parseJSONFromText(text);
      if (parsed) return json({ ok: true, data: parsed, rawText: text });
      return json({ ok: true, data: text, warning: "JSON parse failed. Frontend fallback parser will try." });
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }
};

function buildPrompt(mode, headcount, raceHint) {
  const race = JSON.stringify(raceHint || {});
  return `あなたは競馬画像専用OCRです。画像から読める事実だけを抽出し、JSONだけを返してください。説明、例、Markdown、コードブロックは禁止です。

mode=${mode}
頭数=${headcount}
既知レース情報=${race}

必ず次のキー構造だけで返してください。不明・読めない値は空文字または?です。
{
  "race": {"name":"", "place":"", "grade":"", "surface":"", "distance":""},
  "horses": [{"frame":"", "no":"", "name":"", "last1":"", "last2":"", "last3":"", "odds":""}],
  "odds": [{"no":"", "name":"", "odds":""}],
  "result": {"firstNo":"", "first":"", "secondNo":"", "second":"", "thirdNo":"", "third":"", "umaren":"", "umarenPay":"", "sanrenpuku":"", "sanrenpukuPay":""}
}

抽出ルール:
- 出馬表画像では horses を優先する。
- 単勝オッズ画像では odds を優先する。行頭の数字は馬番として扱う。
- 結果画像では result を優先する。
- 前走/前2走/前3走は着順数字だけを入れる。取消・中止・除外は0にする。
- 馬番、枠、着順、オッズ、払戻は半角数字にする。
- JSON以外を絶対に出力しない。`;
}
function extractText(result) {
  if (typeof result === "string") return result;
  return result?.response || result?.text || result?.description || result?.result || JSON.stringify(result);
}
function safeJSON(v) { try { return JSON.parse(v); } catch { return null; } }
function parseJSONFromText(text) {
  if (!text) return null;
  let s = String(text).trim().replace(/```json|```/g, "").trim();
  const first = s.indexOf("{"); const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  s = s.slice(first, last + 1).replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(s); } catch { return null; }
}
function json(obj, status = 200) { return withCors(Response.json(obj, { status })); }
function withCors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
