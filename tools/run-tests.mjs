#!/usr/bin/env node
/**
 * Test runner wrapper.
 *
 * `npm test` used to be a bare `node --test tests/*.test.mjs`. That has two
 * problems that both bite at exactly the wrong moment:
 *
 *  1. The glob is expanded by the *shell*, so the set of files under test
 *     depends on the platform's shell rather than on this repo. The wrapper
 *     resolves the files itself, so the set is identical everywhere.
 *
 *  2. When the suite fails in CI, the run summary says nothing but
 *     "Process completed with exit code 1." The detail lives only in the raw
 *     job log, which needs authentication to fetch and is easy to lose. The
 *     wrapper re-emits each failing test as an `::error::` annotation, so a red
 *     run explains itself in the UI — and through the REST API.
 *
 * Usage:
 *   node tools/run-tests.mjs                     # the whole suite
 *   node tools/run-tests.mjs --test-name-pattern=<re>   # extra flags pass through
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(root, 'tests');

/** Resolve the suite the same way on every OS: read the directory, sort, filter. */
function testFiles() {
  return fs.readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('tests', name));
}

const files = testFiles();
if (!files.length) {
  console.error(`No *.test.mjs files under ${testsDir} — refusing to report a green run.`);
  process.exit(1);
}

/**
 * The environment is printed before every run because every one of these has,
 * at some point, been the reason a suite passed on one machine and failed on
 * another. A missing line here is a missing alibi.
 */
const locale = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return '(unavailable)';
  }
})();

console.log('--- environment ---');
console.log(`node            ${process.version}  (${process.execPath})`);
console.log(`platform        ${process.platform} ${process.arch}  cpus=${os.cpus().length}`);
console.log(`cwd             ${process.cwd()}`);
console.log(`TZ              ${process.env.TZ ?? '(unset)'}   resolved=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
console.log(`LANG/LC_ALL     ${process.env.LANG ?? '(unset)'} / ${process.env.LC_ALL ?? '(unset)'}`);
console.log(`default locale  ${locale}`);
console.log(`CI              ${process.env.CI ?? '(unset)'}  GITHUB_ACTIONS=${process.env.GITHUB_ACTIONS ?? '(unset)'}`);
console.log(`test files      ${files.length}`);
for (const file of files) console.log(`                  ${file}`);
console.log('--- test run ---');

const extra = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', ...extra, ...files],
  { cwd: root, encoding: 'utf8', env: process.env },
);

const stdout = result.stdout || '';
const stderr = result.stderr || '';
process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

if (result.error) {
  console.error(`Failed to spawn the test runner: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  surfaceFailure(`${stdout}\n${stderr}`, result.status);
}
process.exit(result.status ?? 1);

/**
 * Turn a failing run into annotations.
 *
 * `spec` marks a failure with a leading `✖` (and `not ok` when it falls back to
 * TAP), so both shapes are collected. Messages are truncated per annotation and
 * the number of annotations is capped, because GitHub silently drops them past
 * a limit and a dropped annotation is worse than a short one.
 */
function surfaceFailure(output, status) {
  const annotations = [];
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*(?:✖|not ok)\s/.test(line)) continue;
    const title = line.replace(/^\s*(?:✖|not ok)\s+\d*\s*[-–]?\s*/, '').trim();
    // The detail lives on the lines immediately after the failure marker.
    const detail = lines.slice(i + 1, i + 14)
      .map((entry) => entry.replace(/\s+$/, ''))
      .filter((entry) => entry.trim())
      .slice(0, 8)
      .join('\n');
    annotations.push({ title: title || 'failing test', detail });
  }

  const summary = lines.filter((line) => /^#\s*(?:tests|pass|fail|cancelled)/.test(line)).join(' · ');
  console.error(`\nTest suite failed (exit ${status}). ${summary}`);

  if (process.env.GITHUB_ACTIONS !== 'true') return;

  emit('error', 'test suite failed', summary || `exit code ${status}`);
  for (const annotation of annotations.slice(0, 20)) {
    emit('error', annotation.title.slice(0, 200), annotation.detail.slice(0, 1800));
  }
  if (!annotations.length) {
    // No parseable failure marker: the runner itself died. Ship the tail so the
    // reason is visible without opening the raw log.
    emit('error', 'test runner produced no failure marker', lines.slice(-40).join('\n').slice(0, 3000));
  }
}

/** GitHub workflow command. Newlines and percent signs must be escaped. */
function emit(level, title, message) {
  const escaped = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const safeTitle = String(title).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${level} title=${safeTitle}::${escaped}`);
}
