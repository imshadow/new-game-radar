import { safeFetchText } from './scanner.mjs';

function decode(value='') {
  return value
    .replace(/&amp;/g,'&')
    .replace(/&quot;/g,'"')
    .replace(/&#39;|&apos;/g,"'")
    .replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

// 发行日期的解析与「够不够新」判定搬到了 lib/steam-release-date.mjs —— 因为 Steam 的
// 两个 RSS 源走 lib/scanner.mjs 的 parseSteamFeedXml，那条路径也得用同一条规则，而
// 本文件已经依赖 scanner.mjs，反过来依赖会成环。
//
// 这里保留 re-export，是因为 tests/steam-discovery-freshness.test.mjs 以及仓库里其他
// 调用方一直从本模块取这几个名字。规则本身只有一处定义。
import { filterFreshSteamEntries } from './steam-release-date.mjs';

export * from './steam-release-date.mjs';

export function parseSteamSearch(html='') {
  const entries=[];
  const seen=new Set();
  const regex=/<a\b([^>]*class=["'][^"']*search_result_row[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for(const match of html.matchAll(regex)){
    const attrs=match[1];
    const body=match[2];
    const href=attrs.match(/href=["']([^"']+)["']/i)?.[1];
    const title=decode(body.match(/<span\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]||'');
    const releaseDate=decode(body.match(/<div\b[^>]*class=["'][^"']*search_released[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]||'');
    if(!href||!title)continue;
    let url;
    try{url=new URL(href,'https://store.steampowered.com').toString()}catch{continue}
    if(!/store\.steampowered\.com\/app\/\d+/i.test(url)||seen.has(url))continue;
    seen.add(url);
    entries.push({url,title,date:releaseDate,releaseDate,gameName:title});
  }
  return entries;
}

export async function scanSteamSource(source, options={}){
  const maxEntries=Math.min(Math.max(options.maxEntries||100,1),300);
  const fetched=await safeFetchText(source.url);
  return {
    sourceId:source.id,
    sourceName:source.name,
    sourceUrl:source.url,
    detectedType:'steam-listing',
    entries:filterFreshSteamEntries(parseSteamSearch(fetched.text)).slice(0,maxEntries),
    childSitemaps:0,
    scannedAt:new Date().toISOString(),
  };
}
