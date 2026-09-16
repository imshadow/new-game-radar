import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_TAGS,
  POLICY_SETS,
  ONLINE_EVIDENCE_KINDS,
  WIKI_EVIDENCE_KINDS,
  ONLINE_EVIDENCE_SOURCE_IDS,
  WIKI_EVIDENCE_SOURCE_IDS,
  registeredTags,
} from '../lib/source-registry.mjs';
import { classifySiteType } from '../lib/site-type.mjs';

/**
 * Guards against the drift class this repo actually suffered from.
 *
 * The same source used to be listed in nine separate hardcoded sets spread over
 * nine files. Adding a source meant remembering all of them, and forgetting one
 * produced no error — the new source was just silently down-weighted. That is
 * what happened to the Steam feed / press / HN / GitHub / Armor Games sources:
 * they were wired into `site-type` and `scan` but missing from the rest, so every
 * one of them was scored as if it came from nowhere.
 *
 * The sets now live in `lib/source-registry.mjs` and consumers import them, so
 * drift is structurally impossible rather than merely detected. These tests
 * exist to keep it that way.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const sources = JSON.parse(read('config/sources.json'));
const enabled = sources.filter((source) => source.enabled !== false);

// ------------------------------------------------------- registration guard

test('every source in config/sources.json has a registered kind and id', () => {
  const unregistered = [];
  for (const source of sources) {
    for (const tag of [source.kind, source.id]) {
      if (!tag) continue;
      if (!SOURCE_TAGS[tag]) unregistered.push(`${source.id}: ${tag}`);
    }
  }
  assert.deepEqual(
    unregistered,
    [],
    'New sources must be registered in lib/source-registry.mjs with an explicit channel. '
      + 'Leaving one out does not fail anything at runtime — it silently down-weights the source. '
      + `Unregistered: ${unregistered.join(', ')}`,
  );
});

test('the registry never claims a channel it has no evidence flag for', () => {
  for (const [tag, meta] of Object.entries(SOURCE_TAGS)) {
    assert.ok(['online', 'wiki', 'shared', 'pending'].includes(meta.channel), `${tag} has channel ${meta.channel}`);
    assert.equal(typeof meta.evidence, 'boolean', `${tag} must declare evidence`);
    assert.ok(['kind', 'id'].includes(meta.scope), `${tag} must declare scope`);
    // Only online/wiki tags can be evidence: `shared` and `pending` are by
    // definition not proof of a single channel.
    if (meta.evidence) assert.ok(['online', 'wiki'].includes(meta.channel), `${tag} claims evidence for channel ${meta.channel}`);
  }
});

// ----------------------------------------------- classifySiteType agreement

/** A candidate carrying exactly one source, built from a `config/sources.json` entry. */
function candidateWith(source) {
  return { sources: [{ sourceId: source.id, kind: source.kind, url: 'https://example.com/x', name: source.name }] };
}

/**
 * The channel a lone source can assert: the first of its tags that is itself
 * evidence. A source may be registered under a weaker kind than its id — e.g.
 * `itch-newest-web` has kind `itch-new`, which is a name source, but its id is
 * evidence of a browser build — so the expectation has to consider both.
 */
function expectedChannel(source) {
  for (const tag of [source.kind, source.id]) {
    const meta = SOURCE_TAGS[tag];
    if (meta?.evidence) return meta.channel;
  }
  return 'pending';
}

test('classifySiteType agrees with the channel recorded in the registry', () => {
  const clock = Date.parse('2026-09-15T00:00:00Z');
  const mismatches = [];
  for (const source of enabled) {
    const expected = expectedChannel(source);
    const actual = classifySiteType(candidateWith(source), clock).type;
    if (actual !== expected) mismatches.push(`${source.id} (kind ${source.kind}): expected ${expected}, got ${actual}`);
  }
  assert.deepEqual(
    mismatches,
    [],
    'A source whose registry channel disagrees with classifySiteType means one of the two was '
      + 'updated without the other. Fix the registry — it is the source of truth.',
  );
});

