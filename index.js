/**
 * dsh-project-hud -- 窗口最上方的一排标签角。
 *
 * 鼠标停在某个角上，往下弹一张卡：这条线在干什么、进度几比几、进度条、
 * 卡在哪一步、以及交接单里写死的下一步和细化建议。
 *
 * 2026-11-08 起多了一层：**会话卡**。
 * 盘上哪个会话在读模型缓存里刚被改过，就说明它正在跑；把它变成一张卡自动挂上来，
 * 显示它跑到第几回合、这一步在干什么、上下文用了多少。会话停了卡自己消失，
 * 除非你手动「固定」。自己加的卡、改名、收纳、删除都写进 brain/journal/cards.json。
 *
 * 三半：
 *   - projects.json + 线NN_*.md → 线卡（人维护）
 *   - 会话投影缓存              → 会话卡（自动、秒级）
 *   - cards.json                → 人改的那一层（新增/改名/收纳/删除）
 * client（lib/client.js）是手写 ModuleLoader bundle，挂在 shell.overlay 上（帧级浮层）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBoard } from './lib/board.js';
import { mutate } from './lib/store.js';

export const name = 'project-hud';

/**
 * 2026-11-04 事故之后改的两件事，都是为了「别静默消失」：
 * 1. 去掉 `@deepseek-ai/schemastery` 的硬 import（它在 profile 的解析里拿不到时，
 *    整个 index.js import 失败，Loader 里这条记录直接消失，面板和工具一起没有）。
 *    默认值写死在 DEFAULTS，patch 的 config 照旧覆盖。
 * 2. 声明 `inject = ['webServer']`：apply() 早于 webServer 就绪时路由会静默不注册，
 *    面板只能显示「读不到数据」。声明依赖后 cordis 会等服务到位再调 apply。
 */
export const inject = ['webServer'];

/** 手改；出现在 /ping 里，好判断模块缓存是不是旧的。 */
const BUILD = '0.3.0+20261109';

const PREFIX = '/project-hud';
const MAX_BODY = 128 * 1024;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

const DEFAULTS = {
  // 空 = <cwd>/brain —— 面板自己不带数据，指向哪条线由 patch 里配
  brainDir: '',
  // 空 = <DSH_HOME>/storages/session_projcache/sessions
  cacheDir: '',
  maxTabs: 5,
  maxLive: 3,
  windowHours: 12,
  // 会话状态变得快，缓存时间短一点；点一下「收纳」会立刻失效重建。
  cacheMs: 2000,
};

// 没有 Config schema：loader 会把 patch 里的 config 原样传给 apply（time-sense 同样）。

