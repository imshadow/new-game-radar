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

// Steam's `popularnew` filter is a store *section*, not a date window: a title
// keeps selling well for years, so `steam-popular-new` and
// `steam-popular-new-indie` keep re-serving Palworld (2024), Valheim (2021) and
// Satisfactory (2024) as if they were fresh discoveries. Measured on run #22:
// 71 of the 240 Serper verifications came from a Steam listing, and the old
// titles among them spent a paid request only to be rejected downstream by the
// trend entity check.
//
// The listing already carries the release date in `search_released`, and
// `parseSteamSearch` has always parsed it — it was simply never used. GOG's
// parser has had exactly this guard for a while (GOG_MAX_AGE_DAYS in
// lib/scanner.mjs); Steam's did not.
//
// 180 days, not GOG's 45. Measured against run #22's 240 verifications (67 of
// them Steam-sourced, all 67 carrying a parseable date), the ages fall into two
// clusters with a clean gap between 148 and 185 days: a 45-day window would
// have dropped Endacopia (53 days), which was one of only two candidates that
// run to reach `page`; a 365-day window still lets 330-day-old titles through.
// 180 sits in the gap, removing 24 of 67 (36%) — every one of them at least 185
// days old, none of them plausibly a "new game".
export const STEAM_MAX_AGE_DAYS = 180;

const STEAM_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Steam's English store renders `search_released` as "Sep 15, 2026". Feeding
// that to `Date.parse` yields **local** midnight, which would make the age
// verdict depend on the timezone of whatever machine ran the scan — the same
// class of trap tests/determinism.test.mjs exists to catch. Parse it into an
// explicit UTC midnight instead. Anything unrecognised (including a bare
// "2026", "Q1 2027", "Coming soon") returns NaN, and NaN is kept by the
// filter below.
export function parseSteamReleaseDate(value) {
  const text = String(value || '').trim();
  const named = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (named) {
    const month = STEAM_MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (month !== undefined) return Date.UTC(Number(named[3]), month, Number(named[2]));
    return NaN;
  }
  const iso = text.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return NaN;
}

// Unparseable dates are KEPT rather than dropped: "Coming soon", "Q1 2027" and
// "To be announced" are how Steam renders unreleased titles, and
// steam-top-wishlist / steam-upcoming-* exist precisely to catch those. Only a
// date we can read *and* that is demonstrably old gets filtered out.
export function isFreshSteamRelease(releaseDate, nowMs = Date.now()) {
  const released = parseSteamReleaseDate(releaseDate);
  if (!Number.isFinite(released)) return true;
  // Release dates are dates, not instants: floor the cutoff to midnight UTC so
  // a title released exactly STEAM_MAX_AGE_DAYS ago does not pass or fail
  // depending on what hour the scan happened to run. Mirrors parseGogJson.
  const cutoff = Math.floor((nowMs - STEAM_MAX_AGE_DAYS * 86400000) / 86400000) * 86400000;
  return released >= cutoff;
}

export function filterFreshSteamEntries(entries = [], nowMs = Date.now()) {
  return entries.filter((entry) => isFreshSteamRelease(entry?.releaseDate, nowMs));
}

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
