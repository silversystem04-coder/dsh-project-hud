/**
 * projects.js -- 把「线」的数据读成标签角要的卡片。
 *
 * 两个来源，都是人写的、都只读：
 *   brain/journal/projects.json   线名 / 颜色 / 状态 / 阶段进度 / 截止
 *   brain/线NN_xxx.md             待做（细化建议）、待定（卡点）
 *
 * 这里不推断进度：done/total 是 projects.json 里手写的数字。
 * 插件只负责把这些数字和文件里的下一句「要做的事」摆到一起，
 * 并且按截止远近给出该不该急的判断——判断的规则也写在这里，看得见。
 */

import fs from 'node:fs';
import path from 'node:path';

const STATUS_LABEL = {
  active: '进行中',
  paused: '暂停',
  done: '已完成',
  dropped: '已放弃',
};

function relDays(ms, now) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const a = new Date(ms); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  const d = Math.round((a - b) / 86400000);
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  if (d === -1) return '昨天';
  return d > 0 ? `${d} 天后` : `${-d} 天前`;
}

/** 4d20h / 13h / 40m；负数表示已过期。 */
export function humanLeft(ms) {
  if (!Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60000);
  let out;
  if (m < 60) out = `${m}m`;
  else {
    const h = Math.floor(m / 60);
    if (h < 48) out = m % 60 ? `${h}h${m % 60}m` : `${h}h`;
    else {
      const d = Math.floor(h / 24);
      out = h % 24 ? `${d}d${h % 24}h` : `${d}d`;
    }
  }
  return neg ? `已过期 ${out}` : out;
}

function ageDays(ms, now) {
  return Math.max(0, Math.round((now - ms) / 86400000));
}

// ---------------------------------------------------------------- 交接单解析
/**
 * 从 线NN_xxx.md 里取出「待做」和「待定」。
 *
 * 认的写法（brain 里现在就是这套）：
 *   **待做：**        块，后面跟若干 `- 条目 —— 做法`
 *   **待定：**        一行，冒号后面是卡点
 * 认不出来就返回空数组，不猜。
 */
export function parseLineDoc(text) {
  const lines = String(text || '').split('\n');
  const steps = [];
  const blockers = [];
  let mode = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();

    const head = /^\*\*(待做|待定|待办|下一步|建议)[:：]?\*\*/u.exec(trimmed);
    if (head) {
      mode = (head[1] === '待定') ? 'blocker' : 'steps';
      const rest = trimmed.slice(head[0].length).trim();
      if (rest) {
        if (mode === 'blocker') blockers.push(rest);
        else steps.push(splitStep(rest));
      }
      continue;
    }
    // 别的小标题/加粗段落就结束当前块
    if (/^(\*\*.+\*\*|#{1,6}\s)/u.test(trimmed) || trimmed === '---') {
      mode = null;
      continue;
    }
    if (!mode) continue;

    const bullet = /^[-*]\s+(.*)$/u.exec(trimmed);
    if (bullet) {
      if (mode === 'blocker') blockers.push(bullet[1].trim());
      else steps.push(splitStep(bullet[1]));
      continue;
    }
    const numbered = /^\d+[.、)]\s+(.*)$/u.exec(trimmed);
    if (numbered) {
      if (mode === 'blocker') blockers.push(numbered[1].trim());
      else steps.push(splitStep(numbered[1]));
      continue;
    }
    if (!trimmed) { mode = null; continue; }
  }
  return { steps, blockers };
}

/** 「条目 —— 做法」拆成主句和细化建议。也认单个长破折号。顺手去掉 ** 记号。 */
function splitStep(text) {
  const clean = (s) => String(s).replace(/\*\*/g, '').trim();
  const m = /^(.*?)\s*(?:——|—|--)\s*(.+)$/u.exec(String(text));
  if (m) return { text: clean(m[1]), detail: clean(m[2]) };
  return { text: clean(text), detail: '' };
}

/** brief 是人手写的，可能带 ** 加粗或 ~~删除线~~；卡片上不该露出记号本身。 */
function plain(text) {
  return String(text || '').replace(/\*\*/g, '').replace(/~~/g, '').trim();
}

