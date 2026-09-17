import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionByLastSeen } from '../tools/prune-inherited.mjs';

const CUT = Date.parse('2026-09-16T10:00:00Z');

test('切分点是闭区间：正好等于切分点的候选要留下', () => {
  const { keep, drop } = partitionByLastSeen([
    { gameName: 'on-the-line', lastSeen: '2026-09-16T10:00:00.000Z' },
    { gameName: 'one-ms-before', lastSeen: '2026-09-16T09:59:59.999Z' },
  ], CUT);
  assert.deepEqual(keep.map((candidate) => candidate.gameName), ['on-the-line']);
  assert.deepEqual(drop.map((candidate) => candidate.gameName), ['one-ms-before']);
});

/**
 * 这个工具要修的就是「来路不明的记录永久赖在池子里」，所以解析失败必须算「没见过」。
 * 反过来（当成新鲜）会让一条坏记录永远躲过清理，正好是反效果。
 */
test('时间戳缺失或解析失败按「没见过」处理，宁可清掉也不留', () => {
  const { keep, drop } = partitionByLastSeen([
    { gameName: 'no-last-seen' },
    { gameName: 'garbage', lastSeen: 'not a date' },
    { gameName: 'empty', lastSeen: '' },
    { gameName: 'ours', lastSeen: '2026-09-17T15:04:27.345Z' },
  ], CUT);
  assert.deepEqual(keep.map((candidate) => candidate.gameName), ['ours']);
  assert.equal(drop.length, 3);
});

/**
 * 判据必须是 lastSeen 而不是 firstSeen：一个词最早是上游发现的，只要我们的源
 * 现在还在列它，它就是活的信号 —— 清掉它等于把当前榜单上的词一起扔了。
 * 反过来，firstSeen 晚于切分点但我们的源再没见过，那才是真正的存量。
 */
test('判据是 lastSeen 而不是 firstSeen', () => {
  const { keep, drop } = partitionByLastSeen([
    { gameName: '上游先发现但我们的源还在列', firstSeen: '2026-07-28T00:00:00Z', lastSeen: '2026-09-17T15:04:27.345Z' },
    { gameName: '上游先发现且再没被列过', firstSeen: '2026-07-28T00:00:00Z', lastSeen: '2026-09-14T00:00:00Z' },
    { gameName: 'firstSeen 很新但再没被列过', firstSeen: '2026-09-15T23:00:00Z', lastSeen: '2026-09-15T23:30:00Z' },
  ], CUT);
  assert.deepEqual(keep.map((candidate) => candidate.gameName), ['上游先发现但我们的源还在列']);
  assert.equal(drop.length, 2);
});

test('空池或缺失入参不炸', () => {
  assert.deepEqual(partitionByLastSeen([], CUT), { keep: [], drop: [] });
  assert.deepEqual(partitionByLastSeen(undefined, CUT), { keep: [], drop: [] });
});
