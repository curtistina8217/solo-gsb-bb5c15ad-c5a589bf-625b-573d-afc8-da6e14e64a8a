'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  doc: null, // 当前文稿
  pendingSel: null, // 旧稿中待添加批注的选区 {start, end}
  manualFor: null, // 正在手动定位的批注 id
  groups: [], // 当前新稿的重叠冲突组（每次渲染即时重算）
};
const groupByAid = () => {
  const map = new Map();
  state.groups.forEach((g) => g.annotationIds.forEach((id) => map.set(id, g)));
  return map;
};

// ---------- 工具 ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

function saved() {
  $('saveHint').textContent = `已保存 ${new Date().toLocaleTimeString()}`;
}

/** 计算选区节点在容器内的字符偏移（容器由若干文本节点组成） */
function offsetOf(container, node, offset) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let n;
  while ((n = walker.nextNode())) {
    if (n === node) return pos + offset;
    pos += n.textContent.length;
  }
  return pos;
}

/** 读取容器内当前选区的 [start, end)，无选区返回 null */
function selectionRange(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return null;
  const a = offsetOf(container, sel.anchorNode, sel.anchorOffset);
  const b = offsetOf(container, sel.focusNode, sel.focusOffset);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return end > start ? { start, end } : null;
}

/**
 * 把文本渲染为带高亮的 HTML（marks: [{start, end, cls, aid, gtype}]）。
 * 重叠区间按原子分段后渲染为嵌套 <mark>，保证每条批注在重叠范围内都能被
 * 点击/选中，绝不跳过后续批注。同一起点时范围更大的在外层。
 */
function renderWithMarks(text, marks) {
  const valid = marks
    .filter((m) => m.start != null && m.end != null && m.start < m.end && m.end <= text.length)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  // 全部边界构成原子分段，每段内「生效中的批注」集合不变
  const bounds = new Set();
  for (const m of valid) {
    bounds.add(m.start);
    bounds.add(m.end);
  }
  const points = [...bounds].sort((x, y) => x - y);
  let html = '';
  for (let i = 0; i < points.length - 1; i++) {
    const segStart = points[i];
    const segEnd = points[i + 1];
    const active = valid.filter((m) => m.start <= segStart && m.end >= segEnd);
    if (!active.length) {
      html += escapeHtml(text.slice(segStart, segEnd));
      continue;
    }
    // 起点越晚/终点越早的越在内层（内层最后包裹）
    active.sort((a, b) => b.start - a.start || a.end - b.end);
    let inner = escapeHtml(text.slice(segStart, segEnd));
    for (const m of active) {
      const conflict = m.gtype ? ` conflict conflict-${m.gtype}` : '';
      inner =
        `<mark class="${m.cls}${conflict}" data-aid="${m.aid}">${inner}</mark>`;
    }
    html += inner;
  }
  // 首尾边界之外的文本
  const first = points[0];
  const last = points[points.length - 1];
  if (!points.length) return escapeHtml(text);
  return escapeHtml(text.slice(0, first)) + html + escapeHtml(text.slice(last));
}

// ---------- 文稿管理 ----------

async function refreshDocList(selectId) {
  const docs = await api('GET', '/api/documents');
  const sel = $('docSelect');
  sel.innerHTML = docs
    .map((d) => `<option value="${d.id}">${escapeHtml(d.title)}（批注 ${d.annotationCount}）</option>`)
    .join('');
  if (selectId && docs.some((d) => d.id === selectId)) sel.value = selectId;
  return docs;
}

async function loadDoc(id) {
  state.doc = await api('GET', `/api/documents/${id}`);
  state.pendingSel = null;
  state.manualFor = null;
  state.suppressMarkClick = false;
  $('emptyState').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('annotForm').classList.add('hidden');
  $('manualBanner').classList.add('hidden');
  $('oldInput').value = state.doc.oldText || '';
  $('newInput').value = state.doc.newText || '';
  $('oldMsg').textContent = '';
  $('migrateMsg').textContent = '';
  renderOldView();
  renderAnnotList();
  renderResults();
}

// ---------- ① 旧稿与批注 ----------

