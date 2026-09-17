import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const TIMEOUT_MS = 15000;
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
const BRAVE_SEARCH_MONTHLY_LIMIT = Math.max(1, Number(process.env.BRAVE_SEARCH_MONTHLY_LIMIT || 900));
const BRAVE_SEARCH_DAILY_LIMIT = Math.max(1, Number(process.env.BRAVE_SEARCH_DAILY_LIMIT || 30));
const BRAVE_SEARCH_COUNTRY = String(process.env.SEO_REGION || 'US').toUpperCase();
const BRAVE_SEARCH_LANGUAGE = String(process.env.SEO_LANGUAGE || 'en-US').split('-')[0].toLowerCase();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const braveUsagePath = path.join(root, 'data', 'brave-search-usage.json');

const DEDICATED_GAME_DOMAINS = [
  'itch.io','crazygames.com','poki.com','y8.com','gamepix.com','lagged.com','steamcommunity.com','store.steampowered.com',
  'gamejolt.com','kongregate.com','armorgames.com','miniclip.com','roblox.com','gx.games'
];
const NEWS_DOMAINS = [
  'reuters.com','apnews.com','bbc.com','bbc.co.uk','cnn.com','foxnews.com','nbcnews.com','cbsnews.com','abcnews.go.com',
  'nytimes.com','washingtonpost.com','theguardian.com','aljazeera.com','politico.com','cfr.org','defensenews.com','newsweek.com',
  'time.com','forbes.com','bloomberg.com','wsj.com','npr.org','axios.com','usatoday.com','euronews.com'
];
const NON_GAME_DOMAINS = [
  'spotify.com','genius.com','soundcloud.com','last.fm','discogs.com','allmusic.com','songfacts.com','lyrics.com','musixmatch.com',
  'imdb.com','rottentomatoes.com','goodreads.com','music.apple.com'
];
const STRONG_GAME_TERMS = /\b(video game|browser game|online game|html5 game|indie game|gameplay|walkthrough|playthrough|game demo|game jam|steam game|itch\.io|play the game|play game|game controls|games?)\b/i;
const SUGGESTION_GAME_TERMS = /\b(game|games|gameplay|walkthrough|playthrough|itch|steam|wiki|guide|controls|ending)\b/i;
const NEWS_TERMS = /\b(news|war|conflict|attack|airstrike|military strike|missile|troops|army|defense|politics|election|president|government|israel|iran|ukraine|russia|killed|ceasefire)\b/i;
const NON_GAME_TERMS = /\b(song|lyrics?|album|track|single|band|singer|artist|music|metallica|soundtrack|concert|film|movie|television|tv series|episode|novel|book|motorcycle|bike|price|product|company)\b/i;
const HIGH_RISK_TERMS = /\b(military|war|airstrike|attack|election|president|government|weather|hurricane|earthquake|disease|virus|stock|crypto|bitcoin|football|basketball|parking|supermarket|song|music|movie|film)\b/i;
const GENERIC_WORDS = new Set([
  'the','a','an','of','and','for','to','in','on','with','my','your','new','super','mega','funny','city','car','truck','parking','football',
  'basketball','military','strike','war','battle','shooter','simulator','racing','race','rush','party','dress','up','food','physics','jigsaw',
  'marble','block','blood','alien','wool','empire','game','online','3d','2d','idle','clicker','puzzle','adventure','hero','heroes','web'
]);

export function cleanGameName(value='') {
  return value
    .replace(/^\s*\d{1,3}[.)]\s+/, '')
    .replace(/(?:\s*\[[^\]\r\n]{1,40}\])+\s*$/g,'')
    .replace(/\s*\((?:demo|prototype|alpha|beta|playtest|game jam version|web|web version|browser|html5|online version|windows|mac(?:os)?|linux)\)\s*$/gi,'')
    .replace(/\s*[|–—-]\s*(?:itch\.io|free browser game|play online|downloadable game)\s*$/i,'')
    .replace(/\s+/g,' ')
    .trim();
}

function decodeHtml(value='') {
  return value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}

async function fetchText(url, accept='text/html,*/*;q=0.8') {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url,{headers:{'user-agent':USER_AGENT,accept},redirect:'follow',signal:controller.signal});
    if(!response.ok) throw new Error(`SEO source returned ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

function unwrapDuckUrl(href='') {
  try {
    const url = new URL(decodeHtml(href),'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.toString();
  } catch { return ''; }
}

export function parseDuckResults(html='') {
  const results=[];
  const blocks=[...html.matchAll(/<div[^>]+class=["'][^"']*result[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]+class=["'][^"']*result|<\/body>)/gi)];
  for(const match of blocks.slice(0,12)){
    const block=match[1];
    const a=block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if(!a) continue;
    const snippet=block.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1]||'';
    const url=unwrapDuckUrl(a[1]);
    if(!url) continue;
    results.push({url,title:decodeHtml(a[2]),snippet:decodeHtml(snippet)});
  }
  return results;
}

async function searchDuck(query) {
  const url=`https://html.duckduckgo.com/html/?kl=us-en&q=${encodeURIComponent(query)}`;
  const html=await fetchText(url);
  const blocked=duckBlockReason(html);
  if(blocked)throw new Error(`DuckDuckGo 拦截：${blocked}`);
  return parseDuckResults(html);
}

