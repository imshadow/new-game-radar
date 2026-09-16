import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateSeoVerdict, cleanGameName, estimateNameRisk } from '../lib/seo-verifier.mjs';
import { calculateFastSignals, FAST_MODEL_VERSION } from '../lib/fast-signals.mjs';
import { SEO_MODEL_VERSION } from '../lib/trend-queue.mjs';
import { POLICY_SETS } from '../lib/source-registry.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const candidatesPath=path.join(root,'data','candidates.json');
const reportPath=path.join(root,'data','latest-report.json');
const usagePath=path.join(root,'data','google-cse-usage.json');
const TIMEOUT=Math.max(5000,Number(process.env.GOOGLE_CSE_TIMEOUT_MS||15000));
const LIMIT=Math.max(0,Math.min(200,Number(process.env.GOOGLE_CSE_VERIFY_LIMIT||180)));
const DEFAULT_DAILY=Math.max(1,Number(process.env.GOOGLE_CSE_DAILY_LIMIT||90));
const REGION=String(process.env.SEO_REGION||'US').toLowerCase();
const LANGUAGE=String(process.env.SEO_LANGUAGE||'en-US').split('-')[0].toLowerCase();
const slots=[
  {id:'1',key:process.env.GOOGLE_CSE_API_KEY||'',cx:process.env.GOOGLE_CSE_CX||'',limit:Math.max(1,Number(process.env.GOOGLE_CSE_DAILY_LIMIT_1||DEFAULT_DAILY))},
  {id:'2',key:process.env.GOOGLE_CSE_API_KEY_2||'',cx:process.env.GOOGLE_CSE_CX_2||'',limit:Math.max(1,Number(process.env.GOOGLE_CSE_DAILY_LIMIT_2||DEFAULT_DAILY))},
].filter(x=>x.key&&x.cx);
// Declared in lib/source-registry.mjs. NOTE: this script is not invoked by
// .github/workflows/radar.yml — the Google CSE path was superseded by Serper.
// See the review report; it is a candidate for deletion.
const STRATEGIC=POLICY_SETS.GOOGLE_CSE_STRATEGIC;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return fallback}}
const day=()=>new Date().toISOString().slice(0,10);
async function readUsage(){
  let u=await readJson(usagePath,{});
  if(u.day!==day())u={day:day(),slots:{},updatedAt:new Date().toISOString()};
  u.slots=u.slots||{};
  for(const s of slots){const old=u.slots[s.id]||{};u.slots[s.id]={dayUsed:Number(old.dayUsed||0),dailyLimit:s.limit,blocked:Boolean(old.blocked),lastError:old.lastError||null,lastUsedAt:old.lastUsedAt||null}}
  return u;
}
async function saveUsage(u){u.updatedAt=new Date().toISOString();await fs.writeFile(usagePath,JSON.stringify(u,null,2)+'\n')}
async function reserve(s){const u=await readUsage(),x=u.slots[s.id];if(x.blocked||x.dayUsed>=s.limit)return false;x.dayUsed+=1;x.lastUsedAt=new Date().toISOString();await saveUsage(u);return true}
async function block(s,msg){const u=await readUsage();u.slots[s.id]={...(u.slots[s.id]||{dayUsed:0,dailyLimit:s.limit}),blocked:true,lastError:String(msg).slice(0,300)};await saveUsage(u)}
async function usageSummary(){const u=await readUsage();let used=0,limit=0;for(const s of slots){used+=Number(u.slots[s.id]?.dayUsed||0);limit+=s.limit}return{enabled:slots.length>0,configuredSlots:slots.length,day:u.day,totalDayUsed:used,totalDailyLimit:limit,slots:u.slots,updatedAt:u.updatedAt||null}}

