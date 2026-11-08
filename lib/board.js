/**
 * board.js -- 把三份东西拼成一次要给浏览器的数据：
 *   1. projects.json + 线NN_*.md  → 线卡（人维护，慢变）
 *   2. 会话投影缓存               → 会话卡（DSH 自己刷新，秒级变）
 *   3. cards.json                 → 人改过的那一层（自己加的卡、收纳、改名、删掉）
 *
 * 「自动添加卡片，并根据会话里提取的信息丰富内容」就是第 2 步：
 * 不落盘、不去 projects.json 里写新线，只是每次读的时候把活着的会话变成卡。
 * 会话结束后卡自己消失（除非被「固定」过 —— 那就写进 cards.json 的 sessions）。
 */
import { readCards } from './projects.js';
import { readLiveSessions } from './live.js';
import { loadStore, storeFile } from './store.js';

const SESSION_COLOR = '#4b8bf5';
const MANUAL_COLOR = '#8b5cf6';

export function humanIdle(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 45000) return '刚刚';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.round(hour / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  return `${Math.round(day / 30)} 个月前`;
}

/**
 * 会话归到哪条线：拿线的 keywords 去会话标题 + 当前步骤里找。
 * 只认命中，找不到就是没有 —— 宁可多一张会话卡，也不硬塞进某条线。
 */
export function matchProject(session, projects) {
  const hay = `${session.title} ${session.currentStep} ${session.lastResponse}`.toLowerCase();
  if (!hay.trim()) return null;
  let best = null;
  for (const p of projects) {
    const kws = Array.isArray(p.keywords) ? p.keywords.slice() : [];
    if (p.name) kws.push(p.name);
    for (const kw of kws) {
      const k = String(kw || '').toLowerCase().trim();
      if (k.length < 2) continue;
      if (!hay.includes(k)) continue;
      const score = k.length;
      if (!best || score > best.score) best = { project: p, score, keyword: k };
    }
  }
  return best;
}

