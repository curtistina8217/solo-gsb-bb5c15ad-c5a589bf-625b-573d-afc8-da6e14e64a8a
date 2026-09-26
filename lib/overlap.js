'use strict';

/**
 * 新稿批注重叠复核。
 *
 * 仅对「已有确定位置」的批注（matched / manual，且 newStart/newEnd 为有效
 * 半开区间 [start, end)）判定重叠；待处理（pending）与未迁移（unmigrated）
 * 批注一律不入组。
 *
 * 重叠按半开区间判定：a.start < b.end && b.start < a.end，
 * 因此端点相接（前一条的 end === 后一条的 start）不算重叠。
 *
 * 重叠关系具有传递性：A 与 B 交叠、B 与 C 交叠时，即使 A、C 不直接交叠，
 * 三者也归入同一冲突组（并查集实现）。
 */

/** 批注是否已有确定位置，可参与重叠分组 */
function hasPosition(a, newTextLength) {
  if (!a || (a.status !== 'matched' && a.status !== 'manual')) return false;
  const { newStart, newEnd } = a;
  if (!Number.isInteger(newStart) || !Number.isInteger(newEnd)) return false;
  if (newStart < 0 || newStart >= newEnd) return false;
  if (typeof newTextLength === 'number' && newEnd > newTextLength) return false;
  return true;
}

/** 两条半开区间是否交叠（端点相接不算） */
function overlaps(a, b) {
  return a.newStart < b.newEnd && b.newStart < a.newEnd;
}

/**
 * 计算重叠冲突组。
 * @param {Array} annotations 全部批注（pending/unmigrated 自动排除）
 * @param {number} [newTextLength] 新稿长度，越界位置不参与分组
 * @returns {Array<{type:'exact'|'partial', start:number, end:number,
 *   annotationIds:string[], members:Array<{id,start,end,status}>}>}
 *   type=exact 表示组内全部批注范围完全相同；partial 表示存在部分交叠。
 *   结果按新稿位置先后排序。
 */
function buildOverlapGroups(annotations, newTextLength) {
  const list = (annotations || []).filter((a) => hasPosition(a, newTextLength));

  // 并查集：传递重叠关系
  const parent = list.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x, y) => {
    parent[find(x)] = find(y);
  };

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (overlaps(list[i], list[j])) union(i, j);
    }
  }

  const buckets = new Map();
  list.forEach((a, i) => {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(a);
  });

  const groups = [];
  for (const anns of buckets.values()) {
    if (anns.length < 2) continue; // 单独一条、与谁都不交叠 → 不成组
    anns.sort((x, y) => x.newStart - y.newStart || x.newEnd - y.newEnd);
    const start = Math.min(...anns.map((a) => a.newStart));
    const end = Math.max(...anns.map((a) => a.newEnd));
    // 组内所有区间端点完全一致 → 完全相同；否则为部分交叠
    const exact = anns.every((a) => a.newStart === start && a.newEnd === end);
    groups.push({
      type: exact ? 'exact' : 'partial',
      start,
      end,
      annotationIds: anns.map((a) => a.id),
      members: anns.map((a) => ({
        id: a.id,
        start: a.newStart,
        end: a.newEnd,
        status: a.status,
      })),
    });
  }

  groups.sort(
    (a, b) => a.start - b.start || b.end - a.end || b.annotationIds.length - a.annotationIds.length
  );
  return groups;
}

const api = { hasPosition, overlaps, buildOverlapGroups };

// 同时供 Node（测试/服务端）与浏览器（<script>）使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof self !== 'undefined') {
  self.OverlapGroups = api;
}
