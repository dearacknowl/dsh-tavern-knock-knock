// 史事与条件条目（V0.3）：纯函数，不依赖 DSHT。
// 史事：从卡的世界书（标题以「[敲敲门·史事]」开头、设为禁用）或插件事件包读出，
//       按时间窗落地（种子抽日 / 窗口末），先“已发生、主角不知”，消息按地点和传播天数到达后才备查一次，之后进条目池。
// 条件：标题以「[敲敲门·条件]」开头；条件满足（关键词全中，或提取模型引原文判定）后注入一次，之后进条目池。
import { cnNumber, monthNumber, toIdx, dateLabel } from './calendar.mjs'

const PREFIX_HIST = /^\s*[\[【]\s*(?:敲敲门|世界引擎)\s*[·・.]\s*史事\s*[\]】]\s*/
const PREFIX_COND = /^\s*[\[【]\s*(?:敲敲门|世界引擎)\s*[·・.]\s*条件\s*[\]】]\s*/
const KEYS_HIST = ['日期', '可靠度', '地点', '传播', '级别', '前提', '落地', '关键词', '事实', '可见']
const KEYS_COND = ['条件', '关键词', '内容', '级别']
const RELIABILITY = ['史载', '推定', '存疑']
export const STAGE_LABEL = { pending: '未到', checking: '待判前提', happened: '已发生·消息未到', arrived: '消息已到', known: '主角已知', background: '开局前旧事', cancelled: '未发生' }

const norm = s => String(s ?? '').replace(/[\s，。；、,.;:：！？!?“”"'‘’（）()【】《》「」『』—…·\-]/g, '')
function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0 } return h >>> 0 }
export const shortId = (kind, title) => kind + hash(norm(title)).toString(36).slice(0, 6)

