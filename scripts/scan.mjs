import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, normalizeGameName, candidateId, calculateCandidateScore, candidateLevel } from '../lib/scanner.mjs';
import { scanSteamSource } from '../lib/steam-discovery.mjs';
import { discoverRisingGameQueries } from '../lib/rising-discovery.mjs';
import { verifyGameKeyword, cleanGameName, estimateNameRisk } from '../lib/seo-verifier.mjs';
import { verifyTrendDemand } from '../lib/trend-verifier.mjs';
import { calculateFastSignals, verifyYoutubeSignals, FAST_MODEL_VERSION } from '../lib/fast-signals.mjs';
import { applyFinalRecommendation } from '../lib/opportunity-finalizer.mjs';
import { SEO_MODEL_VERSION, TREND_MODEL_VERSION } from '../lib/model-versions.mjs';
import { hasCurrentSeo, isTrendEligible } from '../lib/trend-queue.mjs';
import { stripDerivedBlocks, buildDashboardPayload, writeJsonCompact, applyRetention } from '../lib/persistence.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourcesPath=path.join(root,'config','sources.json');
const statePath=path.join(root,'data','state.json');
const candidatesPath=path.join(root,'data','candidates.json');
const reportPath=path.join(root,'data','latest-report.json');
const dashboardPath=path.join(root,'data','dashboard.json');
const VERIFY_LIMIT=Math.max(0,Math.min(50,Number(process.env.SEO_VERIFY_LIMIT ?? 30)));
// 免费路径（DuckDuckGo HTML）连续被拦截多少次就熔断本轮。
// 2026-09-17 实测：run #16 试了 19 个，18 个被拦（95%），只有 1 个成功。
// 不熔断的话每轮都会把 20 个新候选刷成失败、白等 850ms×20，而且下一轮换一批
// 再来一遍 —— 代价是负的（污染候选 + 浪费运行时），收益接近 0。
const FREE_SEO_ABORT_AFTER=Math.max(1,Number(process.env.FREE_SEO_ABORT_AFTER ?? 5));
// 熔断只管本轮。但被拦是「目标在拦我们」，下一轮换个批次撞墙一样被拦 ——
// 而且撞的都是队列最前面那几个高优先级候选（撞完还要等 12 小时冷却）。
// 所以被拦占多数时整体退避一段时间，状态存在 data/state.json（唯一写者是本文件）。
const FREE_SEO_BLOCK_COOLDOWN=Math.max(0,Number(process.env.FREE_SEO_BLOCK_COOLDOWN ?? 6*3600000));
// 样本太小（比如只试了 2 个）不构成「目标在拦我们」的证据，不退避。
const FREE_SEO_BLOCK_MIN_ATTEMPTS=Math.max(1,Number(process.env.FREE_SEO_BLOCK_MIN_ATTEMPTS ?? 3));
const TREND_LIMIT=Math.max(0,Math.min(10,Number(process.env.TRENDS_VERIFY_LIMIT ?? 3)));
const YOUTUBE_LIMIT=Math.max(0,Math.min(10,Number(process.env.YOUTUBE_VERIFY_LIMIT||3)));
const YOUTUBE_API_KEY=process.env.YOUTUBE_API_KEY||'';
const TARGET_MARKET=process.env.TARGET_MARKET||'US_GLOBAL';
// VERIFY_MAX_AGE 曾是「SEO 结论 3 天后过期」的全局规则，现在分档在
// lib/seo-freshness.mjs（page 14 天 / watch 7 天 / reject 30 天），
// 免费路径的保鲜期是下面的 FREE_VERIFY_MAX_AGE。删掉以免被误当成现行规则。
const TREND_MAX_AGE=86400000;
const TREND_ERROR_RETRY=3600000;
const TREND_BATCH_INTERVAL=30*60000;
const RISING_DISCOVERY_INTERVAL=3*3600000;
const YOUTUBE_MAX_AGE=6*3600000;
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));

async function readJson(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return fallback}}
function sourceKinds(candidate){return new Set((candidate.sources||[]).map(source=>source.kind))}