test('a name-only source alone never asserts a channel', () => {
  const clock = Date.parse('2026-09-15T00:00:00Z');
  // `itch-new` is channel online but is not evidence of a browser build, and
  // `hn-showhn` is not evidence of anything yet.
  for (const source of sources.filter((entry) => ['itch-new-feed', 'hn-showhn'].includes(entry.id))) {
    assert.equal(classifySiteType(candidateWith(source), clock).type, 'pending', source.id);
  }
});

test('site-type derives its sets from the registry', () => {
  // The registry is the source; if these diverge, someone re-hardcoded them.
  assert.ok(ONLINE_EVIDENCE_KINDS.includes('armorgames-new'));
  assert.ok(ONLINE_EVIDENCE_KINDS.includes('github-game'));
  assert.ok(WIKI_EVIDENCE_KINDS.includes('steam-upcoming'));
  assert.ok(WIKI_EVIDENCE_KINDS.includes('press-new'));
  assert.ok(ONLINE_EVIDENCE_SOURCE_IDS.includes('github-html5-games'));
  assert.ok(WIKI_EVIDENCE_SOURCE_IDS.includes('alphabetagamer'));
  assert.ok(WIKI_EVIDENCE_SOURCE_IDS.includes('steam-feed-topsellers'));
  // The flagship wishlist source is wiki evidence.
  assert.ok(WIKI_EVIDENCE_SOURCE_IDS.includes('steam-top-wishlist'));
  // Name-only tags must not leak into the evidence sets.
  assert.ok(!ONLINE_EVIDENCE_KINDS.includes('hn-showhn'));
  assert.ok(!ONLINE_EVIDENCE_KINDS.includes('itch-new'));
});

// ------------------------------------------------ single declaration guard

/** Where each policy set is consumed, and under what local name. */
const CONSUMERS = {
  'lib/fast-signals.mjs': {
    SHARED_HIGH_QUALITY_KINDS: 'FAST_SHARED_HIGH_QUALITY',
    ONLINE_HIGH_QUALITY_KINDS: 'FAST_ONLINE_HIGH_QUALITY',
    WIKI_HIGH_QUALITY_KINDS: 'FAST_WIKI_HIGH_QUALITY',
  },
  'lib/trend-queue.mjs': {
    ONLINE_STRATEGIC_KINDS: 'TREND_ONLINE_STRATEGIC',
    WIKI_STRATEGIC_KINDS: 'TREND_WIKI_STRATEGIC',
  },
  'lib/site-type.mjs': { PREMIUM_ONLINE_SOURCE_IDS: 'SITE_TYPE_PREMIUM_ONLINE_IDS' },
  'lib/wiki-prelaunch.mjs': { WISHLIST_TAGS: 'WIKI_PRELAUNCH_WISHLIST' },
  'scripts/expand-seo-queue.mjs': { STRATEGIC_KINDS: 'SEO_QUEUE_STRATEGIC' },
  'scripts/verify-serper.mjs': {
    ONLINE_STRATEGIC: 'SERPER_ONLINE_STRATEGIC',
    ONLINE_SECONDARY: 'SERPER_ONLINE_SECONDARY',
    WIKI_STRATEGIC: 'SERPER_WIKI_STRATEGIC',
  },
  'scripts/verify-evidence-fallback.mjs': {
    ONLINE_STRATEGIC: 'FALLBACK_ONLINE_STRATEGIC',
    WIKI_STRATEGIC: 'FALLBACK_WIKI_STRATEGIC',
  },
  'scripts/diagnose-evidence-fallback.mjs': {
    ONLINE: 'DIAGNOSE_ONLINE_STRATEGIC',
    WIKI: 'DIAGNOSE_WIKI_STRATEGIC',
  },
};

function sourceFiles() {
  const files = ['app.js'];
  for (const dir of ['lib', 'scripts', 'tools']) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (name.endsWith('.mjs')) files.push(`${dir}/${name}`);
    }
  }
  return files;
}