/** 线文件按「文件名里的名字」和「正文里出现的项目名」对到项目上。 */
function linkLines(brainDir, projects) {
  let names = [];
  try {
    names = fs.readdirSync(brainDir).filter((n) => /^线\d+_.*\.md$/u.test(n));
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const file of names) {
    const abs = path.join(brainDir, file);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const head = text.split('\n').slice(0, 6).join('\n');
    let best = null;
    for (const p of projects) {
      if (!p.name) continue;
      if (head.includes(p.name)) { best = p; break; }
    }
    if (!best) {
      // 退一步：文件名里的英文/中文片段能否对上 id
      for (const p of projects) {
        if (file.toLowerCase().includes(String(p.id).toLowerCase())) { best = p; break; }
      }
    }
    if (!best || out.has(best.id)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(abs).mtimeMs; } catch { /* ignore */ }
    const parsed = parseLineDoc(text);
    out.set(best.id, { file, mtime, ...parsed });
  }
  return out;
}

// --------------------------------------------------------------------- 读数据
export function projectsFile(brainDir) {
  return path.join(brainDir, 'journal', 'projects.json');
}

export function readProjectRegistry(brainDir) {
  const file = projectsFile(brainDir);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, file, error: `读不到 ${file}：${error.message}`, projects: [] };
  }
  const list = Array.isArray(json.projects) ? json.projects : [];
  const projects = list.map((p) => ({
    id: String(p.id || ''),
    name: String(p.name || p.id || ''),
    color: String(p.color || '#8d8d8d'),
    status: ['active', 'paused', 'done', 'dropped'].includes(p.status) ? p.status : 'active',
    brief: plain(p.brief),
    keywords: Array.isArray(p.keywords) ? p.keywords.map(String) : [],
    deadlines: (Array.isArray(p.deadlines) ? p.deadlines : [])
      .map((d) => ({ at: String((d && d.at) || ''), label: String((d && d.label) || '') }))
      .filter((d) => d.at && Number.isFinite(Date.parse(d.at)))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    stage: {
      done: Number((p.stage && p.stage.done) || 0),
      total: Number((p.stage && p.stage.total) || 0),
      unit: String((p.stage && p.stage.unit) || ''),
      note: String((p.stage && p.stage.note) || ''),
      updatedAt: String((p.stage && p.stage.updatedAt) || ''),
    },
  })).filter((p) => p.id);
  return { ok: true, file, updatedAt: json.updatedAt || null, projects };
}

/** 给一张卡算「该不该急」和「下一步」。规则全在这里，一眼能看完。 */
function buildAdvice(card, now) {
  const out = [];
  const next = card.deadlines.find((d) => d.msLeft > 0) || null;

  if (next) {
    if (next.msLeft < 72 * 3600000 && card.stage.total > 0 && card.stage.done === 0) {
      out.push({ kind: 'urgent', text: `离「${next.label}」还剩 ${humanLeft(next.msLeft)}，一步没动 —— 这周只做这一件。` });
    } else if (next.msLeft < 72 * 3600000) {
      out.push({ kind: 'urgent', text: `离「${next.label}」还剩 ${humanLeft(next.msLeft)}，收尾优先。` });
    } else if (next.msLeft < 7 * 86400000) {
      out.push({ kind: 'warn', text: `「${next.label}」还有 ${humanLeft(next.msLeft)}。` });
    }
  }
  if (card.stage.total > 0 && card.stage.done >= card.stage.total) {
    out.push({ kind: 'ok', text: '这一步已经做完了 —— 去 projects.json 加下一件，别让它空转。' });
  }
  if (card.stage.total === 0) {
    out.push({ kind: 'idle', text: '这条线没排期：定一个 ≤2 周能交的东西，写进 stage.total。' });
  }
  if (card.status === 'paused' && !next) {
    out.push({ kind: 'idle', text: '停着：要么定个日子恢复，要么划掉。挂着比放弃更耗人。' });
  }
  if (card.blockedBy.length) {
    out.push({ kind: 'block', text: `卡在：${card.blockedBy[0]}` });
  }
  // 不再重复「下一步」：卡片上方已经有「到这一步」那一行了，这里只说要注意的。
  if (card.idleDays >= 3) {
    out.push({ kind: 'idle', text: `${card.idleDays} 天没碰交接单了。` });
  }
  if (!card.file && card.status === 'active') {
    out.push({ kind: 'idle', text: '没有交接单：开一张 线NN_<名字>.md，把下一步一句话写死。' });
  }
  return out;
}

