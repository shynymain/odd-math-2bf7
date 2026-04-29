export default {
 async fetch(request, env) {
  if (request.method === "GET") return Response.json({ok:true,service:"rev-production-worker"});
  if (request.method !== "POST") return Response.json({ok:false,error:"POST only"},{status:405});
  try{
   if(!env.AI) return Response.json({ok:false,error:"Workers AI binding 'AI' がありません"});
   const form=await request.formData();
   const file=form.get("file"); if(!file) return Response.json({ok:false,error:"画像ファイルがありません"});
   const allowed=parseAllowed(String(form.get("allowedFrame")||"1-3"));
   const head=Number(form.get("headcount")||18);
   const image=new Uint8Array(await file.arrayBuffer());
   const prompt=`競馬出馬表OCR。JSON 1個だけ返す。説明、Markdown、コードは禁止。
対象枠:${allowed.join(",")} 頭数:${head}
画像に実際に見える馬だけ。推測で作らない。対象枠以外禁止。馬番が頭数超えは禁止。
形式のみ:
{"horses":[{"no":"","frame":"","name":"","last1":"","last2":"","last3":"","odds":"","confidence":0}]}`;
   const ai=await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct",{image,temperature:0,max_tokens:900,prompt});
   const raw=String(ai.response||ai.text||"");
   const horses=parseBest(raw,allowed,head);
   return Response.json({ok:true,mode:"entry-block",parser:"production-guard",allowedFrame:allowed.join(","),headcount:head,count:horses.length,horses,rawText:raw});
  }catch(e){return Response.json({ok:false,error:String(e)})}
 }
}
function parseAllowed(s){if(s.includes("-")){let[a,b]=s.split("-").map(Number),r=[];for(let i=a;i<=b;i++)r.push(String(i));return r}return s.split(",").map(x=>x.trim()).filter(Boolean)}
function strip(t){let i=t.indexOf("```");if(i>=0)t=t.slice(0,i);return t.replace(/出力[:：][\s\S]*$/,"").replace(/ご了承ください[\s\S]*$/,"")}
function objs(t){t=strip(String(t||""));let a=[],d=0,st=-1,str=false,esc=false;for(let i=0;i<t.length;i++){let c=t[i];if(str){if(esc)esc=false;else if(c==="\\")esc=true;else if(c==='"')str=false;continue}if(c==='"'){str=true;continue}if(c==="{"){if(d===0)st=i;d++}else if(c==="}"){d--;if(d===0&&st>=0){try{a.push(JSON.parse(t.slice(st,i+1)))}catch(e){}st=-1}}}return a}
function ci(v){return String(v??"").replace(/[^\d]/g,"")}
function co(v){let s=String(v??"").replace(/[^\d.]/g,""),n=+s;return isFinite(n)&&n>0&&n<1000?s:""}
function norm(h){return {no:ci(h?.no??h?.number),frame:ci(h?.frame),name:String(h?.name??"").replace(/[^\p{L}\p{N}ァ-ヶー・]/gu,"").trim(),last1:ci(h?.last1).slice(0,2),last2:ci(h?.last2).slice(0,2),last3:ci(h?.last3).slice(0,2),odds:co(h?.odds),confidence:Math.max(0,Math.min(100,Number(h?.confidence||0)))}}
function bad(h,allowed,head){if(!h.no||+h.no<1||+h.no>head)return true;if(!allowed.includes(h.frame))return true;if(!h.name&&!h.last1&&!h.last2&&!h.last3&&!h.odds)return true;return false}
function score(hs,allowed){let s=0,names={};for(const h of hs){if(h.name){s+=8;names[h.name]=(names[h.name]||0)+1}if(h.odds)s+=2;if(h.last1||h.last2||h.last3)s+=2;s+=h.confidence/20}if(hs.length>allowed.length*3)s-=80;if(hs.length>12)s-=120;let un=Object.keys(names).length;if(un>0&&un<=2&&hs.length>=6)s-=100;for(const k in names)if(names[k]>=3)s-=names[k]*15;return s}
function parseBest(raw,allowed,head){let best=[],bestS=-9999;for(const o of objs(raw)){let hs=(Array.isArray(o?.horses)?o.horses:[]).map(norm).filter(h=>!bad(h,allowed,head));let sc=score(hs,allowed);if(hs.length&&sc>bestS){best=hs;bestS=sc}}return best}
