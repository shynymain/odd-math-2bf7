export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, {status:204}));

    try {
      if (!env.AI) return json({ok:false,error:"Cloudflare Workers AI binding 'AI' がありません。"});
      const mode = url.pathname.split("/").pop();

      if (!["entry","entryRow","result"].includes(mode)) {
        return json({ok:false,error:"unknown endpoint", endpoint:mode});
      }

      const form = await request.formData();
      const file = form.get("file");
      if (!file) return json({ok:false,error:"画像ファイルがありません"});

      const image = new Uint8Array(await file.arrayBuffer());
      const prompt = buildPrompt(mode);

      const ai = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
        image,
        prompt,
        temperature: 0,
        max_tokens: 1200
      });

      const payload = typeof ai === "string" ? ai : (ai.response || ai.description || JSON.stringify(ai));
      const parsed = parseBestJson(payload);

      return json({
        ok: !!parsed.ok || !!parsed.race || !!parsed.horse || !!parsed.result,
        mode,
        rawText: payload,
        parsed
      });

    } catch (e) {
      return json({ok:false,error:String(e)});
    }
  }
};

function buildPrompt(mode){
  if (mode === "entry") return `
あなたは競馬出馬表ヘッダー専用OCRです。
必ずJSONだけ。説明禁止。推測禁止。
抽出対象：
年月日、開催地、レース番号、レース名、馬場、距離、対象年齢、対象性別、条件、グレード、頭数。
馬名・結果・払戻は出力しない。
形式：
{"ok":true,"race":{"date":"","place":"","raceNo":"","raceName":"","grade":"","condition":"","age":"","sex":"","surface":"","distance":"","headcount":""}}
`;

  if (mode === "entryRow") return `
あなたは競馬出馬表の1行専用OCRです。
必ずJSONだけ。説明禁止。推測禁止。
この画像には1頭分の行だけが入っている前提。
抽出対象：
馬番、枠、馬名、前走着順、前2走着順、前3走着順、単勝オッズ、人気。
結果払戻・馬連・3連複は出力しない。
形式：
{"ok":true,"horse":{"no":"","frame":"","name":"","last1":"","last2":"","last3":"","odds":"","popularity":""}}
`;

  return `
あなたは競馬結果・払戻専用OCRです。
必ずJSONだけ。説明禁止。推測禁止。
抽出対象：
1着馬番、2着馬番、3着馬番、馬連組合せ、馬連払戻、3連複組合せ、3連複払戻。
馬名一覧・出馬表・単勝オッズは出力しない。
形式：
{"ok":true,"result":{"firstNo":"","secondNo":"","thirdNo":"","umaren":"","umarenPay":"","sanrenpuku":"","sanrenpukuPay":""}}
`;
}

function parseBestJson(text){
  const s = String(text || "");
  const out = [];
  let depth = 0, start = -1;
  for (let i=0;i<s.length;i++){
    if (s[i] === "{") { if (depth === 0) start = i; depth++; }
    if (s[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const part = s.slice(start, i+1);
        try { out.push(JSON.parse(part)); } catch(e) {}
      }
    }
  }
  if (!out.length) return {ok:false,error:"JSON抽出失敗",rawText:s};
  out.sort((a,b)=>score(b)-score(a));
  return out[0];
}

function score(x){
  let n = 0;
  if (x.race) n += Object.values(x.race).filter(Boolean).length * 2;
  if (x.horse) n += Object.values(x.horse).filter(Boolean).length * 3;
  if (x.result) n += Object.values(x.result).filter(Boolean).length * 3;
  return n;
}

function json(obj){
  return cors(Response.json(obj));
}

function cors(res){
  res.headers.set("Access-Control-Allow-Origin","*");
  res.headers.set("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers","Content-Type");
  return res;
}