function updateDiscovery(candidate){
  const kinds=sourceKinds(candidate);
  let score=calculateCandidateScore(candidate);
  if(kinds.has('trends-rising-7d'))score+=8;
  if(kinds.has('trends-rising-30d'))score+=6;
  if(kinds.has('steam-popular-new'))score+=4;
  if(kinds.has('steam-upcoming'))score+=4;
  if(kinds.has('itch-jam-popular'))score+=4;
  if(kinds.has('itch-jam-new'))score+=2;
  if(kinds.has('newgrounds-top'))score+=2;
  if(kinds.has('hn-showhn'))score+=3;
  if(kinds.has('armorgames-new'))score+=2;
  if(kinds.has('press-new'))score+=2;
  if(kinds.has('github-game'))score+=2;
  candidate.discoveryScore=Math.min(20,score);
  candidate.discoveryLevel=candidateLevel(candidate.discoveryScore);
}

function normalizeCandidateName(candidate){
  const cleaned=cleanGameName(candidate.gameName||'');
  if(!cleaned)return false;
  const normalized=normalizeGameName(cleaned);
  if(!normalized)return false;
  candidate.sources=candidate.sources||[];
  for(const source of candidate.sources){
    source.firstSeen=source.firstSeen||candidate.firstSeen;
    source.lastSeen=source.lastSeen||candidate.lastSeen||candidate.firstSeen;
    if(source.currentRank&&!source.bestRank)source.bestRank=source.currentRank;
  }
  if(cleaned!==candidate.gameName||normalized!==candidate.normalizedName){
    candidate.gameName=cleaned;
    candidate.normalizedName=normalized;
    delete candidate.seo;
    delete candidate.fast;
    delete candidate.trend;
    delete candidate.youtube;
    delete candidate.social;
    delete candidate.wikiPrelaunch;
    delete candidate.marketFreshness;
    delete candidate.opportunity;
    candidate.score=0;
    candidate.level='pending';
    candidate.recommendation='pending';
  }
  return true;
}

function dedupeCandidates(items){
  const map=new Map();
  for(const item of items){
    if(!normalizeCandidateName(item))continue;
    const existing=map.get(item.normalizedName);
    if(!existing){map.set(item.normalizedName,item);continue}
    const sourceKeys=new Set((existing.sources||[]).map(source=>source.key));
    for(const source of item.sources||[])if(!sourceKeys.has(source.key)){existing.sources.push(source);sourceKeys.add(source.key)}
    if(Date.parse(item.firstSeen)<Date.parse(existing.firstSeen))existing.firstSeen=item.firstSeen;
    if(Date.parse(item.lastSeen)>Date.parse(existing.lastSeen))existing.lastSeen=item.lastSeen;
    if(!existing.seo&&item.seo)existing.seo=item.seo;
    if(!existing.fast&&item.fast)existing.fast=item.fast;
    if(!existing.trend&&item.trend)existing.trend=item.trend;
    if(!existing.youtube&&item.youtube)existing.youtube=item.youtube;
    if(!existing.social&&item.social)existing.social=item.social;
    if(!existing.wikiPrelaunch&&item.wikiPrelaunch)existing.wikiPrelaunch=item.wikiPrelaunch;
    if(!existing.marketFreshness&&item.marketFreshness)existing.marketFreshness=item.marketFreshness;
    if(!existing.opportunity&&item.opportunity)existing.opportunity=item.opportunity;
  }
  return [...map.values()];
}

function mergeCandidate(candidates,gameName,source,entry,now){
  const cleanedName=cleanGameName(gameName);
  const normalizedName=normalizeGameName(cleanedName);
  if(!normalizedName||normalizedName.length<2)return false;
  let candidate=candidates.find(item=>item.normalizedName===normalizedName);
  if(!candidate){
    candidate={id:candidateId(normalizedName),gameName:cleanedName,normalizedName,firstSeen:now,lastSeen:now,status:'new',sources:[],recommendation:'pending'};
    candidates.push(candidate);
  }
  const key=`${source.id}|${entry.url}`;
  const rank=Number(entry.rank||0);
  let sourceRecord=candidate.sources.find(item=>item.key===key);
  if(!sourceRecord){
    sourceRecord={
      key,sourceId:source.id,name:source.name,kind:source.kind,url:entry.url,date:entry.date||'',
      growth:entry.growth||'',seed:entry.seed||'',windowDays:entry.windowDays||null,
      firstSeen:now,lastSeen:now,currentRank:rank||null,previousRank:null,bestRank:rank||null,
    };
    candidate.sources.push(sourceRecord);
  }else{
    sourceRecord.lastSeen=now;
    sourceRecord.date=entry.date||sourceRecord.date||'';
    if(rank){
      sourceRecord.previousRank=sourceRecord.currentRank||rank;
      sourceRecord.currentRank=rank;
      sourceRecord.bestRank=Math.min(Number(sourceRecord.bestRank||rank),rank);
    }
  }
  candidate.lastSeen=now;
  updateDiscovery(candidate);
  return true;
}

