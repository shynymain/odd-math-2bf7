export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname === '/' || url.pathname === '/api/health') return cors(Response.json({ ok:true, name:'rev-ocr-worker-retry-nonempty-fixed', version:'2026-04-29-retry-nonempty-fixed' }));
    if (url.pathname !== '/api/ocr') return cors(Response.json({ ok:false, error:'Not found', path:url.pathname }, { status:404 }));
    if (request.method !== 'POST') return cors(Response.json({ ok:false, error:'POST only' }, { status:405 }));
    try {
      if (!env.AI) return cors(Response.json({ ok:false, error:'Cloudflare Workers AI binding AI がありません' }, { status:500 }));
      const form = await request.formData();
      const files = form.getAll('files').length ? form.getAll('files') : [form.get('file')].filter(Boolean);
      const mode = String(form.get('mode') || 'auto');
      const headcount = String(form.get('headcount') || '');
      if (!files.length) return cors(Response.json({ ok:false, error:'画像ファイルがありません' }, { status:400 }));
      const raw = [];
      for (const file of files) raw.push(await recognizeOne(env, file, mode, headcount));
      const merged = mergeAll(raw);
      const ok = raw.some(r => r.ok) && (merged.horses.length || merged.odds.length || hasResult(merged.result) || hasRace(merged.race));
      return cors(Response.json({ ok, mode, count: files.length, merged, raw }));
    } catch (e) {
      return cors(Response.json({ ok:false, error:String(e?.message || e) }, { status:500 }));
    }
  }
};

async function recognizeOne(env, file, mode, headcount) {
  const imageBytes = new Uint8Array(await file.arrayBuffer());
  const image = [...imageBytes];
  const attempts = buildAttempts(mode, headcount);
  const tried = [];

  for (let i = 0; i < attempts.length; i++) {
    const prompt = attempts[i];
    let aiResult;
    try {
      aiResult = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        image,
        prompt,
        temperature: 0,
        max_tokens: 1800
      });
    } catch (e) {
      tried.push({ attempt:i+1, error:'AI run failed: ' + String(e?.message || e) });
      continue;
    }

    const text = normalizeAIText(aiResult);
    const parsed = parseSingleJSON(text);
    if (!parsed) {
      tried.push({ attempt:i+1, error:'AI returned non-JSON text', rawText:text.slice(0, 1200) });
      continue;
    }

    const data = normalizeData(parsed);
    const meaningful = hasMeaningfulData(data, mode);
    tried.push({ attempt:i+1, ok:true, meaningful, rawText:text.slice(0, 1200) });

    if (meaningful) {
      return { ok:true, file:file.name || '', data, rawText:text.slice(0, 3000), attempts: tried };
    }
  }

  return {
    ok:false,
    file:file.name || '',
    error:'JSONにはなりましたが、画像から実データを抽出できませんでした。画像が小さい/表が細かい/余白が多い可能性があります。modeを horses / odds / result に分けて再実行してください。',
    data: emptyData(),
    attempts: tried
  };
}

function buildAttempts(mode, headcount) {
  const modes = mode === 'auto' ? ['horses','odds','result','auto'] : [mode, 'auto'];
  return [...new Set(modes)].map((m, idx) => buildPrompt(m, headcount, idx + 1));
}

function emptyData(){
  return { ok:false, race:{name:'',place:'',grade:'',surface:'',distance:''}, horses:[], odds:[], result:{firstNo:'',first:'',secondNo:'',second:'',thirdNo:'',third:'',umaren:'',umarenPay:'',sanrenpuku:'',sanrenpukuPay:''} };
}

function hasMeaningfulData(data, mode){
  if (!data) return false;
  const hasHorse = Array.isArray(data.horses) && data.horses.some(h => h.no || h.name || h.last1 || h.last2 || h.last3);
  const hasOdds = Array.isArray(data.odds) && data.odds.some(o => o.no || o.name || o.odds);
  const hasRes = hasResult(data.result);
  const hasRc = hasRace(data.race);
  if (mode === 'horses') return hasHorse;
  if (mode === 'odds') return hasOdds;
  if (mode === 'result') return hasRes;
  return hasHorse || hasOdds || hasRes || hasRc;
}