/** 「键：值」块 → 对象；值可跨行，直到下一个已知的键。 */
function fields(content, keys) {
  const out = {}
  let cur = null
  for (const raw of String(content || '').split(/\r?\n/)) {
    const line = raw.trim()
    const m = line.match(/^([^：:]{1,4})[：:]\s*(.*)$/)
    if (m && keys.includes(m[1])) { cur = m[1]; out[cur] = m[2]; continue }
    if (cur && line) out[cur] += '\n' + line
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim()
  return out
}

/** 纪年串 → 年号名（“万历十五年” → “万历”）。 */
export const eraName = era => String(era || '').replace(/[〇零一二两三四五六七八九十廿卅元\d]+年.*$/, '').trim()
const yearOf = s => (s === '元' ? 1 : cnNumber(s))
const dayOf = s => { if (!s) return null; const n = cnNumber(s); return n >= 1 && n <= 30 ? n : null }

/**
 * 史事日期 → 时间窗 { from, to, label } 或 { after: { title, days } }；不认识返回 null。
 * 写法：万历十五年十月十四 / 万历十五年十月 / 三月上旬 / 春 / 内 / 约五至七月 / 某事件之后约一月。
 */
export function parseHistDate(text, era) {
  let s = String(text || '').trim().replace(/^约/, '')
  const after = s.match(/^(.+?)之后约?([〇零一二两三四五六七八九十廿\d]+)\s*(日|天|旬|月)/)
  if (after) {
    const n = cnNumber(after[2]) || 1
    return { after: { title: after[1].replace(/^[「『“]|[」』”]$/g, ''), days: n * ({ 日: 1, 天: 1, 旬: 10, 月: 30 })[after[3]] }, label: s }
  }
  const ym = s.match(/^(\S*?)([〇零一二两三四五六七八九十廿卅元\d]+)年(.*)$/)
  if (!ym) return null
  const name = ym[1], y = yearOf(ym[2]), rest = ym[3].replace(/^约/, '').trim()
  if (!y) return null
  if (era && name && eraName(era) && name !== eraName(era)) return { otherEra: name, label: s }
  const M = '([正冬腊臘一二三四五六七八九十]{1,2})月'
  let m
  if ((m = rest.match(new RegExp('^' + M + '([初十廿卅一二三四五六七八九]{1,3})[日号]?$')))) {
    const mo = monthNumber(m[1]), d = dayOf(m[2]); if (!mo || !d) return null
    const idx = toIdx(y, mo, d); return { from: idx, to: idx, label: s, precision: 'day' }
  }
  if ((m = rest.match(new RegExp('^' + M + '([上中下])旬$')))) {
    const mo = monthNumber(m[1]); if (!mo) return null
    const [a, b] = { 上: [1, 10], 中: [11, 20], 下: [21, 30] }[m[2]]
    return { from: toIdx(y, mo, a), to: toIdx(y, mo, b), label: s, precision: 'part' }
  }
  if ((m = rest.match(/^([正冬腊一二三四五六七八九十]{1,2})(?:月)?\s*(?:至|到|—|-|～|~)\s*([正冬腊一二三四五六七八九十]{1,2})月$/))) {
    const a = monthNumber(m[1]), b = monthNumber(m[2]); if (!a || !b || b < a) return null
    return { from: toIdx(y, a, 1), to: toIdx(y, b, 30), label: s, precision: 'range' }
  }
  if ((m = rest.match(new RegExp('^' + M + '$')))) {
    const mo = monthNumber(m[1]); if (!mo) return null
    return { from: toIdx(y, mo, 1), to: toIdx(y, mo, 30), label: s, precision: 'month' }
  }
  const season = { 春: [1, 3], 夏: [4, 6], 秋: [7, 9], 冬: [10, 12] }[rest.replace(/[季天]$/, '')]
  if (season) return { from: toIdx(y, season[0], 1), to: toIdx(y, season[1], 30), label: s, precision: 'season' }
  if (/^(内|间|中|是年)?$/.test(rest)) return { from: toIdx(y, 1, 1), to: toIdx(y, 12, 30), label: s, precision: 'year' }
  return null
}

const levelOf = s => /高|P1|重/.test(s || '') ? 'high' : /低|P3|轻/.test(s || '') ? 'low' : 'mid'
const keysOf = (s, title) => { const ks = String(s || '').split(/[、，,；;\s]+/).map(x => x.trim()).filter(x => x.length >= 2).slice(0, 12); return ks.length ? ks : [title].filter(Boolean) }
function spreadOf(s) {
  const nums = (String(s || '').match(/\d+|[一二三四五六七八九十廿]+(?=\s*(?:到|至|-|—|~|日|天))/g) || []).map(x => /^\d+$/.test(x) ? Number(x) : cnNumber(x)).filter(n => n != null && n >= 0 && n <= 120)
  const days = nums.length >= 2 ? Math.round((nums[0] + nums[1]) / 2) : nums.length ? nums[0] : null
  return { days, text: String(s || '') }
}

/**
 * 读世界书条目（getCard 的 character_book.entries，或事件包），分出史事和条件。
 * 返回 { events, conds, warnings }。
 */
export function parseEntries(entries, { era = '', source = 'card' } = {}) {
  const events = [], conds = [], warnings = []
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue
    const title = String(e.comment || e.name || e.title || '')
    const isHist = PREFIX_HIST.test(title), isCond = PREFIX_COND.test(title)
    if (!isHist && !isCond) continue
    const name = title.replace(isHist ? PREFIX_HIST : PREFIX_COND, '').trim() || '（未命名）'
    const enabled = !(e.enabled === false || e.disable === true || (e.extensions && e.extensions.disable === true))
    if (source === 'card' && enabled) warnings.push('「' + name + '」在世界书里是启用的，可能被提前召回、剧透。请设为禁用。')
    if (isHist) {
      const f = fields(e.content, KEYS_HIST)
      const date = parseHistDate(f['日期'], era)
      if (!date) { warnings.push('史事「' + name + '」的日期看不懂：' + (f['日期'] || '（没写）')); continue }
      if (date.otherEra) continue // 别的年号，不属于本局
      const rel = RELIABILITY.find(r => (f['可靠度'] || '').includes(r)) || '推定'
      events.push({
        id: shortId('h', name), title: name, source, date, reliability: rel, place: (f['地点'] || '').slice(0, 20),
        spread: spreadOf(f['传播']), level: levelOf(f['级别']), pre: (f['前提'] || '').slice(0, 200),
        land: /窗口末|窗末/.test(f['落地'] || '') ? 'end' : /剧情/.test(f['落地'] || '') ? 'story' : 'sample',
        keys: keysOf(f['关键词'], name), fact: (f['事实'] || '').slice(0, 3000), visible: (f['可见'] || f['事实'] || '').slice(0, 3000),
      })
    } else {
      const f = fields(e.content, KEYS_COND)
      if (!f['条件'] || !f['内容']) { warnings.push('条件条目「' + name + '」缺少「条件：」或「内容：」'); continue }
      const kw = (f['条件'].match(/^关键词[：:]?\s*(.+)$/m) || [])[1]
      conds.push({ id: shortId('c', name), title: name, source, cond: f['条件'].slice(0, 400), allKeys: kw ? keysOf(kw) : null, keys: keysOf(f['关键词'], name), content: f['内容'].slice(0, 3000), level: levelOf(f['级别']) })
    }
  }
  return { events, conds, warnings }
}

