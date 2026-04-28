export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({ ok: true, service: "rev-ocr-worker-hard-json-fix", version: "2026-04-29" });
    }

    if (url.pathname !== "/api/ocr") {
      return json({ ok: false, error: "Not found" }, 404);
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "POST only" }, 405);
    }

    try {
      if (!env.AI) {
        return json({ ok: false, error: "Cloudflare Workers AI binding 'AI' がありません" }, 500);
      }

      const form = await request.formData();
      const files = form.getAll("file").filter(Boolean);
      const mode = String(form.get("mode") || "auto");

      if (!files.length) {
        return json({ ok: false, error: "画像ファイルがありません" }, 400);
      }

      const raw = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const image = [...new Uint8Array(await file.arrayBuffer())];
        const prompt = buildPrompt(mode);

        const aiRes = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
          image,
          prompt,
          temperature: 0,
          max_tokens: 2200
        });

        const rawText = extractText(aiRes);
        const parsed = strictParseRaceJson(rawText);

        if (!parsed.ok) {
          raw.push({
            ok: false,
            error: parsed.error,
            hint: parsed.hint,
            rawText,
            mode,
            index: i
          });
          continue;
        }

        const normalized = normalizePayload(parsed.data);
        const quality = validatePayload(normalized, mode);

        if (!quality.ok) {
          raw.push({
            ok: false,
            error: quality.error,
            hint: quality.hint,
            rawText,
            parsed: normalized,
            mode,
            index: i
          });
          continue;
        }

        raw.push({ ok: true, data: normalized, rawText, mode, index: i });
      }

      const merged = mergePayloads(raw.filter(r => r.ok).map(r => r.data));
      return json({ ok: raw.some(r => r.ok), merged, raw });
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() }
  });
}

function buildPrompt(mode) {
  return `あなたは競馬画像専用OCRです。
必ずJSONのみを返してください。
説明文、Markdown、箇条書き、コードブロック、前置き、後書きは禁止。
画像に無い値は必ず空文字 "" にしてください。
推測で馬名・馬番・オッズ・着順を作らないでください。
例文は禁止。サンプルJSONは禁止。

返答はこのJSONスキーマだけです。
{
  "race": {"name":"","place":"","grade":"","surface":"","distance":""},
  "horses": [{"frame":"","no":"","name":"","last1":"","last2":"","last3":"","odds":""}],
  "odds": [{"no":"","name":"","odds":""}],
  "result": {
    "firstNo":"","first":"",
    "secondNo":"","second":"",
    "thirdNo":"","third":"",
    "umaren":"","umarenPay":"",
    "sanrenpuku":"","sanrenpukuPay":""
  }
}

mode=${mode}
読み取りルール:
- 馬番は先頭の数字を no に入れる。
- 枠番が見える場合だけ frame に入れる。
- オッズ一覧は「馬番 馬名 オッズ」の先頭数字を no として読む。
- 結果は1着/2着/3着の馬番と馬名を分ける。
- 馬連・3連複は組み合わせと払戻を分ける。
- JSON以外を返した場合は失敗です。`;
}

function extractText(aiRes) {
  if (typeof aiRes === "string") return aiRes.trim();
  if (aiRes?.response) return String(aiRes.response).trim();
  if (aiRes?.result) return String(aiRes.result).trim();
  if (aiRes?.text) return String(aiRes.text).trim();
  return JSON.stringify(aiRes || "");
}

function strictParseRaceJson(text) {
  const t = String(text || "").trim();

  if (!t) {
    return { ok: false, error: "AI returned empty text", hint: "画像OCRが空です。画像の解像度またはモデル応答を確認してください。" };
  }

  const badSigns = [
    "**", "```", "JSONオブジェクトの例", "以下は", "最終的な答え", "文字認識", "OCR（Optical", "競馬情報を読み取るには"
  ];

  if (badSigns.some(s => t.includes(s))) {
    return {
      ok: false,
      error: "AI returned explanatory/sample text",
      hint: "説明文や例JSONを返したため失敗扱いにしました。Workerは正常ですがVisionモデルがJSON-only指示を守っていません。"
    };
  }

  if (!(t.startsWith("{") && t.endsWith("}"))) {
    return {
      ok: false,
      error: "AI returned non-JSON text",
      hint: "JSONだけで返っていません。説明文混在を除外しました。"
    };
  }

  try {
    const data = JSON.parse(t);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: "JSON parse failed", hint: String(e?.message || e) };
  }
}