function buildPrompt(mode, headcount, attemptNo = 1) {
  const target = mode === 'horses'
    ? '出馬表です。馬番・枠番・馬名・前走着順・前2走着順・前3走着順を読む。'
    : mode === 'odds'
      ? '単勝オッズ表です。馬番・馬名・単勝オッズを読む。人気は不要。'
      : mode === 'result'
        ? 'レース結果/払戻です。1着・2着・3着・馬連・3連複・払戻金を読む。'
        : '競馬画像です。読める出馬表・単勝オッズ・結果・払戻だけ読む。';

  const required = mode === 'horses'
    ? 'horses配列に、画像内で見える馬を必ず1頭ずつ入れる。'
    : mode === 'odds'
      ? 'odds配列に、画像内で見える単勝オッズを必ず1頭ずつ入れる。'
      : mode === 'result'
        ? 'resultに、画像内で見える着順/払戻を必ず入れる。'
        : 'horses/odds/resultのうち、画像内で見えるデータを必ず入れる。';

  return [
    '競馬画像OCR。JSONだけを返す。',
    '説明文、例、Markdown、コメント、同じJSONの繰り返しは禁止。',
    '最初は { 、最後は } 。JSONオブジェクトは1個だけ。',
    '空テンプレートは禁止。画像に文字が見える場合、必ず実データを入れる。',
    '読み取れない1項目だけ空文字。全項目を空にしてはいけない。',
    '馬番は先頭の数字。馬名は日本語/カタカナ/英字の馬名。',
    '表は左から右、上から下に読み、1行=1頭として扱う。',
    '同じ値を大量に繰り返してはいけない。',
    `mode=${mode}`,
    `attempt=${attemptNo}`,
    `headcount=${headcount || ''}`,
    target,
    required,
    '返すキーは ok,race,horses,odds,result の5つだけ。',
    'race: name,place,grade,surface,distance',
    'horses要素: frame,no,name,last1,last2,last3',
    'odds要素: no,name,odds',
    'result: firstNo,first,secondNo,second,thirdNo,third,umaren,umarenPay,sanrenpuku,sanrenpukuPay',
    '画像に対象データが全く見えない場合だけ ok:false で空配列にする。',
    '画像に1文字でも馬番/馬名/オッズ/着順が見えるなら ok:true にして該当配列へ入れる。'
  ].join('\n');
}

function normalizeAIText(v) {
  // Workers AI の返却形式差を吸収する。
  // ここで String(オブジェクト) にすると [object Object] になるため、必ず再帰的に中身を取り出す。
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(normalizeAIText).filter(Boolean).join('\n').trim();

  if (typeof v === 'object') {
    // AIがJSONオブジェクトを直接返した場合
    if (v.ok !== undefined || v.race || v.horses || v.odds || v.result) {
      try { return JSON.stringify(v); } catch { return ''; }
    }

    // Cloudflare Workers AIでよくあるラップ形式
    const keys = ['response', 'result', 'text', 'output', 'content', 'message', 'data'];
    for (const k of keys) {
      if (v[k] !== undefined && v[k] !== null) {
        const inner = normalizeAIText(v[k]);
        if (inner) return inner;
      }
    }

    // 最後の保険。少なくとも [object Object] にはしない。
    try { return JSON.stringify(v); } catch { return ''; }
  }
  return '';
}

function parseSingleJSON(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  try { return JSON.parse(t); } catch {}
  const candidates = extractJSONObjects(t);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch {}
  }
  return null;
}

function extractJSONObjects(text) {
  const out = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i=0;i<text.length;i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc=false; else if (ch==='\\') esc=true; else if (ch==='"') inStr=false; continue; }
    if (ch==='"') { inStr=true; continue; }
    if (ch==='{') { if (depth===0) start=i; depth++; }
    if (ch==='}') { depth--; if (depth===0 && start>=0) { out.push(text.slice(start,i+1)); start=-1; } }
  }
  return out;
}