/** 合并多个来源；同名以卡内为准。 */
export function mergeCatalogs(...cats) {
  const out = { events: [], conds: [], warnings: [] }
  for (const c of cats) {
    if (!c) continue
    for (const e of c.events) if (!out.events.some(x => x.id === e.id)) out.events.push(e)
    for (const e of c.conds) if (!out.conds.some(x => x.id === e.id)) out.conds.push(e)
    out.warnings.push(...c.warnings)
  }
  return out
}

/** 种子抽日：同一局同一件事结果固定；不同局各不相同。 */
export function sampleDay(seed, id, from, to) {
  if (to <= from) return from
  return from + (hash(String(seed) + ':' + id) % (to - from + 1))
}

const near = (a, b) => { a = norm(a); b = norm(b); return a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)) }
/** 消息传到主角要几天：同地 0；写了天数按写的；没写按默认。 */
export function spreadDays(ev, place, fallback = 10) {
  if (ev.place && place && near(ev.place, place)) return 0
  return ev.spread && ev.spread.days != null ? ev.spread.days : fallback
}

function windowOf(ev, state) {
  if (!ev.date.after) return { from: ev.date.from, to: ev.date.to }
  const ref = Object.values(state).find(s => s.title === ev.date.after.title && s.landIdx != null && s.stage !== 'cancelled')
  if (!ref) return null
  const c = ref.landIdx + ev.date.after.days
  return { from: c - 5, to: c + 5 }
}

/**
 * 本轮要问提取模型的事：快落地且有前提的史事，未满足的条件。
 * 返回 { hist: [{id,title,pre}], conds: [{id,title,cond}] }。
 */
export function pendingChecks(ledger, catalog, { seed }) {
  const T = ledger.clock ? ledger.clock.idx : null
  const st = ledger.hist || {}
  const out = { hist: [], conds: [] }
  if (T == null || !catalog) return out
  for (const ev of catalog.events) {
    const s = st[ev.id]
    if (!ev.pre || (s && !['pending', 'checking'].includes(s.stage))) continue
    const w = windowOf(ev, st); if (!w) continue
    const land = s && s.landIdx != null ? s.landIdx : (ev.land === 'end' ? w.to : sampleDay(seed, ev.id, w.from, w.to))
    if (T >= land) out.hist.push({ id: ev.id, title: ev.title, pre: ev.pre })
  }
  const cs = ledger.conds || {}
  for (const c of catalog.conds) if (!(cs[c.id] && cs[c.id].met) && !c.allKeys) out.conds.push({ id: c.id, title: c.title, cond: c.cond })
  out.hist = out.hist.slice(0, 6); out.conds = out.conds.slice(0, 8)
  return out
}

/** 给提取模型的附加说明（只在有待判事项时附上）。 */
export function checksText(checks) {
  const parts = []
  if (checks.hist.length) parts.push('【史事前提】以下史事按时间该发生了。对照本轮正文和卡的事务，判断前提是否仍成立，给出 history：[{"id","verdict":"照常|延后|形式改变|取消","reason":"一句话"}]。看不出就写“照常”。\n' + checks.hist.map(h => h.id + '｜' + h.title + '｜前提：' + h.pre).join('\n'))
  if (checks.conds.length) parts.push('【待判条件】以下条件**只有本轮正文明确写到**时才算满足；满足的给出 conditions：[{"id","quote":"逐字摘的原句"}]，不满足就不写。\n' + checks.conds.map(c => c.id + '｜' + c.cond).join('\n'))
  return parts.join('\n\n')
}

