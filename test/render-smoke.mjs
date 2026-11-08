/**
 * test/render-smoke.mjs -- 在 node 里用假 React 渲染客户端组件。
 *
 * 抓的是浏览器里最烦的那类错：某个数组是 undefined、某个 style 是 NaN、
 * 渲染出 "undefined" 字样。不跑 effect，所以只测无数据也能画的那些。
 *
 *   node test/render-smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCards } from '../lib/projects.js';
import { readBoard } from '../lib/board.js';
import { defaultCacheDir } from '../lib/live.js';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BUNDLE = path.join(HERE, '..', 'lib', 'client.js');
const BRAIN = process.argv[2] || path.join(
  'C:\\Users\\Lenovo\\Documents\\deepseek-harness\\default-workspace', 'brain',
);

function createElement(type, props, ...children) {
  const flat = [];
  const push = (c) => {
    if (Array.isArray(c)) c.forEach(push);
    else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c);
  };
  children.forEach(push);
  // 真 React 把 children 也放进 props.children；组件（比如 Chip）会读它，
  // 假 React 不补这一步的话那类组件会渲染成空，测试就成了漏网。
  const p = Object.assign({}, props || {});
  if (flat.length) p.children = flat.length === 1 ? flat[0] : flat;
  return { type, props: p, children: flat, key: props && props.key };
}
const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

const captured = {};
globalThis.window = {
  __ModuleLoader__: { load: (def) => { captured.id = def.id; captured.factory = def.factory; } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
};
new Function('window', fs.readFileSync(BUNDLE, 'utf8'))(globalThis.window);
const I = captured.factory((n) => { if (n === 'react') return React; throw new Error(n); }).__internals;

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  PASS', name); pass += 1; } catch (e) { console.log('  FAIL', name, '->', e.message); fail += 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
assert.equal = (a, b) => { if (a !== b) throw new Error(`期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

function walk(node, out) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return; }
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return; }
  if (typeof node.type === 'function') { walk(node.type(node.props), out); return; }
  const style = node.props && node.props.style;
  if (style && typeof style === 'object') {
    for (const [k, v] of Object.entries(style)) {
      if (typeof v === 'number' && Number.isNaN(v)) out.bad.push(`style.${k}=NaN`);
      if (typeof v === 'string' && v.includes('NaN')) out.bad.push(`style.${k}=NaN(${v})`);
      if (v === undefined) out.bad.push(`style.${k}=undefined`);
    }
  }
  node.children.forEach((c) => walk(c, out));
}

function render(name, tree, minText = 4) {
  ok(name, () => {
    const out = { text: [], bad: [] };
    walk(tree, out);
    assert(out.bad.length === 0, '样式问题：' + out.bad.slice(0, 5).join(', '));
    const text = out.text.join(' ');
    assert(text.length >= minText, '文本太少：' + JSON.stringify(text.slice(0, 60)));
    assert(!text.includes('undefined'), '渲染出 undefined 字样');
    assert(!text.includes('NaN'), '渲染出 NaN 字样');
  });
}

const data = readCards(BRAIN, { maxTabs: 5 });
const planned = data.cards.find((c) => c.stage.planned) || data.cards[0];
const noPlan = data.cards.find((c) => !c.stage.planned) || data.cards[0];

const board = readBoard({ brainDir: BRAIN, cacheDir: defaultCacheDir(os.homedir()), now: Date.now(), maxTabs: 5 });
const sessionCard = board.strip.find((c) => c.kind === 'session') || {
  kind: 'session', id: 's:x', sid: 'x', name: '会话', color: '#4b8bf5',
  busy: true, turns: 3, steps: 12, currentStep: '写点东西', currentKind: 'step',
  tokens: { used: 12000, window: 1000000, pct: 0.012 }, model: 'deepseek-flash',
  humanIdle: '刚刚', link: null, pinned: false, shelf: false, note: '',
};
const manualCard = {
  kind: 'manual', id: 'm-test', name: '手写卡', color: '#8b7bd8', title: '手写卡',
  note: '一句备注', steps: [{ text: '第一步', detail: '做法' }], shelf: false,
  createdAt: new Date().toISOString(),
};

console.log('# 渲染');
render('Tabs（无数据时返回 null）', createElement(I.Tabs, {}), 0);
render('Progress（有排期）', createElement(I.Progress, { stage: { done: 3, total: 8, unit: '页', note: '展示 PPT' }, color: '#d98324' }));
render('Progress（未排期）', createElement(I.Progress, { stage: { done: 0, total: 0, unit: '', note: '' }, color: '#888' }));
render('Progress（超额完成不自炸）', createElement(I.Progress, { stage: { done: 12, total: 8, unit: '页' }, color: '#888' }));
render('ProjectBody（有排期的线）', createElement(I.ProjectBody, { card: planned }));
render('ProjectBody（没排期的线）', createElement(I.ProjectBody, { card: noPlan }));
render('SessionBody（在跑的会话）', createElement(I.SessionBody, { card: sessionCard }));
render('SessionBody（没在跑、没 link 的会话）', createElement(I.SessionBody, {
  card: Object.assign({}, sessionCard, { busy: false, openStep: null, link: null, model: '', tokens: null }),
}));
render('ManualBody（手写卡）', createElement(I.ManualBody, { card: manualCard }));
render('ShelfBody（空收纳）', createElement(I.ShelfBody, { data: { shelf: [] } }));
render('ShelfBody（有两张）', createElement(I.ShelfBody, { data: { shelf: [manualCard, sessionCard] } }));
render('MoreBody（其余线）', createElement(I.MoreBody, { data, board }));

ok('pctOf 上限封在 100%', () => {
  assert.equal(I.pctOf({ done: 12, total: 8 }), 100);
  assert.equal(I.pctOf({ done: 0, total: 0 }), 0);
  assert.equal(I.pctOf(null), 0);
});
ok('线卡文本带上了进度和下一步', () => {
  const out = { text: [], bad: [] };
  walk(createElement(I.ProjectBody, { card: planned }), out);
  const text = out.text.join(' ');
  assert(text.includes(`${planned.stage.done} / ${planned.stage.total}`), '没有进度：' + text.slice(0, 80));
  assert(text.includes(planned.nextStep.slice(0, 8)), '没有下一步');
});
ok('会话卡文本带上了当前步骤', () => {
  const out = { text: [], bad: [] };
  walk(createElement(I.SessionBody, { card: sessionCard }), out);
  const text = out.text.join(' ');
  assert(text.includes(sessionCard.currentStep.slice(0, 6)), '没有当前步骤');
  assert(text.includes(String(sessionCard.turns)), '没有回合数');
});
ok('未排期的卡显示「未排期」而不是 0%', () => {
  const out = { text: [], bad: [] };
  walk(createElement(I.Progress, { stage: { done: 0, total: 0 }, color: '#888' }), out);
  assert(out.text.join(' ').includes('未排期'));
});

console.log(`\n${pass} 项通过，${fail} 项失败`);
if (fail) process.exitCode = 1;