// 免费 SEO 路径（DuckDuckGo / Brave）只负责「补空缺」，绝不覆盖 Serper 的权威结论。
//
// 旧实现只看「多久没验过」，不看是谁验的 —— 于是打开 SEO_VERIFY_LIMIT 之后，
// 免费抓取会把这些词重来一遍：既冲掉已经花钱拿到的结论，又把每天那点免费额度
// 全花在已验词上，真正积压的两千多个词一个都轮不到。
// Serper 自己的重验节奏由 lib/seo-freshness.mjs 的分档保鲜期负责，不在这里重复。
const FREE_VERIFY_MAX_AGE=7*86400000;

function needsSeoCheck(candidate){
  const seo=candidate.seo;
  // 1) 权威结论：模型版本还是当前的，就完全交给 verify-serper.mjs。
  if(seo?.provider==='serper+autocomplete'&&seo?.modelVersion===SEO_MODEL_VERSION)return false;
  const checked=Date.parse(seo?.checkedAt||'');
  if(!Number.isFinite(checked))return true;
  if(seo?.status==='error')return Date.now()-checked>12*3600000;
  // 2) 免费路径自己的结论按 7 天保鲜：抓的是 HTML / 第三方索引，本来就更粗，
  //    不值得像 Serper 那样频繁重来。
  const freeProvider=seo?.provider==='duckduckgo+autocomplete'
    ||seo?.provider==='brave+autocomplete'
    ||Boolean(seo?.provider?.startsWith('google-cse-'));
  if(freeProvider)return Date.now()-checked>FREE_VERIFY_MAX_AGE;
  // 3) 没有结论、pending、临时验证（evidence-fallback）一律要验。
  return true;
}

function shouldAutoVerify(candidate){
  const kinds=sourceKinds(candidate);
  const risk=estimateNameRisk(candidate.gameName);
  return kinds.has('trends-rising-7d')||kinds.has('trends-rising-30d')||kinds.has('steam-popular-new')||
    kinds.has('steam-upcoming')||kinds.has('press-new')||kinds.has('hn-showhn')||
    candidate.sources?.length>=2||kinds.has('itch-featured')||kinds.has('itch-popular')||kinds.has('itch-jam-popular')||
    kinds.has('newgrounds-top')||(kinds.has('steam-new')&&risk<=12)||(kinds.has('itch-new')&&risk<=12)||
    ((candidate.discoveryScore||0)>=7&&risk<=16);
}

function verifyPriority(candidate){
  const kinds=sourceKinds(candidate);
  let score=(candidate.discoveryScore||0)+(30-estimateNameRisk(candidate.gameName));
  if(kinds.has('trends-rising-7d'))score+=35;
  if(kinds.has('trends-rising-30d'))score+=25;
  if(kinds.has('itch-featured'))score+=16;
  if(kinds.has('itch-popular'))score+=12;
  if(kinds.has('newgrounds-top'))score+=10;
  if(kinds.has('steam-popular-new'))score+=10;
  if(kinds.has('steam-upcoming'))score+=10;
  if(kinds.has('press-new'))score+=6;
  if(kinds.has('hn-showhn'))score+=5;
  if(kinds.has('armorgames-new'))score+=5;
  if(kinds.has('github-game'))score+=4;
  if(kinds.has('itch-new'))score+=4;
  if((candidate.sources||[]).length>=2)score+=10;
  return score;
}

function needsTrendCheck(candidate){
  if(!isTrendEligible(candidate))return false;
  if(candidate.trend?.modelVersion!==TREND_MODEL_VERSION)return true;
  const checked=Date.parse(candidate.trend?.checkedAt||'');
  if(!Number.isFinite(checked))return true;
  if(candidate.trend?.status==='error')return Date.now()-checked>TREND_ERROR_RETRY;
  return Date.now()-checked>TREND_MAX_AGE;
}