function decode(v=''){return String(v).replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim()}
export function parseGoogleCseResults(payload={}){return(payload.items||[]).slice(0,10).map(x=>({url:String(x.link||''),title:decode(x.htmlTitle||x.title||''),snippet:decode(x.htmlSnippet||x.snippet||'')})).filter(x=>x.url)}
async function googleSearch(query){
  let attempts=0,lastError=null;
  for(const s of slots){
    if(!await reserve(s))continue;
    attempts+=1;
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),TIMEOUT);
    const params=new URLSearchParams({key:s.key,cx:s.cx,q:query,num:'10',gl:REGION,hl:LANGUAGE,lr:`lang_${LANGUAGE}`,safe:'active',filter:'1'});
    try{
      const res=await fetch(`https://customsearch.googleapis.com/customsearch/v1?${params}`,{signal:ctl.signal});
      const data=await res.json().catch(()=>({}));
      if(!res.ok){const msg=data?.error?.message||`Google CSE returned ${res.status}`;lastError=new Error(msg);if([400,401,403,429].includes(res.status))await block(s,msg);continue}
      return{results:parseGoogleCseResults(data),slotId:s.id,attempts};
    }catch(e){lastError=new Error(e?.name==='AbortError'?'Google CSE request timed out':e.message)}finally{clearTimeout(timer)}
  }
  const e=lastError||new Error('Google CSE daily quota exhausted');e.code=lastError?'GOOGLE_CSE_UNAVAILABLE':'GOOGLE_CSE_QUOTA';throw e;
}
async function suggestions(q){try{const r=await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`);if(!r.ok)return[];const d=await r.json();return Array.isArray(d?.[1])?d[1].map(String):[]}catch{return[]}}
function kinds(c){return new Set((c.sources||[]).map(x=>x.kind).filter(Boolean))}
function sourceCount(c){return new Set((c.sources||[]).map(x=>x.sourceId||x.kind||x.url)).size}
function needs(c){
  if(c.seo?.modelVersion!==SEO_MODEL_VERSION)return true;
  if(c.seo?.provider?.startsWith('google-cse-')){const t=Date.parse(c.seo.checkedAt||'');return !Number.isFinite(t)||Date.now()-t>3*86400000}
  return['pending','error','watch'].includes(c.seo?.classification)||['duckduckgo+autocomplete','brave+autocomplete'].includes(c.seo?.provider);
}
function useful(c){const risk=estimateNameRisk(c.gameName||'');if(risk>20)return false;const ks=kinds(c),strategic=[...ks].some(k=>STRATEGIC.has(k)),count=sourceCount(c),age=Date.now()-Date.parse(c.firstSeen||0),recent=Number.isFinite(age)&&age<=7*86400000;return strategic||count>=2||(recent&&Number(c.discoveryScore||0)>=4&&risk<=17)}
function priority(c){const ks=kinds(c),count=sourceCount(c);let s=Number(c.discoveryScore||0)*5+Math.max(0,25-estimateNameRisk(c.gameName||''))+count*10;if(ks.has('trends-rising-7d'))s+=80;if(ks.has('trends-rising-30d'))s+=60;if(ks.has('itch-featured'))s+=40;if(ks.has('itch-popular'))s+=32;if(ks.has('steam-popular-new'))s+=30;if(ks.has('newgrounds-top'))s+=22;const age=Date.now()-Date.parse(c.firstSeen||0);if(Number.isFinite(age)&&age<2*86400000)s+=25;return s}
function refresh(c){const seo=c.seo?.classification||'pending',fast=c.fast?.classification||'pending';if(seo==='error')c.recommendation='error';else if(seo==='reject'||c.seo?.entityConflict||['reject','weak'].includes(fast))c.recommendation='reject';else if(fast==='watch')c.recommendation='watch';else if(!c.trend)c.recommendation='pending';if(['reject','pending','error'].includes(c.recommendation)){c.finalScore=0;c.score=0}c.level=c.recommendation}

const payload=await readJson(candidatesPath,{candidates:[]});
const candidates=Array.isArray(payload)?payload:payload.candidates||[];
const report=await readJson(reportPath,{});
const queue=candidates.filter(c=>needs(c)&&useful(c)).sort((a,b)=>priority(b)-priority(a)||Date.parse(b.firstSeen||0)-Date.parse(a.firstSeen||0)).slice(0,LIMIT);
let verified=0,errors=0,quotaStopped=false;const providerCounts={},verifiedNames=[];
if(!slots.length)console.log('Google CSE is not configured; skipping dual-account SEO verification.');
for(const c of slots.length?queue:[]){
  try{
    const name=cleanGameName(c.gameName||'');
    const [search,suggest]=await Promise.all([googleSearch(`"${name}"`),suggestions(name)]);
    c.seo={modelVersion:SEO_MODEL_VERSION,checkedAt:new Date().toISOString(),status:'ok',provider:`google-cse-${search.slotId}+autocomplete`,queryName:name,searchRequests:search.attempts,googleCseUsage:await usageSummary(),...calculateSeoVerdict({gameName:name,exactResults:search.results,gameResults:[],suggestions:suggest,discoveryScore:c.discoveryScore||0})};
    c.fast=calculateFastSignals(c,c.fast||{});refresh(c);verified+=1;verifiedNames.push(name);providerCounts[search.slotId]=(providerCounts[search.slotId]||0)+1;
  }catch(e){
    if(e.code==='GOOGLE_CSE_QUOTA'){quotaStopped=true;break}
    errors+=1;console.error(`Google CSE SEO failed: ${c.gameName}: ${e.message}`);
  }
  await sleep(250);
}
const seoErrors=candidates.filter(c=>c.seo?.classification==='error').length;
const seoPassedCount=candidates.filter(c=>c.seo?.modelVersion===SEO_MODEL_VERSION&&['independent','page'].includes(c.seo?.classification)).length;
const fastPassedCount=candidates.filter(c=>c.fast?.classification==='pass').length;
const fastWatchCount=candidates.filter(c=>c.fast?.classification==='watch').length;
const fastRejectedCount=candidates.filter(c=>['weak','reject'].includes(c.fast?.classification)).length;
await fs.writeFile(candidatesPath,JSON.stringify({...payload,candidates},null,2)+'\n');
await fs.writeFile(reportPath,JSON.stringify({...report,seoProvider:slots.length?'google-custom-search':'duckduckgo-html',googleCseConfiguredSlots:slots.length,googleCseUsage:await usageSummary(),googleCseVerification:{limit:LIMIT,queueSize:queue.length,verified,errors,quotaStopped,providerCounts,verifiedNames,ranAt:new Date().toISOString()},seoVerified:Number(report.seoVerified||0)+verified,seoErrors,seoPassedCount,fastPassedCount,fastWatchCount,fastRejectedCount},null,2)+'\n');
console.log(`Google CSE SEO complete: ${verified} verified, ${errors} errors, quota stopped ${quotaStopped}.`);
