/**
 * store.js -- 用户那一层的卡片数据：自己加的卡、给会话卡起的名字、收纳/删除的标记。
 *
 * 单独一个文件 brain/journal/cards.json，和 projects.json 分开：
 *   - projects.json 是「线」的登记表，人写的、线级的、稳定的；
 *   - cards.json 是「角」的状态，插件写的、卡级的、会变的（收纳、改名、删掉）。
 * 混在一起的话，每次点一下「收纳」都要重写人手维护的那份表。
 *
 * 结构：
 *   settings  { autoCards, windowHours, maxLive }
 *   cards     [{ id:'m-xxx', title, note, steps:[{text,detail}], color, createdAt }]
 *   projects  { '<线id>': { shelf, hidden, title?, note? } }      // 覆盖 projects.json 的线卡
 *   sessions  { '<会话id>': { pinned, shelf, hidden, title?, note?, at } }  // 覆盖自动会话卡
 *
 * 写盘是原子的：先写 .tmp，再改名。改之前留一份 .bak。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_TITLE = 60;
const MAX_NOTE = 600;
const MAX_STEPS = 20;
const MAX_STEP = 140;
const OVERRIDE_TTL = 45 * 86400000;

export function storeFile(brainDir) {
  return path.join(brainDir, 'journal', 'cards.json');
}

function emptyStore() {
  return {
    version: 1,
    updatedAt: null,
    settings: { autoCards: true, windowHours: 12, maxLive: 3 },
    cards: [],
    projects: {},
    sessions: {},
  };
}

export function clip(s, max) {
  const flat = String(s == null ? '' : s).replace(/\r/g, '').trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

/** 步骤可以写成字符串或 {text,detail}；统一成 {text,detail}。 */
export function normalizeSteps(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of list.slice(0, MAX_STEPS)) {
    const raw = typeof item === 'string' ? item : (item && item.text) || '';
    const text = clip(raw, MAX_STEP);
    if (!text) continue;
    const detail = typeof item === 'object' && item ? clip(item.detail || '', MAX_STEP) : '';
    out.push({ text, detail });
  }
  return out;
}

function coerce(raw) {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  const settings = { ...base.settings, ...(raw.settings || {}) };
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    settings: {
      autoCards: settings.autoCards !== false,
      windowHours: Number.isFinite(Number(settings.windowHours)) ? Math.max(1, Math.min(168, Number(settings.windowHours))) : 12,
      maxLive: Number.isFinite(Number(settings.maxLive)) ? Math.max(0, Math.min(8, Number(settings.maxLive))) : 3,
    },
    cards: (Array.isArray(raw.cards) ? raw.cards : [])
      .filter((c) => c && typeof c === 'object' && c.id)
      .map((c) => ({
        id: String(c.id),
        title: clip(c.title || '新卡片', MAX_TITLE),
        note: clip(c.note || '', MAX_NOTE),
        steps: normalizeSteps(c.steps),
        color: String(c.color || '#4b8bf5'),
        shelf: c.shelf === true,
        createdAt: String(c.createdAt || new Date().toISOString()),
      })),
    projects: (raw.projects && typeof raw.projects === 'object') ? raw.projects : {},
    sessions: (raw.sessions && typeof raw.sessions === 'object') ? raw.sessions : {},
  };
}