function renderOldView() {
  const doc = state.doc;
  if (!doc) return;
  const marks = doc.annotations.map((a) => ({
    start: a.oldStart, end: a.oldEnd, cls: 'hl-old', aid: a.id,
  }));
  $('oldView').innerHTML = renderWithMarks(doc.oldText || '', marks);
}

function renderAnnotList() {
  const doc = state.doc;
  if (!doc) return;
  $('annotCount').textContent = `共 ${doc.annotations.length} 条`;
  $('annotList').innerHTML = doc.annotations
    .map((a) => `
      <div class="annot-card">
        <div class="quote">${escapeHtml(a.quote)}</div>
        <div class="comment">${escapeHtml(a.comment)}</div>
        <div class="ops">
          <button class="danger small" data-del="${a.id}">删除</button>
        </div>
      </div>`)
    .join('') || '<p class="hint">暂无批注：在上方旧稿中框选文字即可添加。</p>';
  $('annotList').querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('删除这条批注？')) return;
      state.doc = await api('DELETE', `/api/documents/${state.doc.id}/annotations/${btn.dataset.del}`);
      renderOldView();
      renderAnnotList();
      renderResults();
      saved();
    });
  });
}

// ---------- ② 新稿与迁移 ----------

const STATUS_LABEL = {
  matched: '已定位',
  manual: '人工指定',
  pending: '待处理',
  unmigrated: '未迁移',
};
const REASON_LABEL = {
  unique: '新稿中仅出现一次',
  context: '多处出现，已按前后文区分',
  not_found: '新稿中未找到原文（可能已删除或改写）',
  ambiguous: '多处出现且前后文相近，需人工选择',
  human: '由人工指定位置',
};

function snippet(text, start, end) {
  const before = text.slice(Math.max(0, start - 15), start);
  const mid = text.slice(start, end);
  const after = text.slice(end, end + 15);
  return `…${escapeHtml(before)}<b>【${escapeHtml(mid)}】</b>${escapeHtml(after)}…`;
}

function rangeText(start, end) {
  return `[${start}, ${end}) · ${end - start} 字`;
}

function renderResults() {
  const doc = state.doc;
  if (!doc) return;
  const text = doc.newText || '';
  $('markChooser').classList.add('hidden');

  // 即时重算重叠冲突组（迁移 / 人工定位 / 重新渲染后都会走到这里）
  state.groups = OverlapGroups.buildOverlapGroups(doc.annotations, text.length);
  const aidGroup = groupByAid();

  // 左栏：新稿 + 高亮（重叠区间嵌套渲染，每条批注均可点击）
  const marks = doc.annotations
    .filter((a) => a.newStart != null)
    .map((a) => ({
      start: a.newStart,
      end: a.newEnd,
      cls: a.status === 'manual' ? 'hl-manual' : a.status === 'matched' ? 'hl-matched' : 'hl-pending',
      aid: a.id,
      gtype: aidGroup.has(a.id) ? aidGroup.get(a.id).type : null,
    }));
  $('newView').innerHTML = renderWithMarks(text, marks);
  $('newView').querySelectorAll('mark[data-aid]').forEach((el) => {
    el.addEventListener('click', (e) => onMarkClick(e, el));
  });

  // 右栏：批注卡片
  $('resultList').innerHTML = doc.annotations
    .map((a) => {
      const cands = (a.candidates || [])
        .map((c, i) => `
          <button class="candidate" data-aid="${a.id}" data-start="${c.start}" data-end="${c.end}">
            候选${i + 1}：${snippet(text, c.start, c.end)}
            <span class="score">${c.fuzzy ? `相似度 ${c.score}` : `上下文得分 ${c.score}`}</span>
          </button>`)
        .join('');
      const pos = a.newStart != null
        ? `<div class="hint">位置：${rangeText(a.newStart, a.newEnd)} ${snippet(text, a.newStart, a.newEnd)}</div>`
        : '';
      const g = aidGroup.get(a.id);
      const conflictTag = g
        ? `<span class="conflict-tag conflict-tag-${g.type}" data-jump-group="${state.groups.indexOf(g)}">
             ${g.type === 'exact' ? '⚠ 范围完全相同' : '⚠ 部分交叠'}（${g.annotationIds.length} 条）
           </span>`
        : '';
      return `
        <div class="result-card st-${a.status}" data-card="${a.id}">
          <div class="ops">
            <span class="badge badge-${a.status}">${STATUS_LABEL[a.status] || a.status}</span>
            <span class="hint">${REASON_LABEL[a.reason] || ''}</span>
            ${conflictTag}
          </div>
          <div class="quote">${escapeHtml(a.quote)}</div>
          <div class="comment">${escapeHtml(a.comment)}</div>
          ${pos}
          ${cands ? `<div class="hint">可选位置：</div>${cands}` : ''}
          <div class="ops">
            <button class="ghost small" data-manual="${a.id}">手动定位</button>
            ${a.newStart != null ? `<button class="ghost small" data-jump="${a.id}">跳转到新稿位置</button>` : ''}
          </div>
        </div>`;
    })
    .join('') || '<p class="hint">暂无批注。</p>';

  $('resultList').querySelectorAll('[data-manual]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = state.doc.annotations.find((x) => x.id === btn.dataset.manual);
      state.manualFor = a.id;
      $('manualQuote').textContent = a.quote;
      $('manualBanner').classList.remove('hidden');
      $('newView').focus();
    });
  });
  $('resultList').querySelectorAll('.candidate').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await setPosition(btn.dataset.aid, Number(btn.dataset.start), Number(btn.dataset.end));
    });
  });
  $('resultList').querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => jumpToAnnotation(btn.dataset.jump));
  });
  $('resultList').querySelectorAll('[data-jump-group]').forEach((el) => {
    el.addEventListener('click', () => {
      const g = state.groups[Number(el.dataset.jumpGroup)];
      if (g) jumpToRange(g.start, g.end);
    });
  });

  renderConflicts(text);
}