function trendPriority(candidate){
  const kinds=sourceKinds(candidate);
  let score=(candidate.seo?.score||0)+(candidate.discoveryScore||0)*2+(candidate.fast?.score||0)*2;
  if(kinds.has('trends-rising-7d'))score+=45;
  if(kinds.has('trends-rising-30d'))score+=32;
  if(kinds.has('itch-featured'))score+=18;
  if(kinds.has('itch-popular'))score+=14;
  if(kinds.has('newgrounds-top'))score+=12;
  if(kinds.has('steam-popular-new'))score+=10;
  if(kinds.has('steam-upcoming'))score+=10;
  if(kinds.has('press-new'))score+=6;
  if(candidate.seo?.classification==='independent')score+=18;
  const age=Date.now()-Date.parse(candidate.firstSeen||0);
  if(Number.isFinite(age)&&age<2*86400000)score+=8;
  return score;
}

function youtubeNeedsCheck(candidate){
  if(!YOUTUBE_API_KEY||YOUTUBE_LIMIT<=0||!hasCurrentSeo(candidate))return false;
  if(!['independent','page'].includes(candidate.seo?.classification))return false;
  if(!['pass','watch'].includes(candidate.fast?.classification))return false;
  const checked=Date.parse(candidate.youtube?.checkedAt||'');
  return !Number.isFinite(checked)||Date.now()-checked>YOUTUBE_MAX_AGE;
}

function recommendationRank(candidate){return {independent:7,'test-now':6,page:5,watch:4,pending:3,reject:2,error:1}[candidate.recommendation||'pending']||0}

async function processSourceResult({source,result,candidates,radarState,logs,now}){
  const previous=radarState.snapshots[source.id];
  const previousUrls=new Set(previous?.urls||[]);
  const firstScan=!previous;
  const entries=result.entries.map((entry,index)=>({...entry,rank:entry.rank||index+1}));
  const newEntries=firstScan&&source.baselineOnly?[]:entries.filter(entry=>!previousUrls.has(entry.url));
  const newUrls=new Set(newEntries.map(entry=>entry.url));
  let added=0;
  if(!(firstScan&&source.baselineOnly)){
    for(const entry of entries){const merged=mergeCandidate(candidates,entry.gameName,source,entry,now);if(merged&&newUrls.has(entry.url))added+=1}
  }
  radarState.snapshots[source.id]={urls:entries.map(entry=>entry.url),positions:Object.fromEntries(entries.map(entry=>[entry.url,entry.rank])),scannedAt:result.scannedAt||now,detectedType:result.detectedType||source.kind};
  logs.push({ok:true,sourceId:source.id,sourceName:source.name,total:entries.length,added});
  console.log(`✓ ${source.name}: ${entries.length} entries, ${added} new`);
  return added;
}

const sources=(await readJson(sourcesPath,[])).filter(source=>source.enabled!==false);
const radarState=await readJson(statePath,{snapshots:{},lastScan:null,lastRisingDiscovery:null,lastTrendBatch:null});
const candidatePayload=await readJson(candidatesPath,{candidates:[]});
let candidates=dedupeCandidates(Array.isArray(candidatePayload)?candidatePayload:candidatePayload.candidates||[]);
const previousFastById=new Map(candidates.map(candidate=>[candidate.id,candidate.fast||{}]));
const now=new Date().toISOString();
const logs=[];
let totalAdded=0;

for(const source of sources){
  try{
    const result=source.fetchKind==='steam-listing'?await scanSteamSource(source):await scanSource({...source,kind:source.fetchKind||(source.kind?.includes('sitemap')?'sitemap':source.kind?.includes('itch')?'itch-listing':source.kind||'auto')});
    totalAdded+=await processSourceResult({source,result,candidates,radarState,logs,now});
  }catch(error){logs.push({ok:false,sourceId:source.id,sourceName:source.name,error:error.message});console.error(`✗ ${source.name}: ${error.message}`)}
}

let risingDiscoveryRan=false;
const lastRising=Date.parse(radarState.lastRisingDiscovery||'');
if(!Number.isFinite(lastRising)||Date.now()-lastRising>=RISING_DISCOVERY_INTERVAL){
  risingDiscoveryRan=true;
  const risingResults=await discoverRisingGameQueries();
  for(const item of risingResults){
    const source=item.source;
    if(!item.ok){logs.push({ok:false,sourceId:source.id,sourceName:source.name,error:item.error||'Trends related queries failed'});continue}
    const result={entries:item.entries.slice(0,30),detectedType:'trends-related-rising',scannedAt:now};
    totalAdded+=await processSourceResult({source,result,candidates,radarState,logs,now});
  }
  radarState.lastRisingDiscovery=now;
}