/**
 * DuckDuckGo 的 HTML 端点是未公开的抓取目标。当它判定调用方是机器人时，
 * 会返回一个挑战页而不是结果 —— 解析出来就是 0 条。而 0 条本身也是合法结果
 * （一个刚出现的游戏名确实可能没有任何搜索结果）。这两件事必须区分开：
 *
 *   挑战页 → 抛错 → 记成 classification:'error'（可见、健康检查会告警）
 *   真·0 条 → 正常结论（calculateSeoVerdict 会因 rawTotal<2 扣分，
 *             且空结果下 score 上限只有 21，结构上到不了 page/independent）
 *
 * 如果混为一谈，被拦截时那批词会静默降级成 reject/watch —— 属于假阴性，
 * 而且会把每天的免费额度全浪费在垃圾结论上。
 */
const DUCK_BLOCK_MARKERS = [
  /anomaly/i,
  /captcha/i,
  /unusual traffic/i,
  /too many requests/i,
  /challenge-form/i,
];

export function duckBlockReason(html = '') {
  const body = String(html);
  if (!body.trim()) return '响应为空';
  const marker = DUCK_BLOCK_MARKERS.find((pattern) => pattern.test(body));
  return marker ? `命中拦截页标记 ${marker}` : null;
}

async function readBraveUsage() {
  const now = new Date();
  const month = now.toISOString().slice(0,7);
  const day = now.toISOString().slice(0,10);
  let usage={};
  try { usage=JSON.parse(await fs.readFile(braveUsagePath,'utf8')); } catch {}
  if(usage.month!==month) usage={month,monthUsed:0,day,dayUsed:0,updatedAt:now.toISOString()};
  else if(usage.day!==day) usage={...usage,day,dayUsed:0,updatedAt:now.toISOString()};
  return usage;
}

async function reserveBraveRequest() {
  const usage=await readBraveUsage();
  if(Number(usage.monthUsed||0)>=BRAVE_SEARCH_MONTHLY_LIMIT||Number(usage.dayUsed||0)>=BRAVE_SEARCH_DAILY_LIMIT){
    const error=new Error('Brave Search API safety limit reached');
    error.code='BRAVE_QUOTA_GUARD';
    throw error;
  }
  const updated={...usage,monthUsed:Number(usage.monthUsed||0)+1,dayUsed:Number(usage.dayUsed||0)+1,monthlyLimit:BRAVE_SEARCH_MONTHLY_LIMIT,dailyLimit:BRAVE_SEARCH_DAILY_LIMIT,updatedAt:new Date().toISOString()};
  await fs.writeFile(braveUsagePath,JSON.stringify(updated,null,2)+'\n');
  return updated;
}

export async function getBraveSearchUsage() {
  if(!BRAVE_SEARCH_API_KEY)return {enabled:false,monthUsed:0,dayUsed:0,monthlyLimit:BRAVE_SEARCH_MONTHLY_LIMIT,dailyLimit:BRAVE_SEARCH_DAILY_LIMIT};
  return {enabled:true,...await readBraveUsage(),monthlyLimit:BRAVE_SEARCH_MONTHLY_LIMIT,dailyLimit:BRAVE_SEARCH_DAILY_LIMIT};
}

export function parseBraveResults(payload={}) {
  return (payload?.web?.results||[]).slice(0,10).map(item=>({
    url:String(item?.url||''),
    title:decodeHtml(String(item?.title||'')),
    snippet:decodeHtml([item?.description,...(item?.extra_snippets||[])].filter(Boolean).join(' ')),
  })).filter(item=>item.url);
}