/** 渲染重叠复核面板：列出每组的全部批注及对应范围 */
function renderConflicts(text) {
  const groups = state.groups;
  const box = $('conflictBox');
  if (!groups.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const exactN = groups.filter((g) => g.type === 'exact').length;
  const partialN = groups.length - exactN;
  $('conflictCount').textContent =
    `${groups.length} 组（完全相同 ${exactN}，部分交叠 ${partialN}）`;

  $('conflictList').innerHTML = groups
    .map((g, gi) => {
      const members = g.members
        .map((m) => {
          const a = state.doc.annotations.find((x) => x.id === m.id);
          if (!a) return '';
          const sameAsGroup = m.start === g.start && m.end === g.end;
          return `
            <div class="conflict-member" data-pick="${m.id}">
              <div class="ops">
                <span class="badge badge-${m.status}">${STATUS_LABEL[m.status] || m.status}</span>
                <span class="hint">${rangeText(m.start, m.end)}</span>
                ${g.type === 'partial' && !sameAsGroup ? '<span class="hint">（组内较短范围）</span>' : ''}
                <button class="ghost small" data-pick-jump="${m.id}">跳转到新稿位置</button>
              </div>
              <div class="quote">${escapeHtml(a.quote)}</div>
              <div class="comment">${escapeHtml(a.comment)}</div>
            </div>`;
        })
        .join('');
      return `
        <div class="conflict-card conflict-${g.type}" data-conflict-card="${gi}">
          <div class="conflict-title">
            <span class="conflict-badge conflict-badge-${g.type}">
              ${g.type === 'exact' ? '完全相同' : '部分交叠'}
            </span>
            <b>第 ${gi + 1} 组 · ${g.annotationIds.length} 条批注</b>
            <span class="hint">合并范围 ${rangeText(g.start, g.end)}</span>
            <button class="ghost small" data-group-jump="${gi}">跳转到新稿位置</button>
          </div>
          <div class="conflict-preview hint">新稿内容：${snippet(text, g.start, g.end)}</div>
          ${members}
        </div>`;
    })
    .join('');

  $('conflictList').querySelectorAll('[data-group-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = state.groups[Number(btn.dataset.groupJump)];
      if (g) jumpToRange(g.start, g.end);
    });
  });
  $('conflictList').querySelectorAll('[data-pick-jump]').forEach((btn) => {
    btn.addEventListener('click', () => jumpToAnnotation(btn.dataset.pickJump));
  });
  $('conflictList').querySelectorAll('.conflict-member').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      focusCard(row.dataset.pick);
    });
  });
}