export function loadStore(brainDir) {
  const file = storeFile(brainDir);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      return { ok: false, file, exists: true, error: `cards.json 解析失败：${error.message}`, data: emptyStore() };
    }
    return { ok: true, file, exists: false, data: emptyStore(), created: true };
  }
  return { ok: true, file, exists: true, data: coerce(raw) };
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch { /* 备份失败不影响主流程 */ }
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function prune(store, now) {
  for (const [id, ov] of Object.entries(store.sessions)) {
    const at = ov && ov.at ? Date.parse(ov.at) : NaN;
    // 只有「只是收藏/收纳」的旧记录会被清；起过名字的留着。
    if (Number.isFinite(at) && now - at > OVERRIDE_TTL && !ov.title && !ov.note) delete store.sessions[id];
  }
  return store;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 一次修改 = 读 → 改 → 原子写。
 * op 见下面各分支；未知 op 抛错，由 HTTP 层回 400。
 */
export function mutate(brainDir, op, now = Date.now()) {
  const loaded = loadStore(brainDir);
  const store = loaded.data;
  const kind = String((op && op.op) || '').toLowerCase();
  const id = String((op && op.id) || '');

  if (kind === 'add') {
    const card = {
      id: newId('m-'),
      title: clip((op && op.title) || '新卡片', MAX_TITLE) || '新卡片',
      note: clip((op && op.note) || '', MAX_NOTE),
      steps: normalizeSteps(op && op.steps),
      color: String((op && op.color) || '#4b8bf5'),
      createdAt: new Date(now).toISOString(),
    };
    store.cards.push(card);
    store.updatedAt = new Date(now).toISOString();
    writeAtomic(loaded.file, prune(store, now));
    return { ok: true, op: 'add', id: card.id, data: store };
  }

  if (kind === 'update') {
    const card = store.cards.find((c) => c.id === id);
    if (!card) return { ok: false, error: `没有这张卡：${id}` };
    if ('title' in (op || {})) card.title = clip(op.title, MAX_TITLE) || card.title;
    if ('note' in (op || {})) card.note = clip(op.note, MAX_NOTE);
    if ('steps' in (op || {})) card.steps = normalizeSteps(op.steps);
    if ('color' in (op || {})) card.color = String(op.color || card.color);
    store.updatedAt = new Date(now).toISOString();
    writeAtomic(loaded.file, prune(store, now));
    return { ok: true, op: 'update', id, data: store };
  }

  if (kind === 'remove') {
    const before = store.cards.length;
    store.cards = store.cards.filter((c) => c.id !== id);
    // 删线卡/会话卡 = 记一个 hidden，不删 projects.json 里那条线。
    if (id.startsWith('p:')) (store.projects[id.slice(2)] ||= {}).hidden = true;
    if (id.startsWith('s:')) (store.sessions[id.slice(2)] ||= {}).hidden = true;
    store.updatedAt = new Date(now).toISOString();
    writeAtomic(loaded.file, prune(store, now));
    return { ok: true, op: 'remove', id, removed: before !== store.cards.length, data: store };
  }

  if (kind === 'flag') {
    const flag = String((op && op.flag) || '');
    if (!['shelf', 'pinned', 'hidden'].includes(flag)) return { ok: false, error: `不认识的标记：${flag}` };
    const on = op.value !== false;
    if (id.startsWith('m-') || id.startsWith('m:')) {
      const card = store.cards.find((c) => c.id === id);
      if (!card) return { ok: false, error: `没有这张卡：${id}` };
      card.shelf = flag === 'shelf' ? on : card.shelf;
      store.updatedAt = new Date(now).toISOString();
      writeAtomic(loaded.file, prune(store, now));
      return { ok: true, op: 'flag', id, flag, value: on, data: store };
    }
    let bucket;
    let key;
    if (id.startsWith('p:')) { bucket = store.projects; key = id.slice(2); }
    else if (id.startsWith('s:')) { bucket = store.sessions; key = id.slice(2); }
    else return { ok: false, error: `这张卡不能${flag === 'shelf' ? '收纳' : '标记'}：${id}` };
    const ov = (bucket[key] ||= {});
    ov[flag] = on;
    if (bucket === store.sessions) ov.at = new Date(now).toISOString();
    if (!on) { delete ov[flag]; if (!ov.title && !ov.note && !ov.pinned && !ov.shelf && !ov.hidden) delete bucket[key]; }
    store.updatedAt = new Date(now).toISOString();
    writeAtomic(loaded.file, prune(store, now));
    return { ok: true, op: 'flag', id, flag, value: on, data: store };
  }

  if (kind === 'rename') {
    const title = clip((op && op.title) || '', MAX_TITLE);
    if (id.startsWith('s:')) {
      const ov = (store.sessions[id.slice(2)] ||= {});
      if (title) ov.title = title; else delete ov.title;
      ov.at = new Date(now).toISOString();
      store.updatedAt = new Date(now).toISOString();
      writeAtomic(loaded.file, prune(store, now));
      return { ok: true, op: 'rename', id, title, data: store };
    }
    if (id.startsWith('m-') || id.startsWith('m:')) return mutate(brainDir, { op: 'update', id, title }, now);
    if (id.startsWith('p:')) {
      const ov = (store.projects[id.slice(2)] ||= {});
      if (title) ov.title = title; else delete ov.title;
      store.updatedAt = new Date(now).toISOString();
      writeAtomic(loaded.file, prune(store, now));
      return { ok: true, op: 'rename', id, title, data: store };
    }
    return { ok: false, error: `这张卡改不了名：${id}` };
  }

  // 一次改名字和备注：会话/线的覆盖记在 cards.json，自己的卡直接改本体。
  if (kind === 'meta') {
    const title = clip((op && op.title) || '', MAX_TITLE);
    const note = clip((op && op.note) || '', MAX_NOTE);
    const steps = 'steps' in (op || {}) ? normalizeSteps(op.steps) : null;
    if (id.startsWith('s:')) {
      const ov = (store.sessions[id.slice(2)] ||= {});
      if (title) ov.title = title; else delete ov.title;
      if (note) ov.note = note; else delete ov.note;
      ov.at = new Date(now).toISOString();
    } else if (id.startsWith('p:')) {
      const ov = (store.projects[id.slice(2)] ||= {});
      if (title) ov.title = title; else delete ov.title;
      if (note) ov.note = note; else delete ov.note;
    } else {
      const card = store.cards.find((c) => c.id === id);
      if (!card) return { ok: false, error: `没有这张卡：${id}` };
      if (title) card.title = title;
      card.note = note;
      if (steps) card.steps = steps;
    }
    store.updatedAt = new Date(now).toISOString();
    writeAtomic(loaded.file, prune(store, now));
    return { ok: true, op: 'meta', id, data: store };
  }

  if (kind === 'note') {
    const note = clip((op && op.note) || '', MAX_NOTE);
    if (id.startsWith('s:')) {
      const ov = (store.sessions[id.slice(2)] ||= {});
      if (note) ov.note = note; else delete ov.note;
      ov.at = new Date(now).toISOString();
      store.updatedAt = new Date(now).toISOString();
      writeAtomic(loaded.file, prune(store, now));
      return { ok: true, op: 'note', id, note, data: store };
    }
    if (id.startsWith('m-') || id.startsWith('m:')) return mutate(brainDir, { op: 'update', id, note }, now);
    return { ok: false, error: `这张卡写不了备注：${id}` };
  }

  if (kind === 'settings') {
    if (op && 'autoCards' in op) store.settings.autoCards = op.autoCards !== false;
    if (op && 'windowHours' in op) store.settings.windowHours = Math.max(1, Math.min(168, Number(op.windowHours) || 12));
    if (op && 'maxLive' in op) store.settings.maxLive = Math.max(0, Math.min(8, Number(op.maxLive) || 0));
    store.updatedAt = new Date(now).toISOString();
    writeAtomic(loaded.file, prune(store, now));
    return { ok: true, op: 'settings', data: store };
  }

  return { ok: false, error: `不认识的 op：${kind || '(空)'}` };
}
