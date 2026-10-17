// Knock Knock · 敲敲门（浏览器侧）：右侧栏「敲敲门」面板（今日 / 台账 / 诊断 / 设置）、输入框上方「今日备忘」、正文下「重新提取约定」。
// 皮肤：古风（宣纸 · 朱砂）或跟随 DSH 主题。
window.__ModuleLoader__.load({
  id: 'dsh-tavern-knock-knock',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const HOST = 'dsh-tavern-knock-knock/'
    const ui = { current: null }
    const cache = new Map()     // gameId -> status
    const watching = new Map()  // gameId -> cancel
    const listeners = new Set()

    // —— 日期 ——
    const CN_DAY = ['', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九', '三十']
    const CN_MONTH = ['', '正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']
    const CN_NUM = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
    const cnInt = n => { n = Math.round(n); if (n < 0) return String(n); if (n <= 10) return CN_NUM[n]; if (n < 20) return '十' + (n % 10 ? CN_NUM[n % 10] : ''); if (n < 100) return CN_NUM[Math.floor(n / 10)] + '十' + (n % 10 ? CN_NUM[n % 10] : ''); return String(n) }
    // 本局日历（面板渲染时从台账读）：lunar 古风 / gregorian 公历 / story 故事天数
    let curCal = 'lunar'
    const CAL_NAME = { lunar: '古风', gregorian: '公历', story: '故事天数' }
    const label = idx => {
      if (idx == null) return '—'
      if (curCal === 'story') return '第' + (idx + 1) + '天'
      if (curCal === 'gregorian') { const t = new Date(idx * 86400000); return (t.getUTCMonth() + 1) + '月' + t.getUTCDate() + '日' }
      const y = Math.floor(idx / 360), r = idx - y * 360; return CN_MONTH[Math.floor(r / 30) + 1] + CN_DAY[(r % 30) + 1]
    }
    const rel = (idx, T, cn) => {
      if (idx == null || T == null) return ''
      const n = idx - T, f = cn ? cnInt : String
      if (curCal !== 'lunar') return n === 0 ? '今天' : n === 1 ? '明天' : n === -1 ? '昨天' : n > 0 ? f(n) + '天后' : '已过' + f(-n) + '天'
      return n === 0 ? '今日' : n === 1 ? '明日' : n === -1 ? '昨日' : n > 0 ? f(n) + '日后' : '已过' + f(-n) + '日'
    }
    /** 日期输入：故事天数填“几天后”，其余填月、日。 */
    function DateInputs({ v, set }) {
      if (curCal === 'story') return h(React.Fragment, null, h(Input, { 'aria-label': '几天后', placeholder: '几天后', value: v.inDays || '', onChange: ev => set({ ...v, inDays: ev.target.value }), style: { width: 72 } }), h('span', { style: { fontSize: 12 } }, '天后'))
      return h(React.Fragment, null,
        h(Input, { 'aria-label': '月', placeholder: '月', value: v.month || '', onChange: ev => set({ ...v, month: ev.target.value }), style: { width: 48 } }),
        h(Input, { 'aria-label': '日', placeholder: '日', value: v.day || '', onChange: ev => set({ ...v, day: ev.target.value }), style: { width: 48 } }))
    }
    const KIND = { appointment: '约会', deadline: '期限', errand: '托办', debt: '借还', expect: '预计', memo: '备忘' }
    const STATUS = { done: '办完', cancelled: '取消', missed: '失约', faded: '没下文', lapsed: '没下文' }
    const W = { high: '高', mid: '中', low: '低' }
    const RANK = { high: 0, mid: 1, low: 2 }
    const effW = e => e.weightLock || (e.mentions && e.mentions.count >= 3 ? (e.weight === 'low' ? 'mid' : 'high') : (e.weight || 'mid'))

    // —— 皮肤 ——
    const SKINS = {
      ancient: {
        bg: '#F3ECDD', card: '#FAF6EC', line: '#D8CBB0', line2: '#E7DDC9', btnLine: '#C9B894',
        ink: '#2A2420', ink2: '#685D52', ink3: '#7A6E61', accent: '#A3322A', onAccent: '#FAF6EC', accentSoft: '#F7E9E1', link: '#8E2A22',
        warn: '#9A2E25', ok: '#3E5E3A', okBg: '#E3EAD9', mid: '#2F5560', midBg: '#E1E7E2', lowBg: '#EBE3D2',
        playerInk: '#6E4A12', playerBg: '#F1E1BA', worldBg: '#E7DFCE', errBg: '#F6E3DC', errLine: '#DDB3A8', dangerLine: '#D9AFA6',
        font: "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', serif", mono: "'Noto Serif SC', 'Songti SC', 'SimSun', serif",
        r: 3, rb: 2, cn: true, seal: true, rule: '3px double #C9B894', track: '0.1em',
      },
      host: {
        bg: 'transparent', card: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))', line: 'var(--dsw-alias-border-l2, rgba(127,127,127,.28))', line2: 'var(--dsw-alias-border-l1, rgba(127,127,127,.16))', btnLine: 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
        ink: 'var(--dsw-alias-label-primary, inherit)', ink2: 'var(--dsw-alias-label-secondary, inherit)', ink3: 'var(--dsw-alias-label-tertiary, inherit)',
        accent: 'var(--dsh-tavern-accent, var(--dsw-alias-brand-primary, #4D6BFE))', onAccent: '#fff', accentSoft: 'var(--dsh-tavern-accent-soft, rgba(77,107,254,.12))', link: 'var(--dsh-tavern-accent, var(--dsw-alias-brand-primary, #4D6BFE))',
        warn: 'var(--dsw-alias-state-error-primary, #d33)', ok: 'var(--dsw-alias-state-business-primary, #2a7a4b)', okBg: 'rgba(42,122,75,.12)', mid: 'var(--dsh-tavern-accent, #4D6BFE)', midBg: 'var(--dsh-tavern-accent-soft, rgba(77,107,254,.12))', lowBg: 'rgba(127,127,127,.12)',
        playerInk: 'var(--dsw-alias-state-warn-label, #8a4b00)', playerBg: 'var(--dsw-alias-state-warn-tertiary, rgba(255,170,0,.16))', worldBg: 'rgba(127,127,127,.12)', errBg: 'rgba(220,50,50,.08)', errLine: 'rgba(220,50,50,.3)', dangerLine: 'rgba(220,50,50,.35)',
        font: 'inherit', mono: 'var(--ds-font-family-code, ui-monospace, monospace)',
        r: 8, rb: 6, cn: false, seal: false, rule: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))', track: '0',
      },
    }
    const skinOf = s => SKINS[(s && s.settings && s.settings.skin) === 'host' ? 'host' : 'ancient']
    const SkinCtx = React.createContext(SKINS.ancient)
    const useP = () => React.useContext(SkinCtx)

    // —— 小组件 ——
    function Btn({ kind, children, style, ...rest }) {
      const P = useP()
      const base = { height: 30, padding: '0 12px', borderRadius: P.rb, font: 'inherit', fontSize: 12, cursor: rest.disabled ? 'default' : 'pointer', opacity: rest.disabled ? 0.55 : 1, whiteSpace: 'nowrap' }
      const look = kind === 'primary' ? { border: '1px solid ' + P.accent, background: P.accent, color: P.onAccent }
        : kind === 'danger' ? { border: '1px solid ' + P.dangerLine, background: 'transparent', color: P.warn }
          : kind === 'link' ? { border: 0, background: 'transparent', color: P.link, padding: 0, height: 'auto', alignSelf: 'flex-start' }
            : { border: '1px solid ' + P.btnLine, background: 'transparent', color: P.ink }
      return h('button', { type: 'button', ...rest, style: { ...base, ...look, ...style } }, children)
    }
    function Tag({ tone, children, title }) {
      const P = useP()
      const t = { high: { color: P.accent, border: '1px solid ' + P.accent, background: 'transparent', fontWeight: 700 }, mid: { color: P.mid, background: P.midBg, fontWeight: 700 }, low: { color: P.ink2, background: P.lowBg },
        player: { color: P.playerInk, background: P.playerBg }, world: { color: P.ink, background: P.worldBg }, ok: { color: P.ok, background: P.okBg }, plain: { color: P.ink2, background: P.lowBg }, warn: { color: P.warn, border: '1px solid ' + P.warn } }[tone] || {}
      return h('span', { title, style: { display: 'inline-block', fontSize: 11, lineHeight: '18px', padding: '0 6px', borderRadius: P.rb, flex: 'none', ...t } }, children)
    }
    function Section({ title, hint, marker, children, muted }) {
      const P = useP()
      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 2px', gap: 8 } },
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: P.track, color: muted ? P.ink2 : P.ink, display: 'flex', alignItems: 'center', gap: 8 } },
            P.cn ? h('span', { 'aria-hidden': true, style: { width: 6, height: 6, transform: 'rotate(45deg)', background: muted ? 'transparent' : (marker || P.accent), border: muted ? '1px solid ' + P.ink3 : 0 } }) : null, title),
          hint ? h('span', { style: { fontSize: 12, color: P.ink3 } }, hint) : null),
        children)
    }
    function Card({ children, style, onClick, selected }) {
      const P = useP()
      return h('div', { onClick, style: { background: P.card, border: '1px solid ' + (selected ? P.accent : P.line), borderRadius: P.r, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, ...(selected ? { boxShadow: '0 4px 14px rgba(80,50,20,.10)' } : null), ...style } }, children)
    }
    function Rows({ children, dashed }) {
      const P = useP()
      return h('div', { style: { background: dashed ? 'transparent' : P.card, border: (dashed ? '1px dashed ' : '1px solid ') + (dashed ? P.btnLine : P.line), borderRadius: P.r, display: 'flex', flexDirection: 'column' } }, children)
    }
    function Row({ left, right, last, muted }) {
      const P = useP()
      return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 12px', borderBottom: last ? 0 : '1px solid ' + P.line2, color: muted ? P.ink2 : P.ink, alignItems: 'center' } },
        h('span', { style: { minWidth: 0 } }, left), h('span', { style: { flex: 'none', fontSize: 12, color: P.ink3, display: 'flex', gap: 6, alignItems: 'center' } }, right))
    }
    const Muted = ({ children }) => { const P = useP(); return h('div', { style: { fontSize: 12, color: P.ink3 } }, children) }
    const Quote = ({ children }) => { const P = useP(); return children ? h('div', { style: { fontSize: 12, color: P.ink2 } }, '「' + children + '」') : null }

    // —— 数据 ——
    const call = (name, args) => ui.current.callHost(HOST + name, args)
    async function fetchStatus(gameId) {
      const s = await call('status', { gameId })
      cache.set(gameId, s)
      listeners.forEach(fn => fn(gameId))
      return s
    }
    function ensureWatch(gameId) {
      if (!gameId || watching.has(gameId) || typeof ui.current.watchTurnState !== 'function') return
      let last = null
      const cancel = ui.current.watchTurnState(gameId, st => {
        const key = st ? [st.turn, st.textVersion, st.busy].join('|') : ''
        if (key !== last) { last = key; if (st && !st.busy) fetchStatus(gameId).catch(() => {}) }
      })
      watching.set(gameId, cancel)
    }
    function useStatus(gameId) {
      const [s, setS] = React.useState(cache.get(gameId) || null)
      const [err, setErr] = React.useState('')
      React.useEffect(() => {
        const fn = id => { if (id === gameId) setS(cache.get(gameId)) }
        listeners.add(fn)
        ensureWatch(gameId)
        fetchStatus(gameId).catch(e => setErr(String(e && e.message || e)))
        const t = setInterval(() => fetchStatus(gameId).catch(() => {}), 30000)
        return () => { listeners.delete(fn); clearInterval(t) }
      }, [gameId])
      // 正在提取或回放时，勤快一点刷新
      React.useEffect(() => {
        if (!s || !(s.running || (s.replay && s.replay.progress))) return
        const t = setInterval(() => fetchStatus(gameId).catch(() => {}), 3000)
        return () => clearInterval(t)
      }, [gameId, s && !!(s.running || (s.replay && s.replay.progress))])
      return [s, err, () => fetchStatus(gameId).then(() => setErr(''), e => setErr(String(e && e.message || e)))]
    }
    const fillText = p => p.title + (p.who && p.who.length ? '（' + p.who.join('、') + '）' : '')

    // —— 今日备忘（面板和浮层共用） ——
    function MemoList({ s, busy, act, onFill, onMore, compact }) {
      const P = useP()
      const items = (s.ledger && s.ledger.plan && s.ledger.plan.player) || []
      if (!items.length) return h(Muted, null, '眼下没有到期的主角事项。')
      return h(React.Fragment, null, ...items.map(p => h(Card, { key: p.id, style: compact ? { background: p.kind === 'overdue' ? P.playerBg : P.card } : null },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' } },
          h('span', { style: { fontWeight: 700, fontSize: 14 } }, p.title),
          h(Tag, { tone: p.weight }, W[p.weight] || '中')),
        h('div', { style: { fontSize: 12, color: p.kind === 'overdue' ? P.warn : P.ink } },
          (p.kind === 'overdue' ? '已过' + (P.cn ? cnInt(p.days) : p.days) + '日' : '约 ' + p.whenLabel) + (p.who && p.who.length ? ' · ' + p.who.join('、') : '')),
        compact ? null : h(Quote, null, p.evidence),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 } },
          h(Btn, { kind: 'primary', disabled: busy, onClick: () => onFill(p) }, '填入输入框'),
          h(Btn, { disabled: busy, onClick: act({ type: 'done', id: p.id }) }, '已办'),
          h(Btn, { disabled: busy, onClick: act({ type: 'snooze', id: p.id, days: 3 }) }, '延后三天'),
          onMore ? h(Btn, { 'aria-label': '更多操作', disabled: busy, onClick: () => onMore(p.id), style: { width: 32, padding: 0 } }, '⋯') : null))))
    }

    // —— 今日 ——
    function ModelHint({ s, busy, run, goSettings }) {
      const P = useP()
      const st = s.settings || {}
      if (st.model || st.modelHintSeen || !s.extractModel || s.extractModel.chosen) return null
      return h(Card, { style: { borderStyle: 'dashed' } },
        h('div', { style: { fontSize: 12, color: P.ink2 } }, '记账用的是本局后台模型（' + s.extractModel.name + '），每轮写完都会调用一次。它若较贵，可以在设置里换个便宜、快的小模型。'),
        h('div', { style: { display: 'flex', gap: 6 } },
          h(Btn, { disabled: busy, onClick: goSettings }, '去设置'),
          h(Btn, { kind: 'link', disabled: busy, style: { alignSelf: 'center' }, onClick: () => run('settings', { settings: { ...st, modelHintSeen: true } }) }, '知道了，不再提示')))
    }
    function TodayTab({ s, busy, act, run, fill, goSettings, openEntry }) {
      const P = useP()
      const l = s.ledger
      const eff = s.effective || s.settings || {}
      const plan = l.plan || {}
      const world = plan.world || []
      const held = plan.held || []
      const strength = (s.ledger && s.ledger.plan && s.ledger.plan.strength) || (eff.remind === 'off' ? 'off' : 'auto')
      return h(React.Fragment, null,
        h(ModelHint, { s, busy, run, goSettings }),
        (l.entries || []).some(e => e.suggest) ? h(Section, { title: '等你决定', hint: '你确认过的事，正文里似乎有变' },
          ...(l.entries || []).filter(e => e.suggest).map(e => h(Card, { key: e.id }, h('span', { style: { fontWeight: 700 } }, e.title), h(SuggestBox, { e, busy, act })))) : null,
        ...(l.warnings || []).map((w, i) => h('div', { key: 'w' + i, style: { fontSize: 12, color: P.warn } }, '⚠ ' + w)),
        h(Section, { title: '主角的事', hint: eff.playerToStory === false ? '只提醒你' : '也会由相关的人在正文里问一句' },
          h(MemoList, { s, busy, act, onFill: fill, onMore: openEntry })),
        h(Section, { title: '下一轮会提的事', hint: strength === 'off' || strength === 'archive' ? '只记账：不告诉正文' : '到时间提一次，过期再提一次', marker: P.mid },
          world.length ? h(React.Fragment, null,
            ...world.map((p, i) => h(Card, { key: p.ref || i },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                h('span', { style: { fontWeight: 700 } }, p.kind === 'festival' ? '节令 · ' + p.title : p.title),
                h('span', { style: { flex: 'none', fontSize: 12, color: P.ink2 } }, p.whenLabel || '')),
              p.kind === 'festival' ? h(Muted, null, '场景合适时可带一笔当地节俗。')
                : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  ...(p.signals || []).map(sg => h(Tag, { key: sg, tone: 'ok' }, sg)),
                  p.toMe ? h(Tag, { tone: 'mid' }, '等回应') : null,
                  p.kind === 'overdue' || p.kind === 'ask' ? h(Tag, { tone: 'warn' }, '已过期') : null,
                  p.kind === 'ask' || p.kind === 'ask-due' || p.kind === 'npc' ? h(Tag, { tone: 'player' }, '主角答应的') : null))),
            plan.overflow ? h(Muted, null, '另有 ' + plan.overflow + ' 项超出每轮上限，未列出。') : null,
            h('details', { style: { background: P.card, border: '1px solid ' + P.line, borderRadius: P.r, padding: '8px 12px' } },
              h('summary', { style: { fontSize: 12, color: P.link, cursor: 'pointer' } }, '看实际写进请求的原文'),
              h('pre', { style: { margin: '8px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: P.mono, fontSize: 12, color: P.ink, background: P.bg === 'transparent' ? P.lowBg : P.bg, padding: '8px 10px', borderLeft: '2px solid ' + P.btnLine } }, s.preview)))
            : h(Muted, null, strength === 'off' || strength === 'archive' ? '设置为「只记账」，不往正文里加东西。' : '下一轮没有到时间的事。')),
        held.length ? h(Section, { title: '排在后面', hint: '超出每轮上限，下一轮再提', muted: true },
          h(Rows, null, ...held.map((x, i) => h(Row, { key: x.id, last: i === held.length - 1, left: x.title, right: '相关性 ' + (P.cn ? cnInt(x.rel || 0) : x.rel || 0) + (x.signals && x.signals.length ? ' · ' + x.signals.join('、') : '') })))) : null)
    }

    // —— 模型想改你确认过的事：等你决定 ——
    function SuggestBox({ e, busy, act }) {
      const P = useP()
      const sg = e.suggest
      if (!sg) return null
      const what = sg.op === 'reschedule' ? '改到 ' + (sg.when ? sg.when.label : '另一天') : sg.op === 'cancel' ? '取消' : sg.op === 'missed' ? '算作失约' : sg.op
      return h('div', { style: { fontSize: 12, background: P.playerBg, color: P.playerInk, borderRadius: P.rb, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 4 } },
        h('span', null, '正文里似乎要' + what + (sg.turn != null ? '（第' + sg.turn + '轮）' : '') + '：「' + sg.quote + '」'),
        h('span', { style: { display: 'flex', gap: 6 } },
          h(Btn, { kind: 'primary', disabled: busy, style: { height: 26 }, onClick: act({ type: 'acceptSuggest', id: e.id }) }, '照改'),
          h(Btn, { disabled: busy, style: { height: 26 }, onClick: act({ type: 'dismissSuggest', id: e.id }) }, '不改')))
    }
    // —— 台账 ——
    function EntryCard({ e, T, busy, run, act, expanded, onToggle, prot }) {
      const P = useP()
      const [edit, setEdit] = React.useState(false)
      const [m, setM] = React.useState(null)
      const w = effW(e)
      const reschedules = (e.log || []).filter(x => x.op === 'reschedule').length
      const snoozed = e.snoozeUntil != null && T != null && T < e.snoozeUntil
      const relScore = e.rel ? e.rel.score : 0
      const who = (e.who || []).filter(x => x !== prot)
      return h(Card, { selected: expanded },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }, onClick: onToggle },
          h('span', { style: { fontWeight: 700, fontSize: 14 } }, e.title),
          h('span', { style: { display: 'flex', gap: 4, flex: 'none' } }, e.intent ? h(Tag, { tone: 'plain', title: '只是表态，没说定：只记不提，过一阵没动静自然放下' }, '意向') : null, e.confirmed ? h(Tag, { tone: 'ok', title: '你确认过：模型的改期、取消要你点头才生效' }, '已确认') : null, h(Tag, { tone: e.side === 'world' ? 'world' : 'player' }, e.side === 'world' ? '世界' : '主角'), h(Tag, { tone: w }, W[w]))),
        h('div', { style: { fontSize: 12, color: e.when && T != null && T > e.when.end ? P.warn : P.ink } },
          (e.when ? e.when.label + ' · ' + (T != null && e.when.end > e.when.idx && T >= e.when.idx && T <= e.when.end ? (curCal === 'lunar' ? '正在这几日' : '就在这几天') : rel(e.when.idx, T, P.cn)) : '无日期') + (who.length ? ' · ' + who.join('、') : '') + (e.place ? ' · ' + e.place : '')),
        h(Quote, null, e.evidence),
        h(SuggestBox, { e, busy, act }),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: P.ink3, gap: 8 } },
          h('span', null, (e.created && e.created.turn != null ? '第' + (P.cn ? cnInt(e.created.turn) : e.created.turn) + '轮记入' : { manual: '手动备忘', rebuild: '重建' }[e.source] || '') +
            (reschedules ? ' · 改期' + (P.cn ? cnInt(reschedules) : reschedules) + '次' : '') + (e.frozen ? ' · 已冻结' : '') + (snoozed ? ' · 延后至' + label(e.snoozeUntil) : '') +
            (e.quiet ? ' · ' + (P.cn ? cnInt(e.quiet.left) : e.quiet.left) + '日后放手' : '')),
          h('span', { title: e.rel && e.rel.signals ? e.rel.signals.join('、') : '' }, '相关 ', h('span', { style: { color: P.accent } }, '●'.repeat(Math.min(4, relScore))), '○'.repeat(Math.max(0, 4 - Math.min(4, relScore))))),
        expanded ? h(React.Fragment, null,
          (e.log || []).length ? h('details', { open: true, style: { fontSize: 12, color: P.ink2 } }, h('summary', { style: { cursor: 'pointer' } }, '变动记录 ' + (P.cn ? cnInt(e.log.length) : e.log.length)),
            ...e.log.map((x, i) => h('div', { key: i, style: { padding: '2px 0 0 10px', borderLeft: '1px solid ' + P.line, marginLeft: 4 } }, (x.turn != null ? '第' + x.turn + '轮 ' : '') + ({ add: '新增', intent: '意向', confirm: '说定', reschedule: '改期', progress: '进展', done: '办完', cancel: '取消', missed: '失约' }[x.op] || x.op) + '：' + x.quote))) : null,
          h('div', { style: { marginTop: 4, paddingTop: 10, borderTop: '1px dashed ' + P.line, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 } },
            h(Btn, { disabled: busy, onClick: act({ type: 'done', id: e.id }) }, '已办'),
            h(Btn, { disabled: busy, onClick: act({ type: 'cancel', id: e.id }) }, '取消'),
            h(Btn, { disabled: busy, onClick: () => setEdit(!edit) }, '改日期'),
            h(Btn, { disabled: busy, onClick: act({ type: 'side', id: e.id, side: e.side === 'world' ? 'player' : 'world' }) }, e.side === 'world' ? '改为主角的事' : '改为世界的事'),
            h(Btn, { disabled: busy, onClick: act({ type: e.frozen ? 'unfreeze' : 'freeze', id: e.id }) }, e.frozen ? '解冻' : '冻结'),
            snoozed ? h(Btn, { disabled: busy, onClick: act({ type: 'unsnooze', id: e.id }) }, '取消延后') : h(Btn, { disabled: busy, onClick: act({ type: 'snooze', id: e.id, days: 3 }) }, '延后三天'),
            e.intent ? h(Btn, { disabled: busy, onClick: act({ type: 'confirm', id: e.id }) }, '算说定了')
              : e.confirmed ? h(Btn, { disabled: busy, onClick: act({ type: 'unconfirm', id: e.id }) }, '取消确认')
                : h(Btn, { kind: 'primary', disabled: busy, onClick: act({ type: 'confirm', id: e.id }) }, '确认无误'),
            e.intent ? null : h(Btn, { disabled: busy, onClick: act({ type: 'intent', id: e.id }) }, '只是意向')),
          h(Muted, null, e.intent ? '意向：只记不提，过一阵没动静自然放下。说定了点「算说定了」。' : '确认后，模型想改期、取消这一条，要你点头才生效。你改过日期、归属的，也算确认。'),
          edit ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h(DateInputs, { v: m || {}, set: setM }),
            h(Btn, { kind: 'primary', disabled: busy, onClick: () => { run('action', { action: { type: 'when', id: e.id, ...(m || {}) } }); setEdit(false); setM(null) } }, '保存'),
            h(Btn, { disabled: busy, onClick: () => { run('action', { action: { type: 'clearWhen', id: e.id } }); setEdit(false) } }, '清除日期')) : null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: P.ink2, flexWrap: 'wrap' } },
            h('span', null, '分量'),
            h('div', { style: { display: 'flex', border: '1px solid ' + P.btnLine, borderRadius: P.rb, overflow: 'hidden' } },
              ...['high', 'mid', 'low'].map((k, i) => h('button', { key: k, type: 'button', disabled: busy, onClick: () => run('action', { action: { type: 'weight', id: e.id, weight: k } }),
                style: { height: 28, padding: '0 12px', border: 0, borderRight: i < 2 ? '1px solid ' + P.btnLine : 0, font: 'inherit', fontSize: 12, cursor: 'pointer', background: w === k ? (k === 'high' ? P.accentSoft : k === 'mid' ? P.midBg : P.lowBg) : 'transparent', color: w === k ? (k === 'high' ? P.accent : k === 'mid' ? P.mid : P.ink) : P.ink, fontWeight: w === k ? 700 : 400 } }, W[k]))),
            e.weightLock ? h(Btn, { kind: 'link', disabled: busy, onClick: () => run('action', { action: { type: 'weight', id: e.id, weight: null } }) }, '已锁定 · 改回自动') : h('span', { style: { color: P.ink3 } }, '自动' + (w !== (e.weight || 'mid') ? '（被提到多次，升了一档）' : ''))),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, h(Btn, { kind: 'danger', disabled: busy, onClick: act({ type: 'delete', id: e.id }) }, '删除'))) : null)
    }
    function Input(props) {
      const P = useP()
      return h('input', { ...props, style: { height: 32, padding: '0 8px', border: P.cn ? 0 : '1px solid ' + P.btnLine, borderBottom: '1px solid ' + P.btnLine, borderRadius: P.cn ? 0 : P.rb, background: 'transparent', color: P.ink, font: 'inherit', fontSize: 13, minWidth: 0, ...props.style } })
    }
    function GroupTitle({ children, hint }) {
      const P = useP()
      return h('h3', { style: { margin: 0, padding: '0 2px', fontSize: 13, fontWeight: 700, color: P.ink2, letterSpacing: P.cn ? '0.2em' : 0, display: 'flex', alignItems: 'center', gap: 8 } },
        children, h('span', { 'aria-hidden': true, style: { flex: 1, height: 1, background: P.line } }), hint ? h('span', { style: { fontSize: 11, fontWeight: 400, letterSpacing: 0, color: P.ink3 } }, hint) : null)
    }
    function LedgerTab({ s, busy, run, act, focus, setFocus }) {
      const P = useP()
      const l = s.ledger
      const T = l.clock ? l.clock.idx : null
      const [filter, setFilter] = React.useState('all')
      const [form, setForm] = React.useState({ month: '', day: '', title: '', note: '' })
      const open = l.entries || []
      const closed = (l.closed || []).slice().reverse()
      const counts = { all: open.length, world: open.filter(e => e.side === 'world').length, player: open.filter(e => e.side !== 'world').length, closed: closed.length }
      const shown = open.filter(e => filter === 'all' || (filter === 'world' ? e.side === 'world' : e.side !== 'world'))
      const groups = { over: [], near: [], far: [], none: [], quiet: [], intent: [] }
      for (const e of shown) {
        if (e.intent) groups.intent.push(e)
        else if (e.quiet) groups.quiet.push(e)
        else if (!e.when) groups.none.push(e)
        else if (T != null && T > e.when.end) groups.over.push(e)
        else if (T != null && e.when.idx <= T + 3) groups.near.push(e)
        else groups.far.push(e)
      }
      const byDate = (a, b) => (a.when ? a.when.idx : 1e9) - (b.when ? b.when.idx : 1e9) || RANK[effW(a)] - RANK[effW(b)]
      const card = e => h(EntryCard, { key: e.id, e, T, busy, run, act, prot: l.protagonist, expanded: focus === e.id, onToggle: () => setFocus(focus === e.id ? null : e.id) })
      const chip = (k, text) => h(Btn, { key: k, onClick: () => setFilter(k), style: filter === k ? (P.cn ? { background: P.ink, color: P.card, border: '1px solid ' + P.ink } : { background: P.accent, color: P.onAccent, border: '1px solid ' + P.accent }) : null }, text + ' ' + counts[k])
      return h(React.Fragment, null,
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, chip('all', '全部'), chip('world', '世界的事'), chip('player', '主角的事'), chip('closed', '已结束')),
        filter === 'closed' ? (closed.length ? h(Rows, null, ...closed.map((c, i) => h(Row, { key: c.id + i, last: i === closed.length - 1, muted: true,
          left: c.title + (c.when ? '（' + c.when + '）' : ''),
          right: [h(Tag, { key: 't', tone: c.status === 'done' ? 'ok' : c.status === 'missed' ? 'warn' : 'plain' }, STATUS[c.status] || c.status), h('span', { key: 'd' }, label(c.endIdx)),
            c.status === 'faded' && c.entry ? h(Btn, { key: 'r', kind: 'link', disabled: busy, onClick: act({ type: 'reopen', id: c.id }) }, '恢复') : null] }))) : h(Muted, null, '还没有结束的事。'))
          : h(React.Fragment, null,
            !shown.length ? h(Muted, null, '台账是空的。推进一轮后会自动记账，也可以在下面手动加一条备忘。') : null,
            groups.over.length ? h(React.Fragment, null, h(GroupTitle, null, '已过期'), ...groups.over.sort(byDate).map(card)) : null,
            groups.near.length ? h(React.Fragment, null, h(GroupTitle, null, '三日内'), ...groups.near.sort(byDate).map(card)) : null,
            groups.far.length ? h(React.Fragment, null, h(GroupTitle, null, '更远'), ...groups.far.sort(byDate).map(card)) : null,
            groups.none.length ? h(React.Fragment, null, h(GroupTitle, null, '无日期'), ...groups.none.map(card)) : null,
            groups.intent.length ? h(React.Fragment, null, h(GroupTitle, { hint: '只记不提' }, '意向'), ...groups.intent.sort(byDate).map(card)) : null,
            groups.quiet.length ? h(React.Fragment, null, h(GroupTitle, { hint: '没动静的，到期算没下文' }, '快放手的'), ...groups.quiet.sort((a, b) => a.quiet.left - b.quiet.left).map(card)) : null),
        h(GroupTitle, null, '加一条备忘'),
        h(Card, null,
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: P.ink2 } }, '备忘什么',
            h(Input, { placeholder: '例如：回赠诗集', value: form.title, onChange: e => setForm({ ...form, title: e.target.value }) })),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' } },
            h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, h(DateInputs, { v: form, set: setForm })),
            h(Btn, { kind: 'primary', disabled: busy || !form.title, style: { marginLeft: 'auto', height: 34, padding: '0 18px', letterSpacing: P.cn ? '0.2em' : 0 }, onClick: () => { run('action', { action: { type: 'addMemo', ...form } }); setForm({ month: '', day: '', inDays: '', title: '', note: '' }) } }, P.cn ? '记下' : '添加')),
          h(Muted, null, (curCal === 'story' ? '填几天后（故事里的天数）。' : '月、日填数字。') + '备忘只提醒你自己，不写进正文，也不会自动结束。')))
    }

    // —— 诊断 ——
    function Tile({ name, value, unit, dim }) {
      const P = useP()
      return h('div', { style: { background: P.card, border: '1px solid ' + P.line, borderRadius: P.r, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('span', { style: { fontSize: 11, color: P.ink2 } }, name),
        h('span', { style: { fontSize: 19, fontWeight: 700, color: dim ? P.ink3 : P.ink } }, value, unit ? h('span', { style: { fontSize: 12, fontWeight: 400, color: P.ink3 } }, ' ' + unit) : null))
    }
    function ReplayCard({ s, busy, run, gameId }) {
      const P = useP()
      const [detail, setDetail] = React.useState(null)
      const rp = s.replay || {}
      const pg = rp.progress, last = rp.last
      const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—'
      const loadDetail = () => call('replay-detail', { gameId }).then(setDetail, () => setDetail({ details: [] }))
      const JT = { 对: 'ok', 部分对: 'mid', 错: 'warn', 新: 'plain' }
      return h(Card, null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '回放测试'),
          pg ? h(Btn, { kind: 'danger', onClick: () => run('replay', { stop: true }, () => '已请求停止回放') }, '停止')
            : h(Btn, { kind: 'primary', disabled: busy, onClick: () => run('replay', {}, () => '回放已开始：大约 25 次调用，可以先去做别的') }, '开始回放')),
        h(Muted, null, '把 V0.2 实测甲局的 25 轮正文原样再提取一遍，和当时逐条判过对错的 59 条操作对照。不动当前这局的台账。'),
        pg ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { fontSize: 12 } }, '进行中：第 ' + (pg.done || 0) + ' / ' + (pg.total || 25) + ' 轮'),
          h('div', { style: { height: 6, background: P.line2 } }, h('div', { style: { width: pct(pg.done || 0, pg.total || 25), height: 6, background: P.mid } }))) : null,
        !pg && !last && rp.partial ? h(Muted, null, '上次回放中途断了（做完 ' + rp.partial.done + ' / ' + rp.partial.total + ' 轮），需要重新开始。') : null,
        last ? h(React.Fragment, null,
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px', fontSize: 12 } },
            h('span', null, '当时判「对」的，这次还在'), h('b', { style: { color: P.ok } }, last.goodHit + ' / ' + last.good + '（' + pct(last.goodHit, last.good) + '）'),
            h('span', null, '当时判「部分对」的，这次还在'), h('b', null, last.partialHit + ' / ' + last.partial),
            h('span', null, '当时判「错」的，这次又犯'), h('b', { style: { color: last.badRepeat ? P.warn : P.ok } }, last.badRepeat + ' / ' + last.bad),
            h('span', null, '这次新出现、需要人工判断的'), h('b', null, String(last.fresh)),
            last.intents != null ? h('span', null, '其中记为意向（不提醒）的') : null, last.intents != null ? h('b', null, String(last.intents)) : null,
            h('span', null, '平均每轮'), h('span', null, (last.avgMs / 1000).toFixed(1) + ' 秒 · 直连 ' + last.direct + '/' + last.rounds + (last.errors ? ' · 出错 ' + last.errors : ''))),
          h(Muted, null, (last.model || '') + ' · v' + last.version + ' · ' + new Date(last.at).toLocaleString() + (last.aborted ? ' · 中途停止' : '') + '。匹配是近似的，「新出现」的要人工看。'),
          detail && (detail.results || []).some(r => r.error || r.attempts || r.ms > 60000) ? h('div', { style: { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px dashed ' + P.line, paddingTop: 8 } },
            h('b', null, '慢或出错的轮次'),
            ...detail.results.filter(r => r.error || r.attempts || r.ms > 60000).map(r => h('div', { key: r.round, style: { color: r.error ? P.warn : P.ink2 } }, '第' + r.round + '轮 · ' + (r.ms / 1000).toFixed(0) + ' 秒 · ' + (r.via || '未完成') + (r.attempts ? ' · ' + r.attempts.join('；') : '') + (r.error ? ' · ' + r.error : '')))) : null,
          detail ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflow: 'auto', borderTop: '1px dashed ' + P.line, paddingTop: 8 } },
            ...(detail.details || []).map((d, i) => h('div', { key: i, style: { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 6, borderBottom: '1px solid ' + P.line2 } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, h('span', { style: { color: P.ink3 } }, '第' + d.round + '轮'), h(Tag, { tone: JT[d.judge] || 'plain' }, d.judge === '新' ? '新' : '当时' + d.judge), h('span', null, d.op + ' · ' + d.title)),
              d.evidence ? h('div', { style: { color: P.ink2 } }, '当时：「' + d.evidence + '」' + (d.judge === '错' && d.reason ? ' — ' + d.reason : '')) : null,
              h('div', { style: { color: d.now ? (d.judge === '错' ? P.warn : P.ink) : P.ink3 } }, d.now ? '这次：' + d.now.op + ' ' + d.now.title + (d.now.when ? '（' + d.now.when + '）' : '') + (d.now.quote ? '「' + d.now.quote + '」' : '') : '这次：没有对应操作')))) : h(Btn, { kind: 'link', onClick: loadDetail }, '看逐条明细')) : null)
    }
    // —— 导出数据 ——
    function saveFile(name, text) {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url; a.download = name; a.style.display = 'none'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    }
    function ExportCard({ s, gameId }) {
      const P = useP()
      const [withText, setWithText] = React.useState(false)
      const [n, setN] = React.useState('60')
      const [state, setState] = React.useState('')
      const go = how => {
        setState('正在整理…')
        call('export', { gameId, turns: n, withText }).then(async data => {
          const text = JSON.stringify(data, null, 1)
          const kb = Math.round(text.length / 1024)
          const d = new Date(), pad = x => String(x).padStart(2, '0')
          const name = '敲敲门导出_第' + (data.latestTurn || 0) + '轮_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json'
          if (how === 'file') { saveFile(name, text); setState('已保存：' + name + '（约 ' + kb + ' KB）。没看到文件的话，改用「复制」。') }
          else { await navigator.clipboard.writeText(text); setState('已复制到剪贴板（约 ' + kb + ' KB），可以粘贴到文本文件或聊天里。') }
        }).catch(e => setState('导出失败：' + String(e && e.message || e)))
      }
      return h(Card, null,
        h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '导出数据'),
        h(Muted, null, '台账、最近若干轮记了什么、告诉了正文什么、错误和设置，存成一个文件。反馈问题时把它发过来就行。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
          h('span', null, '最近'), h(Input, { 'aria-label': '导出轮数', value: n, onChange: e => setN(e.target.value), style: { width: 52, textAlign: 'center' } }), h('span', null, '轮'),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8 } }, h('input', { type: 'checkbox', checked: withText, onChange: e => setWithText(e.target.checked), style: { accentColor: P.accent } }), '附上正文')),
        withText ? h(Muted, null, '附上正文方便查哪里漏记了，但文件里会有你的剧情原文，发给别人前请留意。') : null,
        h('div', { style: { display: 'flex', gap: 6 } },
          h(Btn, { kind: 'primary', onClick: () => go('file') }, '保存为文件'),
          h(Btn, { onClick: () => go('copy') }, '复制')),
        state ? h('div', { style: { fontSize: 12, color: /失败/.test(state) ? P.warn : P.ink2, wordBreak: 'break-all' } }, state) : null)
    }
    function DiagTab({ s, busy, run, gameId }) {
      const P = useP()
      const l = s.ledger
      const [nTurns, setNTurns] = React.useState('')
      const runs = (l && l.runs) || []
      const timed = runs.filter(r => r.ms)
      const avg = timed.length ? timed.reduce((a, r) => a + r.ms, 0) / timed.length / 1000 : null
      const maxMs = Math.max(1, ...timed.map(r => r.ms))
      const withUsage = runs.filter(r => r.input)
      const cachePct = withUsage.length ? Math.round(withUsage.reduce((a, r) => a + (r.cacheRead || 0), 0) / withUsage.reduce((a, r) => a + r.input, 0) * 100) : null
      const lr = l && l.lastRun
      const dg = s.diag
      return h(React.Fragment, null,
        h(ExportCard, { s, gameId }),
        h(Card, null,
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
            h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '记账模型'),
            h(Btn, { disabled: busy, onClick: () => run('diag', {}) }, P.cn ? '试调一次' : '测试调用')),
          h('div', { style: { fontSize: 13 } }, dg && dg.model ? dg.model : (s.settings.model ? s.settings.model.replace('\u0001', ' / ') : '本局后台模型'), h('span', { style: { color: P.ink3 } }, dg && dg.effort ? ' · 推理 ' + ({ low: '低', minimal: '最低', off: '关闭', none: '关闭' }[dg.effort] || dg.effort) : '')),
          dg ? h('div', { style: { fontSize: 12, color: dg.ok && dg.systemFollowed ? P.ok : P.warn, background: dg.ok && dg.systemFollowed ? P.okBg : P.errBg, padding: '6px 10px', borderRadius: P.rb } },
            dg.ok ? (dg.via + ' · ' + (dg.ms / 1000).toFixed(1) + ' 秒 · 系统指令' + (dg.systemFollowed ? '生效' : '未生效')) : '调用失败：' + (dg.error || dg.directError || ''),
            dg.directError && dg.ok ? h('div', null, '直连没成功：' + dg.directError) : null) : h(Muted, null, '还没测过。')),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 } },
          h(Tile, { name: '平均耗时', value: avg != null ? avg.toFixed(1) : '—', unit: avg != null ? '秒' : '', dim: avg == null }),
          h(Tile, { name: '走直连', value: runs.length ? String(runs.filter(r => r.via === '直连').length) : '—', unit: runs.length ? '/ ' + runs.length : '', dim: !runs.length }),
          h(Tile, { name: '缓存命中', value: cachePct != null ? cachePct + '%' : '—', dim: cachePct == null })),
        timed.length ? h(Card, null,
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '最近几轮'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '34px 1fr 48px 34px', gap: '6px 8px', alignItems: 'center', fontSize: 12 } },
            h('span', { style: { color: P.ink3 } }, '轮'), h('span', { style: { color: P.ink3 } }, '耗时'), h('span', { style: { color: P.ink3, textAlign: 'right' } }, '秒'), h('span', { style: { color: P.ink3, textAlign: 'right' } }, '生效'),
            ...timed.slice().reverse().slice(0, 8).flatMap(r => [
              h('span', { key: 'a' + r.turn }, r.turn),
              h('span', { key: 'b' + r.turn, style: { height: 6, background: P.line2, display: 'block' } }, h('span', { style: { display: 'block', width: Math.max(3, r.ms / maxMs * 100) + '%', height: 6, background: r.via === '直连' ? P.mid : P.accent } })),
              h('span', { key: 'c' + r.turn, style: { textAlign: 'right' } }, (r.ms / 1000).toFixed(1)),
              h('span', { key: 'd' + r.turn, style: { textAlign: 'right' } }, r.applied)])),
          h(Muted, null, (P.cn ? '朱色' : '强调色') + ' = 转后台 Agent。')) : null,
        lr ? h(Card, null,
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '最新一轮（第 ' + lr.turn + ' 轮）'),
          h('div', { style: { fontSize: 12 } }, lr.pending ? (s.running && s.running.turn === lr.turn ? '后台正在记账…' : '还没记上（下一轮会把这一轮一并补记）') : lr.gate ? '已记账（' + ({ keywords: '有约定字眼', 'near-due': '有临近事项', manual: '手动', rebuild: '重建', every: '每轮', 'catch-up': '连同第 ' + lr.catchUp + ' 轮补记', history: '有史事要判断' }[lr.gate] || lr.gate) + '）' + (lr.via ? ' · ' + lr.via + ' · 后台 ' + (lr.ms / 1000).toFixed(1) + ' 秒' : '') : '没记账（本轮没有约定字眼，也没有临近事项）'),
          h(Muted, null, '日历：' + (CAL_NAME[lr.calendar || (l && l.calendar)] || '古风') + (lr.clockSource ? ' · 时间来自' + ({ variable: '卡的变量', marker: '正文里的日期标记', 'elapsed-marker': '正文里的“时间流逝”', model: '模型读出的日期', 'model-elapsed': '模型估计的经过时间' }[lr.clockSource] || lr.clockSource) : '') + (lr.cleaned ? ' · 去掉非剧情块 ' + lr.cleaned.removed + ' 个' + (lr.cleaned.fallback === 'too-little' ? '（洗得太多，改用整段正文）' : '') : '')),
          lr.wait ? h(Muted, null, lr.wait.gaveUp ? '这一轮开始结算时，第 ' + lr.wait.turn + ' 轮的后台记账超时，已放弃，改由下一轮补记。' : '这一轮结算时等了上一轮的后台记账 ' + (lr.wait.ms / 1000).toFixed(1) + ' 秒。') : null,
          lr.usage ? h(Muted, null, '用量：输入 ' + (lr.usage.input ?? '—') + '，输出 ' + (lr.usage.output ?? '—') + '，缓存命中 ' + (lr.usage.cacheRead ?? '—') + ' tokens') : lr.inChars ? h(Muted, null, '输入约 ' + lr.inChars + ' 字，输出约 ' + (lr.outChars || 0) + ' 字（服务商没有返回用量）') : null,
          lr.directError ? h('div', { style: { fontSize: 12, color: P.warn } }, '直连没成功：' + lr.directError) : lr.attempts ? h('div', { style: { fontSize: 12, color: P.ink2 } }, '重试过：' + lr.attempts.join('；')) : null,
          lr.repaired || lr.retried ? h(Muted, null, lr.retried ? '模型回复的 JSON 坏了，重问了一次。' : '模型回复的 JSON 有小毛病，已修补后采用。') : null,
          ...(lr.applied || []).map((a, i) => h('div', { key: i, style: { fontSize: 12 } }, ({ add: '新增', intent: '意向', confirm: '说定', reschedule: '改期', progress: '进展', done: '办完', cancel: '取消', missed: '失约' }[a.op] || a.op) + ' · ' + (a.title || a.id))),
          (lr.faded || []).length ? h(Muted, null, '本轮放手（没下文）：' + lr.faded.length + ' 件') : null,
          h(Muted, null, '累计：调用 ' + (l.stats.calls || 0) + ' 次，跳过 ' + (l.stats.skipped || 0) + ' 次，丢弃 ' + (l.stats.rejected || 0) + ' 条')) : null,
        s.replay && s.replay.available === false ? null : h(ReplayCard, { s, busy, run, gameId }),
        (l && (l.rejected || []).length) ? h(Card, null,
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '被丢弃的操作 ', h('span', { style: { fontWeight: 400, color: P.ink3 } }, String(l.rejected.length))),
          ...l.rejected.slice().reverse().slice(0, 12).map((x, i, all) => h('div', { key: i, style: { display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 6, borderBottom: i < all.length - 1 ? '1px dashed ' + P.line : 0 } },
            h('span', { style: { fontSize: 12 } }, '第' + x.turn + '轮 · ' + ({ add: '新增', intent: '意向', confirm: '说定', reschedule: '改期', progress: '进展', done: '办完', cancel: '取消', missed: '失约' }[x.op] || x.op || '?') + (x.title ? '「' + x.title + '」' : x.id ? ' ' + x.id : '')),
            x.quote ? h('span', { style: { fontSize: 12, color: P.ink2 } }, '「' + x.quote + '」') : null,
            h('span', { style: { fontSize: 11, color: P.warn } }, x.why)))) : null,
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h(Btn, { disabled: busy, style: { flex: 1, height: 36 }, onClick: () => run('reextract', {}, r => '已重新提取：' + r.info.applied.length + ' 条生效，' + r.info.rejected + ' 条丢弃') }, '重新提取最新一轮')),
        h(Card, null,
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '从历史重建台账'),
          h(Muted, null, '读最近若干轮正文，整理出仍未了结的约定。会调用后台模型，轮数多时要等一会儿；手动备忘保留。'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h(Input, { 'aria-label': '轮数', placeholder: String(s.settings.rebuildTurns || 60), value: nTurns, onChange: e => setNTurns(e.target.value), style: { width: 64 } }), h('span', { style: { fontSize: 12 } }, '轮'),
            h(Btn, { disabled: busy, style: { marginLeft: 'auto' }, onClick: () => run('rebuild', { turns: nTurns }, () => '已开始重建，完成后台账会自动刷新') }, '开始重建'))),
        (s.errors || []).length ? h('div', { style: { background: P.errBg, border: '1px solid ' + P.errLine, borderRadius: P.r, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', { style: { fontSize: 12, fontWeight: 700, color: P.warn } }, '错误 ' + s.errors.length),
            h(Btn, { kind: 'danger', style: { height: 26 }, onClick: () => run('clear-errors', {}) }, '清除')),
          ...s.errors.slice().reverse().map((e, i) => h('div', { key: i, style: { fontSize: 12, color: P.warn, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, new Date(e.at).toLocaleString() + ' · ' + e.where + '\n' + e.error))) : null)
    }


    // —— 世事（史事与条件条目） ——
    const STAGE = { pending: '未到', checking: '待判前提', happened: '已发生·消息未到', arrived: '消息已到', known: '主角已知', background: '开局前旧事', cancelled: '未发生' }
    const UNKNOWN = ['pending', 'checking', 'happened']
    function HistoryTab({ s, busy, run, gameId }) {
      const P = useP()
      const hs = s.history || {}
      const [spoil, setSpoil] = React.useState(false)
      const [detail, setDetail] = React.useState({})
      const [edit, setEdit] = React.useState(null)
      const [md, setMd] = React.useState({ m: '', d: '' })
      if (hs.enabled === false) return h(Muted, null, '史事已在设置里关闭。')
      const events = hs.events || [], conds = hs.conds || []
      const known = events.filter(e => !UNKNOWN.includes(e.stage)), hidden = events.filter(e => UNKNOWN.includes(e.stage))
      const show = d => call('history-detail', { gameId, id: d }).then(r => setDetail({ ...detail, [d]: r }), e => setDetail({ ...detail, [d]: { error: String(e && e.message || e) } }))
      const relTone = { 史载: 'ok', 推定: 'mid', 存疑: 'plain' }
      const row = e => h(Card, { key: e.id },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' } },
          h('span', { style: { fontWeight: 700 } }, e.title),
          h('span', { style: { display: 'flex', gap: 4, flex: 'none' } }, h(Tag, { tone: relTone[e.reliability] || 'plain' }, e.reliability), h(Tag, { tone: e.stage === 'cancelled' ? 'warn' : e.stage === 'arrived' ? 'player' : 'plain' }, STAGE[e.stage] || e.stage))),
        h('div', { style: { fontSize: 12, color: P.ink2 } }, [e.window, e.place, e.landLabel ? '落地 ' + e.landLabel + (e.manual ? '（手动）' : '') : '', e.arriveLabel ? '传到 ' + e.arriveLabel : ''].filter(Boolean).join(' · ')),
        e.verdict && e.verdict !== '照常' ? h('div', { style: { fontSize: 12, color: P.warn } }, '前提判定：' + e.verdict + (e.reason ? '（' + e.reason + '）' : '')) : null,
        detail[e.id] ? h('div', { style: { fontSize: 12, color: P.ink2, whiteSpace: 'pre-wrap', borderLeft: '2px solid ' + P.btnLine, paddingLeft: 8 } },
          detail[e.id].error || ['可见：' + (detail[e.id].visible || ''), detail[e.id].fact && detail[e.id].fact !== detail[e.id].visible ? '事实：' + detail[e.id].fact : '', detail[e.id].pre ? '前提：' + detail[e.id].pre : '', detail[e.id].spread ? '传播：' + detail[e.id].spread : '', '关键词：' + (detail[e.id].keys || []).join('、')].filter(Boolean).join('\n')) : null,
        edit === e.id ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h(Input, { 'aria-label': '月', placeholder: '月', value: md.m, onChange: ev => setMd({ ...md, m: ev.target.value }), style: { width: 48 } }),
          h(Input, { 'aria-label': '日', placeholder: '日', value: md.d, onChange: ev => setMd({ ...md, d: ev.target.value }), style: { width: 48 } }),
          h(Btn, { kind: 'primary', disabled: busy, onClick: () => { run('action', { action: { type: 'histLand', id: e.id, month: md.m, day: md.d } }); setEdit(null) } }, '改落地日')) : null,
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          detail[e.id] ? null : h(Btn, { kind: 'link', onClick: () => show(e.id) }, '看内容'),
          e.stage === 'cancelled' ? h(Btn, { kind: 'link', disabled: busy, onClick: () => run('action', { action: { type: 'histRestore', id: e.id } }) }, '恢复')
            : e.stage === 'known' || e.stage === 'background' ? null
              : h(React.Fragment, null,
                h(Btn, { kind: 'link', disabled: busy, onClick: () => setEdit(edit === e.id ? null : e.id) }, '改落地日'),
                h(Btn, { kind: 'link', disabled: busy, onClick: () => run('action', { action: { type: 'histArriveNow', id: e.id } }, () => '下一轮会传到') }, '让消息下一轮就到'),
                h(Btn, { kind: 'link', disabled: busy, onClick: () => run('action', { action: { type: 'histCancel', id: e.id } }) }, '本局不发生'))))
      return h(React.Fragment, null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(Muted, null, '卡内世界书 ' + ((hs.counts && hs.counts.card) || 0) + ' 条 · 事件包 ' + ((hs.counts && hs.counts.packs) || 0) + ' 条'),
          h(Btn, { disabled: busy, onClick: () => run('history-reload', {}, r => '已重新读取：卡内 ' + r.counts.card + ' 条，事件包 ' + r.counts.packs + ' 条') }, '重新读取')),
        ...(hs.warnings || []).map((w, i) => h('div', { key: 'hw' + i, style: { fontSize: 12, color: P.warn } }, '⚠ ' + w)),
        (hs.news || []).length ? h(Section, { title: '下一轮传到', hint: '注入一次，之后进条目池', marker: P.mid },
          ...hs.news.map(n => h(Card, { key: n.id }, h('span', { style: { fontWeight: 700 } }, n.title), h('div', { style: { fontSize: 12, color: P.ink2 } }, n.content)))) : null,
        h(Section, { title: '主角已知与旧事', hint: known.length ? null : '还没有' },
          ...known.map(row)),
        h(Section, { title: '尚未发生或主角不知', hint: hidden.length + ' 件', muted: true },
          spoil ? h(React.Fragment, null, ...hidden.map(row), h(Btn, { kind: 'link', onClick: () => setSpoil(false) }, '收起'))
            : h(Card, null, h(Muted, null, '这些事主角还不知道。看了会剧透。'), h('div', null, h(Btn, { onClick: () => setSpoil(true), disabled: !hidden.length }, '显示（剧透）')))),
        h(Section, { title: '条件条目', hint: conds.filter(c => c.met).length + ' / ' + conds.length + ' 已满足', muted: true },
          ...conds.filter(c => c.met || spoil).map(c => h(Card, { key: c.id },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, h('span', { style: { fontWeight: 700 } }, c.title), h(Tag, { tone: c.met ? 'ok' : 'plain' }, c.met ? (c.injected ? '已注入' : '已满足') : '未满足')),
            c.quote ? h(Quote, null, c.quote) : null,
            detail[c.id] ? h('div', { style: { fontSize: 12, color: P.ink2, whiteSpace: 'pre-wrap' } }, detail[c.id].error || '条件：' + detail[c.id].cond + '\n内容：' + detail[c.id].content) : h(Btn, { kind: 'link', onClick: () => show(c.id) }, '看内容'))),
          !spoil && conds.some(c => !c.met) ? h(Muted, null, '未满足的条件只在「显示（剧透）」后列出。') : null),
        h(Muted, null, '在卡的世界书里加标题以「[敲敲门·史事]」或「[敲敲门·条件]」（旧写法「[世界引擎·史事]」也认）开头、设为禁用的条目，或把事件包放进插件的 packs 文件夹。写法见插件文件夹里的「史事条目写法.md」。'))
    }

    // —— 设置 ——
    function Field({ label: name, children, hint }) {
      const P = useP()
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: P.ink2 } }, name, children, hint ? h('span', { style: { color: P.ink3 } }, hint) : null)
    }
    function Select({ value, onChange, children, style }) {
      const P = useP()
      return h('select', { value, onChange, style: { height: 34, padding: '0 8px', border: '1px solid ' + P.btnLine, borderRadius: P.rb, font: 'inherit', fontSize: 13, color: P.ink, background: P.card, ...style } }, children)
    }
    function SettingsTab({ s, busy, run, gameId }) {
      const P = useP()
      const [cfg, setCfg] = React.useState(s.settings)
      const [models, setModels] = React.useState(null)
      const [calPick, setCalPick] = React.useState('')
      React.useEffect(() => { call('models', { gameId }).then(setModels, () => setModels([])) }, [gameId])
      const set = (k, v) => setCfg({ ...cfg, [k]: v })
      const choice = (name, k, val, t, d, rec) => h('label', { key: k, style: { display: 'flex', gap: 10, padding: '10px 12px', border: '1px solid ' + (val ? P.accent : P.line), background: val ? P.accentSoft : P.card, borderRadius: P.r, cursor: 'pointer' } },
        h('input', { type: 'radio', name, checked: val, onChange: () => set(...k), style: { marginTop: 4, accentColor: P.accent } }),
        h('span', { style: { display: 'flex', flexDirection: 'column' } }, h('span', { style: { fontWeight: 700 } }, t, rec ? h('span', { style: { fontSize: 11, fontWeight: 400, color: P.warn } }, ' 推荐') : null), h('span', { style: { fontSize: 12, color: P.ink2 } }, d)))
      const h3 = t => h('h3', { style: { margin: '6px 0 0', fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, t)
      const auto = cfg.remind !== 'off' && cfg.strength !== 'archive'
      const manual = cfg.mode === 'manual'
      const fs = (legend, ...kids) => h('fieldset', { style: { margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: 8 } }, h('legend', { style: { padding: '0 0 8px', fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, legend), ...kids)
      return h(React.Fragment, null,
        fs('档位',
          choice('we-mode', ['mode', 'auto'], !manual, '自动', '下面这些由插件定，装上就能玩。', true),
          choice('we-mode', ['mode', 'manual'], manual, '自己调', '提醒、告诉正文的范围、何时记账等逐项设置。')),
        !manual ? h(Card, null,
          h('div', { style: { fontSize: 12, color: P.ink2, display: 'flex', flexDirection: 'column', gap: 2 } },
            h('span', null, '· 每轮写完后在后台记账，不挡下一轮。'),
            h('span', null, '· 事情到了该有动静的时候告诉正文一次，过期再提一次，然后放手。'),
            h('span', null, '· 当天、次日的零碎小事只记不提；同一轮到期的事多时，等回应的和要紧的先提，其余顺延。'),
            h('span', null, '· 主角答应的事，由相关的人在正文里问一句，不替主角去办。'),
            h('span', null, '· 日历开局时自动判断（古风 / 公历 / 故事天数）；节令、史事只在古风日历下开。'))) : h(React.Fragment, null,
        h('fieldset', { style: { margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('legend', { style: { padding: '0 0 8px', fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '提醒'),
          choice('we-remind', ['remind', 'auto'], auto, '自动提醒', '事情到了该有动静的时候，告诉正文一次；过期仍没下文再提一次，然后放手。', true),
          choice('we-remind', ['remind', 'off'], !auto, '只记账', '不往正文里加任何东西，只在面板上列出来。')),
        h('fieldset', { style: { margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('legend', { style: { padding: '0 0 8px', fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '告诉正文的范围'),
          choice('we-scope', ['scope', 'important'], cfg.scope === 'important', '只提要紧的', '只提错过了有后果的事（分量高）。'),
          choice('we-scope', ['scope', 'normal'], (!cfg.scope || cfg.scope === 'normal' || cfg.scope === 'auto') === true, '跨天的事', '不提当天、次日的零碎小事（买碗、打油、捎句话）。', true),
          choice('we-scope', ['scope', 'all'], cfg.scope === 'all', '全部', '台账里的事到时间都提。'),
          h(Muted, null, '回信、回话、来访这类“等外面回应”的事，任何档位都会提。没提的事照样记在台账里。')),
        h('fieldset', { style: { margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('legend', { style: { padding: '0 0 8px', fontSize: 14, fontWeight: 700, letterSpacing: P.track } }, '何时记账'),
          choice('we-gate', ['gate', 'every'], cfg.gate !== 'keywords', '每轮都记', '每轮写完后在后台读一遍，不挡下一轮。刚记下的事，提醒最多晚一轮。', true),
          choice('we-gate', ['gate', 'keywords'], cfg.gate === 'keywords', '只在有约定字眼时记', '省一些调用，但没有约定字眼的轮次（如“把信交给吴伯去寄”）会漏掉。')),
        h3('主角答应的事'),
        h('label', { style: { display: 'flex', gap: 8 } }, h('input', { type: 'radio', name: 'we-p2s', checked: cfg.playerToStory !== false, onChange: () => set('playerToStory', true), style: { accentColor: P.accent } }), '也告诉正文：由相关的人问一句，不替主角去办'),
        h('label', { style: { display: 'flex', gap: 8 } }, h('input', { type: 'radio', name: 'we-p2s', checked: cfg.playerToStory === false, onChange: () => set('playerToStory', false), style: { accentColor: P.accent } }), '只提醒我（今日备忘）'),
        h(Muted, null, '手动添加的备忘只给你看，不会告诉正文。'),
        h3('放手'),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('span', null, '没写日期的事，多少天没动静算没下文'), h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, h(Input, { 'aria-label': '天数', value: cfg.fadeMid, onChange: e => set('fadeMid', e.target.value), style: { width: 48, textAlign: 'center' } }), '日')),
        h(Muted, null, '有日期的事：过期后再提一次，三天内仍无动静就算没下文。没下文不等于删除，正文再提起会重新打开。'),),
        h3('记账用的模型'),
        h(Field, { label: '记账用模型', hint: '每轮写完都会调用一次，只是读正文、记约定。本局后台模型若较贵，建议换个便宜、快的小模型（名字常带 flash、mini、lite）。' + (s.extractModel ? '当前：' + s.extractModel.name + '。' : '') },
          h(Select, { value: cfg.model || '', onChange: e => set('model', e.target.value) },
            h('option', { value: '' }, '本局后台模型（默认）'),
            ...(Array.isArray(models) ? models : []).map(g => h('optgroup', { key: g.provider, label: g.providerName }, ...g.models.map(m => h('option', { key: m.id, value: g.provider + '\u0001' + m.id }, m.name)))),
            cfg.model && !(Array.isArray(models) ? models : []).some(g => g.models.some(m => g.provider + '\u0001' + m.id === cfg.model)) ? h('option', { value: cfg.model }, cfg.model.replace('\u0001', ' / ')) : null)),
        manual ? h(Field, { label: '推理强度' }, h(Select, { value: cfg.effort || 'low', onChange: e => set('effort', e.target.value) },
          h('option', { value: 'low' }, '低（推荐）'), h('option', { value: 'off' }, '关闭思考（最快）'), h('option', { value: 'model' }, '跟随模型设置（最慢）'))) : null,
        manual ? h('label', { style: { display: 'flex', gap: 8 } }, h('input', { type: 'checkbox', checked: cfg.extract !== false, onChange: e => set('extract', e.target.checked), style: { accentColor: P.accent } }), '记账（关掉后只按已有台账提醒）') : null,
        manual ? h(React.Fragment, null, h3('史事'),
        h('label', { style: { display: 'flex', gap: 8 } }, h('input', { type: 'checkbox', checked: cfg.history !== false, onChange: e => set('history', e.target.checked), style: { accentColor: P.accent } }), '读卡内世界书和事件包里的史事、条件条目'),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('span', null, '每轮最多传到几条消息'), h(Input, { 'aria-label': '每轮消息数', value: cfg.newsMax, onChange: e => set('newsMax', e.target.value), style: { width: 48, textAlign: 'center' } })),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('span', null, '没写传播天数时，消息几天传到'), h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, h(Input, { 'aria-label': '默认传播天数', value: cfg.newsDays, onChange: e => set('newsDays', e.target.value), style: { width: 48, textAlign: 'center' } }), '日'))) : null,
        h3('日历'),
        h(Field, { label: '本局日历', hint: '开局时自动判断：卡的变量里有古风日期用古风，正文或变量里有公历日期用公历，都没有就按故事天数。改了以后，已有事项的日期作废（事项保留），时间从头算。' },
          h(Select, { value: calPick || (s.ledger && s.ledger.calendar) || '', disabled: !s.ledger, onChange: e => setCalPick(e.target.value === (s.ledger && s.ledger.calendar) ? '' : e.target.value) },
            s.ledger && s.ledger.calendar ? null : h('option', { value: '' }, '（还没开始记账）'),
            h('option', { value: 'lunar' }, '古风（正月初五、腊月）'), h('option', { value: 'gregorian' }, '公历（5月31日 周五）'), h('option', { value: 'story' }, '故事天数（没有日历，按第几天）'))),
        calPick ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: P.warn, flexWrap: 'wrap' } }, '改成「' + CAL_NAME[calPick] + '」后，已有事项的日期作废。',
          h(Btn, { kind: 'primary', disabled: busy, onClick: () => { run('action', { action: { type: 'setCalendar', calendar: calPick } }, () => '本局日历已改为' + CAL_NAME[calPick]); setCalPick('') } }, '确定改'),
          h(Btn, { disabled: busy, onClick: () => setCalPick('') }, '算了')) : null,
        h(Field, { label: '记账时另外去掉的标签', hint: '思考、序言、选项、小剧场、摘要、状态栏、闪回这类常见标签已内置去掉。别的预设或卡另有不是剧情的块，在这里填标签名，逗号隔开，例如：ooc, 旁白' },
          h(Input, { value: cfg.ignoreTags || '', placeholder: '例如：ooc, 旁白', onChange: e => set('ignoreTags', e.target.value) })),
        h3('界面'),
        h(Field, { label: '皮肤' }, h(Select, { value: cfg.skin || 'ancient', onChange: e => set('skin', e.target.value) }, h('option', { value: 'ancient' }, '古风（宣纸 · 朱砂）'), h('option', { value: 'host' }, '跟随 DSH 主题'))),
        h('details', { style: { fontSize: 12, color: P.ink2 } },
          h('summary', { style: { cursor: 'pointer', color: P.link } }, manual ? '高级：每轮上限、节令、主角名、变量路径' : '高级：主角名、变量路径'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 } },
            manual ? h(Field, { label: '每轮最多告诉正文几条' }, h(Input, { value: cfg.maxPerTurn, onChange: e => set('maxPerTurn', e.target.value), style: { width: 64 } })) : null,
            manual ? h('label', { style: { display: 'flex', gap: 8, color: P.ink } }, h('input', { type: 'checkbox', checked: cfg.festivals !== false, onChange: e => set('festivals', e.target.checked), style: { accentColor: P.accent } }), '节令') : null,
            h(Field, { label: '主角名字', hint: '留空由模型识别。填了以这里为准，会从人物名单里去掉，免得出现“主角自己过问自己”。' }, h(Input, { value: cfg.protagonist || '', placeholder: s.ledger && s.ledger.protagonist ? '模型识别为：' + s.ledger.protagonist : '', onChange: e => set('protagonist', e.target.value) })),
            h(Field, { label: '重建默认读多少轮' }, h(Input, { value: cfg.rebuildTurns, onChange: e => set('rebuildTurns', e.target.value), style: { width: 64 } })),
            h(Field, { label: '日期变量路径' }, h(Input, { value: cfg.datePath, onChange: e => set('datePath', e.target.value) })),
            h(Field, { label: '地点变量路径' }, h(Input, { value: cfg.placePath, onChange: e => set('placePath', e.target.value) })))),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h(Btn, { disabled: busy, onClick: () => setCfg(s.settings) }, '还原'),
          h(Btn, { kind: 'primary', disabled: busy, style: { height: 34, padding: '0 18px' }, onClick: () => run('settings', { settings: cfg }, () => '设置已保存') }, '保存设置')))
    }

    // —— 面板 ——
    function Panel({ gameId }) {
      const [s, err, refresh] = useStatus(gameId)
      const [tab, setTab] = React.useState('today')
      const [focus, setFocus] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const run = (name, args, done) => {
        if (busy) return
        setBusy(true); setMsg('')
        call(name, { gameId, ...args }).then(r => { if (done) setMsg(done(r)); return refresh() }, e => setMsg('出错：' + String(e && e.message || e))).finally(() => setBusy(false))
      }
      const act = action => () => run('action', { action })
      const P = skinOf(s)
      const fill = p => { try { ui.current.setInput({ gameId, text: fillText(p) }) } catch (e) { setMsg('填入失败：' + e.message) } }
      const root = { boxSizing: 'border-box', minHeight: '100%', background: P.bg, color: P.ink, fontFamily: P.font, fontSize: 13, lineHeight: 1.6, display: 'flex', flexDirection: 'column' }
      if (!s) return h(SkinCtx.Provider, { value: P }, h('div', { style: { ...root, padding: 16 } }, err ? h('div', { style: { color: P.warn } }, err) : '读取中…'))
      const l = s.ledger
      curCal = (l && l.calendar) || 'lunar'
      const clock = l && l.clock
      const era = clock && clock.era ? clock.era : ''
      const lr = l && l.lastRun
      const status = s.running ? { tone: 'mid', text: '正在记第' + (P.cn ? cnInt(s.running.turn) : s.running.turn) + '轮…' }
        : lr ? (lr.pending ? { tone: 'plain', text: '第' + (P.cn ? cnInt(lr.turn) : lr.turn) + '轮待补记' } : lr.gate ? { tone: 'ok', text: '第' + (P.cn ? cnInt(lr.turn) : lr.turn) + '轮已记' + (lr.ms ? ' · ' + (lr.ms / 1000).toFixed(1) + '秒' : '') } : { tone: 'plain', text: '第' + (P.cn ? cnInt(lr.turn) : lr.turn) + '轮无需记账' }) : null
      const histN = s.history && s.history.events ? s.history.events.filter(e => !['pending', 'checking', 'happened'].includes(e.stage)).length : 0
      const tabs = [['today', '今日'], ['ledger', '台账', l ? l.entries.length : 0], ['history', '世事', histN], ['diag', '诊断'], ['settings', '设置']]
      const festivalToday = l && l.plan && (l.plan.world || []).find(p => p.kind === 'festival')
      return h(SkinCtx.Provider, { value: P }, h('div', { style: root },
        h('header', { style: { flex: 'none', padding: '16px 16px 12px', borderBottom: P.rule, display: 'flex', gap: 12, alignItems: 'flex-start' } },
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
            h('span', { style: { fontSize: 12, color: P.ink2, letterSpacing: P.cn ? '0.2em' : 0 } }, 'Knock Knock · 敲敲门 · v' + s.version),
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 26, fontWeight: 700, letterSpacing: P.cn ? '0.12em' : 0 } }, clock ? clock.label : (l ? '日期未知' : '尚未记账')),
              festivalToday ? h(Tag, { tone: 'warn' }, festivalToday.title) : null),
            h('span', { style: { fontSize: 12, color: P.ink2 } }, [era, l && l.place ? l.place : '', clock && ['model', 'model-elapsed', 'elapsed-marker'].includes(clock.source) ? (curCal === 'story' ? '（按正文推算的故事天数）' : '（日期按正文推算）') : ''].filter(Boolean).join(' · ') || '　'),
            status ? h('span', { style: { fontSize: 12, color: status.tone === 'ok' ? P.ok : status.tone === 'mid' ? P.mid : P.ink3 } }, status.text) : null),
          P.seal && era ? h('div', { 'aria-hidden': true, style: { flex: 'none', width: 44, height: 44, background: P.accent, borderRadius: 3, color: P.onAccent, fontSize: 15, fontWeight: 700, lineHeight: 1.1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 0 0 2px ' + P.accent + ', inset 0 0 0 3px ' + P.onAccent } }, ...era.slice(0, 2).split('').map((c, i) => h('span', { key: i }, c))) : null),
        h('nav', { style: { flex: 'none', display: 'flex', gap: 2, padding: '6px 10px 0', borderBottom: '1px solid ' + P.line, overflowX: 'auto' } },
          ...tabs.map(([k, t, n]) => h('button', { key: k, type: 'button', onClick: () => setTab(k), style: { padding: '8px 12px', border: 0, background: 'transparent', font: 'inherit', fontSize: 13, cursor: 'pointer', color: tab === k ? P.ink : P.ink2, fontWeight: tab === k ? 700 : 400, borderBottom: '2px solid ' + (tab === k ? P.accent : 'transparent'), letterSpacing: P.track, whiteSpace: 'nowrap' } },
            t, n ? h('span', { style: { color: P.ink3, fontWeight: 400, letterSpacing: 0 } }, ' ' + n) : null))),
        h('main', { style: { flex: '1 0 auto', padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 16 } },
          msg ? h('div', { style: { fontSize: 12, color: /出错|失败|异常|未生效/.test(msg) ? P.warn : P.ok } }, msg) : null,
          err ? h('div', { style: { fontSize: 12, color: P.warn } }, err) : null,
          !l && tab !== 'settings' && tab !== 'diag' && tab !== 'history' ? h(Muted, null, '还没有数据。推进一轮后开始记账；已有长局可以在「诊断」里从历史重建台账。')
            : tab === 'today' ? h(TodayTab, { s, busy, act, run, fill, goSettings: () => setTab('settings'), openEntry: id => { setFocus(id); setTab('ledger') } })
              : tab === 'ledger' ? h(LedgerTab, { s, busy, run, act, focus, setFocus })
                : tab === 'history' ? h(HistoryTab, { s, busy, run, gameId })
                : tab === 'diag' ? (l ? h(DiagTab, { s, busy, run, gameId }) : h(React.Fragment, null, h(Muted, null, '还没有数据。'), s.replay && s.replay.available === false ? null : h(ReplayCard, { s, busy, run, gameId })))
                  : h(SettingsTab, { key: JSON.stringify(s.settings), s, busy, run, gameId }))))
    }

    function MemoOverlay({ gameId, close }) {
      const [s, err, refresh] = useStatus(gameId)
      const [busy, setBusy] = React.useState(false)
      const P = skinOf(s)
      const act = action => () => { setBusy(true); call('action', { gameId, action }).then(refresh).finally(() => setBusy(false)) }
      const fill = p => { ui.current.setInput({ gameId, text: fillText(p) }); close() }
      const clock = s && s.ledger && s.ledger.clock
      return h(SkinCtx.Provider, { value: P }, h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 16, boxSizing: 'border-box' }, onClick: close },
        h('div', { role: 'dialog', 'aria-label': '今日备忘', style: { background: P.bg === 'transparent' ? 'var(--dsw-alias-bg-base, var(--background, #fff))' : P.card, color: P.ink, fontFamily: P.font, fontSize: 13, lineHeight: 1.6, border: '1px solid ' + P.btnLine, borderTop: '3px solid ' + P.accent, borderRadius: P.r, width: 'min(440px, 100%)', maxHeight: '80vh', overflow: 'auto', boxShadow: '0 8px 24px rgba(80,50,20,.16)', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, marginBottom: '12vh' }, onClick: e => e.stopPropagation() },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
            h('span', { style: { fontWeight: 700, letterSpacing: P.track } }, '今日备忘' + (clock ? ' · ' + clock.label : '')),
            h('span', { style: { fontSize: 12, color: P.ink3 } }, '不会写进正文')),
          !s ? h('div', null, err || '读取中…') : h(MemoList, { s, busy, act, onFill: fill, compact: true }),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, h(Btn, { onClick: close }, '关闭')))))
    }

    return {
      name: 'dsh-tavern-knock-knock',
      inject: ['tavernUi'],
      apply(ctx) {
        if (!(ctx.tavernUi.apiVersion >= 2)) return
        ui.current = ctx.tavernUi
        ctx.tavernUi.registerPanel({ id: 'knock-knock', title: '敲敲门', render: ({ gameId }) => h(Panel, { gameId }) })
        if (typeof ctx.tavernUi.registerComposerAction === 'function') {
          ctx.tavernUi.registerComposerAction({
            id: 'memo',
            label: '今日备忘',
            when: ({ gameId }) => {
              if (!gameId) return false
              ensureWatch(gameId)
              const s = cache.get(gameId)
              if (!s) { fetchStatus(gameId).catch(() => {}); return false }
              return !!(s.ledger && s.ledger.plan && s.ledger.plan.player && s.ledger.plan.player.length)
            },
            run: ({ gameId }) => { if (typeof ui.current.openOverlay === 'function') ui.current.openOverlay({ gameId, render: ({ close }) => h(MemoOverlay, { gameId, close }) }) },
          })
        }
        if (typeof ctx.tavernUi.registerMessageAction === 'function') {
          ctx.tavernUi.registerMessageAction({
            id: 'reextract',
            label: '重新提取约定',
            when: ({ settled }) => settled,
            run: ({ gameId, turn }) => call('reextract', { gameId, turn }).then(() => fetchStatus(gameId)).catch(e => console.warn('[敲敲门] ' + (e && e.message || e))),
          })
        }
      },
    }
  },
})