/** 点击新稿高亮：重叠处列出该处全部批注，点哪条选哪条，不跳过后续批注 */
function onMarkClick(e, el) {
  e.stopPropagation();
  if (state.suppressMarkClick) {
    state.suppressMarkClick = false;
    return;
  }
  const aids = [];
  let cur = el;
  // 命中点上可能嵌套多个 mark，沿祖先链收集同一处的全部批注
  while (cur && cur !== $('newView') && cur.nodeType === 1) {
    if (cur.dataset && cur.dataset.aid) aids.push(cur.dataset.aid);
    cur = cur.parentElement;
  }
  const unique = [...new Set(aids)];
  if (unique.length === 1) {
    selectAnnotation(unique[0]);
    return;
  }
  const chooser = $('markChooser');
  chooser.innerHTML =
    `<div class="chooser-title">此处有 ${unique.length} 条重叠批注，请选择：</div>` +
    unique
      .map((id) => {
        const a = state.doc.annotations.find((x) => x.id === id);
        if (!a) return '';
        const g = groupByAid().get(id);
        return `
          <button class="chooser-item" data-choose="${id}">
            <span class="badge badge-${a.status}">${STATUS_LABEL[a.status] || a.status}</span>
            ${g ? `<span class="conflict-tag conflict-tag-${g.type}">${g.type === 'exact' ? '完全相同' : '部分交叠'}</span>` : ''}
            <span class="quote">${escapeHtml(a.comment || a.quote)}</span>
            <span class="hint">${rangeText(a.newStart, a.newEnd)}</span>
          </button>`;
      })
      .join('');
  const rect = el.getBoundingClientRect();
  chooser.style.left = `${Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 320)}px`;
  chooser.style.top = `${window.scrollY + rect.bottom + 6}px`;
  chooser.classList.remove('hidden');
  chooser.querySelectorAll('[data-choose]').forEach((b) => {
    b.addEventListener('click', () => {
      chooser.classList.add('hidden');
      selectAnnotation(b.dataset.choose);
    });
  });
}

/** 选中一条批注：高亮新稿对应位置（含被嵌套拆分的各段）并定位右侧卡片 */
function selectAnnotation(aid) {
  $('newView').querySelectorAll(`mark[data-aid="${CSS.escape(aid)}"]`).forEach((m) => flash(m));
  focusCard(aid);
}

