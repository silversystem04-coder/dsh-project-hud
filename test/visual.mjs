/**
 * test/visual.mjs -- 把 Tabs 组件真渲染成 HTML，再用 Edge 无头截一张图。
 *
 * 迷你 React：state 真的会存、effect 真的会跑、fetch 换成直接读 lib/projects.js。
 * 于是截到的是**已加载态**：标签角整排 + 一张弹开的卡。
 * 页面上另画一条假标题栏，用来看它到底压在窗口的哪个位置。
 *
 *   node test/visual.mjs
 *   然后按 README 里的 Edge 命令截图。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBoard } from '../lib/board.js';
import { defaultCacheDir } from '../lib/live.js';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BUNDLE = path.join(HERE, '..', 'lib', 'client.js');
const OUT_HTML = path.join(HERE, 'visual.html');
const BRAIN = process.argv[2] || path.join(
  'C:\\Users\\Lenovo\\Documents\\deepseek-harness\\default-workspace', 'brain',
);

// ------------------------------------------------------------------ mini react
function createElement(type, props, ...children) {
  const flat = [];
  const push = (c) => {
    if (Array.isArray(c)) c.forEach(push);
    else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c);
  };
  children.forEach(push);
  // 真 React 也会把 children 放进 props.children；组件读它的地方要有东西可读。
  const p = Object.assign({}, props || {});
  if (flat.length) p.children = flat.length === 1 ? flat[0] : flat;
  return { type, props: p, children: flat };
}

const states = new Map();
let compSeq = 0;
let hookSeq = 0;
let dirty = false;
let pending = [];
function keyOf(h) { return compSeq + ':' + h; }

const React = {
  createElement,
  Fragment: 'fragment',
  useState(initial) {
    const key = keyOf(hookSeq++);
    if (!states.has(key)) states.set(key, typeof initial === 'function' ? initial() : initial);
    const set = (next) => {
      const cur = states.get(key);
      states.set(key, typeof next === 'function' ? next(cur) : next);
      dirty = true;
    };
    return [states.get(key), set];
  },
  useEffect(fn, deps) {
    const key = keyOf(-1 - hookSeq++);
    const prev = states.get(key + ':deps');
    const same = prev && deps && deps.length === prev.length && deps.every((d, i) => Object.is(d, prev[i]));
    if (same) return;
    states.set(key + ':deps', deps ? deps.slice() : undefined);
    pending.push({ fn });
  },
  useRef(initial) { return { current: initial === undefined ? null : initial }; },
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
};

function enterComponent() { compSeq += 1; hookSeq = 0; }

// ------------------------------------------------------------------ serializer
const UNITLESS = new Set(['flex', 'flexGrow', 'flexShrink', 'opacity', 'fontWeight', 'lineHeight',
  'zIndex', 'order', 'aspectRatio']);
function kebab(k) { return k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()); }
function styleToCss(style) {
  if (!style) return '';
  const parts = [];
  for (const [k, v] of Object.entries(style)) {
    if (v === null || v === undefined) continue;
    parts.push(kebab(k) + ':' + (typeof v === 'number' && !UNITLESS.has(k) ? v + 'px' : String(v)));
  }
  return parts.join(';');
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function serialize(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(node).replace(/\n/g, '<br>');
  if (Array.isArray(node)) return node.map(serialize).join('');
  if (typeof node.type === 'function') { enterComponent(); return serialize(node.type(node.props)); }
  if (node.type === 'fragment') return node.children.map(serialize).join('');
  const tag = typeof node.type === 'string' ? node.type : 'div';
  const attrs = [];
  if (tag === 'svg') attrs.push('xmlns="http://www.w3.org/2000/svg"');
  for (const [k, v] of Object.entries(node.props)) {
    if (k === 'style' || k === 'key' || k === 'children' || k === 'className') continue;
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function' || typeof v === 'object') continue;
    attrs.push(kebab(k) + '="' + esc(v) + '"');
  }
  const style = styleToCss(node.props.style);
  if (style) attrs.push(`style="${esc(style)}"`);
  if (node.props.className) attrs.push(`class="${esc(node.props.className)}"`);
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
    + node.children.map(serialize).join('') + `</${tag}>`;
}

// ----------------------------------------------------------------------- data
const board = readBoard({ brainDir: BRAIN, cacheDir: defaultCacheDir(os.homedir()), now: Date.now(), maxTabs: 5, maxLive: 3, build: 'preview' });
globalThis.fetch = (url) => Promise.resolve({
  ok: true,
  status: 200,
  json: () => Promise.resolve(String(url).includes('/cards') ? board : { ok: true, board }),
});

const captured = {};
globalThis.window = {
  __ModuleLoader__: { load: (def) => { captured.factory = def.factory; } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
};
new Function('window', fs.readFileSync(BUNDLE, 'utf8'))(globalThis.window);
const I = captured.factory((n) => { if (n === 'react') return React; throw new Error(n); }).__internals;

const openOn = process.argv[3] || (board.strip[0] && board.strip[0].id) || '';
const root = createElement(I.Tabs, { initialOpen: openOn, initialAdding: openOn === '__add' ? { title: '', note: '' } : null });

const tick = () => new Promise((r) => setTimeout(r, 12));
let html = '';
for (let pass = 0; pass < 8; pass += 1) {
  compSeq = 0;
  hookSeq = 0;
  dirty = false;
  pending = [];
  try {
    html = serialize(root);
  } catch (error) {
    console.error('渲染失败 pass', pass, error.stack);
    process.exit(1);
  }
  pending.forEach((e) => { try { e.fn(); } catch (error) { console.error('effect 抛错:', error.message); } });
  await tick();
  if (!dirty) break;
}

const mock = `
<div class="win">
  <div class="titlebar">
    <div class="tb-left"><span class="logo">◆</span><span class="tb-title">记忆结构插件可视化会话</span></div>
    <div class="tb-right"><span class="tb-btn">—</span><span class="tb-btn">□</span><span class="tb-btn x">✕</span></div>
  </div>
  <div class="cols">
    <div class="side">
      <div class="srow on">记忆结构插件可视化会话</div>
      <div class="srow">AI每日使用记录…</div>
      <div class="srow">实时听网课转写…</div>
      <div class="srow">视频制作</div>
      <div class="srow">游戏自由文本输入…</div>
    </div>
    <div class="main">
      <div class="bubble me">做个插件，相当于在窗口最上方搞几个标签角…</div>
      <div class="bubble"><span class="dim">写代码…</span></div>
    </div>
  </div>
</div>`;

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>project-tabs preview</title>
<style>
  :root {
    --dsw-alias-label-primary:#1a1a1a; --dsw-alias-label-secondary:#6b7280;
    --dsw-alias-label-tertiary:#98a0ac;
    --dsw-alias-border-l1:rgba(0,0,0,.09); --dsw-alias-border-l2:rgba(0,0,0,.18);
    --dsw-alias-bg-base:#fff; --dsw-alias-bg-layer-1:#f7f8fa; --dsw-alias-bg-layer-2:#eef0f4;
    --dsw-alias-brand-primary:#4b8bf5; --dsw-alias-state-warn-primary:#d99a00;
    --dsw-alias-state-error-primary:#d93025; --dsw-alias-state-success-primary:#2e9e5b;
  }
  body { margin:0; background:#e9ebef; font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  .win { width:900px; height:560px; margin:0 auto; background:#fff; border-radius:10px;
         overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.14); }
  .titlebar { height:36px; display:flex; align-items:center; padding:0 10px;
              background:#fbfbfc; border-bottom:1px solid rgba(0,0,0,.07); }
  .tb-left { display:flex; align-items:center; gap:7px; }
  .logo { color:#4b8bf5; font-size:13px; }
  .tb-title { font-size:11.5px; color:#6b7280; }
  .tb-right { margin-left:auto; display:flex; gap:12px; }
  .tb-btn { font-size:11px; color:#98a0ac; }
  .cols { display:flex; height:524px; }
  .side { width:210px; border-right:1px solid rgba(0,0,0,.07); padding:8px 6px; background:#fbfbfc; }
  .srow { font-size:11px; color:#6b7280; padding:5px 7px; border-radius:6px; white-space:nowrap;
          overflow:hidden; text-overflow:ellipsis; }
  .srow.on { background:#eef0f4; color:#1a1a1a; font-weight:600; }
  .main { flex:1; padding:16px 20px; }
  .bubble { max-width:420px; font-size:12px; line-height:1.6; padding:9px 12px; border-radius:10px;
            background:#f4f5f7; margin-bottom:10px; color:#333; }
  .bubble.me { margin-left:auto; background:#e7f0ff; }
  .dim { color:#9aa4b2; }
</style></head>
<body>${mock}${html}</body></html>`;

fs.writeFileSync(OUT_HTML, page, 'utf8');
console.log('wrote', OUT_HTML, page.length, 'bytes');
console.log('标签：', board.strip.map((c) => c.name).join(' · '), '| 其余', board.paused.length + board.rest.length + board.idleSessions.length);
console.log('弹开的是：', openOn);
console.log('占位符检查：', /读不到|no route/.test(html) ? '有（数据没注入）' : '没有');
// Tabs 里挂着一个 60s 的 setInterval（刷新用），迷你 React 不跑 cleanup，
// 不清掉的话进程会一直挂着。
process.exit(0);