/**
 * 推进史事和条件。ctx：{ seed, place, corpus, turn, reply, settings }。
 * reply.history / reply.conditions 来自本轮提取（已在外面解析）；条件的引文在这里核对。
 * 返回本轮的变化列表（给面板看）。
 */
export function stepHistory(ledger, catalog, { seed, place, corpus = '', turn = null, reply = null, settings = {} }) {
  const T = ledger.clock ? ledger.clock.idx : null
  const changes = []
  if (T == null || !catalog) return changes
  const st = ledger.hist = ledger.hist || {}
  const cs = ledger.conds = ledger.conds || {}
  const fallback = Number(settings.newsDays) || 10
  const verdicts = new Map(((reply && reply.history) || []).filter(v => v && v.id).map(v => [String(v.id), v]))
  const hay = norm(corpus)
  for (const ev of catalog.events) {
    const s = st[ev.id] = st[ev.id] || { title: ev.title, stage: 'pending', landIdx: null, arriveIdx: null }
    s.title = ev.title
    if (['cancelled', 'known', 'background'].includes(s.stage)) continue
    const w = windowOf(ev, st)
    if (!w) continue
    // 开局时就已过去很久的：当作旧事，直接进条目池，不当新闻
    if (s.landIdx == null && s.stage === 'pending' && T > w.to + spreadDays(ev, place, fallback) && s.firstSeen == null) {
      s.stage = 'background'; s.landIdx = w.to; changes.push({ id: ev.id, title: ev.title, to: 'background' }); continue
    }
    if (s.firstSeen == null) s.firstSeen = T
    if (s.landIdx == null && T >= w.from - 1) { s.landIdx = ev.land === 'end' || ev.land === 'story' ? w.to : sampleDay(seed, ev.id, w.from, w.to); s.landLabel = dateLabel(s.landIdx) }
    if (s.landIdx == null || T < s.landIdx) continue
    if (s.stage === 'pending' || s.stage === 'checking') {
      const v = verdicts.get(ev.id)
      if (ev.pre && !v && s.stage === 'pending') { s.stage = 'checking'; continue } // 下一轮再问一次；仍没答复按照常
      const verdict = v ? String(v.verdict || '照常') : '照常'
      s.verdict = verdict; s.reason = v ? String(v.reason || '').slice(0, 80) : ''
      if (/取消/.test(verdict)) { s.stage = 'cancelled'; changes.push({ id: ev.id, title: ev.title, to: 'cancelled' }); continue }
      if (/延后/.test(verdict) && !s.delayed) { s.delayed = true; s.landIdx = T + 10; s.landLabel = dateLabel(s.landIdx); s.stage = 'pending'; changes.push({ id: ev.id, title: ev.title, to: 'delayed' }); continue }
      s.stage = 'happened'; s.changed = /形式/.test(verdict)
      s.arriveIdx = s.landIdx + spreadDays(ev, place, fallback); s.arriveLabel = dateLabel(s.arriveIdx)
      changes.push({ id: ev.id, title: ev.title, to: 'happened' })
    }
    if (s.stage === 'happened' && T >= s.arriveIdx) {
      s.stage = ev.level === 'low' ? 'known' : 'arrived'; s.arrivedTurn = turn
      changes.push({ id: ev.id, title: ev.title, to: s.stage })
    }
  }
  const metFromModel = new Map(((reply && reply.conditions) || []).filter(c => c && c.id).map(c => [String(c.id), c]))
  for (const c of catalog.conds) {
    const s = cs[c.id] = cs[c.id] || { title: c.title, met: false }
    if (s.met) continue
    let ok = false, quote = ''
    if (c.allKeys) ok = c.allKeys.every(k => hay.includes(norm(k)))
    else {
      const m = metFromModel.get(c.id)
      if (m && m.quote && norm(m.quote).length >= 4 && hay.includes(norm(m.quote))) { ok = true; quote = String(m.quote).slice(0, 60) }
    }
    if (ok) { s.met = true; s.metIdx = T; s.metTurn = turn; s.quote = quote; s.injected = false; changes.push({ id: c.id, title: c.title, to: 'met' }) }
  }
  return changes
}