async function searchBrave(query) {
  await reserveBraveRequest();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  const params=new URLSearchParams({q:query,count:'10',country:BRAVE_SEARCH_COUNTRY,search_lang:BRAVE_SEARCH_LANGUAGE,ui_lang:'en-US',safesearch:'moderate',spellcheck:'1'});
  try {
    const response=await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`,{headers:{Accept:'application/json','X-Subscription-Token':BRAVE_SEARCH_API_KEY},signal:controller.signal});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok){
      const error=new Error(payload?.message||`Brave Search returned ${response.status}`);
      // 上游限流同样降级到免费路径，而不是让候选卡在 pending。
      if(response.status===429)error.code='BRAVE_RATE_LIMITED';
      throw error;
    }
    return parseBraveResults(payload);
  } finally { clearTimeout(timer); }
}

async function fetchSuggestions(query) {
  try {
    const raw=await fetchText(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`,'application/json,text/plain,*/*');
    const data=JSON.parse(raw);
    return Array.isArray(data?.[1])?data[1].map(String):[];
  } catch {
    try {
      const raw=await fetchText(`https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(query)}`,'application/json,text/plain,*/*');
      const data=JSON.parse(raw);
      return Array.isArray(data)?data.flatMap(x=>typeof x==='string'?[x]:x?.phrase?[x.phrase]:[]):[];
    } catch { return []; }
  }
}

function hostOf(url='') { try{return new URL(url).hostname.replace(/^www\./,'').toLowerCase()}catch{return''} }
function domainMatches(host,list){return list.some(domain=>host===domain||host.endsWith(`.${domain}`))}
function normalizePhrase(value='') {
  return decodeHtml(value).toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\b(?:web|game|games|online|official)\b/g,' ').replace(/\s+/g,' ').trim();
}
function resultMatchesName(result,targetName) {
  const target=normalizePhrase(targetName),text=normalizePhrase(`${result.title} ${result.url}`);
  if(!target||!text)return false;
  if(text.includes(target))return true;
  const targetTokens=target.split(' ').filter(token=>token.length>1);
  if(!targetTokens.length)return false;
  const textTokens=new Set(text.split(' '));
  const overlap=targetTokens.filter(token=>textTokens.has(token)).length/targetTokens.length;
  return overlap>=0.75;
}

function classifyResults(results,targetName) {
  let game=0,news=0,nonGame=0,other=0;
  for(const result of results.slice(0,10)){
    const host=hostOf(result.url),text=`${result.title} ${result.snippet}`;
    const nameMatch=resultMatchesName(result,targetName);
    const dedicatedGame=domainMatches(host,DEDICATED_GAME_DOMAINS)&&nameMatch;
    const nonGameEvidence=domainMatches(host,NON_GAME_DOMAINS)||NON_GAME_TERMS.test(text);
    const gameEvidence=nameMatch&&(dedicatedGame||STRONG_GAME_TERMS.test(text));
    const newsEvidence=domainMatches(host,NEWS_DOMAINS)||NEWS_TERMS.test(text);
    if(gameEvidence&&!nonGameEvidence) game+=1;
    else if(nonGameEvidence) nonGame+=1;
    else if(newsEvidence) news+=1;
    else other+=1;
  }
  const rawTotal=game+news+nonGame+other;
  const total=Math.max(1,rawTotal);
  return {game,news,nonGame,other,total,rawTotal,gameRatio:game/total,newsRatio:news/total,nonGameRatio:nonGame/total};
}

export function estimateNameRisk(name='') {
  const cleaned=cleanGameName(name);
  const tokens=cleaned.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
  if(!tokens.length) return 25;
  const generic=tokens.filter(token=>GENERIC_WORDS.has(token)||/^\d+d?$/.test(token)).length;
  let risk=Math.round((generic/tokens.length)*18);
  if(HIGH_RISK_TERMS.test(cleaned)) risk+=8;
  if(tokens.length===1) risk+=5;
  return Math.min(30,risk);
}