candidates=dedupeCandidates(candidates);
for(const candidate of candidates)updateDiscovery(candidate);
// 上一轮被拦占多数就整体退避，不再拿高优先级候选去撞墙。
const freePathBlockedUntil=Date.parse(radarState.seoFreePathBlockedUntil||'');
const freePathSkipped=Number.isFinite(freePathBlockedUntil)&&Date.now()<freePathBlockedUntil;
if(freePathSkipped)console.error(`免费 SEO 路径退避中（到 ${new Date(freePathBlockedUntil).toISOString()}），本轮跳过，不消耗候选。`);
const verifyQueue=freePathSkipped?[]:candidates.filter(candidate=>needsSeoCheck(candidate)&&shouldAutoVerify(candidate)).sort((a,b)=>verifyPriority(b)-verifyPriority(a)||Date.parse(b.firstSeen)-Date.parse(a.firstSeen)).slice(0,VERIFY_LIMIT);
let seoVerified=0,seoErrors=0,seoBlocked=0,consecutiveBlocks=0,seoAbortedAfter=0;
for(const candidate of verifyQueue){
  try{
    console.log(`SEO verify: ${candidate.gameName}`);
    candidate.seo={modelVersion:SEO_MODEL_VERSION,...await verifyGameKeyword(candidate.gameName,candidate.discoveryScore||0)};
    seoVerified+=1;
    consecutiveBlocks=0;
  }catch(error){
    // 被拦截 ≠ 验证失败。拦截是「我们没拿到结论」，失败是「结论是不合格」。
    // 两者混成一个 classification:'error' 会把候选推进用户可见的 error 桶里，
    // 制造一批假的失败结论；所以拦截只写 classification:'pending' 并打 blocked 标记。
    // status:'error' 保留，好让 needsSeoCheck 的 12 小时冷却继续挡住重试。
    const blocked=error.code==='SEO_BLOCKED';
    const seo={modelVersion:SEO_MODEL_VERSION,checkedAt:new Date().toISOString(),status:'error',classification:blocked?'pending':'error',score:0,reasons:[`自动验证失败：${error.message}`]};
    if(blocked){seo.blocked=true;seoBlocked+=1;consecutiveBlocks+=1}else{seoErrors+=1;consecutiveBlocks=0}
    candidate.seo=seo;
    console.error(`SEO verify failed: ${candidate.gameName}: ${error.message}`);
    if(blocked&&consecutiveBlocks>=FREE_SEO_ABORT_AFTER){
      seoAbortedAfter=consecutiveBlocks;
      console.error(`免费 SEO 路径连续 ${consecutiveBlocks} 次被拦截，本轮熔断：剩余 ${verifyQueue.length-verifyQueue.indexOf(candidate)-1} 个候选不再尝试。`);
      break;
    }
  }
  await sleep(850);
}

// 本轮的拦截率决定下一轮还试不试。
const seoAttempted=seoVerified+seoErrors+seoBlocked;
if(seoAttempted>=FREE_SEO_BLOCK_MIN_ATTEMPTS&&seoBlocked/seoAttempted>=0.5){
  radarState.seoFreePathBlockedUntil=new Date(Date.now()+FREE_SEO_BLOCK_COOLDOWN).toISOString();
  console.error(`免费 SEO 路径本轮被拦 ${seoBlocked}/${seoAttempted}，退避到 ${radarState.seoFreePathBlockedUntil}。`);
}else if(seoVerified>0&&seoBlocked===0){
  // 恢复正常就立刻解除退避，别把 6 小时当成固定惩罚。
  delete radarState.seoFreePathBlockedUntil;
}

for(const candidate of candidates){
  if(!candidate.seo)candidate.seo={modelVersion:SEO_MODEL_VERSION,status:'pending',classification:'pending',score:0,reasons:['等待自动搜索意图验证']};
  if(hasCurrentSeo(candidate)&&['independent','page','reject','watch'].includes(candidate.seo.classification))candidate.fast=calculateFastSignals(candidate,previousFastById.get(candidate.id)||{});
  else candidate.fast={modelVersion:FAST_MODEL_VERSION,status:'pending',classification:'pending',score:0,reasons:['等待最新SEO验证后计算快速热度']};
}