function shortName(s, max) {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/**
 * @param {{ brainDir: string, cacheDir: string, now?: number, maxTabs?: number,
 *           windowHours?: number, maxLive?: number }} opts
 */
export function readBoard(opts) {
  const now = opts.now || Date.now();
  const store = loadStore(opts.brainDir);
  const data = store.data;
  const windowHours = Number(opts.windowHours) || data.settings.windowHours || 12;
  const maxLive = Number.isFinite(opts.maxLive) ? opts.maxLive : data.settings.maxLive;
  const maxTabs = Number.isFinite(opts.maxTabs) ? opts.maxTabs : 5;

  const base = readCards(opts.brainDir, { now, maxTabs: 999 });
  // 没有 brain/journal/projects.json 不算坏掉：会话卡和手写卡照样能用，
  // 只是没有线卡。真正的错误（JSON 坏了）仍然照实报出来。
  const missingRegistry = !base.ok && /ENOENT/.test(String(base.error || ''));
  const projects = base.ok ? base.cards.concat(base.paused || [], base.rest || []) : [];
  const live = readLiveSessions(opts.cacheDir, { now, windowMs: windowHours * 3600000 });

  // ---- 会话 → 会话卡（自动那些）
  const liveByProject = new Map();
  const sessionCards = [];
  for (const s of live.sessions) {
    const ov = data.sessions[s.id] || {};
    if (ov.hidden) continue;
    // 关掉自动会话卡之后，只剩你固定过 / 收进收纳的。
    if (data.settings.autoCards === false && !ov.pinned && !ov.shelf) continue;
    const match = matchProject(s, projects);
    if (match) {
      const entry = liveByProject.get(match.project.id) || { count: 0, busy: 0, names: [], items: [], keyword: match.keyword };
      entry.count += 1;
      if (s.busy) entry.busy += 1;
      entry.names.push(s.title);
      // 线卡上不只报「有几个在跑」，还要能看到跑到哪一步了。
      entry.items.push({
        id: s.id,
        title: s.title,
        busy: s.busy,
        currentStep: s.currentStep,
        currentKind: s.currentKind,
        turns: s.turns,
        steps: s.steps,
        humanIdle: s.humanIdle,
      });
      liveByProject.set(match.project.id, entry);
    }
    sessionCards.push({
      kind: 'session',
      id: 's:' + s.id,
      sid: s.id,
      name: ov.title || shortName(s.title, 22),
      color: SESSION_COLOR,
      busy: s.busy,
      pinned: !!ov.pinned,
      shelf: !!ov.shelf,
      note: ov.note || '',
      title: s.title,
      turns: s.turns,
      steps: s.steps,
      openStep: s.openStep,
      currentStep: s.currentStep,
      currentKind: s.currentKind,
      lastResponse: s.lastResponse,
      idleMs: s.idleMs,
      humanIdle: humanIdle(s.idleMs),
      tokens: s.tokens,
      model: s.model,
      link: match ? { id: match.project.id, name: match.project.name, color: match.project.color } : null,
    });
  }

  // ---- 线 → 线卡
  const projectCards = [];
  for (const p of projects) {
    if (p.id === 'other') continue;
    const ov = data.projects[p.id] || {};
    if (ov.hidden) continue;
    const liveInfo = liveByProject.get(p.id) || null;
    projectCards.push({
      ...p,
      kind: 'project',
      id: 'p:' + p.id,
      pid: p.id,
      shelf: !!ov.shelf,
      name: ov.title || p.name,
      note: ov.note || '',
      live: liveInfo
        ? {
          count: liveInfo.count,
          busy: liveInfo.busy,
          names: liveInfo.names.slice(0, 3),
          items: liveInfo.items.slice(0, 3),
          keyword: liveInfo.keyword,
        }
        : null,
    });
  }

  // ---- 人自己加的卡
  const manualCards = data.cards.map((c) => ({
    kind: 'manual',
    id: c.id,
    name: c.title,
    color: c.color || MANUAL_COLOR,
    note: c.note || '',
    steps: c.steps || [],
    shelf: !!c.shelf,
    createdAt: c.createdAt,
  }));

  // ---- 上排：在跑的会话 → 线（按旧的紧急度排序）→ 自己加的卡
  const busySessions = sessionCards.filter((c) => c.busy && !c.shelf);
  const pinnedSessions = sessionCards.filter((c) => c.pinned && !c.shelf && !c.busy);
  const shownSessions = busySessions.slice(0, Math.max(0, maxLive)).concat(pinnedSessions);

  // 有会话正在跑的线往前挪：正在干活的那条线不该排到「5 张之外」。
  const activeProjects = projectCards.filter((c) => !c.shelf && c.status === 'active');
  const hotProjects = activeProjects.filter((c) => c.live && c.live.busy);
  const coldProjects = activeProjects.filter((c) => !(c.live && c.live.busy));
  const orderedProjects = hotProjects.concat(coldProjects);
  const shownProjects = orderedProjects.slice(0, maxTabs);
  const shownManual = manualCards.filter((c) => !c.shelf);

  const strip = [...shownSessions, ...shownProjects, ...shownManual];

  const shelf = [
    ...sessionCards.filter((c) => c.shelf),
    ...projectCards.filter((c) => c.shelf),
    ...manualCards.filter((c) => c.shelf),
  ];

  const paused = projectCards.filter((c) => !c.shelf && c.status === 'paused');
  const rest = projectCards.filter((c) => !c.shelf && c.status !== 'active' && c.status !== 'paused')
    .concat(orderedProjects.slice(maxTabs));
  const idleSessions = sessionCards.filter((c) => !c.shelf && !c.pinned && !c.busy);

  return {
    ok: base.ok || missingRegistry,
    error: base.ok ? (store.ok ? null : store.error) : (missingRegistry ? null : base.error),
    notice: missingRegistry
      ? '还没建 brain/journal/projects.json —— 现在只有会话卡和手写卡'
      : null,
    generatedAt: now,
    build: opts.build || '',
    registry: base.registry || null,
    registryUpdatedAt: base.registryUpdatedAt || null,
    storeFile: storeFile(opts.brainDir),
    storeExists: !!store.exists,
    settings: data.settings,
    windowHours,
    live: { ok: live.ok, total: live.total || 0, busy: live.busy || 0, dir: live.dir },
    strip,
    shelf,
    paused,
    rest,
    idleSessions,
    counts: {
      strip: strip.length,
      busy: busySessions.length,
      sessions: sessionCards.length,
      projects: projectCards.length,
      manual: manualCards.length,
      shelf: shelf.length,
    },
    total: projectCards.length + manualCards.length + sessionCards.length,
  };
}
