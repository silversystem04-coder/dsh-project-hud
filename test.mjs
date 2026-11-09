/**
 * test.mjs -- 不碰 Host、不开浏览器，只验两件事：
 *   1. 交接单解析（待做 / 待定 / —— 拆细节）认不认得 brain 里现在这套写法；
 *   2. 卡片生成（分组、排序、紧急判断）在真实数据上说得通。
 *
 *   node test.mjs [brainDir]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLineDoc, readCards, humanLeft } from './lib/projects.js';
import { loadStore, mutate, storeFile } from './lib/store.js';
import { readLiveSessions, defaultCacheDir } from './lib/live.js';
import { readBoard } from './lib/board.js';

// 真实数据目录：第一个参数或 PT_BRAIN；都没有就看 ./brain，再没有就只用合成数据。
const BRAIN = process.argv[2] || process.env.PT_BRAIN || path.join(process.cwd(), 'brain');
const HAS_BRAIN = fs.existsSync(path.join(BRAIN, 'journal', 'projects.json'));

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('  PASS', name);
    pass += 1;
  } catch (error) {
    console.log('  FAIL', name, '->', error.message);
    process.exitCode = 1;
  }
}

console.log('# 交接单解析');
ok('待做块 + —— 拆细节', () => {
  const doc = [
    '# 线09：测试',
    '**待做：**',
    '- 写一页 PPT —— 从定稿里摘',
    '- 找人看图',
    '',
  ].join('\n');
  const r = parseLineDoc(doc);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].text, '写一页 PPT');
  assert.equal(r.steps[0].detail, '从定稿里摘');
  assert.equal(r.steps[1].detail, '');
});
ok('待定单行（广接那种写法）', () => {
  const doc = '# 线02：广接\n\n**待定：** 能不能部署上线（域名已注册；备案待查）\n';
  const r = parseLineDoc(doc);
  assert.equal(r.blockers.length, 1);
  assert.ok(r.blockers[0].startsWith('能不能部署上线'));
  assert.equal(r.steps.length, 0);
});
ok('块外的东西不算待做', () => {
  const doc = '**待做：**\n- A\n\n**别的段：**\n- B\n- C\n';
  const r = parseLineDoc(doc);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].text, 'A');
});
ok('编号条目也认', () => {
  const r = parseLineDoc('**待做：**\n1. 第一件\n2. 第二件\n');
  assert.equal(r.steps.length, 2);
});
ok('没有待做就是空，不瞎猜', () => {
  assert.deepEqual(parseLineDoc('# 什么都没有\n\n正文。'), { steps: [], blockers: [] });
  assert.deepEqual(parseLineDoc(''), { steps: [], blockers: [] });
});
ok('humanLeft 认过期', () => {
  assert.match(humanLeft(-3600000), /^已过期 /);
  assert.equal(humanLeft(45 * 60000), '45m');
  assert.equal(humanLeft(5 * 3600000), '5h');
  assert.match(humanLeft(4 * 86400000 + 20 * 3600000), /^4d20h$/);
});

if (!HAS_BRAIN) {
  console.log('# 卡片（真实数据） -- SKIP (no projects.json)');
} else {
console.log('# 卡片（真实数据）');
const data = readCards(BRAIN, { maxTabs: 5 });
ok('读得到', () => assert.equal(data.ok, true));
ok('有进行中的线', () => assert.ok(data.cards.length >= 3, `cards ${data.cards.length}`));
ok('标签里没有「其他」', () => assert.ok(!data.cards.some((c) => c.id === 'other')));
ok('标签数不超过上限', () => assert.ok(data.cards.length <= 5));
ok('暂停的单独放，不占标签', () => {
  assert.ok(Array.isArray(data.paused));
  assert.ok(data.paused.every((c) => c.status === 'paused'));
  assert.ok(!data.cards.some((c) => c.status === 'paused'));
});
ok('按截止排：有截止的排在没截止的前面', () => {
  const firstNoDl = data.cards.findIndex((c) => !Number.isFinite(c.urgencyMs));
  if (firstNoDl < 0) return;
  for (let i = firstNoDl; i < data.cards.length; i += 1) {
    assert.ok(!Number.isFinite(data.cards[i].urgencyMs), `${data.cards[i].name} 排错`);
  }
});
ok('职规赛：已提交，归进「其余」而不是条带', () => {
  const all = data.cards.concat(data.paused || [], data.rest || []);
  const z = all.find((c) => c.id === 'zhiye');
  assert.ok(z, '没有职规赛');
  assert.equal(z.status, 'done');
  assert.ok(!data.cards.some((c) => c.id === 'zhiye'), '做完的线还占着条带');
  assert.match(z.brief, /已提交|完成/);
  // 已提交的线没有 stage 就不许编一个 0/8 —— projects.json 里 stage 已被删掉。
  assert.equal(z.stage.total, 0);
  assert.equal(z.stage.planned, false);
});
ok('衣鱼：四件待做都在，第一件是训练基线', () => {
  const y = data.cards.find((c) => c.id === 'yiyu');
  assert.ok(y, '没有衣鱼');
  assert.equal(y.stage.total, 4);
  assert.equal(y.steps.length, 4);
  assert.match(y.steps[0].text, /基线/);
  assert.ok(y.steps.some((s) => s.detail.includes('徐卓')), '界面的「徐卓负责」没被拆出来');
});
ok('广接：卡点被读出来', () => {
  const g = data.cards.concat(data.paused || [], data.rest || []).find((c) => c.id === 'guangjie');
  assert.ok(g, '没有广接');
  assert.equal(g.blockedBy.length, 1);
  assert.ok(g.advice.some((a) => a.kind === 'block'));
});
ok('每条卡都有可操作的信息（建议 或 「到这一步」）', () => {
  for (const c of data.cards) {
    assert.ok(c.advice.length >= 1 || c.nextStep, `${c.name} 既没建议也没下一步`);
  }
});
ok('「该注意」不重复「到这一步」', () => {
  for (const c of data.cards) {
    if (!c.nextStep) continue;
    const dup = c.advice.some((a) => a.text.includes(c.nextStep.slice(0, 10)));
    assert.ok(!dup, `${c.name} 的建议把下一步又抄了一遍`);
  }
});
ok('后面的条目不再出现在「到这一步」里', () => {
  const y = data.cards.concat(data.paused || [], data.rest || []).find((c) => c.id === 'yiyu');
  assert.ok(y, '没有衣鱼');
  assert.equal(y.laterSteps.length, y.steps.length - 1);
  assert.ok(!y.laterSteps.some((s) => s.text === y.nextStep));
});
ok('** 记号被清掉', () => {
  for (const c of data.cards) {
    for (const s of c.steps) {
      assert.ok(!s.text.includes('**'), `${c.name} 的待做里还有 **`);
      assert.ok(!s.detail.includes('**'), `${c.name} 的细化里还有 **`);
    }
  }
});
ok('没有交接单的活跃线被点名', () => {
  const noFile = data.cards.find((c) => !c.file);
  if (!noFile) return;
  assert.ok(noFile.advice.some((a) => a.text.includes('交接单')), `${noFile.name} 没提示补交接单`);
});
ok('进度百分比只在有排期时给', () => {
  for (const c of data.cards) {
    if (c.stage.planned) assert.ok(c.stage.pct >= 0 && c.stage.pct <= 1);
    else assert.equal(c.stage.pct, 0);
  }
});

}

console.log('\n# 用户层（cards.json）');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-store-'));
ok('空目录：ok=true / exists=false / 空数据', () => {
  const s = loadStore(sandbox);
  assert.equal(s.ok, true);
  assert.equal(s.exists, false);
  assert.deepEqual(s.data.cards, []);
});
ok('新增一张手写卡', () => {
  const r = mutate(sandbox, { op: 'add', title: '整理答辩稿', note: '周五前' });
  assert.equal(r.ok, true);
  const s = loadStore(sandbox);
  assert.equal(s.data.cards.length, 1);
  assert.equal(s.data.cards[0].title, '整理答辩稿');
  assert.match(s.data.cards[0].id, /^m-/);
});
let manualId = '';
ok('改名 + 备注 + 步骤', () => {
  manualId = loadStore(sandbox).data.cards[0].id;
  mutate(sandbox, { op: 'meta', id: manualId, title: '整理答辩稿（终）', note: '三页', steps: ['写提纲', '配图'] });
  const c = loadStore(sandbox).data.cards[0];
  assert.equal(c.title, '整理答辩稿（终）');
  assert.equal(c.note, '三页');
  assert.deepEqual(c.steps.map((s) => s.text), ['写提纲', '配图']);
});
ok('收纳：flag=shelf 后置位，取回归位', () => {
  mutate(sandbox, { op: 'flag', id: manualId, flag: 'shelf', value: true });
  assert.equal(loadStore(sandbox).data.cards[0].shelf, true);
  mutate(sandbox, { op: 'flag', id: manualId, flag: 'shelf', value: false });
  assert.equal(loadStore(sandbox).data.cards[0].shelf, false);
});
ok('删除', () => {
  mutate(sandbox, { op: 'remove', id: manualId });
  assert.equal(loadStore(sandbox).data.cards.length, 0);
});
ok('坏 JSON 不覆盖、报 ok=false', () => {
  const f = storeFile(sandbox);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ 这不是 json', 'utf8');
  const s = loadStore(sandbox);
  assert.equal(s.ok, false);
  assert.match(s.error, /JSON|json/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ 这不是 json');
});
ok('空标题落成「新卡片」，不写空串', () => {
  const r = mutate(sandbox, { op: 'add', title: '   ' });
  assert.equal(r.ok, true);
  assert.equal(loadStore(sandbox).data.cards[0].title, '新卡片');
  mutate(sandbox, { op: 'remove', id: r.id });
});
ok('标题有长度上限', () => {
  const r = mutate(sandbox, { op: 'add', title: '长'.repeat(200) });
  assert.ok(loadStore(sandbox).data.cards[0].title.length <= 60);
  mutate(sandbox, { op: 'remove', id: r.id });
});
ok('改不存在的卡被拒', () => {
  assert.equal(mutate(sandbox, { op: 'meta', id: 'm-nope', title: 'x' }).ok, false);
});
ok('未知 op 被拒', () => {
  assert.equal(mutate(sandbox, { op: 'hack' }).ok, false);
});

console.log('\n# 会话（真实缓存）');
const cacheDir = defaultCacheDir(os.homedir());
const live = readLiveSessions(cacheDir, { now: Date.now() });
ok('读得到缓存目录', () => assert.equal(live.ok, true, live.error || ''));
ok('窗口内会话都有当前步骤', () => {
  for (const s of live.sessions) {
    if (s.turns > 0) {
      assert.ok(typeof s.currentStep === 'string' && s.currentStep.length > 0, `${s.id} 没有当前步骤`);
      assert.ok(['step', 'prompt', 'response'].includes(s.currentKind));
    } else {
      // 刚开、还没说过话的会话：不许替它编一个步骤。
      assert.equal(s.currentStep, '');
      assert.equal(s.currentKind, '');
    }
    assert.ok(s.tokens.pct >= 0 && s.tokens.pct <= 1.5);
  }
});
ok('busy 不超过 total', () => assert.ok(live.busy <= live.total));

console.log('\n# 拼板（真实数据 + 沙箱 store）');
const board = readBoard({ brainDir: BRAIN, cacheDir, now: Date.now(), maxTabs: 5, maxLive: 3 });
ok('拼得出来', () => assert.equal(board.ok, true, board.error || ''));
ok('条带不超上限', () => {
  const sessions = board.strip.filter((c) => c.kind === 'session').length;
  const projects = board.strip.filter((c) => c.kind === 'project').length;
  assert.ok(sessions <= 3, `会话卡 ${sessions}`);
  assert.ok(projects <= 5, `线卡 ${projects}`);
});
ok('条带每一项都有 id/name/color', () => {
  for (const c of board.strip) {
    assert.ok(c.id && c.name, `缺字段 ${JSON.stringify(c.id)}`);
    assert.match(c.color, /^#[0-9a-f]{6}$/i);
  }
});
ok('在跑的会话排在最前面', () => {
  const firstIdle = board.strip.findIndex((c) => c.kind === 'session' && !c.busy);
  const firstBusy = board.strip.findIndex((c) => c.busy);
  if (firstBusy < 0 || firstIdle < 0) return;
  assert.ok(firstBusy < firstIdle, '忙的会话排到后面去了');
});
ok('有会话在跑的线被前移进条带', () => {
  const hot = board.strip.find((c) => c.kind === 'project' && c.live && c.live.busy);
  if (!hot) return; // 当前没人在跑就跳过
  assert.ok(board.strip.indexOf(hot) <= 5, '热门线被挤出条带');
});
ok('会话按关键词归到线', () => {
  const linked = board.strip.concat(board.idleSessions || []).filter((c) => c.link);
  for (const c of linked) assert.ok(c.link.id && c.link.name);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全绿'}`);