let youtubeVerified=0,youtubeErrors=0;
if(YOUTUBE_API_KEY&&YOUTUBE_LIMIT>0){
  const youtubeQueue=candidates.filter(youtubeNeedsCheck).sort((a,b)=>(b.fast?.score||0)-(a.fast?.score||0)).slice(0,YOUTUBE_LIMIT);
  for(const candidate of youtubeQueue){
    try{candidate.youtube=await verifyYoutubeSignals(candidate.gameName,YOUTUBE_API_KEY);youtubeVerified+=1}
    catch(error){candidate.youtube={checkedAt:new Date().toISOString(),status:'error',error:error.message};youtubeErrors+=1}
    candidate.fast=calculateFastSignals(candidate,previousFastById.get(candidate.id)||{});
    await sleep(500);
  }
}

const trendEligibleBefore=candidates.filter(isTrendEligible);
const urgentModelUpgrade=trendEligibleBefore.some(candidate=>candidate.trend?.modelVersion!==TREND_MODEL_VERSION);
let trendsVerified=0,trendErrors=0,trendBatchRan=false,trendQueueSize=0;
const lastTrendBatch=Date.parse(radarState.lastTrendBatch||'');
const trendBatchDue=urgentModelUpgrade||!Number.isFinite(lastTrendBatch)||Date.now()-lastTrendBatch>=TREND_BATCH_INTERVAL;
if(trendBatchDue){
  trendBatchRan=true;
  // 这里曾经是 `risingDiscoveryRan?Math.min(2,TREND_LIMIT):TREND_LIMIT`：同轮跑过
  // rising discovery 就把趋势批次压到 2 个。没人写注释解释为什么，而能想到的两个理由
  // 都不成立 ——
  //   1. 怕超时：实测最近 8 轮耗时 1.1~5.4 分钟，job 上限 45 分钟；趋势循环每个
  //      sleep(8000)，跑满 10 个也只有 80 秒。
  //   2. 趋势源不够用：`TREND_MAX_AGE` 只有 1 天，89 条合格候选每天都要重查 = 89 次/天
  //      的需求，而压到 2 时那两轮只有 12 次/天（最近 4 轮里有 2 轮如此）。
  // 压它没有收益，只有欠账，所以取消。留一条观察点：如果免费源被同一轮两次调用打到
  // 限流，`trendsVerified` 会掉而 `trendErrors` 会涨 —— 下一轮 rising-discovery 跑过的
  // 运行里看这两个数就能验证。
  const limit=TREND_LIMIT;
  const trendQueue=candidates.filter(needsTrendCheck).sort((a,b)=>trendPriority(b)-trendPriority(a)||Date.parse(b.firstSeen)-Date.parse(a.firstSeen)).slice(0,limit);
  trendQueueSize=trendQueue.length;
  for(const candidate of trendQueue){
    const previousTrend=candidate.trend;
    try{console.log(`Trends verify: ${candidate.gameName}`);candidate.trend=await verifyTrendDemand(candidate.gameName);trendsVerified+=1}
    catch(error){
      const previousIsValid=previousTrend&&!['error','pending'].includes(previousTrend.classification);
      candidate.trend=previousIsValid?{...previousTrend,stale:true,lastError:error.message,lastErrorAt:new Date().toISOString()}:{modelVersion:TREND_MODEL_VERSION,checkedAt:new Date().toISOString(),status:'error',classification:'error',score:0,reasons:[`趋势验证失败：${error.message}`]};
      trendErrors+=1;
      console.error(`Trends verify failed: ${candidate.gameName}: ${error.message}`);
    }
    await sleep(8000);
  }
  if(trendQueue.length)radarState.lastTrendBatch=now;
}

const scanNowMs=Date.parse(now);
for(const candidate of candidates){
  if(isTrendEligible(candidate)&&!candidate.trend)candidate.trend={modelVersion:TREND_MODEL_VERSION,status:'pending',classification:'pending',score:0,reasons:['等待Google Trends需求验证']};
  applyFinalRecommendation(candidate,scanNowMs);
}