const PHRASE = {
  史载: t => t + '（史载。可经邸报、同僚议论等合理途径进入剧情，不强制；人物未必立即知情。）',
  推定: t => t + '（约在此前后；具体时日、细节可视场景处理。）',
  存疑: t => '坊间传闻：' + t + '（真假未明；可只作传言，也可不提。）',
}
const trimEnd = t => String(t || '').trim().replace(/[。.]+$/, '')
/** 这一轮要注入的消息（worldbookSource）：消息已到、还没注入过的史事，刚满足的条件。 */
export function newsEntries(ledger, catalog, { max = 2 } = {}) {
  if (!catalog) return []
  const out = []
  const st = ledger.hist || {}, cs = ledger.conds || {}
  for (const ev of catalog.events) {
    const s = st[ev.id]
    if (!s || s.stage !== 'arrived') continue
    out.push({ kind: 'hist', id: ev.id, title: '世事·' + ev.title, content: PHRASE[ev.reliability](trimEnd(ev.visible)) + (s.changed ? '（此事与史载有出入：' + (s.reason || '形式有变') + '）' : ''), sort: s.arriveIdx })
  }
  for (const c of catalog.conds) {
    const s = cs[c.id]
    if (!s || !s.met || s.injected) continue
    out.push({ kind: 'cond', id: c.id, title: c.title, content: c.content, sort: s.metIdx })
  }
  return out.sort((a, b) => a.sort - b.sort).slice(0, max)
}

/** 条目池（worldbookEntries）：主角已知的史事、开局前旧事、已注入过的条件。 */
export function poolEntries(ledger, catalog) {
  if (!catalog) return []
  const st = ledger.hist || {}, cs = ledger.conds || {}
  const out = []
  for (const ev of catalog.events) {
    const s = st[ev.id]
    if (!s || !['known', 'background'].includes(s.stage)) continue
    out.push({ id: 'we-' + ev.id, title: '世事·' + ev.title, keys: ev.keys, content: (s.stage === 'background' ? '（旧事）' : '') + ev.visible })
  }
  for (const c of catalog.conds) {
    const s = cs[c.id]
    if (s && s.met && s.injected) out.push({ id: 'we-' + c.id, title: c.title, keys: c.keys, content: c.content })
  }
  return out.slice(0, 200)
}

/** 上一轮注入过的消息：史事转为主角已知，条件标为已注入。 */
export function settleNews(ledger, prevNews) {
  for (const n of prevNews || []) {
    if (n.kind === 'hist' && ledger.hist && ledger.hist[n.id] && ledger.hist[n.id].stage === 'arrived') ledger.hist[n.id].stage = 'known'
    if (n.kind === 'cond' && ledger.conds && ledger.conds[n.id]) ledger.conds[n.id].injected = true
  }
}

/** 面板手动操作。 */
export function applyHistAction(ledger, catalog, action) {
  const st = ledger.hist = ledger.hist || {}
  const s = st[action.id]
  if (!s) throw new Error('找不到这件史事（可能还没进入时间窗）')
  const T = ledger.clock ? ledger.clock.idx : null
  switch (action.type) {
    case 'histCancel': s.stage = 'cancelled'; break
    case 'histRestore': s.stage = 'pending'; s.verdict = null; break
    case 'histArriveNow': if (T == null) throw new Error('不知道今天的日期'); s.stage = 'arrived'; s.landIdx = s.landIdx ?? T; s.arriveIdx = T; s.arriveLabel = dateLabel(T); break
    case 'histLand': {
      const ev = catalog && catalog.events.find(e => e.id === action.id)
      const idx = toIdx(Math.floor((s.landIdx ?? T) / 360), Number(action.month), Number(action.day))
      if (!Number.isFinite(idx) || !(Number(action.month) >= 1 && Number(action.month) <= 12) || !(Number(action.day) >= 1 && Number(action.day) <= 30)) throw new Error('日期不对')
      s.landIdx = idx; s.landLabel = dateLabel(idx); s.stage = 'pending'; s.arriveIdx = null; s.manual = true
      if (ev) s.title = ev.title
      break
    }
    default: throw new Error('不认识的操作：' + action.type)
  }
  return ledger
}