function focusCard(aid) {
  const card = $('resultList').querySelector(`[data-card="${aid}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(card);
  }
}

function flash(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

/** 从右侧/冲突面板跳转到新稿位置 */
function jumpToAnnotation(aid) {
  const first = $('newView').querySelector(`mark[data-aid="${CSS.escape(aid)}"]`);
  if (!first) return;
  selectAnnotation(aid);
  first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** 跳转到指定偏移区间（合并范围）：选覆盖该区间起点的最外层高亮 */
function jumpToRange(start) {
  const covering = [...$('newView').querySelectorAll('mark[data-aid]')].filter((el) => {
    const a = state.doc.annotations.find((x) => x.id === el.dataset.aid);
    return a && a.newStart <= start && a.newEnd > start;
  });
  // 文档顺序中最先出现的是嵌套最外层（其开标签最早）
  const target = covering[0];
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(target);
  }
}

async function setPosition(aid, start, end) {
  state.doc = await api(
    'PUT',
    `/api/documents/${state.doc.id}/annotations/${aid}/position`,
    { start, end }
  );
  state.manualFor = null;
  $('manualBanner').classList.add('hidden');
  renderResults();
  saved();
  toast('位置已保存');
}

async function migrate() {
  state.doc = await api('POST', `/api/documents/${state.doc.id}/migrate`);
  renderResults();
  saved();
  const matched = state.doc.annotations.filter((a) => a.status === 'matched').length;
  const pending = state.doc.annotations.filter((a) => a.status === 'pending').length;
  const msg = `迁移完成：已定位 ${matched} 条，待处理 ${pending} 条`;
  $('migrateMsg').textContent = msg;
  toast(msg);
}

// ---------- 事件绑定 ----------

$('btnNewDoc').addEventListener('click', async () => {
  const title = prompt('文稿标题：', '未命名文稿');
  if (title === null) return;
  const doc = await api('POST', '/api/documents', { title });
  await refreshDocList(doc.id);
  await loadDoc(doc.id);
  saved();
});

$('btnDeleteDoc').addEventListener('click', async () => {
  if (!state.doc || !confirm(`删除文稿「${state.doc.title}」及其全部批注？`)) return;
  await api('DELETE', `/api/documents/${state.doc.id}`);
  state.doc = null;
  const docs = await refreshDocList();
  if (docs.length) await loadDoc(docs[0].id);
  else {
    $('workspace').classList.add('hidden');
    $('emptyState').classList.remove('hidden');
  }
});

$('docSelect').addEventListener('change', (e) => loadDoc(e.target.value));

$('btnSaveOld').addEventListener('click', async () => {
  try {
    const { doc, dropped } = await api('PUT', `/api/documents/${state.doc.id}/old`, {
      oldText: $('oldInput').value,
    });
    state.doc = doc;
    renderOldView();
    renderAnnotList();
    renderResults();
    saved();
    $('oldMsg').textContent = dropped ? `已保存；${dropped} 条批注因超出新文稿范围被移除` : '已保存';
    toast('旧稿已保存');
  } catch (e) {
    alert(e.message);
  }
});

// 在旧稿中框选文字 → 弹出批注表单
$('oldView').addEventListener('mouseup', () => {
  setTimeout(() => {
    if (!state.doc || !state.doc.oldText) return;
    const range = selectionRange($('oldView'));
    if (!range) return;
    state.pendingSel = range;
    $('annotQuote').textContent = `选中：${state.doc.oldText.slice(range.start, range.end)}`;
    $('annotComment').value = '';
    $('annotForm').classList.remove('hidden');
    $('annotComment').focus();
  }, 0);
});

$('btnAddAnnot').addEventListener('click', async () => {
  if (!state.pendingSel) return;
  try {
    state.doc = await api('POST', `/api/documents/${state.doc.id}/annotations`, {
      start: state.pendingSel.start,
      end: state.pendingSel.end,
      comment: $('annotComment').value,
    });
    state.pendingSel = null;
    $('annotForm').classList.add('hidden');
    window.getSelection().removeAllRanges();
    renderOldView();
    renderAnnotList();
    saved();
    toast('批注已添加');
  } catch (e) {
    alert(e.message);
  }
});

$('btnCancelAnnot').addEventListener('click', () => {
  state.pendingSel = null;
  $('annotForm').classList.add('hidden');
});

$('btnSaveNewMigrate').addEventListener('click', async () => {
  try {
    state.doc = await api('PUT', `/api/documents/${state.doc.id}/new`, {
      newText: $('newInput').value,
    });
    await migrate();
  } catch (e) {
    alert(e.message);
  }
});

$('btnRemigrate').addEventListener('click', async () => {
  try {
    await migrate();
  } catch (e) {
    alert(e.message);
  }
});

// 手动定位模式下，在新稿中框选文字即作为该批注的位置
$('newView').addEventListener('mouseup', () => {
  // 框选结束后的合成 click 不应触发批注选择弹层（同步置位，由 click 消费）
  if (state.manualFor) {
    const range = selectionRange($('newView'));
    if (range) state.suppressMarkClick = true;
  }
  setTimeout(async () => {
    if (!state.manualFor || !state.doc) return;
    const range = selectionRange($('newView'));
    if (!range) return;
    window.getSelection().removeAllRanges();
    await setPosition(state.manualFor, range.start, range.end);
  }, 0);
});

$('btnCancelManual').addEventListener('click', () => {
  state.manualFor = null;
  $('manualBanner').classList.add('hidden');
});

// 点击高亮弹层之外 → 关闭选择弹层
document.addEventListener('click', (e) => {
  const chooser = $('markChooser');
  if (chooser.classList.contains('hidden')) return;
  if (e.target.closest('#markChooser') || e.target.closest('mark')) return;
  chooser.classList.add('hidden');
});

// ---------- 启动 ----------

(async () => {
  const docs = await refreshDocList();
  if (docs.length) await loadDoc(docs[0].id);
  else $('emptyState').classList.remove('hidden');
})().catch((e) => alert(e.message));