/**
 * @param {string} brainDir
 * @param {{ now?: number, maxTabs?: number }} [opts]
 */
export function readCards(brainDir, opts = {}) {
  const now = opts.now || Date.now();
  const maxTabs = Number.isFinite(opts.maxTabs) ? opts.maxTabs : 7;
  const reg = readProjectRegistry(brainDir);
  if (!reg.ok) {
    return { ok: false, error: reg.error, generatedAt: now, cards: [], hidden: [], counts: {} };
  }
  const linked = linkLines(brainDir, reg.projects);

  const cards = reg.projects.map((p) => {
    const line = linked.get(p.id) || null;
    const stage = {
      ...p.stage,
      pct: p.stage.total > 0 ? Math.min(1, p.stage.done / p.stage.total) : 0,
      planned: p.stage.total > 0,
    };
    const deadlines = p.deadlines.map((d) => {
      const msLeft = Date.parse(d.at) - now;
      return {
        at: d.at,
        label: d.label,
        msLeft,
        humanLeft: humanLeft(msLeft),
        humanAt: relDays(Date.parse(d.at), now),
        overdue: msLeft < 0,
        urgent: msLeft >= 0 && msLeft < 72 * 3600000,
      };
    });
    const card = {
      id: p.id,
      name: p.name,
      color: p.color,
      status: p.status,
      statusLabel: STATUS_LABEL[p.status] || p.status,
      brief: plain(p.brief),
      // 会话归线要用这串词，带出去，别让 board.js 再读一遍 projects.json。
      keywords: p.keywords,
      stage,
      deadlines,
      file: line ? line.file : '',
      steps: line ? line.steps : [],
      blockedBy: line ? line.blockers : [],
      idleDays: line && line.mtime ? ageDays(line.mtime, now) : null,
      lineTouchedAt: line && line.mtime ? line.mtime : null,
      updatedAt: p.stage.updatedAt || null,
    };
    card.nextStep = card.steps.length ? card.steps[0].text : (card.stage.note || '');
    card.nextDetail = card.steps.length ? card.steps[0].detail : '';
    // 后面的条目单独给出去：卡上「到这一步」已经写了第一条，不再重复。
    card.laterSteps = card.steps.slice(1);
    card.advice = buildAdvice(card, now);
    // 排序用的紧急度：有未来截止的按截止排，没有的排后面。
    const nextDl = deadlines.find((d) => !d.overdue) || null;
    card.urgencyMs = nextDl ? nextDl.msLeft : Number.POSITIVE_INFINITY;
    return card;
  });

  // 标签顺序：先按急（有未来截止的在前），同档「有排期 > 有交接单待做 > 都没有」，最后按名字。
  const planRank = (c) => (c.stage.planned ? 0 : (c.steps.length ? 1 : 2));
  const sorted = cards.filter((c) => c.id !== 'other' && c.status === 'active').sort((a, b) => {
    if (a.urgencyMs !== b.urgencyMs) return a.urgencyMs - b.urgencyMs;
    const r = planRank(a) - planRank(b);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name, 'zh');
  });
  const paused = cards.filter((c) => c.status === 'paused');
  const rest = sorted.slice(maxTabs).concat(cards.filter((c) => c.status === 'done' || c.status === 'dropped'));

  const shown = sorted.slice(0, maxTabs);
  const hidden = rest.concat(paused, cards.filter((c) => c.id === 'other'));

  const counts = { active: 0, paused: 0, done: 0, dropped: 0 };
  for (const c of cards) counts[c.status] = (counts[c.status] || 0) + 1;

  return {
    ok: true,
    generatedAt: now,
    registry: reg.file,
    registryUpdatedAt: reg.updatedAt,
    cards: shown,
    paused,
    rest,
    hidden,
    counts,
    total: cards.length,
  };
}