export function calculateSeoVerdict({gameName,exactResults=[],gameResults=[],suggestions=[],discoveryScore=0}) {
  const cleanedName=cleanGameName(gameName);
  const exact=classifyResults(exactResults,cleanedName),withGame=classifyResults(gameResults,cleanedName);
  const lower=cleanedName.toLowerCase();
  const suggestionGame=suggestions.filter(item=>item.toLowerCase().includes(lower)&&SUGGESTION_GAME_TERMS.test(item)).length;
  const suggestionExact=suggestions.some(item=>item.toLowerCase()===lower);
  const suggestionNonGame=suggestions.filter(item=>item.toLowerCase().includes(lower)&&NON_GAME_TERMS.test(item)).length;
  const risk=estimateNameRisk(cleanedName);

  let score=0;
  score+=Math.round(exact.gameRatio*45);
  score+=Math.round(withGame.gameRatio*22);
  score+=suggestionGame?14:0;
  score+=suggestionExact?5:0;
  score+=Math.min(10,Math.round(discoveryScore/2));
  score-=Math.round(exact.newsRatio*48);
  score-=Math.round(exact.nonGameRatio*58);
  score-=Math.min(15,suggestionNonGame*5);
  score-=Math.round(risk*.75);
  if(exact.rawTotal<2) score-=8;
  score=Math.max(0,Math.min(100,score));

  const entityConflict=exact.nonGameRatio>=0.4||suggestionNonGame>=2;
  let classification='watch';
  if(exact.newsRatio>=0.5||exact.nonGameRatio>=0.5||(exact.game===0&&(risk>=18||exact.nonGame>=2))) classification='reject';
  else if(score>=55&&risk<=12&&!entityConflict&&exact.gameRatio>=0.5&&exact.game>=2&&(withGame.gameRatio>=0.5||suggestionGame>0||discoveryScore>=8)) classification='independent';
  else if(score>=30&&risk<=24&&!entityConflict&&(withGame.gameRatio>=0.45||suggestionGame>0||exact.gameRatio>=0.5||discoveryScore>=6)) classification='page';
  else if(score<18||risk>=25||entityConflict) classification='reject';

  const reasons=[];
  if(exact.gameRatio>=0.5) reasons.push('主词搜索结果以游戏内容为主');
  else if(exact.game===0) reasons.push('主词前列没有明显游戏结果');
  else reasons.push('主词游戏意图较弱');
  if(exact.newsRatio>=0.4) reasons.push('新闻意图过强');
  if(exact.nonGameRatio>=0.4) reasons.push('歌曲、影视或其他非游戏实体占据主词结果');
  if(withGame.gameRatio>=0.6) reasons.push('添加 game 后搜索意图明确');
  if(suggestionGame) reasons.push(`自动补全出现 ${suggestionGame} 个游戏长尾`);
  if(suggestionNonGame) reasons.push(`自动补全出现 ${suggestionNonGame} 个非游戏实体长尾`);
  if(risk>=18) reasons.push('名称过于通用或存在明显歧义');
  else if(risk>=13) reasons.push('名称存在一定歧义，不宜直接注册独立域名');
  if(exact.rawTotal<2) reasons.push('可用于判断的搜索结果太少');
  if(classification==='independent') reasons.unshift('适合独立站验证');
  if(classification==='page') reasons.unshift('更适合综合站内页');
  if(classification==='reject') reasons.unshift('不建议购买独立域名');

  return {
    score,classification,reasons,entityConflict,
    exactGameRatio:Number(exact.gameRatio.toFixed(2)),exactNewsRatio:Number(exact.newsRatio.toFixed(2)),
    exactNonGameRatio:Number(exact.nonGameRatio.toFixed(2)),gameQueryGameRatio:Number(withGame.gameRatio.toFixed(2)),
    suggestionGameCount:suggestionGame,suggestionNonGameCount:suggestionNonGame,
    suggestions:suggestions.slice(0,10),nameRisk:risk,
    exactResultCount:exact.rawTotal,gameResultCount:withGame.rawTotal,
    exactResultUrls:exactResults.slice(0,10).map(result=>result.url).filter(Boolean),
    gameResultUrls:gameResults.slice(0,10).map(result=>result.url).filter(Boolean),
  };
}

export async function verifyGameKeyword(gameName, discoveryScore=0) {
  const cleanedName=cleanGameName(gameName);
  if(BRAVE_SEARCH_API_KEY){
    try{
      const [exactResults,suggestions]=await Promise.all([searchBrave(`"${cleanedName}"`),fetchSuggestions(cleanedName)]);
      return {
        checkedAt:new Date().toISOString(),status:'ok',provider:'brave+autocomplete',queryName:cleanedName,searchRequests:1,
        braveSearchUsage:await getBraveSearchUsage(),
        ...calculateSeoVerdict({gameName:cleanedName,exactResults,gameResults:[],suggestions,discoveryScore})
      };
    }catch(error){
      // Brave 免费档是 $5/月赠金（约 1,000 次），比 Serper 单账号还少。
      // 额度用完（或上游 429）时不要让这个词干等到下一轮 —— 下面还有一条
      // 完全免费的 DuckDuckGo 路径，直接降级过去，白拿一份结论。
      // 其他错误（密钥无效、网络故障）照旧抛出，记成 error，保持可见。
      if(error.code!=='BRAVE_QUOTA_GUARD'&&error.code!=='BRAVE_RATE_LIMITED')throw error;
    }
  }
  const [exactResults,gameResults,suggestions]=await Promise.all([
    searchDuck(`"${cleanedName}"`),
    searchDuck(`"${cleanedName}" game play online`),
    fetchSuggestions(cleanedName)
  ]);
  return {
    checkedAt:new Date().toISOString(),status:'ok',provider:'duckduckgo+autocomplete',queryName:cleanedName,
    braveSearchUsage:await getBraveSearchUsage(),
    ...calculateSeoVerdict({gameName:cleanedName,exactResults,gameResults,suggestions,discoveryScore})
  };
}