candidates.sort((a,b)=>recommendationRank(b)-recommendationRank(a)||(b.finalScore||0)-(a.finalScore||0)||(b.fast?.score||0)-(a.fast?.score||0)||(b.trend?.score||0)-(a.trend?.score||0)||(b.seo?.score||0)-(a.seo?.score||0)||(b.discoveryScore||0)-(a.discoveryScore||0)||Date.parse(b.firstSeen)-Date.parse(a.firstSeen));
// Membership is decided by retention policy, not by the display sort above.
// Truncating the sorted array used to drop the candidates discovered this very
// run, because `pending` always sorts last (see lib/persistence.mjs).
const beforeRetention=candidates.length;
candidates=applyRetention(candidates,scanNowMs);
const evictedCount=beforeRetention-candidates.length;
if(evictedCount>0)console.log(`Retention: kept ${candidates.length}/${beforeRetention} candidates, evicted ${evictedCount} least-recently-seen.`);

const recommendationCounts={independent:0,'test-now':0,page:0,watch:0,reject:0,pending:0,error:0};
for(const candidate of candidates)recommendationCounts[candidate.recommendation||'pending']=(recommendationCounts[candidate.recommendation||'pending']||0)+1;
const seoPassedCount=candidates.filter(candidate=>hasCurrentSeo(candidate)&&['independent','page'].includes(candidate.seo?.classification)).length;
const fastPassedCount=candidates.filter(candidate=>candidate.fast?.classification==='pass').length;
const fastWatchCount=candidates.filter(candidate=>candidate.fast?.classification==='watch').length;
const fastRejectedCount=candidates.filter(candidate=>['weak','reject'].includes(candidate.fast?.classification)).length;
const trendEligibleCount=candidates.filter(isTrendEligible).length;
const trendPendingCount=candidates.filter(candidate=>isTrendEligible(candidate)&&needsTrendCheck(candidate)).length;
const trendValidatedCount=candidates.filter(candidate=>isTrendEligible(candidate)&&candidate.trend?.modelVersion===TREND_MODEL_VERSION&&!['pending','error'].includes(candidate.trend?.classification)).length;
const risingCount=candidates.filter(candidate=>['rising','breakout'].includes(candidate.trend?.classification)).length;
const globalRisingCount=candidates.filter(candidate=>['rising','breakout'].includes(candidate.trend?.globalClassification)).length;
radarState.lastScan=now;
// Derived evaluation blocks are recomputed by `npm run classify` before any
// decision, so only actionable candidates keep them (see lib/persistence.mjs).
for(const candidate of candidates)stripDerivedBlocks(candidate);
await writeJsonCompact(statePath,radarState);
await writeJsonCompact(candidatesPath,{updatedAt:now,candidates});
await writeJsonCompact(dashboardPath,buildDashboardPayload(candidates,{scannedAt:now}));
await fs.writeFile(reportPath,JSON.stringify({scannedAt:now,targetMarket:TARGET_MARKET,primaryMarket:'US',referenceMarket:'WORLDWIDE',totalAdded,sources:logs,seoVerified,seoErrors,seoBlocked,seoFreePath:{queueSize:verifyQueue.length,attempted:seoAttempted,verified:seoVerified,failed:seoErrors,blocked:seoBlocked,abortedAfter:seoAbortedAfter,skipped:freePathSkipped,blockedUntil:radarState.seoFreePathBlockedUntil||null},fastModelVersion:FAST_MODEL_VERSION,fastPassedCount,fastWatchCount,fastRejectedCount,youtubeEnabled:Boolean(YOUTUBE_API_KEY),youtubeConfigured:Boolean(YOUTUBE_API_KEY),youtubeVerified,youtubeErrors,trendsVerified,trendErrors,trendBatchRan,trendQueueSize,risingDiscoveryRan,seoModelVersion:SEO_MODEL_VERSION,trendModelVersion:TREND_MODEL_VERSION,seoPassedCount,trendEligibleCount,trendPendingCount,trendValidatedCount,risingCount,globalRisingCount,recommendationCounts},null,2)+'\n');
console.log(`Scan complete. Market ${TARGET_MARKET}; YouTube ${YOUTUBE_API_KEY?'enabled':'disabled'}; ${totalAdded} names added; ${seoVerified} SEO checks; ${fastPassedCount} fast-pass; ${trendsVerified} Trends checks; ${trendPendingCount} trend candidates pending.`);
