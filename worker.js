export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(json({ ok: true }));
    if (url.pathname === "/" || url.pathname === "/api/health") {
      return cors(json({ ok: true, service: "rev-ocr-worker", mode: "hard-json-v2" }));
    }
    if (url.pathname !== "/api/ocr") return cors(json({ ok: false, error: "Not found" }, 404));
    if (request.method !== "POST") return cors(json({ ok: false, error: "POST only" }, 405));
    if (!env.AI) return cors(json({ ok: false, error: "Workers AI binding AI is missing" }, 500));

    try {
      const form = await request.formData();
      const file = form.get("file");
      const mode = String(form.get("mode") || "auto");
      const headcount = String(form.get("headcount") || "");
      const raceHint = safeParse(form.get("raceHint"));
      if (!file) return cors(json({ ok: false, error: "画像ファイルがありません" }, 400));

      const imageBytes = new Uint8Array(await file.arrayBuffer());
      const model = env.OCR_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";

      let first = await runVision(env, model, imageBytes, buildPrompt(mode, headcount, raceHint, 1));
      let parsed = extractStrictJSON(first);

      // AIがコードや説明を返した場合だけ、さらに短いプロンプトで再試行
      if (!parsed || looksLikeCode(first)) {
        const retry = await runVision(env, model, imageBytes, buildPrompt(mode, headcount, raceHint, 2));
        const retryParsed = extractStrictJSON(retry);
        if (retryParsed && !looksLikeCode(retry)) {
          return cors(json({ ok: true, data: normalizePayload(retryParsed), rawText: retry, repaired: true }));
        }
        return cors(json({
          ok: false,
          error: "AI returned non-JSON text",
          hint: "画像OCRは成功していません。rawTextにPython/説明文が出る場合は、Workerは正常ですがVisionモデルがJSON指示を無視しています。",
          rawText: retry.slice(0, 2500),
          firstText: first.slice(0, 1200)
        }, 422));
      }

      return cors(json({ ok: true, data: normalizePayload(parsed), rawText: first }));
    } catch (e) {
      return cors(json({ ok: false, error: String(e && e.message ? e.message : e) }, 500));
    }
  }
};

async function runVision(env, model, imageBytes, prompt) {
  const res = await env.AI.run(model, {
    image: imageBytes,
    prompt,
    temperature: 0,
    max_tokens: 900
  });
  return typeof res === "string" ? res : (res?.response || res?.description || res?.text || JSON.stringify(res));
}

function buildPrompt(mode, headcount, raceHint, pass) {
  if (pass === 2) {
    return `画像を読み取り、JSONオブジェクト1個だけを返してください。コード、説明、Markdownは禁止。\n{"race":{"name":"","place":"","grade":"","surface":"","distance":""},"horses":[],"odds":[],"result":{}}\nmode=${mode} headcount=${headcount}`;
  }

  return `あなたは競馬画像専用のJSON抽出器です。プログラム作成者ではありません。\n\n最重要ルール:\n1. 返答はJSONオブジェクト1個だけ。\n2. Markdown禁止。コードブロック禁止。説明文禁止。\n3. Python/JavaScript/正規表現/関数/サンプルコードを絶対に書かない。\n4. 画像に実際に見える文字・数字だけを抽出する。\n5. 読めない値は空文字、迷う文字は?。\n\n返すJSONの形:\n{"race":{"name":"","place":"","grade":"","surface":"","distance":""},"horses":[{"frame":"","no":"","name":"","last1":"","last2":"","last3":"","odds":""}],"odds":[{"no":"","name":"","odds":""}],"result":{"firstNo":"","first":"","secondNo":"","second":"","thirdNo":"","third":"","umaren":"","umarenPay":"","sanrenpuku":"","sanrenpukuPay":""}}\n\n抽出方針:\n- 出馬表画像では horses を優先。\n- 単勝オッズ画像では odds を優先。行頭の数字は馬番。\n- 結果画像では result を優先。\n- 前走/前2走/前3走は着順数字だけ。取消・中止・除外は0。\n- 馬番、枠、着順、オッズ、払戻は半角数字。\n\nmode=${mode}\nheadcount=${headcount}\nraceHint=${JSON.stringify(raceHint || {})}`;
}

function extractStrictJSON(text) {
  if (!text) return null;
  let s = String(text).trim();

  // Markdown fenceを含む場合は基本失敗扱い。ただし中身が純JSONなら救済。
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const candidate = s.slice(start, end + 1);

  try {
    const obj = JSON.parse(candidate);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

function looksLikeCode(text) {
  const t = String(text || "");
  return /```|import\s+|def\s+|function\s+|const\s+|let\s+|var\s+|print\s*\(|json\.dumps|このコード|コードは/.test(t);
}

function normalizePayload(obj) {
  const race = obj.race && typeof obj.race === "object" ? obj.race : {};
  const horses = Array.isArray(obj.horses) ? obj.horses : [];
  const odds = Array.isArray(obj.odds) ? obj.odds : [];
  const result = obj.result && typeof obj.result === "object" ? obj.result : {};
  return { race, horses, odds, result };
}

function safeParse(v) {
  if (!v) return {};
  try { return JSON.parse(String(v)); } catch { return {}; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "content-type");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
