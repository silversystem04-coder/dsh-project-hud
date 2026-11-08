/**
 * dsh-project-tabs -- 浏览器半边。
 *
 * 手写 ModuleLoader bundle：没有打包器、没有构建步骤。
 * 挂在 shell.overlay（帧级浮层，默认点得穿）上，自己画一条贴在窗口顶边的标签角。
 *
 * 角上有三种卡：
 *   会话卡 —— 正在跑的会话，3 秒刷一次，自己出现、自己消失；
 *   线卡   —— brain/journal/projects.json + 线NN_*.md 里写的进度与下一步；
 *   自己的卡 —— 点「+」加的，写在 brain/journal/cards.json 里。
 *
 * 交互：
 *   鼠标停在角上 → 往下弹卡；从角移到卡上不会收（中间留 240ms）。
 *   点一下 → 钉住；再点或按 Esc → 收。
 *   卡上能固定/收纳/删除/改名/写备注，都会落盘（POST /api/mutate）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-tabs',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    var PREFIX = '/project-tabs/api';
    var CLOSE_DELAY = 240;
    var POLL_MS = 3000;

    var LABEL = 'var(--dsw-alias-label-primary, #1a1a1a)';
    var LABEL2 = 'var(--dsw-alias-label-secondary, #6b7280)';
    var LABEL3 = 'var(--dsw-alias-label-tertiary, #98a0ac)';
    var BORDER = 'var(--dsw-alias-border-l1, rgba(0,0,0,.09))';
    var BORDER2 = 'var(--dsw-alias-border-l2, rgba(0,0,0,.16))';
    var BG = 'var(--dsw-alias-bg-base, #fff)';
    var BG1 = 'var(--dsw-alias-bg-layer-1, #f7f8fa)';
    var BG2 = 'var(--dsw-alias-bg-layer-2, #eef0f4)';
    var ERR = 'var(--dsw-alias-state-error-primary, #d93025)';
    var WARN = 'var(--dsw-alias-state-warn-primary, #d99a00)';
    var OK = 'var(--dsw-alias-state-success-primary, #2e9e5b)';
    var BRAND = 'var(--dsw-alias-brand-primary, #4b8bf5)';
    var MONO = 'ui-monospace, SFMono-Regular, Consolas, monospace';

    function api(path) {
      return fetch(PREFIX + path, {
        method: 'GET',
        headers: { 'x-project-tabs': '1' },
        cache: 'no-store',
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }

    function mutate(op) {
      return fetch(PREFIX + '/mutate', {
        method: 'POST',
        headers: { 'x-project-tabs': '1', 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(op),
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || !body.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
          return body;
        });
      });
    }

    function pctOf(stage) {
      if (!stage || !stage.total) return 0;
      return Math.max(0, Math.min(100, Math.round(stage.done / stage.total * 100)));
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function clockOf(ms) {
      var d = new Date(ms);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function kfmt(n) {
      var v = Number(n) || 0;
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return Math.round(v / 1000) + 'k';
      return String(v);
    }

    var S = {
      layer: {
        position: 'fixed', top: 0, left: 0, right: 0, height: 0,
        zIndex: 60, pointerEvents: 'none', overflow: 'visible',
      },
      strip: {
        position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'flex-start', gap: 2,
        pointerEvents: 'none', fontFamily: 'inherit',
      },
      // -webkit-app-region: no-drag 是必须的：窗口最上方那条是 Electron 的拖拽区
      // （drag region），在它上面的元素**不接收任何鼠标事件** —— 看得见、悬停没反应。
      // 2026-11-04 就是踩了这个：标签角画出来了，但鼠标放上去毫无动静。
      wrap: { position: 'relative', pointerEvents: 'auto', WebkitAppRegion: 'no-drag' },
      tab: {
        display: 'flex', alignItems: 'center', gap: 4,
        height: 19, padding: '0 7px', boxSizing: 'border-box',
        border: '1px solid ' + BORDER2, borderTop: 'none',
        borderRadius: '0 0 7px 7px',
        background: BG1, color: LABEL2, cursor: 'pointer',
        fontSize: 10.5, lineHeight: '17px', whiteSpace: 'nowrap',
        transition: 'height .12s ease, background .12s ease, color .12s ease',
        boxShadow: '0 1px 2px rgba(0,0,0,.04)',
        userSelect: 'none',
        WebkitAppRegion: 'no-drag',
      },
      tabOn: {
        height: 23, background: BG, color: LABEL,
        borderColor: BORDER2, boxShadow: '0 2px 6px rgba(0,0,0,.12)',
      },
      tabLive: { background: 'rgba(75,139,245,.10)', borderColor: 'rgba(75,139,245,.45)', color: LABEL },
      dot: { width: 6, height: 6, borderRadius: 3, flex: '0 0 auto' },
      dotLive: {
        width: 6, height: 6, borderRadius: 3, flex: '0 0 auto',
        background: BRAND, boxShadow: '0 0 0 3px rgba(75,139,245,.18)',
      },
      tabName: {
        maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis',
        fontWeight: 600,
      },
      tabNum: { fontFamily: MONO, fontSize: 9.5, opacity: .75 },
      alert: { width: 5, height: 5, borderRadius: 2.5, background: ERR, flex: '0 0 auto' },
      plus: { fontSize: 12, lineHeight: '15px', fontWeight: 400, color: LABEL3, padding: '0 2px' },

      card: {
        position: 'absolute', top: '100%', marginTop: 6, width: 320,
        background: BG, color: LABEL, border: '1px solid ' + BORDER2,
        borderRadius: 11, padding: '10px 11px 11px',
        boxShadow: '0 10px 30px rgba(0,0,0,.16)',
        pointerEvents: 'auto', textAlign: 'left', cursor: 'default',
        fontSize: 11.5, lineHeight: 1.5,
        WebkitAppRegion: 'no-drag',
      },
      head: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 },
      bar3: { width: 3, alignSelf: 'stretch', borderRadius: 2, minHeight: 14 },
      title: { fontSize: 13, fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chip: {
        fontSize: 9.5, padding: '1px 6px', borderRadius: 9, border: '1px solid ' + BORDER,
        color: LABEL2, whiteSpace: 'nowrap', flex: '0 0 auto',
      },
      brief: { color: LABEL2, fontSize: 11, marginBottom: 7 },

      progHead: {
        display: 'flex', alignItems: 'baseline', gap: 6,
        fontSize: 10, color: LABEL3, letterSpacing: '.04em', marginTop: 2,
      },
      progVal: { marginLeft: 'auto', fontFamily: MONO, color: LABEL, fontSize: 11 },
      track: {
        height: 8, borderRadius: 4, background: BG2, overflow: 'hidden',
        boxShadow: 'inset 0 0 0 1px ' + BORDER,
        margin: '4px 0 2px', display: 'flex',
      },
      fill: { height: '100%', borderRadius: 4, transition: 'width .2s ease' },

      sect: {
        marginTop: 9, paddingTop: 7, borderTop: '1px solid ' + BORDER,
      },
      sectHead: {
        display: 'flex', alignItems: 'baseline', gap: 6,
        fontSize: 10, color: LABEL3, letterSpacing: '.05em', marginBottom: 4,
      },
      step: { display: 'flex', gap: 6, alignItems: 'flex-start', padding: '2px 0' },
      stepDot: {
        width: 5, height: 5, borderRadius: 2.5, marginTop: 5, flex: '0 0 auto',
        background: BORDER2,
      },
      stepText: { flex: '1 1 auto', fontSize: 11.5 },
      stepDetail: { color: LABEL2, fontSize: 10.5, display: 'block', marginTop: 1 },

      advice: {
        display: 'flex', gap: 6, padding: '3px 0 3px 7px',
        borderLeft: '2px solid ' + BORDER2, fontSize: 11, color: LABEL2,
      },
      foot: {
        marginTop: 9, paddingTop: 6, borderTop: '1px solid ' + BORDER,
        fontSize: 10, color: LABEL3, display: 'flex', gap: 8, flexWrap: 'wrap',
      },
      row: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderTop: '1px solid ' + BORDER },
      rowName: { fontWeight: 600, fontSize: 11.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowMeta: { marginLeft: 'auto', fontFamily: MONO, fontSize: 9.5, color: LABEL3, flex: '0 0 auto' },
      moreNext: { fontSize: 10.5, color: LABEL2, display: 'block', marginTop: 1 },

      btn: {
        fontSize: 10, padding: '2px 7px', borderRadius: 6, border: '1px solid ' + BORDER2,
        background: BG1, color: LABEL2, cursor: 'pointer', fontFamily: 'inherit',
      },
      btnOn: { background: 'rgba(75,139,245,.12)', borderColor: 'rgba(75,139,245,.5)', color: BRAND },
      btnDanger: { background: 'rgba(217,48,37,.07)', borderColor: 'rgba(217,48,37,.4)', color: ERR },
      actions: { marginTop: 9, paddingTop: 7, borderTop: '1px solid ' + BORDER, display: 'flex', gap: 5, flexWrap: 'wrap' },

      field: { display: 'block', marginTop: 6 },
      fieldLabel: { fontSize: 9.5, color: LABEL3, letterSpacing: '.05em', display: 'block', marginBottom: 2 },
      input: {
        width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 11.5,
        padding: '4px 6px', borderRadius: 6, border: '1px solid ' + BORDER2,
        background: BG, color: LABEL, outline: 'none',
      },
      textarea: {
        width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 11,
        padding: '4px 6px', borderRadius: 6, border: '1px solid ' + BORDER2,
        background: BG, color: LABEL, outline: 'none', resize: 'vertical', minHeight: 44,
      },
      empty: { color: LABEL3, fontSize: 10.5, padding: '6px 0' },
      flash: {
        position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)',
        pointerEvents: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 8,
        background: 'rgba(46,158,91,.1)', color: OK, border: '1px solid rgba(46,158,91,.5)',
        WebkitAppRegion: 'no-drag',
      },
      errPill: {
        position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)',
        pointerEvents: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 8,
        background: 'rgba(217,48,37,.1)', color: ERR, border: '1px solid ' + ERR,
        WebkitAppRegion: 'no-drag',
      },
      notePill: {
        position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)',
        pointerEvents: 'none', fontSize: 10, padding: '2px 8px', borderRadius: 8,
        background: 'rgba(0,0,0,.04)', color: LABEL3, border: '1px solid ' + BORDER,
      },
    };

    var KIND_COLOR = { urgent: ERR, warn: WARN, ok: OK, step: BRAND, block: WARN, idle: BORDER2 };

    // ------------------------------------------------------------------ 小件
    function Chip(props) {
      return h('span', {
        style: Object.assign({}, S.chip, props.style || null, {
          color: props.color || LABEL2,
          borderColor: props.border || BORDER,
        }),
      }, props.children);
    }

    function Btn(props) {
      return h('button', {
        style: Object.assign({}, S.btn, props.tone === 'danger' ? S.btnDanger : null, props.on ? S.btnOn : null, props.style || null),
        onClick: function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          if (props.onClick) props.onClick();
        },
        type: 'button',
      }, props.label);
    }

    function Section(props) {
      return h('div', { style: S.sect },
        h('div', { style: S.sectHead },
          props.title,
          props.right ? h('span', { style: { marginLeft: 'auto', fontFamily: MONO } }, props.right) : null),
        props.children);
    }

    function Progress(props) {
      var stage = props.stage;
      var pct = pctOf(stage);
      var color = props.color || BRAND;
      return h('div', null,
        h('div', { style: S.progHead },
          h('span', null, props.label || '阶段进度'),
          h('span', { style: S.progVal },
            stage.total ? (stage.done + ' / ' + stage.total + ' ' + (stage.unit || '') + '  ' + pct + '%') : '未排期'),
        ),
        h('div', { style: S.track },
          stage.total
            ? h('div', { style: Object.assign({}, S.fill, { width: pct + '%', background: color }) })
            : h('div', {
              style: {
                width: '100%', height: '100%',
                backgroundImage: 'repeating-linear-gradient(45deg,' + BG2 + ' 0 5px,' + BORDER + ' 5px 6px)',
              },
            }),
        ),
        props.note ? h('div', { style: { fontSize: 10, color: LABEL3 } }, props.note) : null,
      );
    }

    function TokenBar(props) {
      var t = props.tokens || { pct: 0, used: 0, window: 0 };
      var pct = Math.round((t.pct || 0) * 100);
      var color = pct >= 90 ? ERR : (pct >= 70 ? WARN : BRAND);
      return h('div', null,
        h('div', { style: S.progHead },
          h('span', null, props.label || '上下文'),
          h('span', { style: S.progVal }, kfmt(t.used) + ' / ' + kfmt(t.window) + '  ' + pct + '%'),
        ),
        h('div', { style: S.track },
          h('div', { style: Object.assign({}, S.fill, { width: Math.max(1, pct) + '%', background: color }) }),
        ),
      );
    }

    function Loading() {
      return h('div', { style: { fontSize: 10.5, color: LABEL3, marginTop: 6 } }, '…');
    }

    // ------------------------------------------------------------------ 表单
    function EditForm(props) {
      var d = props.draft;
      function set(key, value) {
        var next = Object.assign({}, d);
        next[key] = value;
        props.onChange(next);
      }
      return h('div', null,
        h('label', { style: S.field },
          h('span', { style: S.fieldLabel }, '名字'),
          h('input', {
            style: S.input, value: d.title || '', maxLength: 60,
            onChange: function (e) { set('title', e.target.value); },
          }),
        ),
        props.withSteps
          ? h('label', { style: S.field },
            h('span', { style: S.fieldLabel }, '备注'),
            h('textarea', {
              style: Object.assign({}, S.textarea, { minHeight: 34 }), value: d.note || '', maxLength: 600,
              onChange: function (e) { set('note', e.target.value); },
            }),
          )
          : h('label', { style: S.field },
            h('span', { style: S.fieldLabel }, '备注'),
            h('textarea', {
              style: Object.assign({}, S.textarea, { minHeight: 34 }), value: d.note || '', maxLength: 600,
              onChange: function (e) { set('note', e.target.value); },
            }),
          ),
        props.withSteps
          ? h('label', { style: S.field },
            h('span', { style: S.fieldLabel }, '步骤（一行一条；「——」后面算做法）'),
            h('textarea', {
              style: S.textarea, value: d.steps || '',
              onChange: function (e) { set('steps', e.target.value); },
            }),
          )
          : null,
        h('div', { style: S.actions },
          h(Btn, { label: props.saving ? '保存中…' : '保存', onClick: props.onSave, on: true }),
          h(Btn, { label: '取消', onClick: props.onCancel }),
        ),
      );
    }

    function AddForm(props) {
      var d = props.draft;
      function set(key, value) {
        var next = Object.assign({}, d);
        next[key] = value;
        props.onChange(next);
      }
      return h('div', null,
        h('label', { style: S.field },
          h('span', { style: S.fieldLabel }, '新卡片'),
          h('input', {
            style: S.input, value: d.title || '', maxLength: 60, placeholder: '叫什么都行，比如「今晚读那篇 RAG」',
            onChange: function (e) { set('title', e.target.value); },
          }),
        ),
        h('label', { style: S.field },
          h('span', { style: S.fieldLabel }, '备注'),
          h('textarea', {
            style: Object.assign({}, S.textarea, { minHeight: 40 }), value: d.note || '', maxLength: 600,
            placeholder: '一句话：现在到哪、下一步干什么',
            onChange: function (e) { set('note', e.target.value); },
          }),
        ),
        h('label', { style: S.field },
          h('span', { style: S.fieldLabel }, '步骤（一行一条；「——」后面算做法）'),
          h('textarea', {
            style: Object.assign({}, S.textarea, { minHeight: 46 }), value: d.steps || '',
            placeholder: '写提纲\n配图 —— 用上次那几张',
            onChange: function (e) { set('steps', e.target.value); },
          }),
        ),
        h('div', { style: S.actions },
          h(Btn, { label: props.saving ? '添加中…' : '加到这里', onClick: props.onSave, on: true }),
          h(Btn, { label: '取消', onClick: props.onCancel }),
        ),
      );
    }

    // ------------------------------------------------------------------ 会话卡
    function SessionBody(props) {
      var card = props.card;
      var editing = props.editing && props.editing.id === card.id;
      return h('div', null,
        h('div', { style: S.head },
          h('div', { style: Object.assign({}, S.bar3, { background: card.color }) }),
          h('span', { style: S.title }, card.name),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 4 } },
            card.busy ? h(Chip, { color: BRAND, border: 'rgba(75,139,245,.5)' }, '在跑') : h(Chip, null, card.humanIdle),
            card.link ? h(Chip, { color: card.link.color, border: card.link.color }, card.link.name) : null),
        ),
        card.title && card.title !== card.name ? h('div', { style: S.brief }, card.title) : null,

        card.currentStep
          ? h('div', { style: { marginTop: 4 } },
            h('div', { style: S.sectHead }, card.openStep ? '这一步' : '最后一句'),
            h('div', { style: { fontSize: 11.5 } }, card.currentStep))
          : null,

        h('div', { style: { marginTop: 8 } },
          h(TokenBar, { tokens: card.tokens, label: '上下文' })),

        h('div', { style: { marginTop: 6, display: 'flex', gap: 8, fontSize: 10, color: LABEL3, fontFamily: MONO } },
          h('span', null, '第 ' + card.turns + ' 回合'),
          h('span', null, card.steps + ' 步'),
          card.model ? h('span', { style: { marginLeft: 'auto' } }, card.model) : null),

        card.lastResponse
          ? h(Section, { title: '最后回你的' },
            h('div', { style: { fontSize: 11, color: LABEL2 } }, card.lastResponse))
          : null,

        card.note
          ? h(Section, { title: '我写的备注' },
            h('div', { style: { fontSize: 11 } }, card.note))
          : null,

        editing
          ? h('div', null,
            h(EditForm, {
              draft: props.draft,
              onChange: props.onDraft,
              onSave: props.onSaveEdit,
              onCancel: props.onCancelEdit,
              saving: props.saving,
              withSteps: false,
            }))
          : h('div', { style: S.actions },
            h(Btn, {
              label: card.pinned ? '取消固定' : '固定住',
              on: card.pinned,
              onClick: function () { props.onFlag(card.id, 'pinned', !card.pinned); },
            }),
            h(Btn, {
              label: '收纳',
              onClick: function () { props.onFlag(card.id, 'shelf', true); },
            }),
            h(Btn, { label: '改名', onClick: function () { props.onEdit(card); } }),
            h(Btn, { label: '删除', tone: 'danger', onClick: function () { props.onRemove(card.id); } }),
          ),
        h('div', { style: S.foot },
          h('span', { style: { fontFamily: MONO } }, card.sid.slice(0, 8)),
          h('span', { style: { marginLeft: 'auto' } }, card.humanIdle)),
      );
    }

    // ------------------------------------------------------------------ 线卡
    function ProjectBody(props) {
      var card = props.card;
      var dl = card.deadlines[0] || null;
      var dlColor = !dl ? LABEL2 : (dl.overdue || dl.urgent ? ERR : (dl.msLeft < 7 * 86400000 ? WARN : LABEL2));
      var editing = props.editing && props.editing.id === card.id;
      // 删线卡只记一个 hidden，不动 projects.json，所以再做一道「真删掉？」确认。
      var confirmBox = React.useState(false);
      var setConfirm = confirmBox[1];

      return h('div', null,
        h('div', { style: S.head },
          h('div', { style: Object.assign({}, S.bar3, { background: card.color }) }),
          h('span', { style: S.title }, card.name),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 4 } },
            card.live && card.live.busy
              ? h(Chip, { color: BRAND, border: 'rgba(75,139,245,.5)' }, card.live.busy + ' 个在跑')
              : null,
            h(Chip, { color: card.status === 'active' ? LABEL : LABEL2, style: { background: BG1 } }, card.statusLabel),
            dl ? h(Chip, { color: dlColor, border: dlColor }, dl.overdue ? '已过期' : dl.humanLeft) : null),
        ),
        card.brief ? h('div', { style: S.brief }, card.brief) : null,

        h(Progress, { stage: card.stage, color: card.color }),

        card.nextStep
          ? h('div', { style: S.sect },
            h('div', { style: S.sectHead }, '到这一步'),
            h('div', { style: { fontSize: 11.5 } }, card.nextStep),
            card.nextDetail
              ? h('div', { style: { fontSize: 10.5, color: LABEL2, marginTop: 1 } }, card.nextDetail)
              : null)
          : null,

        (card.laterSteps && card.laterSteps.length)
          ? h(Section, { title: '后面还排着', right: card.laterSteps.length + ' 条' },
            card.laterSteps.map(function (s, i) {
              return h('div', { key: 's' + i, style: S.step },
                h('span', { style: Object.assign({}, S.stepDot, { background: card.color }) }),
                h('span', { style: S.stepText },
                  s.text,
                  s.detail ? h('span', { style: S.stepDetail }, s.detail) : null),
              );
            }))
          : null,

        card.advice.length
          ? h(Section, { title: '该注意' },
            card.advice.map(function (a, i) {
              return h('div', {
                key: 'a' + i,
                style: Object.assign({}, S.advice, { borderLeftColor: KIND_COLOR[a.kind] || BORDER2 }),
              }, a.text);
            }))
          : null,

        card.live && card.live.count
          ? h(Section, { title: '在跑的会话', right: card.live.count + ' 个' },
            (card.live.items && card.live.items.length ? card.live.items : (card.live.names || []).map(function (n) {
              return { title: n };
            })).map(function (it, i) {
              return h('div', { key: 'lv' + i, style: { padding: '3px 0', borderTop: i ? '1px solid ' + BORDER : 'none' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 } },
                  it.busy ? h('span', { className: 'pt-live', style: Object.assign({}, S.dot, { background: BRAND }) }) : null,
                  h('span', { style: { color: LABEL, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.title),
                  h('span', { style: { marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: LABEL3 } },
                    it.turns ? (it.turns + ' 回合') : '')),
                it.currentStep
                  ? h('div', { style: S.stepDetail },
                    (it.currentKind === 'step' ? '这一步：' : '最后一句：')
                    + (it.currentStep.length > 46 ? it.currentStep.slice(0, 46) + '…' : it.currentStep))
                  : null);
            }))
          : null,

        card.note ? h(Section, { title: '我写的备注' }, h('div', { style: { fontSize: 11 } }, card.note)) : null,

        editing
          ? h(EditForm, {
            draft: props.draft, onChange: props.onDraft, onSave: props.onSaveEdit,
            onCancel: props.onCancelEdit, saving: props.saving, withSteps: false,
          })
          : h('div', { style: S.actions },
            h(Btn, { label: '收纳', onClick: function () { props.onFlag(card.id, 'shelf', true); } }),
            h(Btn, { label: '备注', onClick: function () { props.onEdit(card); } }),
            confirmBox[0]
              ? h(Btn, {
                label: '真删掉？',
                tone: 'danger',
                onClick: function () { setConfirm(false); props.onRemove(card.id); },
              })
              : h(Btn, {
                label: '删除',
                tone: 'danger',
                onClick: function () { setConfirm(true); },
              }),
          ),

        h('div', { style: S.foot },
          card.file ? h('span', { style: { fontFamily: MONO } }, card.file) : h('span', null, '没有交接单'),
          dl ? h('span', null, '截止 ' + dl.label + ' · ' + dl.humanAt) : null,
          card.idleDays !== null && card.idleDays !== undefined
            ? h('span', { style: { marginLeft: 'auto' } }, card.idleDays === 0 ? '今天动过' : card.idleDays + ' 天没动')
            : null),
      );
    }

    // ------------------------------------------------------------------ 自己的卡
    function ManualBody(props) {
      var card = props.card;
      var editing = props.editing && props.editing.id === card.id;
      return h('div', null,
        h('div', { style: S.head },
          h('div', { style: Object.assign({}, S.bar3, { background: card.color }) }),
          h('span', { style: S.title }, card.name),
          h('span', { style: { marginLeft: 'auto' } }, h(Chip, null, card.shelf ? '收纳中' : '自己加的')),
        ),
        card.note ? h('div', { style: S.brief }, card.note) : null,
        card.steps && card.steps.length
          ? h(Section, { title: '步骤', right: card.steps.length + ' 条' },
            card.steps.map(function (s, i) {
              return h('div', { key: 'st' + i, style: S.step },
                h('span', { style: Object.assign({}, S.stepDot, { background: card.color }) }),
                h('span', { style: S.stepText }, s.text,
                  s.detail ? h('span', { style: S.stepDetail }, s.detail) : null),
              );
            }))
          : null,
        editing
          ? h(EditForm, {
            draft: props.draft, onChange: props.onDraft, onSave: props.onSaveEdit,
            onCancel: props.onCancelEdit, saving: props.saving, withSteps: true,
          })
          : h('div', { style: S.actions },
            h(Btn, { label: '编辑内容', onClick: function () { props.onEdit(card); } }),
            h(Btn, {
              label: card.shelf ? '从收纳取回' : '收纳',
              onClick: function () { props.onFlag(card.id, 'shelf', !card.shelf); },
            }),
            h(Btn, { label: '删除', tone: 'danger', onClick: function () { props.onRemove(card.id); } }),
          ),
        h('div', { style: S.foot },
          h('span', { style: { fontFamily: MONO } }, 'cards.json'),
          h('span', { style: { marginLeft: 'auto' } }, card.createdAt ? clockOf(Date.parse(card.createdAt)) : '')),
      );
    }

    // ------------------------------------------------------------------ 收纳
    function ShelfBody(props) {
      var items = props.data.shelf || [];
      var groups = [
        { title: '会话', items: items.filter(function (c) { return c.kind === 'session'; }) },
        { title: '线', items: items.filter(function (c) { return c.kind === 'project'; }) },
        { title: '自己的卡', items: items.filter(function (c) { return c.kind === 'manual'; }) },
      ].filter(function (g) { return g.items.length; });

      return h('div', null,
        h('div', { style: S.head },
          h('div', { style: Object.assign({}, S.bar3, { background: BORDER2 }) }),
          h('span', { style: S.title }, '收纳 · ' + items.length + ' 张'),
          h('span', { style: { marginLeft: 'auto' } }, h(Chip, null, '随时取回')),
        ),
        items.length === 0 ? h('div', { style: S.empty }, '收纳是空的：卡上的「收纳」把它收进来。') : null,
        groups.map(function (group) {
          return h(Section, { key: group.title, title: group.title, right: String(group.items.length) },
            group.items.map(function (card) {
              return h('div', { key: card.id, style: S.row },
                h('span', { style: Object.assign({}, S.dot, { background: card.color }) }),
                h('span', { style: S.rowName }, card.name),
                h('span', { style: S.rowMeta },
                  card.kind === 'session'
                    ? (card.humanIdle + ' · 第' + card.turns + '回合')
                    : (card.kind === 'project' && card.stage && card.stage.total
                      ? card.stage.done + '/' + card.stage.total
                      : '')),
                h(Btn, { label: '取回', onClick: function () { props.onFlag(card.id, 'shelf', false); } }),
                h(Btn, { label: '删', tone: 'danger', onClick: function () { props.onRemove(card.id); } }),
              );
            }));
        }),
      );
    }

    // ------------------------------------------------------------------ 其余
    function MoreBody(props) {
      var data = props.data;
      var idle = data.idleSessions || [];
      var groups = [
        { title: '闲下来的会话（可固定）', items: idle, kind: 'session' },
        { title: '暂停', items: data.paused || [], kind: 'project' },
        { title: '别的线', items: data.rest || [], kind: 'project' },
      ].filter(function (g) { return g.items.length; });
      var listed = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
      var removed = data.hidden || [];
      var settings = data.settings || {};

      return h('div', null,
        h('div', { style: S.head },
          h('div', { style: Object.assign({}, S.bar3, { background: BORDER2 }) }),
          h('span', { style: S.title }, '其余 ' + listed),
          h('span', { style: { marginLeft: 'auto' } }, h(Chip, null, '最近 ' + (data.windowHours || 12) + 'h')),
        ),
        groups.map(function (group) {
          return h(Section, { key: group.title, title: group.title, right: String(group.items.length) },
            group.items.slice(0, 10).map(function (card) {
              return h('div', { key: card.id, style: { padding: '4px 0', borderTop: '1px solid ' + BORDER } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 5 } },
                  h('span', { style: Object.assign({}, S.dot, { background: card.color }) }),
                  h('span', { style: S.rowName }, card.name),
                  h('span', { style: S.rowMeta },
                    card.kind === 'session'
                      ? card.humanIdle + ' · ' + card.turns + ' 回合'
                      : (card.stage && card.stage.total ? card.stage.done + '/' + card.stage.total : card.statusLabel)),
                  card.kind === 'session'
                    ? h(Btn, { label: '固定', onClick: function () { props.onFlag(card.id, 'pinned', true); } })
                    : h(Btn, { label: '收纳', onClick: function () { props.onFlag(card.id, 'shelf', true); } }),
                ),
                card.kind === 'session'
                  ? (card.currentStep ? h('span', { style: S.moreNext }, card.currentStep) : null)
                  : ((card.nextStep || card.brief) ? h('span', { style: S.moreNext }, card.nextStep || card.brief) : null),
              );
            }),
            group.items.length > 10
              ? h('div', { style: { fontSize: 10, color: LABEL3, paddingTop: 3 } }, '… 另外 ' + (group.items.length - 10) + ' 条')
              : null);
        }),
        removed.length
          ? h(Section, { title: '已删除（可恢复）', right: String(removed.length) },
            removed.map(function (card) {
              return h('div', { key: 'rm-' + card.id, style: { padding: '4px 0', borderTop: '1px solid ' + BORDER } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 5 } },
                  h('span', { style: Object.assign({}, S.dot, { background: card.color || BORDER2 }) }),
                  h('span', { style: S.rowName }, card.name),
                  h('span', { style: S.rowMeta }, card.kind === 'session' ? '会话卡' : '线卡'),
                  h(Btn, {
                    label: '恢复',
                    onClick: function () { props.onFlag(card.id, 'hidden', false); },
                  }),
                ),
              );
            }),
            h('div', { style: { fontSize: 10, color: LABEL3, paddingTop: 3 } },
              '删线卡只是从条带里藏起来，projects.json 那条线还在。'))
          : null,
        h(Section, { title: '自动会话卡' },
          h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' } },
            h(Btn, {
              label: settings.autoCards === false ? '已关掉' : '开着',
              on: settings.autoCards !== false,
              onClick: function () { props.onSettings({ autoCards: settings.autoCards === false }); },
            }),
            h(Btn, { label: '12 小时', on: (data.windowHours || 12) === 12, onClick: function () { props.onSettings({ windowHours: 12 }); } }),
            h(Btn, { label: '24 小时', on: (data.windowHours || 12) === 24, onClick: function () { props.onSettings({ windowHours: 24 }); } }),
            h(Btn, { label: '3 张', on: (settings.maxLive || 3) === 3, onClick: function () { props.onSettings({ maxLive: 3 }); } }),
            h(Btn, { label: '5 张', on: (settings.maxLive || 3) === 5, onClick: function () { props.onSettings({ maxLive: 5 }); } }),
          ),
          h('div', { style: { fontSize: 10, color: LABEL3, marginTop: 4 } },
            '关掉之后只留你固定过的会话卡。'),
        ),
      );
    }

    // ------------------------------------------------------------------- 主体
    function Tabs(props) {
      var dataBox = React.useState(null);
      var data = dataBox[0];
      var setData = dataBox[1];

      // initialOpen 只给离屏截图用（真跑时永远是空）。
      var openBox = React.useState((props && props.initialOpen) || '');
      var open = openBox[0];
      var setOpen = openBox[1];

      var errBox = React.useState('');
      var error = errBox[0];
      var setError = errBox[1];

      var flashBox = React.useState('');
      var flash = flashBox[0];
      var setFlash = flashBox[1];

      var editBox = React.useState(null);     // { id, kind, draft }
      var editing = editBox[0];
      var setEditing = editBox[1];

      var addBox = React.useState((props && props.initialAdding) || null); // { title, note } | null
      var adding = addBox[0];
      var setAdding = addBox[1];

      var savingBox = React.useState(false);
      var saving = savingBox[0];
      var setSaving = savingBox[1];

      var timer = React.useRef(null);
      var flashTimer = React.useRef(null);

      var load = React.useCallback(function () {
        api('/cards').then(function (d) {
          setData(d);
          setError('');
        }).catch(function (e) {
          setError(String((e && e.message) || e));
        });
      }, []);

      React.useEffect(function () {
        load();
        var id = setInterval(function () {
          // 页面在后台就别刷了，省得每秒读一遍盘。
          try { if (document && document.hidden) return; } catch (e) { /* ignore */ }
          load();
        }, POLL_MS);
        return function () { clearInterval(id); };
      }, [load]);

      React.useEffect(function () {
        function onKey(e) { if (e && e.key === 'Escape') { setOpen(''); setEditing(null); setAdding(null); } }
        try {
          window.addEventListener('keydown', onKey);
          return function () { window.removeEventListener('keydown', onKey); };
        } catch (e) { return undefined; }
      }, []);

      function say(text) {
        setFlash(text);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(function () { setFlash(''); }, 1800);
      }

      function run(op, okText) {
        setSaving(true);
        return mutate(op).then(function (body) {
          if (body.board) setData(body.board);
          setSaving(false);
          if (okText) say(okText);
          return body;
        }).catch(function (e) {
          setSaving(false);
          setError(String((e && e.message) || e));
        });
      }

      function cancelClose() {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      }
      function enter(id) { cancelClose(); setOpen(id); }
      function leave() {
        cancelClose();
        timer.current = setTimeout(function () {
          // 正在编辑/新增的时候不自动收，否则一移开手就白打了。
          if (!editing && !adding) setOpen('');
        }, CLOSE_DELAY);
      }
      function toggle(id) {
        cancelClose();
        setEditing(null);
        setAdding(null);
        setOpen(function (cur) { return cur === id ? '' : id; });
      }

      function startEdit(card) {
        setEditing({
          id: card.id,
          draft: {
            title: card.kind === 'project' ? (card.name || '') : (card.name || ''),
            note: card.note || '',
            steps: (card.steps || []).map(function (s) { return s.text + (s.detail ? ' —— ' + s.detail : ''); }).join('\n'),
          },
        });
      }

      function saveEdit() {
        if (!editing) return;
        var d = editing.draft;
        var steps = String(d.steps || '').split('\n').map(function (line) {
          var m = line.split(/\s+——\s+/);
          return { text: (m[0] || '').trim(), detail: (m[1] || '').trim() };
        }).filter(function (s) { return s.text; });
        run({ op: 'meta', id: editing.id, title: d.title, note: d.note, steps: steps }, '存好了')
          .then(function (body) { if (body && body.ok) setEditing(null); });
      }

      function saveAdd() {
        var d = adding || {};
        if (!String(d.title || '').trim()) { say('先给它起个名字'); return; }
        var steps = String(d.steps || '').split('\n').map(function (line) {
          var m = line.split(/\s+——\s+/);
          return { text: (m[0] || '').trim(), detail: (m[1] || '').trim() };
        }).filter(function (s) { return s.text; });
        run({ op: 'add', title: d.title, note: d.note, steps: steps }, '加上了')
          .then(function (body) { if (body && body.ok) setAdding(null); });
      }

      function onFlag(id, flag, value) {
        run({ op: 'flag', id: id, flag: flag, value: value },
          flag === 'shelf' ? (value ? '收进收纳了' : '取回来了') : (flag === 'pinned' ? (value ? '固定住了' : '取消固定') : ''));
      }

      function onRemove(id) {
        run({ op: 'remove', id: id }, '删掉了');
      }

      if (error && !data) {
        return h('div', { style: S.layer }, h('div', { style: S.errPill }, '标签角读不到数据：' + error));
      }
      if (!data || !data.ok) return null;

      var strip = data.strip || [];
      var counts = data.counts || {};
      var extraCount = (data.paused || []).length + (data.rest || []).length + (data.idleSessions || []).length;
      var shelfCount = (data.shelf || []).length;
      if (!strip.length && !extraCount && !shelfCount && !adding) return null;

      var entries = strip.map(function (card, index) {
        return { key: card.id, card: card, index: index, kind: card.kind };
      });
      var addKey = '__add';
      // 正在加卡的时候，那个「+」角本身就是表单，别再多画一个空的「+」。
      if (adding) entries.push({ key: addKey, index: entries.length, kind: 'add' });
      else entries.push({ key: '__plus', index: entries.length, kind: 'plus' });
      if (shelfCount) entries.push({ key: '__shelf', index: entries.length, kind: 'shelf' });
      if (extraCount) entries.push({ key: '__more', index: entries.length, kind: 'more' });

      var half = entries.length / 2;

      function bodyFor(entry) {
        var card = entry.card;
        if (!card && entry.kind !== 'add' && entry.kind !== 'shelf' && entry.kind !== 'more') return null;
        if (entry.kind === 'add') {
          return h(AddForm, {
            draft: adding || {},
            onChange: function (d) { setAdding(d); },
            onSave: saveAdd,
            onCancel: function () { setAdding(null); },
            saving: saving,
          });
        }
        if (entry.kind === 'shelf') {
          return h(ShelfBody, {
            data: data,
            onFlag: onFlag,
            onRemove: onRemove,
          });
        }
        if (entry.kind === 'more') {
          return h(MoreBody, {
            data: data,
            onFlag: onFlag,
            onSettings: function (patch) { run(Object.assign({ op: 'settings' }, patch), '改好了'); },
          });
        }
        var common = {
          card: card,
          editing: editing,
          draft: editing && editing.draft,
          onDraft: function (d) { setEditing({ id: editing.id, draft: d }); },
          onSaveEdit: saveEdit,
          onCancelEdit: function () { setEditing(null); },
          onEdit: startEdit,
          onFlag: onFlag,
          onRemove: onRemove,
          saving: saving,
        };
        if (card.kind === 'session') return h(SessionBody, common);
        if (card.kind === 'manual') return h(ManualBody, common);
        return h(ProjectBody, common);
      }

      return h('div', { style: S.layer },
        flash ? h('div', { style: S.flash }, flash) : null,
        // 没有 projects.json 不算坏：常驻一句提示，会话卡和手写卡照常用。
        !data.notice ? null : h('div', { style: S.notePill, title: data.notice }, '还没有项目线 —— 只有会话卡和手写卡'),
        h('div', { style: S.strip },
          entries.map(function (entry) {
            var on = open === entry.key;
            var card = entry.card;
            var urgent = card && card.deadlines ? card.deadlines.some(function (d) { return d.urgent || d.overdue; }) : false;

            var label;
            if (entry.kind === 'shelf') {
              label = [h('span', { key: 'd', style: Object.assign({}, S.dot, { background: BORDER2 }) }),
                h('span', { key: 'n', style: S.tabName }, '收纳 ' + shelfCount)];
            } else if (entry.kind === 'more') {
              label = [h('span', { key: 'd', style: Object.assign({}, S.dot, { background: BORDER2 }) }),
                h('span', { key: 'n', style: S.tabName }, '其余 ' + extraCount)];
            } else if (entry.kind === 'plus' || entry.kind === 'add') {
              label = [h('span', { key: 'p', style: S.plus }, '+')];
            } else if (card.kind === 'session') {
              label = [
                h('span', { key: 'd', style: card.busy ? S.dotLive : Object.assign({}, S.dot, { background: card.color }) }),
                h('span', { key: 'n', style: S.tabName }, card.name),
                h('span', { key: 'v', style: S.tabNum }, '第' + card.turns),
                card.pinned ? h('span', { key: 'p', style: Object.assign({}, S.dot, { background: WARN, width: 4, height: 4 }) }) : null,
              ];
            } else if (card.kind === 'manual') {
              label = [
                h('span', { key: 'd', style: Object.assign({}, S.dot, { background: card.color }) }),
                h('span', { key: 'n', style: S.tabName }, card.name),
              ];
            } else {
              label = [
                h('span', { key: 'd', style: Object.assign({}, S.dot, { background: card.color }) }),
                h('span', { key: 'n', style: S.tabName }, card.name),
                card.stage && card.stage.total
                  ? h('span', { key: 'v', style: S.tabNum }, card.stage.done + '/' + card.stage.total)
                  : null,
                urgent ? h('span', { key: 'u', style: S.alert }) : null,
              ];
            }

            var tabStyle = Object.assign({}, S.tab, on ? S.tabOn : null);
            if (card && card.kind === 'session' && card.busy) tabStyle = Object.assign({}, tabStyle, S.tabLive);

            return h('div', {
              key: entry.key,
              style: S.wrap,
              onMouseEnter: function () { enter(entry.key); },
              onMouseLeave: leave,
            },
              h('div', {
                style: tabStyle,
                onClick: function () {
                  if (entry.kind === 'plus') {
                    cancelClose();
                    setAdding(adding ? null : { title: '', note: '' });
                    setOpen(addKey);
                    return;
                  }
                  toggle(entry.key);
                },
                title: entry.kind === 'plus' ? '加一张自己的卡' : (card ? card.name : ''),
              }, label),

              on
                ? h('div', {
                  style: Object.assign({}, S.card,
                    entry.index < half ? { left: 0 } : { right: 0 }),
                  onMouseEnter: cancelClose,
                  onMouseLeave: leave,
                }, bodyFor(entry))
                : null,
            );
          }),
        ),
      );
    }

    var inject = ['slots'];

    function injectStyle() {
      try {
        if (!document || document.getElementById('project-tabs-style')) return;
        var style = document.createElement('style');
        style.id = 'project-tabs-style';
        style.textContent = '@keyframes pt-breathe{0%,100%{opacity:1}50%{opacity:.35}}'
          + '.pt-live{animation:pt-breathe 1.6s ease-in-out infinite}';
        document.head.appendChild(style);
      } catch (e) { /* ignore */ }
    }

    function apply(ctx) {
      // 启动内核要等**每个**条目激活完才 mount(container)。
      // apply() 里抛一次，整个界面就停在启动态 —— 2026-11-04 真这么死过一次：
      // package.json 的 dsh.client.inject 少写了 @deepseek-ai/dsh-client-ui-layout，
      // 而这个槽正是它的 AppFrame 声明的，于是 inject('shell.overlay') 抛错。
      // 所以这里一律不抛：挂不上就什么都不画，别的照常起来。
      injectStyle();
      try {
        var dispose = ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'project-tabs', order: 40 }, Tabs);
        });
        try { ctx.effect(function () { return dispose; }, 'project-tabs: top tabs'); } catch (e) { /* ignore */ }
      } catch (error) {
        try { console.warn('[project-tabs] 标签角没挂上（不影响其它）:', error && error.message); } catch (e) { /* ignore */ }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      Tabs: Tabs, SessionBody: SessionBody, ProjectBody: ProjectBody, ManualBody: ManualBody,
      ShelfBody: ShelfBody, MoreBody: MoreBody, Progress: Progress, pctOf: pctOf, api: api, mutate: mutate,
    };
    return module.exports;
  },
});