function isLoopback(req) {
  const addr = String((req.socket && (req.socket.remoteAddress || '')) || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function siteAllowed(req) {
  const site = String((req.headers && req.headers['sec-fetch-site']) || '');
  if (site === '') return true;
  return site === 'same-origin' || site === 'none';
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  // brainDir 没配就找 <cwd>/brain；那条线不存在也只是没有线卡，不影响会话卡。
  cfg.brainDir = cfg.brainDir || path.join(process.cwd(), 'brain');
  const cacheDir = cfg.cacheDir || path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
  const log = (msg) => {
    try { ctx.logger?.info?.(msg); } catch { /* ignore */ }
    try { process.stderr.write(msg + '\n'); } catch { /* ignore */ }
  };

  let cacheAt = 0;
  let cacheVal = null;
  const board = (fresh) => {
    const now = Date.now();
    if (!fresh && cacheVal && now - cacheAt < (Number(cfg.cacheMs) || 0)) return cacheVal;
    cacheVal = readBoard({
      brainDir: cfg.brainDir,
      cacheDir,
      maxTabs: Number(cfg.maxTabs) || 5,
      maxLive: Number(cfg.maxLive) || 0,
      windowHours: Number(cfg.windowHours) || 12,
      build: BUILD,
    });
    cacheAt = now;
    return cacheVal;
  };

  // inject 声明过 webServer，正常情况下这里一定有；两个来源都看，是因为
  // 不同 cordis 版本把服务挂在 ctx 上还是只能 ctx.get 拿到。
  const webServer = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined);
  if (!webServer || typeof webServer.register !== 'function') {
    log('[project-hud] 没有 webServer，标签角不会出现');
  } else {
    const handler = async (req, res) => {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { send(res, 400, { error: 'bad url' }); return; }
      const p = url.pathname;
      try {
        if (!isLoopback(req)) { send(res, 403, { error: 'loopback only' }); return; }
        if (!siteAllowed(req)) { send(res, 403, { error: 'cross-site refused' }); return; }

        if (p === PREFIX + '/api/ping') {
          if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return; }
          send(res, 200, {
            ok: true,
            build: BUILD,
            brainDir: cfg.brainDir,
            cacheDir,
            registryExists: fs.existsSync(path.join(cfg.brainDir, 'journal', 'projects.json')),
            storeExists: fs.existsSync(path.join(cfg.brainDir, 'journal', 'cards.json')),
            cacheDirExists: fs.existsSync(cacheDir),
          });
          return;
        }

        if (p === PREFIX + '/api/cards') {
          if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return; }
          const fresh = url.searchParams.get('fresh') === '1';
          send(res, 200, board(fresh));
          return;
        }

        // 唯一会写盘的入口。三道门：loopback、同源、自定义请求头。
        // 自定义头让「别的网页偷偷发一个 form 请求」不可能成立：跨源带这个头要先过 preflight，
        // 而 preflight 也会打到 isLoopback/siteAllowed 上被挡下来（我们对 OPTIONS 一律 405）。
        if (p === PREFIX + '/api/mutate') {
          if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return; }
          if (String(req.headers['x-project-hud'] || '') !== '1') { send(res, 403, { error: 'missing header' }); return; }
          if (!/^application\/json/i.test(String(req.headers['content-type'] || ''))) {
            send(res, 415, { error: 'application/json required' }); return;
          }
          let op;
          try {
            op = JSON.parse(await readBody(req, MAX_BODY));
          } catch (error) {
            send(res, 400, { error: `bad body: ${error.message}` });
            return;
          }
          const result = mutate(cfg.brainDir, op || {});
          if (!result.ok) { send(res, 400, result); return; }
          cacheAt = 0;
          cacheVal = null;
          send(res, 200, { ok: true, op: result.op, id: result.id || null, board: board(true) });
          return;
        }

        send(res, 404, { error: 'no route', path: p });
      } catch (error) {
        try { send(res, 500, { error: String((error && error.message) || error) }); } catch { /* ignore */ }
      }
    };

    try {
      const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler });
      ctx.effect?.(() => dispose, 'project-hud: http routes');
      const port = webServer.port;
      if (port) log(`[project-hud] tabs API on http://127.0.0.1:${port}${PREFIX}/api/cards`);
    } catch (error) {
      log(`[project-hud] webServer 注册失败: ${error.message}`);
    }
  }

  // 会话里也能问一句：「我这些线到哪了」「哪些会话在跑」
  import('@deepseek-ai/dsh-tools').then(({ defineTool }) => {
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') return;
    tools.register(defineTool({
      name: 'project_hud',
      description:
        '项目标签角的数据：每条线（职鱼/衣鱼/广接…）的状态、阶段进度 done/total、'
        + '最近截止倒计时、交接单里写明的下一步与待做、该怎么推；'
        + 'action=sessions 还能看现在哪些会话在跑、跑到哪一步。'
        + ' / Read-only snapshot of the project lines, plus live session progress.',
      parameters: {
        action: { type: 'string', required: true, description: 'lines | line | sessions' },
        id: { type: 'string', description: 'action=line 时的线 id，例如 zhiye / yiyu' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async (args) => {
        const data = board(false);
        if (!data.ok) return `读不到：${data.error}`;
        const action = String(args?.action || 'lines').toLowerCase();

        if (action === 'sessions') {
          const rows = data.strip.filter((c) => c.kind === 'session')
            .concat(data.idleSessions || []);
          if (!rows.length) return '最近没有活着的会话。';
          const out = [`${data.live.busy} 个会话在跑 / 最近 ${data.live.total} 个`];
          for (const s of rows) {
            out.push('', `${s.busy ? '▶' : '·'} ${s.name}（${s.humanIdle}）`);
            out.push(`  第 ${s.turns} 回合 · 上下文 ${Math.round(s.tokens.pct * 100)}%`);
            if (s.currentStep) out.push(`  这一步：${s.currentStep}`);
            if (s.link) out.push(`  归到：${s.link.name}`);
          }
          return out.join('\n');
        }

        if (action === 'line') {
          const id = String(args?.id || '');
          const card = [...data.strip, ...data.shelf, ...(data.paused || []), ...(data.rest || [])]
            .find((c) => c.kind !== 'session' && (c.id === id || c.name === id));
          if (!card) return `没有这条线：${id}`;
          const lines = [
            `${card.name}（${card.statusLabel}）`,
            card.brief,
            `进度：${card.stage.done} / ${card.stage.total || '—'} ${card.stage.unit}`
              + (card.stage.note ? `（${card.stage.note}）` : ''),
          ];
          for (const d of card.deadlines) lines.push(`截止：${d.label} · ${d.humanAt}（${d.humanLeft}）`);
          if (card.nextStep) lines.push(`到这一步：${card.nextStep}`);
          if (card.steps.length) {
            lines.push('', '待做：');
            for (const s of card.steps) lines.push(`  - ${s.text}${s.detail ? ' —— ' + s.detail : ''}`);
          }
          if (card.blockedBy.length) lines.push('', '待定：', ...card.blockedBy.map((b) => `  - ${b}`));
          if (card.live && card.live.count) {
            lines.push('', `在跑的会话：${card.live.count} 个（${card.live.names.join(' / ')}）`);
          }
          if (card.advice.length) {
            lines.push('', '建议：');
            for (const a of card.advice) lines.push(`  - ${a.text}`);
          }
          return lines.join('\n');
        }

        const out = [`${data.counts.busy} 个会话在跑 · 上排 ${data.counts.strip} 张卡 · 收纳 ${data.counts.shelf}`];
        if (data.strip.some((c) => c.kind === 'session')) {
          out.push('', '在跑的会话：');
          for (const s of data.strip.filter((c) => c.kind === 'session')) {
            out.push(`  - ${s.name}（第 ${s.turns} 回合，${s.humanIdle}）${s.currentStep ? '：' + s.currentStep : ''}`);
          }
        }
        out.push('', '线：');
        for (const card of data.strip.filter((c) => c.kind !== 'session')) {
          const dl = card.deadlines[0];
          out.push(`  - ${card.name}（${card.statusLabel}）${card.stage.total ? ` ${card.stage.done}/${card.stage.total}` : ' 未排期'}`
            + (dl ? ` · 截止 ${dl.humanLeft}` : ''));
          if (card.nextStep) out.push(`      ${card.nextStep}`);
        }
        const others = (data.paused || []).concat(data.rest || []);
        if (others.length) {
          out.push('', `其余 ${others.length} 条：` + others.map((c) => c.name).join('、'));
        }
        if ((data.shelf || []).length) {
          out.push('', `收纳里 ${data.shelf.length} 张：` + data.shelf.map((c) => c.name).join('、'));
        }
        return out.join('\n');
      },
    }));
  }).catch((error) => {
    log(`[project-hud] 工具没注册上: ${error && error.message}`);
  });

  log(`[project-hud] ${BUILD} ready (brain=${cfg.brainDir}, sessions=${cacheDir})`);
}
