'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { overlaps, buildOverlapGroups } = require('../lib/overlap');

function a(id, newStart, newEnd, status = 'matched') {
  return {
    id,
    status,
    reason: status === 'manual' ? 'human' : 'unique',
    newStart,
    newEnd,
  };
}

function ids(groups) {
  return groups.map((g) => g.annotationIds);
}

test('半开区间：端点相接不算重叠', () => {
  assert.equal(overlaps({ newStart: 0, newEnd: 10 }, { newStart: 10, newEnd: 20 }), false);
  assert.equal(overlaps({ newStart: 10, newEnd: 20 }, { newStart: 0, newEnd: 10 }), false);
});

test('共享一个字符即算重叠（[0,10) 与 [9,12)）', () => {
  assert.equal(overlaps({ newStart: 0, newEnd: 10 }, { newStart: 9, newEnd: 12 }), true);
});

test('独立区间不产生冲突组', () => {
  const groups = buildOverlapGroups([
    a('x', 0, 5),
    a('y', 5, 10), // 与 x 端点相接
    a('z', 20, 30),
  ]);
  assert.deepEqual(groups, []);
});

test('范围完全相同 → exact 组', () => {
  const groups = buildOverlapGroups([a('x', 10, 20), a('y', 10, 20)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'exact');
  assert.deepEqual(ids(groups), [['x', 'y']]);
  assert.deepEqual([groups[0].start, groups[0].end], [10, 20]);
});

test('部分交叠 → partial 组', () => {
  const groups = buildOverlapGroups([a('x', 0, 10), a('y', 5, 15)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'partial');
  assert.deepEqual([groups[0].start, groups[0].end], [0, 15]);
});

test('传递重叠：A-C 不直接交叠也归入同一组', () => {
  const groups = buildOverlapGroups([
    a('x', 0, 10),
    a('y', 8, 20),
    a('z', 18, 30),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'partial');
  assert.deepEqual(ids(groups), [['x', 'y', 'z']]);
});

test('两个互不相连的重叠链 → 两个组，按位置排序', () => {
  const groups = buildOverlapGroups([
    a('x', 100, 110),
    a('y', 105, 120),
    a('p', 0, 10),
    a('q', 5, 8),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(ids(groups), [['p', 'q'], ['x', 'y']]);
});

test('完全相同的两条与另外一条部分交叠 → partial 组', () => {
  const groups = buildOverlapGroups([
    a('x', 10, 20),
    a('y', 10, 20),
    a('z', 15, 25),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'partial');
  assert.deepEqual(ids(groups), [['x', 'y', 'z']]);
});

test('pending（待处理）与 unmigrated（未迁移）不入组', () => {
  const groups = buildOverlapGroups([
    a('x', 0, 10, 'matched'),
    a('y', 0, 10, 'pending'),
    a('z', 0, 10, 'unmigrated'),
    a('w', 5, 15, 'manual'),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups), [['x', 'w']]);
});

test('人工指定(manual)与自动定位(matched)同样参与分组', () => {
  const groups = buildOverlapGroups([a('x', 0, 10, 'manual'), a('y', 2, 12, 'matched')]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.id), ['x', 'y']);
  assert.deepEqual(groups[0].members.map((m) => m.status), ['manual', 'matched']);
});

test('缺少位置或越界位置的批注被忽略', () => {
  const groups = buildOverlapGroups(
    [
      { id: 'x', status: 'matched', newStart: null, newEnd: null },
      { id: 'y', status: 'matched', newStart: 0, newEnd: 10 },
      { id: 'z', status: 'matched', newStart: 5, newEnd: 999 },
    ],
    20
  );
  assert.deepEqual(groups, []);
});