function normalizeData(d) {
  const race = d.race || {};
  const result = d.result || {};
  const horses = Array.isArray(d.horses) ? d.horses.map(h => ({
    frame: cleanNum(h.frame), no: cleanNum(h.no || h.number), name: cleanName(h.name),
    last1: cleanNum(h.last1), last2: cleanNum(h.last2), last3: cleanNum(h.last3)
  })).filter(h => h.no || h.name) : [];
  const odds = Array.isArray(d.odds) ? d.odds.map(o => ({
    no: cleanNum(o.no || o.number), name: cleanName(o.name), odds: cleanOdds(o.odds)
  })).filter(o => o.no || o.name || o.odds) : [];
  return {
    ok: d.ok !== false,
    race: { name:String(race.name||''), place:String(race.place||''), grade:String(race.grade||''), surface:String(race.surface||''), distance:String(race.distance||'') },
    horses, odds,
    result: {
      firstNo: cleanNum(result.firstNo), first: cleanName(result.first),
      secondNo: cleanNum(result.secondNo), second: cleanName(result.second),
      thirdNo: cleanNum(result.thirdNo), third: cleanName(result.third),
      umaren: cleanTicket(result.umaren), umarenPay: cleanPay(result.umarenPay),
      sanrenpuku: cleanTicket(result.sanrenpuku), sanrenpukuPay: cleanPay(result.sanrenpukuPay)
    }
  };
}
function cleanNum(v){ return String(v ?? '').replace(/[０-９]/g,s=>String.fromCharCode(s.charCodeAt(0)-0xFEE0)).replace(/[^0-9]/g,''); }
function cleanOdds(v){ return String(v ?? '').replace(/[０-９．]/g,s=>s==='．'?'.':String.fromCharCode(s.charCodeAt(0)-0xFEE0)).replace(/[^0-9.]/g,''); }
function cleanPay(v){ return String(v ?? '').replace(/[０-９]/g,s=>String.fromCharCode(s.charCodeAt(0)-0xFEE0)).replace(/[^0-9]/g,''); }
function cleanName(v){ return String(v ?? '').replace(/[《》\[\]{}]/g,'').trim(); }
function cleanTicket(v){ return String(v ?? '').replace(/[－ー―–]/g,'-').replace(/[^0-9\-]/g,''); }
function hasRace(r){ return Object.values(r||{}).some(Boolean); }
function hasResult(r){ return Object.values(r||{}).some(Boolean); }

function mergeAll(raw) {
  const merged = { race:{name:'',place:'',grade:'',surface:'',distance:''}, horses:[], odds:[], result:{firstNo:'',first:'',secondNo:'',second:'',thirdNo:'',third:'',umaren:'',umarenPay:'',sanrenpuku:'',sanrenpukuPay:''} };
  const horseMap = new Map(), oddsMap = new Map();
  for (const r of raw) {
    if (!r.ok || !r.data) continue;
    for (const k of Object.keys(merged.race)) if (!merged.race[k] && r.data.race?.[k]) merged.race[k] = r.data.race[k];
    for (const h of r.data.horses || []) {
      const key = h.no || h.name; if (!key) continue;
      const old = horseMap.get(key) || {};
      horseMap.set(key, { ...old, ...Object.fromEntries(Object.entries(h).filter(([,v])=>v)) });
    }
    for (const o of r.data.odds || []) {
      const key = o.no || o.name; if (!key) continue;
      const old = oddsMap.get(key) || {};
      oddsMap.set(key, { ...old, ...Object.fromEntries(Object.entries(o).filter(([,v])=>v)) });
    }
    for (const k of Object.keys(merged.result)) if (!merged.result[k] && r.data.result?.[k]) merged.result[k] = r.data.result[k];
  }
  merged.horses = [...horseMap.values()].sort((a,b)=>(Number(a.no||999)-Number(b.no||999)));
  merged.odds = [...oddsMap.values()].sort((a,b)=>(Number(a.no||999)-Number(b.no||999)));
  return merged;
}
function cors(res){ const h=new Headers(res.headers); h.set('Access-Control-Allow-Origin','*'); h.set('Access-Control-Allow-Methods','GET,POST,OPTIONS'); h.set('Access-Control-Allow-Headers','Content-Type'); return new Response(res.body,{status:res.status,headers:h}); }
