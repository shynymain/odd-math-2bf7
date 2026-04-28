export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(json({ ok: true }));

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return cors(json({
        ok: true,
        service: "rev-ocr-worker",
        mode: "hard-json-v4-image-array"
      }));
    }

    if (url.pathname !== "/api/ocr") {
      return cors(json({ ok: false, error: "Not found" }, 404));
    }

    if (request.method !== "POST") {
      return cors(json({ ok: false, error: "POST only" }, 405));
    }

    if (!env.AI) {
      return cors(json({
        ok: false,
        error: "Workers AI binding AI is missing"
      }, 500));
    }

    try {
      const form = await request.formData();
      const file = form.get("file");
      const mode = String(form.get("mode") || "auto");
      const headcount = String(form.get("headcount") || "");
      const raceHint = safeParse(form.get("raceHint") || form.get("race"));

      if (!file) {
        return cors(json({ ok: false, error: "画像ファイルがありません" }, 400));
      }

      const imageArray = Array.from(new Uint8Array(await file.arrayBuffer()));
      const model = env.OCR_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";

      const first = await runVision(
        env,
        model,
        imageArray,
        buildPrompt(mode, headcount, raceHint, 1)
      );

      const parsed = extractStrictJSON(first);

      if (!parsed || looksLikeCode(first) || looksLikeBadHallucination(parsed)) {
        const retry = await runVision(
          env,
          model,
          imageArray,
          buildPrompt(mode, headcount, raceHint, 2)
        );

        const retryParsed = extractStrictJSON(retry);

        if (
          retryParsed &&
          !looksLikeCode(retry) &&
          !looksLikeBadHallucination(retryParsed)
        ) {
          return cors(json({
            ok: true,
            data: normalizePayload(retryParsed),
            rawText: retry,
            repaired: true,
            mode: "hard-json-v4-image-array"
          }));
        }

        return cors(json({
          ok: false,
          error: "AI returned non-JSON text",
          hint: "画像OCRは成功していません。rawTextにPython/説明文/異常JSONが出る場合はVisionモデルがJSON抽出に失敗しています。",
          rawText: String(retry || "").slice(0, 2500),
          firstText: String(first || "").slice(0, 1200),
          mode: "hard-json-v4-image-array"
        }, 422));
      }

      return cors(json({
        ok: true,
        data: normalizePayload(parsed),
        rawText: first,
        mode: "hard-json-v4-image-array"
      }));

    } catch (e) {
      return cors(json({
        ok: false,
        error: String(e && e.message ? e.message : e)
      }, 500));
    }
  }
};

async function runVision(env, model, imageArray, prompt) {
  const res = await env.AI.run(model, {
    image: imageArray,
    prompt,
    temperature: 0,
    max_tokens: 800
  });

  return typeof res === "string"
    ? res
    : (res?.response || res?.description || res?.text || JSON.stringify(res));
}

function buildPrompt(mode, headcount, raceHint, pass) {
  if (pass === 2) {
    return [
      "画像から競馬情報を読み取り、JSONオブジェクト1個だけを返してください。",
      "Python、JavaScript、Markdown、説明文、コードブロックは禁止。",
      "読めない項目は空文字。不明な文字は?。",
      '{"race":{"name":"","place":"","grade":"","surface":"","distance":""},"horses":[],"odds":[],"result":{}}',
      `mode=${mode}`,
      `headcount=${headcount}`
    ].join("\n");
  }

  return `あなたは競馬画像専用のJSON抽出器です。プログラム作成者ではありません。

最重要ルール:
1. 返答はJSONオブジェクト1個だけ。
2. Markdown禁止。コードブロック禁止。説明文禁止。
3. Python/JavaScript/正規表現/関数/サンプルコードを絶対に書かない。
4. 画像に実際に見える文字・数字だけを抽出する。
5. 読めない値は空文字、迷う文字は?。
6. 存在しないフィールドを大量生成しない。

返すJSONの形:
{"race":{"name":"","place":"","grade":"","surface":"","distance":""},"horses":[{"frame":"","no":"","name":"","last1":"","last2":"","last3":"","odds":""}],"odds":[{"no":"","name":"","odds":""}],"result":{"firstNo":"","first":"","secondNo":"","second":"","thirdNo":"","third":"","umaren":"","umarenPay":"","sanrenpuku":"","sanrenpukuPay":""}}

抽出方針:
- 出馬表画像では horses を優先。
- 単勝オッズ画像では odds を優先。行頭の数字は馬番。
- 結果画像では result を優先。
- 前走/前2走/前3走は着順数字だけ。取消・中止・除外は0。
- 馬番、枠、着順、オッズ、払戻は半角数字。

mode=${mode}
headcount=${headcount}
raceHint=${JSON.stringify(raceHint || {})}`;
}

