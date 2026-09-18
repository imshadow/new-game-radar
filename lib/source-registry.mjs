/**
 * Single source of truth for how each source tag is treated.
 *
 * A "tag" is either a `kind` (what a source *is*, e.g. `poki-new`) or a
 * `sourceId` (a specific entry in `config/sources.json`, e.g. `poki-new`).
 * Consumers match on either, so both are registered here.
 *
 * Why this file exists
 * --------------------
 * The same source used to be listed in six separate hardcoded sets:
 *
 *   lib/site-type.mjs                 ONLINE_KINDS / WIKI_KINDS
 *   lib/fast-signals.mjs              *_HIGH_QUALITY_KINDS
 *   lib/trend-queue.mjs               *_STRATEGIC_KINDS
 *   scripts/expand-seo-queue.mjs      STRATEGIC_KINDS
 *   scripts/verify-serper.mjs         ONLINE_STRATEGIC / WIKI_STRATEGIC
 *   scripts/verify-evidence-fallback.mjs  ONLINE_STRATEGIC / WIKI_STRATEGIC
 *
 * Adding a source meant remembering all six. Forgetting one did not fail
 * anything — it silently down-weighted the new source. That is exactly what
 * happened when the Steam feed / press / HN / GitHub / Armor Games sources were
 * added: they were wired into `site-type` and `scan` but missing from the other
 * five, so every one of them was scored as if it came from nowhere.
 *
 * `tests/source-registry.test.mjs` now fails when a tag used in
 * `config/sources.json` is not registered here, so the decision has to be made
 * explicitly instead of defaulting to "silently ignored".
 *
 * Fields
 * ------
 * `scope`     'kind' or 'id' — which field of a source record this tag matches.
 * `channel`   Which opportunity model the source feeds:
 *               online  — browser / HTML5 game
 *               wiki    — download or pre-release game
 *               shared  — applies to both (rising queries, competitor sitemaps)
 *               pending — a name-only source; not evidence of either channel
 * `evidence`  Whether appearing in this source alone is enough to *assert* the
 *             channel. `itch-new` is channel `online` but NOT evidence: an itch
 *             feed listing is a name, not proof the game is browser-playable.
 *             `site-type.mjs` derives its sets from this flag.
 */

const ONLINE = 'online';
const WIKI = 'wiki';
const SHARED = 'shared';
const PENDING = 'pending';

/**
 * Tags matched against a source record's `kind`.
 *
 * Kept separate from SOURCE_ID_TAGS on purpose: many tags are both (e.g.
 * `crazygames-new` is the kind AND the id), and putting them in one object would
 * silently drop whichever entry was written second.
 */