test('no file outside the registry declares a set of source tags', () => {
  const registered = new Set(registeredTags());
  const leaks = [];
  for (const file of sourceFiles()) {
    for (const literal of read(file).matchAll(/new Set\(\[([\s\S]*?)\]\)/g)) {
      const members = [...literal[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
      const hits = members.filter((tag) => registered.has(tag));
      if (hits.length) leaks.push(`${file}: ${hits.join(', ')}`);
    }
  }
  assert.deepEqual(
    leaks,
    [],
    'Source tags must be declared once, in lib/source-registry.mjs. A copy here will silently '
      + 'drift from the others the moment someone adds a source.',
  );
});

test('every consumer binds its set to the registry entry it names', () => {
  const problems = [];
  for (const [file, bindings] of Object.entries(CONSUMERS)) {
    const text = read(file);
    for (const [local, setName] of Object.entries(bindings)) {
      assert.ok(POLICY_SETS[setName], `${setName} is referenced by ${file} but missing from POLICY_SETS`);
      if (!new RegExp(`const\\s+${local}\\s*=\\s*POLICY_SETS\\.${setName}\\s*;`).test(text)) {
        problems.push(`${file} does not bind ${local} to POLICY_SETS.${setName}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every policy set is consumed by at least one file', () => {
  const all = sourceFiles().map((file) => read(file)).join('\n');
  const orphans = Object.keys(POLICY_SETS).filter((name) => !all.includes(`POLICY_SETS.${name}`));
  assert.deepEqual(orphans, [], 'A set nobody imports is dead weight — remove it or wire it up.');
});

// --------------------------------------------------------- coverage guards

/**
 * The kinds added when the new sources were wired in. Each one has to appear in
 * every set that gates a scarce resource, otherwise the source is discovered and
 * stored but never treated as a signal.
 */
const REQUIRED = {
  FAST_ONLINE_HIGH_QUALITY: ['armorgames-new', 'github-game'],
  FAST_WIKI_HIGH_QUALITY: ['steam-upcoming', 'press-new'],
  TREND_ONLINE_STRATEGIC: ['armorgames-new', 'github-game'],
  TREND_WIKI_STRATEGIC: ['steam-upcoming', 'press-new'],
  SEO_QUEUE_STRATEGIC: ['armorgames-new', 'github-game', 'steam-upcoming', 'press-new', 'hn-showhn'],
  SERPER_ONLINE_STRATEGIC: ['armorgames-new', 'github-game'],
  SERPER_WIKI_STRATEGIC: ['steam-upcoming', 'press-new'],
  FALLBACK_ONLINE_STRATEGIC: ['armorgames-new', 'github-html5-games'],
  FALLBACK_WIKI_STRATEGIC: ['steam-upcoming-wishlist', 'alphabetagamer', 'steam-feed-newreleases', 'steam-feed-topsellers'],
};

test('every newly added source kind reaches every policy set that needs it', () => {
  const missing = [];
  for (const [setName, required] of Object.entries(REQUIRED)) {
    const members = POLICY_SETS[setName];
    assert.ok(members, `${setName} is missing from POLICY_SETS`);
    for (const tag of required) {
      if (!members.has(tag)) missing.push(`${setName} is missing ${tag}`);
    }
  }
  assert.deepEqual(missing, [], `New sources must be added to every set that gates a scarce resource.\n${missing.join('\n')}`);
});

test('every enabled source is treated as a signal by at least one consumer', () => {
  // Catches "added and enabled the source, registered its channel, then never
  // wired it into anything" — the failure mode this whole file exists for.
  const wired = new Set();
  for (const members of Object.values(POLICY_SETS)) for (const tag of members) wired.add(tag);

  const unwired = [];
  for (const source of enabled) {
    const evidenceTags = [source.kind, source.id].filter((tag) => SOURCE_TAGS[tag]?.evidence);
    if (!evidenceTags.length) continue;
    if (!evidenceTags.some((tag) => wired.has(tag))) unwired.push(`${source.id} (${evidenceTags.join(', ')})`);
  }
  assert.deepEqual(
    unwired,
    [],
    'An enabled source that is evidence of a channel but appears in no policy set is silently '
      + 'down-weighted everywhere. Add it to the sets whose consumer should react to it.',
  );
});