function normalizePayload(d) {
  const race = d?.race || {};
  const result = d?.result || {};

  const horses = Array.isArray(d?.horses) ? d.horses.map(h => ({
    frame: clean(h.frame),
    no: clean(h.no ?? h.number),
    name: clean(h.name ?? h.horse),
    last1: clean(h.last1),
    last2: clean(h.last2),
    last3: clean(h.last3),
    odds: clean(h.odds)
  })) : [];

  const odds = Array.isArray(d?.odds) ? d.odds.map(o => ({
    no: clean(o.no ?? o.number),
    name: clean(o.name ?? o.horse),
    odds: clean(o.odds)
  })) : [];

  return {
    race: {
      name: clean(race.name),
      place: clean(race.place),
      grade: clean(race.grade),
      surface: clean(race.surface),
      distance: clean(race.distance)
    },
    horses,
    odds,
    result: {
      firstNo: clean(result.firstNo ?? result.first_no ?? result.winnerNo),
      first: clean(result.first ?? result.winner),
      secondNo: clean(result.secondNo ?? result.second_no ?? result.runnerUpNo),
      second: clean(result.second ?? result["runner-up"] ?? result.runnerUp),
      thirdNo: clean(result.thirdNo ?? result.third_no),
      third: clean(result.third),
      umaren: clean(result.umaren),
      umarenPay: clean(result.umarenPay),
      sanrenpuku: clean(result.sanrenpuku),
      sanrenpukuPay: clean(result.sanrenpukuPay)
    }
  };
}

function clean(v) {
  return String(v ?? "").replace(/[\n\r\t]/g, " ").replace(/　/g, " ").trim();
}

function validatePayload(d, mode) {
  const hasHorseName = d.horses.some(h => h.name);
  const hasHorseNo = d.horses.some(h => /^\d+$/.test(h.no));
  const hasOdds = d.odds.some(o => /^\d+(\.\d+)?$/.test(o.odds));
  const hasOddsNo = d.odds.some(o => /^\d+$/.test(o.no));
  const hasResult = d.result.firstNo || d.result.secondNo || d.result.thirdNo || d.result.umaren || d.result.sanrenpuku;

  if (d.horses.length && hasHorseName && !hasHorseNo) {
    return { ok: false, error: "horse numbers missing", hint: "馬名は読めていますが馬番が無いため自動反映しません。先頭数字を読める画像で再実行してください。" };
  }

  if (d.odds.length && hasOdds && !hasOddsNo) {
    return { ok: false, error: "odds horse numbers missing", hint: "オッズは読めていますが馬番が無いため自動反映しません。説明文内の例JSON混入も防止済みです。" };
  }

  if (!d.horses.length && !d.odds.length && !hasResult && !Object.values(d.race).some(Boolean)) {
    return { ok: false, error: "empty useful data", hint: "有効な競馬データがありません。" };
  }

  return { ok: true };
}

function mergePayloads(list) {
  const merged = {
    horses: [],
    odds: [],
    result: { firstNo:"", first:"", secondNo:"", second:"", thirdNo:"", third:"", umaren:"", umarenPay:"", sanrenpuku:"", sanrenpukuPay:"" },
    race: { name:"", place:"", grade:"", surface:"", distance:"" }
  };

  for (const d of list) {
    for (const k of Object.keys(merged.race)) if (!merged.race[k] && d.race?.[k]) merged.race[k] = d.race[k];
    for (const k of Object.keys(merged.result)) if (!merged.result[k] && d.result?.[k]) merged.result[k] = d.result[k];

    for (const h of d.horses || []) {
      if (!h.no && !h.name) continue;
      const idx = merged.horses.findIndex(x => x.no && h.no && x.no === h.no);
      if (idx >= 0) merged.horses[idx] = { ...merged.horses[idx], ...removeEmpty(h) };
      else merged.horses.push(h);
    }

    for (const o of d.odds || []) {
      if (!o.no && !o.odds) continue;
      const idx = merged.odds.findIndex(x => x.no && o.no && x.no === o.no);
      if (idx >= 0) merged.odds[idx] = { ...merged.odds[idx], ...removeEmpty(o) };
      else merged.odds.push(o);
    }
  }

  merged.horses.sort((a,b) => Number(a.no || 999) - Number(b.no || 999));
  merged.odds.sort((a,b) => Number(a.no || 999) - Number(b.no || 999));
  return merged;
}

function removeEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([,v]) => v !== "" && v != null));
}