export const KIND_TAGS = {
  // Browser-game portals.
  'crazygames-new': { channel: ONLINE, evidence: true },
  'poki-new': { channel: ONLINE, evidence: true },
  'y8-new': { channel: ONLINE, evidence: true },
  'gamepix-new': { channel: ONLINE, evidence: true },
  'lagged-new': { channel: ONLINE, evidence: true },
  'armorgames-new': { channel: ONLINE, evidence: true },
  'newgrounds-top': { channel: ONLINE, evidence: true },
  'newgrounds-new': { channel: ONLINE, evidence: true },
  'itch-popular': { channel: ONLINE, evidence: true },
  'itch-jam-new': { channel: ONLINE, evidence: true },
  'itch-jam-popular': { channel: ONLINE, evidence: true },
  // `topic:html5-game` is an explicit statement by the author that the project
  // runs in a browser, so the repo itself is the evidence.
  'github-game': { channel: ONLINE, evidence: true },
  // Channel online, but a bare listing is not proof of a browser build.
  'itch-new': { channel: ONLINE, evidence: false },

  // Steam / pre-release / indie press.
  'steam-top-wishlist': { channel: WIKI, evidence: true },
  'steam-popular-new': { channel: WIKI, evidence: true },
  'steam-new': { channel: WIKI, evidence: true },
  // `popularcomingsoon` — the wishlist precursor. Same channel as the wishlist
  // source, but a distinct kind so it is not mistaken for a Top-Wishlists hit.
  'steam-upcoming': { channel: WIKI, evidence: true },
  'press-new': { channel: WIKI, evidence: true },
  // GOG catalog releases. The raw feed is "newly added to catalog" (includes
  // back-catalogue ports); `parseGogJson` narrows it to the last 45 days, so a
  // hit here is a released PC game.
  'gog-new': { channel: WIKI, evidence: true },

  // Deliberately not evidence of either channel: itch-featured spans web and
  // downloadable builds, and HN Show HN posts are heterogeneous (web demos,
  // Steam builds, source-only repos). Both are treated as name sources; the
  // downstream verifiers decide what they actually are.
  'itch-featured': { channel: SHARED, evidence: false },
  'hn-showhn': { channel: PENDING, evidence: false },

  // Discovery primitives that are channel-agnostic by construction.
  'trends-rising-7d': { channel: SHARED, evidence: false },
  'trends-rising-30d': { channel: SHARED, evidence: false },
  'competitor-sitemap': { channel: SHARED, evidence: false },
  // Generic fallback for a source with no specific kind.
  feed: { channel: SHARED, evidence: false },
};

/** Tags matched against a source record's `sourceId`. */
export const SOURCE_ID_TAGS = {
  'itch-newest-web': { channel: ONLINE, evidence: true },
  'itch-new-popular-web': { channel: ONLINE, evidence: true },
  'itch-jam-newest-html5': { channel: ONLINE, evidence: true },
  'itch-jam-popular-html5': { channel: ONLINE, evidence: true },
  // The broad itch feeds mix web and downloadable builds, so a hit in them is
  // not evidence of either channel.
  'itch-new-feed': { channel: SHARED, evidence: false },
  'itch-featured-feed': { channel: SHARED, evidence: false },

  'newgrounds-daily-top': { channel: ONLINE, evidence: true },
  'newgrounds-latest': { channel: ONLINE, evidence: true },
  'crazygames-new': { channel: ONLINE, evidence: true },
  'poki-new': { channel: ONLINE, evidence: true },
  'y8-new': { channel: ONLINE, evidence: true },
  'gamepix-new': { channel: ONLINE, evidence: true },
  'lagged-new': { channel: ONLINE, evidence: true },
  'armorgames-new': { channel: ONLINE, evidence: true },
  'github-html5-games': { channel: ONLINE, evidence: true },

  'steam-top-wishlist': { channel: WIKI, evidence: true },
  'steam-popular-new': { channel: WIKI, evidence: true },
  'steam-latest-indie': { channel: WIKI, evidence: true },
  'steam-upcoming-wishlist': { channel: WIKI, evidence: true },
  'steam-upcoming-indie': { channel: WIKI, evidence: true },
  'steam-popular-new-indie': { channel: WIKI, evidence: true },
  'steam-feed-newreleases': { channel: WIKI, evidence: true },
  'steam-feed-topsellers': { channel: WIKI, evidence: true },
  alphabetagamer: { channel: WIKI, evidence: true },
  indiegamesplus: { channel: WIKI, evidence: true },
  'gog-new-arrivals': { channel: WIKI, evidence: true },

  'hn-showhn': { channel: PENDING, evidence: false },
};

/** Combined view for lookups. Source id wins — it is the more specific tag. */
export const SOURCE_TAGS = {};
for (const [tag, meta] of Object.entries(KIND_TAGS)) SOURCE_TAGS[tag] = { ...meta, scope: 'kind' };
for (const [tag, meta] of Object.entries(SOURCE_ID_TAGS)) SOURCE_TAGS[tag] = { ...meta, scope: 'id' };

/** Look up a tag, tolerating unknown input so callers never throw on data drift. */
export function describeTag(tag) {
  return SOURCE_TAGS[tag] || null;
}

