/**
 * test/http-check.mjs -- 不开 DSH，把 host 半边自己跑起来打真 HTTP。
 *
 * 用的是一份临时的 brain 目录（复制一份 projects.json 进去），所以 POST /api/mutate
 * 写的是沙箱里的 cards.json，不会动真的 brain/journal。
 *
 *   node test/http-check.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REAL_BRAIN = process.argv[2] || path.join(
  'C:\\Users\\Lenovo\\Documents\\deepseek-harness\\default-workspace', 'brain',
);

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  PASS', name); pass += 1; } catch (e) { console.log('  FAIL', name, '->', e.message); fail += 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---- 沙箱 brain：projects.json 照抄，cards.json 不存在
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-http-'));
fs.mkdirSync(path.join(sandbox, 'journal'), { recursive: true });
fs.copyFileSync(path.join(REAL_BRAIN, 'journal', 'projects.json'), path.join(sandbox, 'journal', 'projects.json'));
const storePath = path.join(sandbox, 'journal', 'cards.json');

// ---- 假 ctx：只提供 webServer.register
const captured = {};
const ctx = {
  webServer: {
    register(spec) { captured.spec = spec; return () => {}; },
  },
  get() { return undefined; },
};

await apply(ctx, { brainDir: sandbox, cacheMs: 0 });
ok('注册了 prefix 路由', () => {
  assert(captured.spec, '没有 register');
  assert(captured.spec.kind === 'prefix', 'kind 不是 prefix');
  assert(captured.spec.path === '/project-tabs', 'path 不对：' + captured.spec.path);
});

const server = http.createServer((req, res) => captured.spec.handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/project-tabs/api`;

async function call(pathname, init) {
  const res = await fetch(base + pathname, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
const H = { 'x-project-tabs': '1' };
const J = { ...H, 'content-type': 'application/json' };

const ping = await call('/ping', { headers: H });
ok('GET /ping', () => {
  assert(ping.status === 200, 'status ' + ping.status);
  assert(ping.body.ok === true);
  assert(/^0\.2\./.test(ping.body.build), 'build 还是旧的：' + ping.body.build);
  assert(ping.body.storeExists === false, '沙箱里不该有 cards.json');
});

const cards = await call('/cards', { headers: H });
ok('GET /cards 返回拼板', () => {
  assert(cards.status === 200, 'status ' + cards.status);
  assert(cards.body.ok === true, JSON.stringify(cards.body.error));
  assert(Array.isArray(cards.body.strip), '没有 strip');
  assert(cards.body.strip.length > 0, '条带是空的');
  for (const c of cards.body.strip) assert(c.id && c.kind, '卡缺 id/kind');
});

const added = await call('/mutate', {
  method: 'POST', headers: J, body: JSON.stringify({ op: 'add', title: '沙箱测试卡', note: '来自 http-check' }),
});
ok('POST /mutate 新增', () => {
  assert(added.status === 200, 'status ' + added.status);
  assert(added.body.ok === true, JSON.stringify(added.body));
  assert(/^m-/.test(added.body.id), '没有回 id');
  assert(added.body.board.strip.some((c) => c.id === added.body.id), '新卡没进条带');
  assert(fs.existsSync(storePath), 'cards.json 没落盘');
});

ok('新增的卡真写进了 cards.json', () => {
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert(store.cards.length === 1, 'cards ' + store.cards.length);
  assert(store.cards[0].title === '沙箱测试卡', store.cards[0].title);
});

const noHeader = await call('/mutate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"op":"add"}' });
ok('缺 x-project-tabs 头被拒', () => assert(noHeader.status === 403, 'status ' + noHeader.status));

const badType = await call('/mutate', { method: 'POST', headers: H, body: '{"op":"add"}' });
ok('非 JSON content-type 被拒', () => assert(badType.status === 415, 'status ' + badType.status));

const badBody = await call('/mutate', { method: 'POST', headers: J, body: '{ 不是 json' });
ok('坏 body 被拒', () => assert(badBody.status === 400, 'status ' + badBody.status));

const getMutate = await call('/mutate', { headers: H });
ok('GET /mutate 被拒', () => assert(getMutate.status === 405, 'status ' + getMutate.status));

const shelf = await call('/mutate', {
  method: 'POST', headers: J, body: JSON.stringify({ op: 'flag', id: added.body.id, flag: 'shelf', value: true }),
});
ok('收纳后进 shelf、离条带', () => {
  assert(shelf.status === 200, 'status ' + shelf.status);
  assert(shelf.body.board.shelf.some((c) => c.id === added.body.id), '没进收纳');
  assert(!shelf.body.board.strip.some((c) => c.id === added.body.id), '还在条带里');
});

const removed = await call('/mutate', {
  method: 'POST', headers: J, body: JSON.stringify({ op: 'remove', id: added.body.id }),
});
ok('删除', () => {
  assert(removed.status === 200, 'status ' + removed.status);
  assert(!removed.body.board.shelf.some((c) => c.id === added.body.id), '还在收纳里');
});

const crossSite = await call('/cards', { headers: { ...H, 'sec-fetch-site': 'cross-site' } });
ok('跨站请求被拒', () => assert(crossSite.status === 403, 'status ' + crossSite.status));

server.close();
fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${pass} 项通过，${fail} 项失败`);
if (fail) process.exitCode = 1;
