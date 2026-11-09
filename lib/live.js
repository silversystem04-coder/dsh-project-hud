/**
 * live.js -- 会话的「现在」。
 *
 * 数据只来自读模型缓存：~/.dsh/storages/session_projcache/sessions/session-<uuid>.json。
 * 那是 DSH 自己每隔几步就刷新的投影（version 7 的 rows 结构），比解会话日志便宜得多
 * —— 日志是 24MB 的多帧 zstd，一次解不开也读不完。
 *
 * 「在跑」怎么判断：这个缓存**文件**的最后修改时间。DSH 每推进一步都会重写它，
 * 所以 mtime 在 2 分钟内的就是正开着的会话。不去猜内部状态，只看盘上的事实。
 *
 * 只读。不写任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 缓存文件在这个时间内被改过 = 这个会话正在跑。 */
export const BUSY_MS = 120000;

function val(rows, name) {
  const entry = rows && rows[name];
  if (entry && typeof entry === 'object' && 'val' in entry) return entry.val;
  return entry;
}

function text(s, max) {
  const flat = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + '…';
}

/** 第一行就够当「这一步在干什么」，提示词后面常常是很长的正文。 */
function firstLine(s, max) {
  const line = String(s == null ? '' : s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
  return text(line, max);
}

export function sessionIdFromFile(name) {
  return name.replace(/^session-/, '').replace(/\.json$/, '');
}

export function defaultCacheDir(home) {
  return path.join(home || '', '.dsh', 'storages', 'session_projcache', 'sessions');
}

/** 把一个缓存文件读成一张「会话卡」的原料。字段缺失一律给默认值，不抛。 */
export function readSessionCache(id, file, mtimeMs, now, busyMs) {
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const rows = (json && json.record && json.record.rows) || {};
  const stats = val(rows, 'sessionStats') || {};
  const pressure = val(rows, 'contextPressure') || {};
  const outline = val(rows, 'turnOutline') || {};
  const turns = Array.isArray(outline.turns) ? outline.turns : [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const meta = val(rows, 'sessionListMetadata') || {};
  const identity = (json && json.record && json.record.identity) || {};
  const model = (val(rows, 'modelSelection') || {}).lastUsed || null;
  const openStep = stats.openStep || null;

  const used = Number(pressure.pressureTokens) || 0;
  const windowTokens = Number(pressure.contextWindow) || 0;
  const idleMs = Math.max(0, now - Number(mtimeMs || 0));

  // 当前步骤：有「正在走的这一步」就说第几回合第几步；否则退回最后一条**非空**用户输入。
  // 最后一轮偶尔 prompt 为空（续轮 / 只跑了工具），别把它当成「没有步骤」，往前找一条。
  const lastAsked = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i] && firstLine(turns[i].prompt, 200)) return turns[i];
    }
    return null;
  })();
  let currentStep = '';
  let currentKind = 'prompt';
  if (openStep) {
    currentStep = `第 ${Number(openStep.turn) || '?'} 回合 · 第 ${Number(openStep.step) || '?'} 步`;
    currentKind = 'step';
    if (lastAsked) currentStep += '：' + firstLine(lastAsked.prompt, 46);
  } else if (lastAsked) {
    currentStep = firstLine(lastAsked.prompt, 60);
  } else {
    // 定时会话 / 系统触发的会话在缓存里没有 prompt，退而用它刚做完的事。
    currentStep = firstLine(lastTurn && lastTurn.response, 60);
    currentKind = 'response';
  }

  return {
    id,
    title: text(val(rows, 'title') || val(rows, 'titleInput') && (val(rows, 'titleInput').first || {}).text || '未命名会话', 28),
    turns: Number(stats.turns) || turns.length,
    steps: Number(stats.steps) || 0,
    openStep: openStep ? { turn: Number(openStep.turn) || 0, step: Number(openStep.step) || 0 } : null,
    currentStep,
    currentKind,
    lastResponse: firstLine(lastTurn && lastTurn.response, 80),
    lastPromptAt: Number(meta.lastPromptAt) || null,
    idleMs,
    busy: idleMs < (busyMs || BUSY_MS),
    tokens: { used, window: windowTokens, pct: windowTokens > 0 ? Math.min(1, used / windowTokens) : 0 },
    model: model ? String(model.model || '') : '',
    cwd: String(identity.cwd || ''),
    blank: !!(meta.blank),
  };
}

/**
 * 最近 windowMs 内动过的会话，正在跑的排前面。
 * @param {string} cacheDir
 * @param {{ now?: number, windowMs?: number, busyMs?: number, limit?: number }} [opts]
 */
export function readLiveSessions(cacheDir, opts = {}) {
  const now = opts.now || Date.now();
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : 12 * 3600000;
  const busyMs = Number.isFinite(opts.busyMs) ? opts.busyMs : BUSY_MS;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 40;

  let names;
  try { names = fs.readdirSync(cacheDir); } catch (error) {
    return { ok: false, error: `读不到会话缓存：${error.message}`, dir: cacheDir, sessions: [] };
  }

  const all = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const file = path.join(cacheDir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (now - st.mtimeMs > windowMs) continue;
    const one = readSessionCache(sessionIdFromFile(name), file, st.mtimeMs, now, busyMs);
    if (!one || one.blank) continue;
    all.push(one);
  }
  all.sort((a, b) => (Number(b.busy) - Number(a.busy)) || (a.idleMs - b.idleMs));

  return {
    ok: true,
    dir: cacheDir,
    total: all.length,
    busy: all.filter((s) => s.busy).length,
    sessions: all.slice(0, limit),
  };
}