export function channelOf(tag) {
  return SOURCE_TAGS[tag]?.channel || PENDING;
}

/** Tags that assert a channel on their own. */
export const ONLINE_EVIDENCE_KINDS = Object.entries(KIND_TAGS)
  .filter(([, meta]) => meta.channel === ONLINE && meta.evidence).map(([tag]) => tag);
export const ONLINE_EVIDENCE_SOURCE_IDS = Object.entries(SOURCE_ID_TAGS)
  .filter(([, meta]) => meta.channel === ONLINE && meta.evidence).map(([tag]) => tag);
export const WIKI_EVIDENCE_KINDS = Object.entries(KIND_TAGS)
  .filter(([, meta]) => meta.channel === WIKI && meta.evidence).map(([tag]) => tag);
export const WIKI_EVIDENCE_SOURCE_IDS = Object.entries(SOURCE_ID_TAGS)
  .filter(([, meta]) => meta.channel === WIKI && meta.evidence).map(([tag]) => tag);

/**
 * Consumer policy sets — the other half of the drift problem.
 *
 * The tables above answer "what is this source?". These answer "which sources
 * does a given consumer treat as a signal?". They used to be declared in five
 * different files, so registering a new source meant editing six places, and a
 * missed one failed silently — the source was discovered, stored, and then
 * scored as if it had come from nowhere.
 *
 * They live here so the complete list of consumers for any source is visible in
 * one place. Each consumer imports its set instead of declaring its own copy.
 *
 * Membership is copied verbatim from the previous per-file literals, so this is
 * behaviour-preserving. The sets deliberately differ from one another and must
 * NOT be unioned into one: `SEO_QUEUE_STRATEGIC` omits the large portals because
 * it allocates a scarce SEO slot and those are already well covered, while
 * `TREND_ONLINE_STRATEGIC` counts them; `FALLBACK_*` match on source id as well
 * as kind because they run when a candidate has no kind-level evidence at all.
 *
 * Adding a source? Add it to every set whose consumer should react to it. The
 * drift guard in `tests/source-registry.test.mjs` fails if a set member is not a
 * registered tag, or if a newly added source is missing from a set it needs.
 *
 * Fixed while writing this file
 * -----------------------------
 * `steam-top-wishlist` was in none of these sets. It is the flagship wiki
 * source — `site-type.mjs` gives it a dedicated reason string and
 * `wiki-prelaunch.mjs` exists to model it — yet a candidate found only through
 * it could not reach the `strategic` Trends tier, because `hasStrategicSource`
 * was false. The gap was invisible because every wishlist candidate in the
 * current payload also carries a `trends-rising-*` source, which masked it.
 *
 * Measured before changing it, against the real 3000-candidate payload:
 * 2 candidates gained 6 fast-score points (`dear passengers`, `Phantom Blade
 * Zero`, both wiki-channel), and 0 candidates changed Trends tier. The change is
 * therefore safe, but it is recorded here because it is a scoring change rather
 * than a pure refactor.
 */