function extractStrictJSON(text) {
  if (!text) return null;

  let s = String(text).trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");

  if (start < 0 || end <= start) return null;

  const candidate = s.slice(start, end + 1)
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");

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

  return /```|import\s+|def\s+|function\s+|const\s+|let\s+|var\s+|print\s*\(|json\.dumps|このコード|コードは|Pillow|正規表現/.test(t);
}

function looksLikeBadHallucination(obj) {
  const s = JSON.stringify(obj || {});

  if (s.length > 12000) return true;
  if (/position_change_percentage_percentage|percentage_percentage_percentage/.test(s)) return true;
  if (/image=\{|000000000000000000000000/.test(s)) return true;

  const allowedTop = new Set(["race", "horses", "odds", "result"]);
  const topKeys = Object.keys(obj || {});

  if (topKeys.some(k => !allowedTop.has(k)) && topKeys.length > 6) {
    return true;
  }

  return false;
}

function normalizePayload(obj) {
  const race = obj.race && typeof obj.race === "object"
    ? normalizeRace(obj.race)
    : {};

  const horses = Array.isArray(obj.horses)
    ? obj.horses.map(normalizeHorse).filter(h =>
        h.no || h.name || h.last1 || h.last2 || h.last3 || h.odds
      )
    : [];

  const odds = Array.isArray(obj.odds)
    ? obj.odds.map(normalizeOdd).filter(o =>
        o.no || o.name || o.odds
      )
    : [];

  const result = obj.result && typeof obj.result === "object"
    ? normalizeResult(obj.result)
    : {};

  return { race, horses, odds, result };
}

function normalizeRace(r) {
  return {
    name: str(r.name),
    place: str(r.place),
    grade: str(r.grade),
    surface: str(r.surface),
    distance: str(r.distance)
  };
}

function normalizeHorse(h) {
  return {
    frame: digits(h.frame || h["枠"]),
    no: digits(h.no || h.number || h["馬番"]),
    name: str(h.name || h["馬名"]),
    last1: rank(h.last1 || h["前走"]),
    last2: rank(h.last2 || h["前2走"]),
    last3: rank(h.last3 || h["前3走"]),
    odds: oddsValue(h.odds || h["単勝オッズ"])
  };
}

function normalizeOdd(o) {
  return {
    no: digits(o.no || o.number || o["馬番"]),
    name: str(o.name || o["馬名"]),
    odds: oddsValue(o.odds || o["単勝オッズ"])
  };
}

function normalizeResult(r) {
  return {
    firstNo: digits(r.firstNo || r["1着馬番"]),
    first: str(r.first || r["1着"] || r.firstName),
    secondNo: digits(r.secondNo || r["2着馬番"]),
    second: str(r.second || r["2着"] || r.secondName),
    thirdNo: digits(r.thirdNo || r["3着馬番"]),
    third: str(r.third || r["3着"] || r.thirdName),
    umaren: combo(r.umaren || r["馬連"]),
    umarenPay: pay(r.umarenPay || r["馬連払戻"]),
    sanrenpuku: combo(r.sanrenpuku || r["3連複"]),
    sanrenpukuPay: pay(r.sanrenpukuPay || r["3連複払戻"])
  };
}

function str(v) {
  return v == null ? "" : String(v).trim();
}

function digits(v) {
  const m = String(v || "").match(/\d+/);
  return m ? String(Number(m[0])) : "";
}

function rank(v) {
  const s = String(v || "").trim();

  if (/取消|中止|除外/.test(s)) return "0";

  const m = s.match(/\d+/);
  return m ? String(Number(m[0])) : "";
}

function oddsValue(v) {
  const m = String(v || "")
    .replace(/,/g, ".")
    .match(/\d+(?:\.\d+)?/);

  return m ? m[0] : "";
}

function combo(v) {
  const nums = String(v || "").match(/\d+/g);
  return nums ? nums.map(n => String(Number(n))).join("-") : "";
}

function pay(v) {
  const nums = String(v || "").replace(/,/g, "").match(/\d+/g);
  return nums ? nums.join("") : "";
}

function safeParse(v) {
  if (!v) return {};

  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function cors(res) {
  const h = new Headers(res.headers);

  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "content-type");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: h
  });
}
