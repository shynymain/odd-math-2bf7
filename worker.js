export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method === "GET") {
      return Response.json({
        ok: true,
        message: "Rev OCR Worker is running",
        endpoint: "/api/ocr"
      }, { headers: cors });
    }

    try {
      if (!env.AI) {
        return Response.json({
          ok: false,
          error: "Workers AI binding がありません。変数名 AI の binding を追加してください。"
        }, { headers: cors });
      }

      const formData = await request.formData();
      const files = formData.getAll("file");
      const mode = formData.get("mode") || "auto";

      if (!files.length) {
        return Response.json({
          ok: false,
          error: "画像ファイルがありません"
        }, { headers: cors });
      }

      const results = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const imageBytes = new Uint8Array(await file.arrayBuffer());

        const prompt = buildPrompt(mode);

        const aiResult = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
          image: imageBytes,
          temperature: 0,
          max_tokens: 2400,
          prompt
        });

        const rawText =
          aiResult?.response ||
          aiResult?.text ||
          aiResult?.result ||
          JSON.stringify(aiResult);

        const parsed = extractJsonFromText(rawText);

        if (parsed) {
          results.push({
            ok: true,
            mode,
            index: i,
            data: normalizeData(parsed),
            rawText
          });
        } else {
          results.push({
            ok: false,
            mode,
            index: i,
            error: "AI returned non-JSON text",
            hint: "rawTextからJSONを抽出できませんでした",
            rawText
          });
        }
      }

      const merged = mergeResults(results);

      return Response.json({
        ok: true,
        merged,
        raw: results
      }, { headers: cors });

    } catch (err) {
      return Response.json({
        ok: false,
        error: String(err?.message || err)
      }, { headers: cors });
    }
  }
};

function buildPrompt(mode) {
  return `
あなたは競馬画像専用OCRです。
必ずJSONだけを返してください。
説明文、Markdown、コードブロックは禁止です。
不明な項目は空文字 "" にしてください。
馬番は必ず先頭の数字として扱ってください。

返すJSON形式：

{
  "race": {
    "name": "",
    "place": "",
    "grade": "",
    "surface": "",
    "distance": ""
  },
  "horses": [
    {
      "frame": "",
      "no": "",
      "name": "",
      "last1": "",
      "last2": "",
      "last3": "",
      "odds": ""
    }
  ],
  "odds": [
    {
      "no": "",
      "name": "",
      "odds": ""
    }
  ],
  "result": {
    "firstNo": "",
    "first": "",
    "secondNo": "",
    "second": "",
    "thirdNo": "",
    "third": "",
    "umaren": "",
    "umarenPay": "",
    "sanrenpuku": "",
    "sanrenpukuPay": ""
  }
}

現在の読取モード: ${mode}
`;
}

function extractJsonFromText(text) {
  if (!text) return null;

  let s = String(text).trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");

  if (start >= 0 && end > start) {
    s = s.slice(start, end + 1);
  }

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeData(data) {
  return {
    race: data.race || {},
    horses: Array.isArray(data.horses) ? data.horses : [],
    odds: Array.isArray(data.odds) ? data.odds : [],
    result: data.result || {}
  };
}

function mergeResults(results) {
  const merged = {
    horses: [],
    odds: [],
    result: {
      firstNo: "",
      first: "",
      secondNo: "",
      second: "",
      thirdNo: "",
      third: "",
      umaren: "",
      umarenPay: "",
      sanrenpuku: "",
      sanrenpukuPay: ""
    },
    race: {
      name: "",
      place: "",
      grade: "",
      surface: "",
      distance: ""
    }
  };

  for (const r of results) {
    if (!r.ok || !r.data) continue;

    const d = r.data;

    if (d.race) {
      for (const k of Object.keys(merged.race)) {
        if (!merged.race[k] && d.race[k]) merged.race[k] = String(d.race[k]);
      }
    }

    if (Array.isArray(d.horses)) {
      for (const h of d.horses) {
        if (!h.no && !h.number) continue;
        const no = String(h.no || h.number || "").trim();
        const old = merged.horses.find(x => String(x.no) === no);
        const item = {
          frame: String(h.frame || ""),
          no,
          name: String(h.name || ""),
          last1: String(h.last1 || ""),
          last2: String(h.last2 || ""),
          last3: String(h.last3 || ""),
          odds: String(h.odds || "")
        };

        if (old) Object.assign(old, cleanMerge(old, item));
        else merged.horses.push(item);
      }
    }

    if (Array.isArray(d.odds)) {
      for (const o of d.odds) {
        if (!o.no && !o.number) continue;
        const no = String(o.no || o.number || "").trim();
        const old = merged.odds.find(x => String(x.no) === no);
        const item = {
          no,
          name: String(o.name || ""),
          odds: String(o.odds || "")
        };

        if (old) Object.assign(old, cleanMerge(old, item));
        else merged.odds.push(item);
      }
    }

    if (d.result) {
      for (const k of Object.keys(merged.result)) {
        if (!merged.result[k] && d.result[k]) {
          merged.result[k] = String(d.result[k]);
        }
      }
    }
  }

  merged.horses.sort((a, b) => Number(a.no) - Number(b.no));
  merged.odds.sort((a, b) => Number(a.no) - Number(b.no));

  return merged;
}

function cleanMerge(oldItem, newItem) {
  const out = { ...oldItem };
  for (const k of Object.keys(newItem)) {
    if (!out[k] && newItem[k]) out[k] = newItem[k];
    if (k === "odds" && newItem[k]) out[k] = newItem[k];
    if (k === "name" && newItem[k] && newItem[k].length > String(out[k] || "").length) {
      out[k] = newItem[k];
    }
  }
  return out;
}