const SET_MEMBERS = {
  // lib/fast-signals.mjs — matches against kind OR sourceId.
  FAST_SHARED_HIGH_QUALITY: [
    'trends-rising-7d', 'trends-rising-30d', 'itch-featured', 'itch-popular', 'newgrounds-top', 'competitor-sitemap',
  ],
  // `hn-showhn` is deliberately absent: Show HN is an unverified name source,
  // and this set gates how much fast-score weight a candidate gets.
  FAST_ONLINE_HIGH_QUALITY: [
    'crazygames-new', 'poki-new', 'y8-new', 'gamepix-new', 'lagged-new',
    'newgrounds-top', 'newgrounds-new', 'itch-popular', 'armorgames-new', 'github-game',
  ],
  FAST_WIKI_HIGH_QUALITY: [
    'steam-top-wishlist', 'steam-popular-new', 'steam-new', 'itch-featured', 'steam-upcoming', 'press-new', 'gog-new',
  ],

  // lib/trend-queue.mjs — matches against kind OR sourceId.
  TREND_ONLINE_STRATEGIC: [
    'trends-rising-7d', 'trends-rising-30d', 'itch-popular', 'newgrounds-top', 'newgrounds-new',
    'crazygames-new', 'poki-new', 'y8-new', 'gamepix-new', 'lagged-new',
    'armorgames-new', 'github-game',
  ],
  TREND_WIKI_STRATEGIC: [
    'trends-rising-7d', 'trends-rising-30d', 'itch-featured', 'itch-popular',
    'steam-top-wishlist', 'steam-popular-new', 'steam-new', 'newgrounds-top', 'competitor-sitemap',
    'steam-upcoming', 'press-new', 'gog-new',
  ],

  // scripts/expand-seo-queue.mjs — matches against kind ONLY, and is
  // channel-agnostic by construction: it decides who gets a scarce SEO slot, so
  // it is the right place for name-only sources like `hn-showhn` that are not
  // yet provably online or wiki.
  //
  // `steam-new` (the kind behind `steam-latest-indie`) is absent here while
  // TREND_WIKI_STRATEGIC does list it. That looks like an oversight, but adding
  // it changes scoring for a source that already works, so it is left as-is and
  // recorded in the review report instead of being changed silently.
  SEO_QUEUE_STRATEGIC: [
    'trends-rising-7d', 'trends-rising-30d', 'itch-featured', 'itch-popular',
    'steam-top-wishlist', 'steam-popular-new', 'newgrounds-top', 'competitor-sitemap',
    'steam-upcoming', 'press-new', 'gog-new',
    'armorgames-new', 'github-game', 'hn-showhn',
  ],

  // scripts/verify-serper.mjs — matches against kind OR sourceId.
  SERPER_ONLINE_STRATEGIC: [
    'crazygames-new', 'poki-new', 'newgrounds-top', 'newgrounds-new', 'itch-popular', 'armorgames-new', 'github-game',
  ],
  SERPER_ONLINE_SECONDARY: ['y8-new', 'gamepix-new', 'lagged-new'],
  SERPER_WIKI_STRATEGIC: [
    'steam-top-wishlist', 'steam-popular-new', 'steam-new', 'itch-featured', 'itch-popular', 'newgrounds-top',
    'competitor-sitemap', 'steam-upcoming', 'press-new', 'gog-new',
  ],

  // scripts/verify-evidence-fallback.mjs — matches on kind, sourceId AND id, and
  // is the one consumer that mixes kind-level and id-level tags on purpose: it
  // runs when the kind-level evidence was not enough to decide a channel.
  FALLBACK_ONLINE_STRATEGIC: [
    'crazygames-new', 'poki-new', 'y8-new', 'gamepix-new', 'lagged-new',
    'newgrounds-daily-top', 'newgrounds-latest',
    'itch-new-popular-web', 'itch-featured-feed', 'itch-newest-web',
    'newgrounds-top', 'newgrounds-new', 'itch-popular',
    'armorgames-new', 'github-html5-games', 'github-game',
  ],
  FALLBACK_WIKI_STRATEGIC: [
    'steam-popular-new', 'steam-latest-indie',
    'steam-top-wishlist',
    'itch-featured-feed', 'itch-new-popular-web',
    'newgrounds-daily-top', 'competitor-sitemap',
    'steam-new', 'itch-featured', 'itch-popular', 'newgrounds-top',
    'steam-upcoming', 'steam-upcoming-wishlist',
    'steam-feed-newreleases', 'steam-feed-topsellers',
    'press-new', 'alphabetagamer',
    'gog-new', 'gog-new-arrivals',
  ],

  // lib/site-type.mjs — matched against `sourceId` only. These platforms are
  // strong enough that one hit alone raises confidence to `high`.
  SITE_TYPE_PREMIUM_ONLINE_IDS: [
    'crazygames-new', 'poki-new', 'itch-new-popular-web', 'newgrounds-daily-top',
  ],

  // lib/wiki-prelaunch.mjs — the one source the pre-launch opportunity model is
  // built around. Matched on kind, sourceId and id.
  WIKI_PRELAUNCH_WISHLIST: ['steam-top-wishlist'],

  // scripts/diagnose-evidence-fallback.mjs — intentionally NARROWER than the
  // FALLBACK_* sets above. It reports why the fallback verifier did not act on a
  // candidate, so it counts only the sources that were true when the diagnostic
  // was written; widening it would change the reported numbers without changing
  // any behaviour. Matched on sourceId, kind and id.
  DIAGNOSE_ONLINE_STRATEGIC: [
    'crazygames-new', 'poki-new', 'y8-new', 'gamepix-new', 'lagged-new',
    'newgrounds-daily-top', 'newgrounds-latest',
    'itch-new-popular-web', 'itch-featured-feed', 'itch-newest-web',
  ],
  DIAGNOSE_WIKI_STRATEGIC: [
    'steam-popular-new', 'steam-latest-indie', 'itch-featured-feed',
    'itch-new-popular-web', 'newgrounds-daily-top', 'competitor-sitemap',
  ],

  // lib/trend-queue.mjs — the sources that contribute a *name* and never a game.
  //
  // A candidate whose entire source set is in here is a search phrase that
  // happened to trend, not a game: `indie games on switch`, `itch io down`,
  // `whats an indie`. Both kinds come from Google Trends related-rising queries.
  //
  // Measured 2026-09-18 on the live pool (1893 candidates): 137 candidates were
  // sourced *only* by these two kinds. 133 of them were sitting in the SEO queue
  // and 107 had never been verified once — 12% of a queue that is 5.8 days deep,
  // competing for the same 240 Serper requests/day as real game names. They were
  // there because `scripts/scan.mjs` lists both kinds as a *reason* to spend
  // quota (`shouldAutoVerify`) and gives them +35/+25, the two largest bonuses in
  // `verifyPriority`. Meanwhile this registry already declared them
  // `evidence: false` — "appearing in this source alone is not enough to assert
  // the channel". One rule, two definitions, and the running one was cruder.
  //
  // `hn-showhn` is deliberately NOT here even though it is `channel: PENDING`.
  // Adding it would drop 29 more entries from the SEO queue at zero measured cost
  // to output, but a Show HN post can genuinely be a game launch, so that is a
  // separate judgement call rather than part of this defect.
  //
  // `evidence: false` is also NOT the right boundary: it also covers
  // `itch-featured` (a real signal, worth +16) and `feed` / `competitor-sitemap`
  // (absent from the pool entirely, so they would change nothing but would make
  // the set lie about its meaning).
  NAME_ONLY_KINDS: ['trends-rising-7d', 'trends-rising-30d'],

  // scripts/verify-google-cse.mjs used to live here. It was never invoked by
  // .github/workflows/radar.yml — the Google CSE path was superseded by Serper —
  // so both the script and its GOOGLE_CSE_STRATEGIC set were removed. Nothing
  // reads `data/google-cse-usage.json` any more either.
  //
  // `scripts/verify-serper.mjs` still treats a stored `seo.provider` beginning
  // with `google-cse-` as needing re-verification. That check is deliberately
  // kept: it inspects *stored data provenance*, not this script, and stays
  // correct if such records ever reappear (for example when syncing from
  // upstream). No candidate currently carries that provider.
};

export const POLICY_SETS = Object.fromEntries(
  Object.entries(SET_MEMBERS).map(([name, members]) => [name, new Set(members)]),
);

/** Every registered tag, for the drift guard in tests. */
export function registeredTags() {
  return [...Object.keys(KIND_TAGS), ...Object.keys(SOURCE_ID_TAGS)];
}

export { ONLINE, WIKI, SHARED, PENDING };
