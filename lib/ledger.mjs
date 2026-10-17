// 约定台账：纯函数，不依赖 DSHT。
// 模型负责读懂正文、提出增删改；这里负责核对、换算日期、记账、算相关性与提醒。
// V0.2.5：记事本而不是日程表——相关才备查、同一件事只提一次、长期没人提就静默结束（见《World_Engine_Plan_V1.3》）。
import { gameDate, dateLabel, toIdx, fromIdx, FESTIVALS } from './calendar.mjs'
import { makeCal, relLabel, relSpan, dateFromVariables, CAL_LABEL } from './cal.mjs'
export { CAL_LABEL }

export const DEFAULT_SETTINGS = {
  mode: 'auto',           // 'auto' 自动挡：下面的提醒、范围、记账时机等由插件定（见 AUTO_SETTINGS）/ 'manual' 自己调
  modelHintSeen: false,   // 「记账用的是本局后台模型」的提示，玩家点过“知道了”
  extract: true,          // 每轮提取
  remind: 'auto',         // 自动提醒：'auto' 到时间就告诉正文 / 'off' 只记账、只给玩家看
  scope: 'normal',        // 告诉正文的范围：'important' 只提要紧的 / 'normal' 跨天的事（低分量只记不提）/ 'all' 全部
  gate: 'every',          // 何时记账：'every' 每轮（后台进行，不挡下一轮）/ 'keywords' 只在有约定字眼或临近事项时
  playerToStory: true,    // 主角答应的事也告诉正文（由相关的人问一句，不替主角办）
  fadeMid: 15,            // 没日期的事、或没开提醒时，多少个游戏日没动静算没下文
  maxPerTurn: 3,
  festivals: true,
  rebuildTurns: 60,
  calendar: 'auto',       // 日历：'auto' 开局时自动判断 / 'lunar' 古风 / 'gregorian' 公历 / 'story' 故事天数
  ignoreTags: '',         // 记账时另外要去掉的正文标签（逗号分隔），内置的见 clean.mjs
  datePath: 'stat_data.时间',
  placePath: 'stat_data.地点',
  protagonist: '',        // 主角名字；留空由模型识别
  model: '',              // 提取用模型：'' = 本局后台模型；否则 'provider\u0001model'
  effort: 'low',          // 提取用的推理强度：low / off（关闭思考）/ model（跟随模型设置）
  skin: 'ancient',        // 面板皮肤：'ancient' 古风 / 'host' 跟随 DSH
  history: true,          // 史事与条件条目（V0.3）
  newsMax: 2,             // 每轮最多传到几条消息
  newsDays: 10,           // 史事没写传播天数时，消息多少天传到
}
// 自动挡：玩家不用选。范围按每轮到期的多少自动取舍（见 plan）。模型仍由玩家自己选。
export const AUTO_SETTINGS = { extract: true, remind: 'auto', scope: 'auto', gate: 'every', playerToStory: true, fadeMid: 15, maxPerTurn: 3, festivals: true, history: true, effort: 'low', newsMax: 2, newsDays: 10 }
export function effectiveSettings(s) {
  const m = { ...DEFAULT_SETTINGS, ...(s || {}) }
  return m.mode === 'manual' ? m : { ...m, ...AUTO_SETTINGS }
}
const MAX_OPEN = 40, MAX_CLOSED = 40, MAX_OPS = 10, MAX_LOG = 5, MAX_REJECTED = 30
const OVERDUE_STEPS = [2, 4, 8], STALE_STEPS = [1, 2, 4]
const KINDS = ['appointment', 'deadline', 'errand', 'debt', 'expect', 'memo']
const WEIGHTS = ['low', 'mid', 'high']
export const KIND_LABEL = { appointment: '约会', deadline: '期限', errand: '托办', debt: '借还', expect: '预计', memo: '备忘' }
export const WEIGHT_LABEL = { high: '高', mid: '中', low: '低' }
export const STATUS_LABEL = { done: '办完', cancelled: '取消', missed: '失约', faded: '没下文' }

const cut = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const PUNCT = /[\s，。；、,.;:：！？!?“”"'‘’（）()【】《》〈〉「」『』—…⋯·\-~～]/g
export const norm = s => String(s ?? '').replace(PUNCT, '')
const maxDefined = (...xs) => { const v = xs.filter(x => x != null && Number.isFinite(x)); return v.length ? Math.max(...v) : null }

export function emptyLedger() {
  return { v: 3, seq: 0, clock: null, protagonist: null, entries: [], closed: [], plan: { world: [], player: [], held: [], overflow: 0 }, rejected: [], stats: { calls: 0, skipped: 0, rejected: 0, via: null }, festivalsDone: [], warnings: [] }
}

function upgradeEntry(e) {
  if (!e.weight) e.weight = 'mid'
  if (e.weightLock === undefined) e.weightLock = ({ P1: 'high', P2: 'mid', P3: 'low' })[e.priority] || null
  delete e.priority
  if (e.place === undefined) e.place = ''
  if (!e.mentions) e.mentions = { count: 0, lastIdx: null, lastTurn: null }
  if (!e.notified) e.notified = {}
  if (!e.reminded) e.reminded = { count: 0, lastIdx: null, step: 0, forIdx: [] }
  if (e.status === 'lapsed') e.status = 'open'
  return e
}

/** 旧版状态迁移。v1：只保留手动备忘；v2：补字段。 */
export function migrate(data) {
  return withCalendar(migrate0(data))
}
function withCalendar(l) {
  if (!l.calendar && l.clock) l.calendar = l.clock.cal || 'lunar'
  if (l.clock && !l.clock.cal) l.clock.cal = l.calendar || 'lunar'
  return l
}
function migrate0(data) {
  if (data && data.v === 3) return structuredClone(data)
  if (data && data.v === 2) {
    const l = { ...emptyLedger(), ...structuredClone(data), v: 3 }
    l.entries = (l.entries || []).map(upgradeEntry)
    l.plan = { world: [], player: [], held: [], overflow: 0 }
    return l
  }
  const l = emptyLedger()
  if (data && data.v === 1) {
    for (const m of data.manual || []) {
      if (m.done) continue
      l.entries.push(newEntry(l, { title: m.title, who: [], side: 'player', kind: 'memo', when: { idx: m.idx, end: m.idx, label: dateLabel(m.idx), precision: 'day' }, evidence: m.note || '', source: 'manual' }, null))
    }
    if (data.date) l.clock = { idx: data.date.idx, label: dateLabel(data.date.idx), source: 'variable', era: data.date.era, cal: 'lunar' }
  }
  return l
}

// —— 时钟 ——
export function readPath(obj, path) {
  let v = obj
  for (const k of String(path || '').split('.').filter(Boolean)) { if (v == null || typeof v !== 'object') return undefined; v = v[k] }
  return v
}
export function clockFromVariables(variables, path) {
  const d = gameDate(readPath(variables, path))
  if (d) return { idx: d.idx, label: dateLabel(d.idx), source: 'variable', era: d.era, cal: 'lunar', path }
  const g = dateFromVariables(variables, path, readPath) // 别的写法：{年,月,日}、“2024年5月3日”、在 stat_data 里自动找
  return g ? { idx: g.idx, label: g.label, source: 'variable', era: g.era, cal: g.cal, path: g.path } : null
}
/** 日历里的一天 → 时钟对象。 */
export function clockAt(cal, idx, source, era) { return { idx, label: makeCal(cal).label(idx), source, era, cal } }
/** 时钟往前走 hours 小时（零头攒着）。 */
export function advanceClock(ledger, hours, source) {
  if (!ledger.clock || !(hours > 0)) return false
  const total = (ledger.clockHours || 0) + hours
  const days = Math.floor(total / 24)
  ledger.clockHours = total - days * 24
  if (days > 0) { ledger.clock = clockAt(ledger.clock.cal || ledger.calendar || 'story', ledger.clock.idx + days, source, ledger.clock.era); return true }
  return false
}

const MONTH = ['', '正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']
/** 月、日 → 日序（年份按 today 推断：腊月说正月 → 明年；正月说腊月 → 去年）。 */
function dayIdx(m, d, today) {
  const T = fromIdx(today.idx)
  let y = T.y
  if (T.m - m >= 6) y += 1
  else if (m - T.m >= 6) y -= 1
  return toIdx(y, m, d)
}

/**
 * 模型给的 when → { idx, end, label, precision }；不合法返回 null。
 * 写法：{month, day|'end'} / {month, part:'上|中|下'} / {month} / {offsetDays, said:{month,day}}。
 * 相对日期以 said（说这句话那天）为准；没有 said 时以 anchor（缺省为 today）为准。
 */
export function whenToRange(when, today, { anchor = null, saidRange = null } = {}) {
  if (!when || typeof when !== 'object' || !today) return null
  const cal = makeCal(today.cal || 'lunar')
  const T = today.idx
  const lab = (a, b) => a === b ? cal.short(a) : cal.short(a) + '至' + cal.short(b)
  const MAX = cal.kind === 'lunar' ? 400 : 3650
  const saidBase = () => { // undefined：没写说话日；null：写错了
    if (!when.said || typeof when.said !== 'object' || cal.kind === 'story') return undefined
    const sm = Number(when.said.month), sd = Number(when.said.day)
    if (!Number.isInteger(sm) || sm < 1 || sm > 12 || !cal.dayOk(sd)) return null
    const s0 = cal.monthDay(sm, sd, T)
    if (s0 == null || (saidRange && (s0 < saidRange[0] - 1 || s0 > saidRange[1] + 1))) return null
    return s0
  }
  if (Array.isArray(when.afterDays) && when.afterDays.length === 2) { // 估计：说话那天之后 a 到 b 天
    const a = Number(when.afterDays[0]), b = Number(when.afterDays[1])
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b > MAX) return null
    const s0 = saidBase(); if (s0 === null) return null
    const base = s0 !== undefined ? s0 : anchor != null ? anchor : T
    return { idx: base + a, end: base + b, label: lab(base + a, base + b), precision: 'estimate' }
  }
  if (when.offsetDays != null) {
    const n = Number(when.offsetDays)
    if (!Number.isInteger(n) || n < 0 || n > MAX) return null
    const s0 = saidBase(); if (s0 === null) return null
    const idx = (s0 !== undefined ? s0 : anchor != null ? anchor : T) + n
    return { idx, end: idx, label: cal.short(idx), precision: 'day' }
  }
  if (when.weekday != null && cal.kind === 'gregorian') { // 周几：1–7；week 0 本周 / 1 下周 / 2 下下周
    const w = Number(when.weekday), k = when.week == null ? null : Number(when.week)
    if (!Number.isInteger(w) || w < 1 || w > 7 || (k != null && (!Number.isInteger(k) || k < 0 || k > 4))) return null
    let idx = cal.weekday(w, k || 0, T)
    if (k == null && idx < T) idx += 7
    return { idx, end: idx, label: cal.short(idx), precision: 'day' }
  }
  if (cal.kind === 'story') return null // 故事天数没有月日
  const m = Number(when.month)
  if (!Number.isInteger(m) || m < 1 || m > 12) return null
  if (when.day === 'end') { const idx = cal.monthEnd(m, T); return { idx, end: idx, label: cal.monthName(m) + '底', precision: 'day' } }
  if (when.day != null) {
    const d = Number(when.day)
    if (!cal.dayOk(d)) return null
    const idx = cal.monthDay(m, d, T)
    if (idx == null) return null
    return { idx, end: idx, label: cal.short(idx), precision: 'day' }
  }
  const first = cal.monthDay(m, 1, T), last = cal.monthEnd(m, T)
  const part = { 上: [0, 9], 中: [10, 19], 下: [20, null] }[when.part]
  if (part) return { idx: first + part[0], end: part[1] == null ? last : first + part[1], label: cal.monthName(m) + when.part + '旬', precision: 'part' }
  return { idx: first, end: last, label: cal.monthName(m), precision: 'month' }
}

// —— 门槛 ——
// 有日期或约定类字眼就提取；台账里有临近的事项也提取（它可能在本轮被办完或改期）。
const GATE = /初[一二三四五六七八九十]|廿[一二三四五六七八九]|(?:[十卅]|[二三]十)[一二三四五六七八九]?[日号]|\d{1,2}\s*[日号]|[正二三四五六七八九十冬腊]月|明日|明天|明早|明儿|后日|后天|[几数两三五十]日后|过几日|过两日|下月|月底|月末|年底|[上中下]旬|约|定[了下在好]|说定|讲定|应承|答应|应了|许了|期|限|改到|改日|取消|作罢|不去了|回话|回信|回音|听信|候信|归还|还钱|还银|还债|欠|借|送到|送去|带回|托|收到|接到|办妥|办完|交割|呈上|交上|动身|启程|上船|抵达|来访|拜访|赴/
export function shouldExtract(input, text, ledger) {
  if (GATE.test(String(input || '') + '\n' + String(text || ''))) return 'keywords'
  const T = ledger.clock && ledger.clock.idx
  if (T != null && ledger.entries.some(e => e.status === 'open' && e.when && e.when.idx <= T + 3 && e.when.end >= T - 3)) return 'near-due'
  return null
}

// —— 指令 ——
export const SYSTEM_PROMPT = `你是剧情约定的记账员。你只做一件事：根据本轮的玩家输入和正文，对【未结台账】提出增删改。
不写剧情，不评价，不推测正文以外的事。

一、要记的：将来要发生、要做、要等的事，并且**已经说定**，有明确的或可推算的时间。
- 约会、拜访、聚会；公务期限；托人办事后等回音；借贷还期；预计的抵达、送达、回信；
- 主角答应别人的事，别人答应主角的事，上司交代下来的期限；
- 别人明白告知的安排或预计（“伙计初七初八动身”“山东司二月里还会来催”“运河那边二月中才有准信”）：记为 side world、kind expect。这是当事人说的安排，不算传闻。
- **发出去、等回应的事**：主角寄出的信、托人打听的事、请人办的事、递上去的呈文。即使原文没写日子也要记：side world、kind expect、toMe true，when 用估计写法 {"afterDays":[最少天数,最多天数],"said":{寄出那天}}，按这个世界的交通和通讯估：同城几日；书信、驿马、商船按路程（古代京师到江南单程一月上下，回信再加一月）；电话、网络、传讯法术几乎即时，回音通常当天到几天。title 写成“××的回信”“××的回话”。别人要来访、要送东西来，也标 toMe true。
- **不同的事分开记**。同一个人交代的两件事是两条；新出现的期限不要并进已有的另一件事（“说帖初十前呈”不是“档房核对”的改期）。只有同一件事改了时间才用 reschedule。
二、不记的：
- 只是提议、商量、问句，对方还没答应（“要不要明早去问问？”“不如初五再去”“信明日送不送？”）；
- 已经发生的事（“正月十九某人来问过”）——它若是台账里某件事的进展或了结，用 progress / done；
- 否定、假设、条件、猜测、传闻、梦境、玩笑（“不是初六”“兴许明儿来”“若是有车便捎去”）；
- 主角自己没有时间的笼统打算（“改天再说”“得空去一趟”）；纯粹的日期描写（“今日初二，天晴”）。
- 回忆、闪回、梦境、幻想里的事；正文后附的选项、剧情分支、状态栏、小剧场（插件已尽量去掉，残留的也不要记）。
二之一、**意向**（记，但标 basis "intent"）：有人表示愿意帮忙、答应留意、说等有消息再说，但没说定具体做什么或什么时候（“可以帮忙留意有没有合适的玻璃”“我替你打听打听”“等有了好的再给你送来”）。
- 给对方留的余地也算意向，不算说定：“可明日来取，也可后日”“得空再来”“相公若还要，到时先捎句话”。
- **条件建议不是改期，也不是说定**：“要赶上十九日的车，得十八日前把信交到”只是说明怎样才来得及，主角还没决定，不要 reschedule / confirm；主角照做了再记。
- 意向和说定的区别：说定的有明确的事和时间，或是已经动手（信已寄出、人已派出）；意向只是表态。拿不准时标 intent，不要拔高成说定。
- 意向不会提醒，过一阵没动静自然放下。后来说定了（“三日后把玻璃送来”），对那条用 confirm。

三、操作：
- add：新约定。
- reschedule：已有条目改了时间（“初二改到初五”）。不要另建新条目。
- progress：有进展但没了结（“信已交到铺里，等上船”），可附新的 when。
- confirm：台账里标着（意向）的事说定了。附说定的原话，有时间就给 when。
- done：办完了、兑现了。
- cancel：取消了、作罢了。
- missed：时间已过，正文明确说**这件事本身**没办成或失约。quote 必须是说没办成的那句。
  别人的行程照常走了、而主角那头的事没做，不是 missed：用 progress 记下变化（例如“伙计已动身，信没赶上”）。
- 台账里标着【没下文】的事，正文又提起并有了新进展，可以对它的编号用 progress / done / reschedule，它会重新打开。

四、字段：
- side：要主角自己动手的写 player（主角去赴约、主角交说帖、主角还钱）；要别人或外部世界动的写 world（书肆回话、商人动身、信件送达、别人来访）。
- kind：appointment 约会 / deadline 期限 / errand 托人办事等回音 / debt 借还 / expect 预计 / memo 备忘。
- weight（分量，只看原文，不看剧情重不重要）：high 有明确的对方和期限、错过有后果（上司限期、借银归还日、官府程限）；mid 普通约会、托办、等回话、寄信；low 顺口一说、没人会追，以及当天或次日就办的家务琐事（买碗、打油、捎句话、跑一趟腿）。
- toMe：这件事的结果会找上主角（回信、回话、来访、送达）时填 true。
- who：涉及的人名（不要写主角自己）。place：事情发生或要去的地点，2–8 字，没有就省略。
- basis（add 和 reschedule 必填）："agreed" 已说定 / "intent" 意向（见二之一）/ "proposal" 只是提议或问句（不登记）。
  如果 quote 本身是问句或提议，而后文有人答应了，另给 agreeQuote：答应的那句原话。

五、when 的写法（估计写法见上）：{"month":2,"day":5} 或 {"month":1,"day":"end"}（月底）或 {"month":3,"part":"上"}（上旬）或 {"month":3}（只知道月份）。
相对日期（明日、后日、三日后、过两日）写 {"offsetDays":1,"said":{"month":1,"day":27}}：said 是**说这句话的那一天**。
正文跨了好几天时，要按那句话所在那一段的日期写 said，不要用本轮结束那天。不要自己换算年份和星期，不要写“明年”。

六、引文：每个操作都必须附 quote，从本轮玩家输入或正文里**逐字**摘，40 字以内，能证明这个操作。
一句话被中间的“他说”之类隔开时，可以用“……”连接前后两段，每段都要逐字。摘不出原句的操作不要输出。拿不准的不要输出。

七、另外给出：
- today：本轮正文结束时的日期 {"month":M,"day":D}；正文没写清就填 null。
- elapsed：本轮故事里大约过了多久，{"hours":H} 或 {"days":D}（“三年后”就是 {"days":1095}）；几乎没过就填 {"hours":1}。
- mentioned：本轮正文提到了的未结条目编号（包括只是被人提起、没有进展的），没有就是空数组。
- protagonist：主角的名字（看不出就填 null）。
- 只有消息末尾附了【史事前提】或【待判条件】时，才另给 history、conditions（写法见那里）；它们不影响 ops。

只输出一个 JSON 对象，不要任何其他文字：
{"today":{"month":2,"day":2},"protagonist":"汪景珩","mentioned":["e3"],"ops":[
 {"op":"add","title":"高梁桥踏青","who":["沈恪"],"place":"高梁桥","side":"player","kind":"appointment","weight":"mid","basis":"agreed","when":{"month":2,"day":5},"quote":"……"},
 {"op":"add","title":"邵鸣谦来取文册","who":["邵鸣谦"],"side":"world","kind":"appointment","weight":"mid","basis":"agreed","when":{"offsetDays":1,"said":{"month":1,"day":28}},"quote":"……"},
 {"op":"add","title":"苏先生的回信","who":["苏浚"],"place":"杭州","side":"world","kind":"expect","toMe":true,"weight":"mid","basis":"agreed","when":{"afterDays":[60,90],"said":{"month":2,"day":13}},"quote":"……"},
 {"op":"reschedule","id":"e7","basis":"agreed","when":{"month":2,"day":5},"quote":"……"},
 {"op":"done","id":"e3","quote":"……"}
]}`

const WHEN_GREGORIAN = `五、when 的写法（估计写法见上）：{"month":5,"day":31} 或 {"month":6,"day":"end"}（月底）或 {"month":6,"part":"上"}（上旬）或 {"month":6}（只知道月份）。
周几写 {"weekday":3,"week":1}（weekday 1–7 是周一到周日；week 0 本周、1 下周、2 下下周；“周三”没说哪周就省略 week，取接下来最近的那个）。
相对日期（明天、后天、三天后、下周）写 {"offsetDays":1,"said":{"month":5,"day":30}}：said 是**说这句话的那一天**。
正文跨了好几天时，要按那句话所在那一段的日期写 said，不要用本轮结束那天。不要自己换算年份，不要写“明年”。`
const WHEN_STORY = `五、when 的写法：这个故事没有日历，台账里的日期写成“第N天”（故事从开局那天算起）。when **只能用相对写法**：
{"offsetDays":n}：从本轮结束那天算起 n 天后（明天 = 1，“下周”约 7，“下个月”约 30）；
估计写法 {"afterDays":[a,b]}：从本轮结束那天算起 a 到 b 天（“明年夏天”“等她毕业”按常理估天数）。
不要写 month、day、said。`
/** 按日历给出记账规则。 */
export function promptFor(cal) {
  if (cal === 'gregorian') return SYSTEM_PROMPT
    .replace(/五、when 的写法[\s\S]*?不要写“明年”。/, WHEN_GREGORIAN)
    .replace('纯粹的日期描写（“今日初二，天晴”）', '纯粹的日期描写（“今天 5 月 3 日，晴”）')
  if (cal === 'story') return SYSTEM_PROMPT
    .replace(/五、when 的写法[\s\S]*?不要写“明年”。/, WHEN_STORY)
    .replace('when 用估计写法 {"afterDays":[最少天数,最多天数],"said":{寄出那天}}', 'when 用估计写法 {"afterDays":[最少天数,最多天数]}')
    .replace(/- today：本轮正文结束时的日期[^\n]*\n/, '- today：填 null。\n')
    .replace('- elapsed：本轮故事里大约过了多久', '- elapsed（必填）：本轮故事里大约过了多久')
    .replace(/有明确的或可推算的时间。/, '有明确的或可推算的时间（这个故事没有日历，时间按“几天后”“几个月后”这样推算）。')
    .replace(/"when":\{"month":2,"day":5\}/g, '"when":{"offsetDays":3}')
    .replace('"when":{"offsetDays":1,"said":{"month":1,"day":28}}', '"when":{"offsetDays":1}')
    .replace('"when":{"afterDays":[60,90],"said":{"month":2,"day":13}}', '"when":{"afterDays":[60,90]}')
    .replace('{"today":{"month":2,"day":2},', '{"today":null,"elapsed":{"hours":5},')
  return SYSTEM_PROMPT
}
export function rebuildPromptFor(cal) {
  return promptFor(cal)
    .replace('根据本轮的玩家输入和正文，对【未结台账】提出增删改。', '通读下面按时间顺序排列的多轮剧情（每轮前面标了当轮的日期），整理出到【今天】为止**仍未了结**的约定，对【未结台账】提出增删改。已经了结的不要 add。')
    .replace('从本轮玩家输入或正文里**逐字**摘', '从下面的剧情里**逐字**摘')
    .replace('正文跨了好几天时，要按那句话所在那一段的日期写 said，不要用本轮结束那天。', 'said 按那句话所在那一轮标出的日期写（正文里另写了日期的，以正文为准）。')
    .replace('从本轮结束那天算起', '从【今天】算起')
}

export const REBUILD_PROMPT = SYSTEM_PROMPT
  .replace('根据本轮的玩家输入和正文，对【未结台账】提出增删改。', '通读下面按时间顺序排列的多轮剧情（每轮前面标了当轮的日期），整理出到【今天】为止**仍未了结**的约定，对【未结台账】提出增删改。已经了结的不要 add。')
  .replace('从本轮玩家输入或正文里**逐字**摘', '从下面的剧情里**逐字**摘')
  .replace('正文跨了好几天时，要按那句话所在那一段的日期写 said，不要用本轮结束那天。', 'said 按那句话所在那一轮标出的日期写（正文里另写了日期的，以正文为准）。')

function ledgerLines(ledger) {
  const open = ledger.entries.filter(e => e.status === 'open').slice(0, 30)
  const lines = open.map(e => [e.id, e.title + (e.toMe ? '（等回应）' : '') + (e.intent ? '（意向）' : '') + (e.confirmed ? '（玩家确认）' : ''), (e.who || []).join('、') || '—', e.side, e.kind, WEIGHT_LABEL[effectiveWeight(e)] || '中', e.when ? e.when.label : '无日期', e.place || '—'].join('｜'))
  const faded = (ledger.closed || []).filter(c => c.status === 'faded' && c.entry).slice(-8)
    .map(c => [c.id, c.title, (c.who || []).join('、') || '—', c.side, c.kind, '没下文', c.when || '无日期', '—'].join('｜'))
  return (lines.length ? lines.join('\n') : '（空）') + (faded.length ? '\n【没下文（已静默结束，正文再提起可重新打开）】\n' + faded.join('\n') : '')
}

/** 用户消息：不常变的放前面（台账），每轮都变的放后面（日期、正文）。 */
export function buildUserMessage({ ledger, start, input, text, tasks, extra, earlier }) {
  const end = ledger.clock
  const era = end && end.era ? end.era + ' ' : ''
  return [
    '【未结台账】编号｜事项｜人物｜side｜kind｜分量｜日期｜地点\n' + ledgerLines(ledger),
    tasks && tasks.length ? '【参考：卡的事务列表】\n' + tasks.slice(0, 15).map(t => '· ' + t).join('\n') : '',
    ledger.protagonist ? '【主角】' + ledger.protagonist : '',
    '【日期】本轮开始时：' + (start ? era + start.label : '未知') + '；本轮结束时（今天）：' + (end ? era + end.label : '未知') +
      (start && end && end.idx - start.idx >= 2 ? '。本轮跨了 ' + (end.idx - start.idx) + ' 天，相对日期务必按说话那天写 said。' : ''),
    earlier ? '【上一轮（第' + earlier.turn + '轮）：当时没来得及记账，和本轮一并看】\n玩家输入：' + (String(earlier.input || '').trim() || '（无）') + '\n正文：\n' + String(earlier.text || '').slice(0, 8000) : '',
    '【本轮玩家输入】\n' + (String(input || '').trim() || '（无）'),
    '【本轮正文】\n' + String(text || '').slice(0, 12000),
    extra || '',
  ].filter(Boolean).join('\n\n')
}

export function buildRebuildMessage({ ledger, corpus }) {
  return ['【未结台账】编号｜事项｜人物｜side｜kind｜分量｜日期｜地点\n' + ledgerLines(ledger), '【今天】' + (ledger.clock ? ledger.clock.label : '未知'), '【剧情（按时间顺序）】\n' + corpus].join('\n\n')
}

// —— 解析模型回复（容错） ——
function balancedObjects(s, from) {
  const out = []
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { if (depth === 0) start = i; depth++ }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1 } if (depth < 0) break }
    else if (c === ']' && depth === 0) break
  }
  return out
}
const tryJSON = s => { try { return JSON.parse(s) } catch { return undefined } }
const clean = s => s.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
function closeOpen(s) {
  let inStr = false, esc = false
  const stack = []
  for (const c of s) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']')
    else if (c === '}' || c === ']') stack.pop()
  }
  return (inStr ? s + '"' : s) + stack.reverse().join('')
}
/** 从模型回复里取出 JSON；格式坏了先修补，修不了再逐条抢救 ops。repaired 表示修补过。 */
export function parseReply(reply) {
  const raw = String(reply || '').replace(/```(?:json)?/gi, '')
  const start = raw.indexOf('{')
  if (start < 0) throw new Error('模型没有返回 JSON')
  const end = raw.lastIndexOf('}')
  const pack = (obj, repaired) => ({
    today: obj && obj.today && typeof obj.today === 'object' ? obj.today : null,
    elapsed: elapsedHours(obj && obj.elapsed),
    ops: Array.isArray(obj && obj.ops) ? obj.ops.filter(o => o && typeof o === 'object') : [],
    mentioned: Array.isArray(obj && obj.mentioned) ? obj.mentioned.map(String).slice(0, 30) : [],
    protagonist: obj && typeof obj.protagonist === 'string' ? cut(obj.protagonist, 10) : null,
    history: Array.isArray(obj && obj.history) ? obj.history.filter(x => x && typeof x === 'object').slice(0, 10) : [],
    conditions: Array.isArray(obj && obj.conditions) ? obj.conditions.filter(x => x && typeof x === 'object').slice(0, 10) : [],
    repaired,
  })
  let obj = end > start ? tryJSON(raw.slice(start, end + 1)) : undefined
  if (obj !== undefined) return pack(obj, false)
  obj = end > start ? tryJSON(clean(raw.slice(start, end + 1))) : undefined
  if (obj !== undefined) return pack(obj, true)
  obj = tryJSON(closeOpen(clean(raw.slice(start))))
  if (obj !== undefined) return pack(obj, true)
  // 逐条抢救
  const opsAt = raw.indexOf('"ops"')
  const arr = opsAt >= 0 ? raw.indexOf('[', opsAt) : -1
  const ops = arr >= 0 ? balancedObjects(raw, arr + 1).map(x => tryJSON(clean(x))).filter(x => x && typeof x === 'object') : []
  const todayM = raw.match(/"today"\s*:\s*(\{[^{}]*\})/)
  const elapsedM = raw.match(/"elapsed"\s*:\s*(\{[^{}]*\})/)
  const mentionedM = raw.match(/"mentioned"\s*:\s*(\[[^\]]*\])/)
  const protM = raw.match(/"protagonist"\s*:\s*"([^"]{1,20})"/)
  if (!ops.length && !todayM) throw new Error('模型回复的 JSON 坏了，修补不了')
  return pack({ today: todayM ? tryJSON(todayM[1]) : null, elapsed: elapsedM ? tryJSON(elapsedM[1]) : null, ops, mentioned: mentionedM ? tryJSON(mentionedM[1]) || [] : [], protagonist: protM ? protM[1] : null }, true)
}

/** 模型给的“过了多久” → 小时数；不合法返回 null。 */
export function elapsedHours(e) {
  if (!e || typeof e !== 'object') return null
  const h = Number(e.hours || 0) + Number(e.days || 0) * 24 + Number(e.minutes || 0) / 60
  return Number.isFinite(h) && h > 0 && h <= 24 * 3650 * 3 ? h : null
}

// —— 引文核对 ——
/** 引文可用“……”分段，每段逐字出现在语料里且先后顺序一致。返回 true / 'short' / false。 */
export function quoteFound(hay, quote) {
  const segs = String(quote || '').split(/……|…|⋯|\.{3,}/).map(norm).filter(s => s.length >= 2)
  if (!segs.length || segs.join('').length < 4) return 'short'
  let pos = 0
  for (const s of segs) {
    const i = hay.indexOf(s, pos)
    if (i < 0) return false
    pos = i + s.length
  }
  return true
}
const TENTATIVE = /[？?]\s*[」』”"]?\s*$|要不要|要不|不如|可好|好不好|行不行|成不成|可否|能否|兴许|也许|或许|说不定|若是|若有|若要|要是|倘若|如果|假如/
const FAILED = /[没未]|错过|误了|耽误|不成|赶不上|失约|爽约|落空|不曾|没能|作罢|黄了/

// —— 记账 ——
function newEntry(ledger, f, turnInfo) {
  ledger.seq = (ledger.seq || 0) + 1
  const at = turnInfo ? { turn: turnInfo.turn, idx: turnInfo.idx } : { turn: null, idx: ledger.clock ? ledger.clock.idx : null }
  const prot = ledger.protagonist
  return {
    id: 'e' + ledger.seq, title: cut(f.title, 20) || '（未命名）',
    who: (Array.isArray(f.who) ? f.who : []).map(w => cut(w, 10)).filter(w => w && w !== prot).slice(0, 4),
    side: f.side === 'world' ? 'world' : 'player', kind: KINDS.includes(f.kind) ? f.kind : 'appointment',
    weight: WEIGHTS.includes(f.weight) ? f.weight : 'mid', weightLock: null, place: cut(f.place, 12), toMe: f.toMe === true || f.toMe === 'true',
    when: f.when || null, status: 'open', evidence: cut(f.evidence, 60), log: f.evidence ? [{ turn: at.turn, op: 'add', quote: cut(f.evidence, 60) }] : [],
    created: at, touched: at, mentions: { count: 0, lastIdx: null, lastTurn: null }, notified: {},
    reminded: { count: 0, lastIdx: null, step: 0, forIdx: [] },
    frozen: false, snoozeUntil: null, source: f.source || 'model',
    intent: f.intent === true, confirmed: false, suggest: null,
  }
}

function close(ledger, e, status, at) {
  e.status = status
  ledger.entries = ledger.entries.filter(x => x !== e)
  const rec = { id: e.id, title: e.title, who: e.who, side: e.side, kind: e.kind, status, endIdx: at.idx, when: e.when ? e.when.label : null, evidence: e.evidence }
  if (status === 'faded') rec.entry = structuredClone(e) // 没下文的留全文，正文再提起时可重新打开
  ledger.closed = [...ledger.closed, rec].slice(-MAX_CLOSED)
}
function reopen(ledger, id) {
  const i = (ledger.closed || []).findIndex(c => c.id === id && c.status === 'faded' && c.entry)
  if (i < 0) return null
  const e = upgradeEntry(ledger.closed[i].entry)
  e.status = 'open'; e.notified = {}
  ledger.closed = ledger.closed.filter((_, k) => k !== i)
  ledger.entries.push(e)
  return e
}

/**
 * 核对并应用模型给出的操作。
 * corpus：引文必须出现在其中（本轮输入 + 正文，或重建时的多轮剧情）。
 * start：本轮开始时的时钟（相对日期的说话日不能早于它）。
 * 返回 { applied: [...], rejected: [...] }，直接修改 ledger。
 */
export function applyOps(ledger, ops, { corpus, turn, start = null, allowPastAdd = false }) {
  const applied = [], rejected = []
  const hay = norm(corpus)
  const T = ledger.clock
  const at = { turn, idx: T ? T.idx : null }
  const saidRange = T ? [start ? Math.min(start.idx, T.idx) : T.idx - 30, T.idx] : null
  const anchor = T ? T.idx : null
  const reject = (op, why) => rejected.push({ turn, op: op && op.op, id: op && op.id, title: op && op.title, quote: cut(op && op.quote, 50), why })
  const toRange = when => whenToRange(when, T, { anchor, saidRange })
  for (const op of (ops || []).slice(0, MAX_OPS)) {
    if (!op || typeof op !== 'object') { reject(op, '格式不对'); continue }
    const found = quoteFound(hay, op.quote)
    if (found === 'short') { reject(op, '没有引文或引文太短'); continue }
    if (!found) { reject(op, '引文在正文里找不到'); continue }
    const quote = cut(op.quote, 60)
    const isIntent = op.op === 'add' && op.basis === 'intent'
    if (isIntent && /[？?]\s*[」』”"]?\s*$/.test(String(op.quote).trim())) { reject(op, '意向的引文是问句'); continue }
    if (!isIntent && (op.op === 'add' || op.op === 'reschedule' || op.op === 'confirm')) {
      if (op.basis === 'proposal') { reject(op, '只是提议，还没说定'); continue }
      if (TENTATIVE.test(String(op.quote).trim())) {
        const ok = op.agreeQuote && quoteFound(hay, op.agreeQuote) === true && !TENTATIVE.test(String(op.agreeQuote).trim())
        if (!ok) { reject(op, '引文是问句或提议，没有答应的原话'); continue }
      }
    }
    if (op.op === 'add') {
      if (!T) { reject(op, '不知道今天的日期，无法登记'); continue }
      const when = op.when == null ? null : toRange(op.when)
      if (op.when != null && !when) { reject(op, '日期写法不认识，或说话日不在本轮'); continue }
      if (when && when.end < T.idx && !allowPastAdd) { reject(op, '日期已经过去（视为已发生的事）'); continue }
      const dup = ledger.entries.find(e => e.status === 'open' && norm(e.title) === norm(op.title))
      if (dup) { // 同名未结条目：当作改期或进展；意向被说定的，顺势转正
        if (when && (!dup.when || dup.when.idx !== when.idx)) {
          if (dup.confirmed) { holdForPlayer(dup, { op: 'reschedule', when, quote, turn }); reject(op, CONFIRMED_WHY); continue }
          dup.when = when; dup.reminded.forIdx = []; dup.notified = {}
        }
        const up = dup.intent && !isIntent
        if (up) dup.intent = false
        touch(dup, at, 'progress', quote); applied.push({ op: up ? 'confirm' : 'progress', id: dup.id, via: 'add-dup', quote }); continue
      }
      if (ledger.entries.filter(e => e.status === 'open').length >= MAX_OPEN) { reject(op, '台账已满'); continue }
      const e = newEntry(ledger, { ...op, when, evidence: quote, intent: isIntent }, at)
      ledger.entries.push(e)
      applied.push({ op: isIntent ? 'intent' : 'add', id: e.id, quote })
      continue
    }
    let e = ledger.entries.find(x => x.id === op.id && x.status === 'open')
    if (!e && ['progress', 'done', 'reschedule'].includes(op.op)) e = reopen(ledger, op.id)
    if (!e) { reject(op, '编号不存在或已了结'); continue }
    if (op.op === 'confirm') {
      if (!e.intent) { touch(e, at, 'progress', quote); applied.push({ op: 'progress', id: e.id, via: 'confirm', quote }); continue }
      if (op.when != null) {
        const when = toRange(op.when)
        if (when && when.end >= (T ? T.idx : 0) && !e.confirmed) { e.when = when; e.reminded.forIdx = []; e.notified = {} }
      }
      e.intent = false
      touch(e, at, 'confirm', quote); applied.push({ op: 'confirm', id: e.id, quote }); continue
    }
    // 玩家确认过（或手动改过）的条目：改期、取消、判失约不直接生效，留给玩家决定
    if (e.confirmed && (op.op === 'reschedule' || op.op === 'cancel' || op.op === 'missed' || (op.op === 'progress' && op.when != null))) {
      if (op.op === 'missed' && !FAILED.test(String(op.quote))) { reject(op, '判失约却没有“没办成”的原话'); continue }
      const when = op.when != null ? toRange(op.when) : null
      if ((op.op === 'reschedule' || op.op === 'progress') && !when) { if (op.op === 'progress') { touch(e, at, 'progress', quote); applied.push({ op: 'progress', id: e.id, quote }) } else reject(op, '日期写法不认识'); continue }
      holdForPlayer(e, { op: op.op === 'progress' ? 'reschedule' : op.op, when, quote, turn })
      reject(op, CONFIRMED_WHY); continue
    }
    if (op.op === 'reschedule' || op.op === 'progress') {
      if (op.when != null) {
        const when = toRange(op.when)
        if (!when) { if (op.op === 'reschedule') { reject(op, '日期写法不认识'); continue } }
        else if (when.end < (T ? T.idx : 0) && op.op === 'reschedule') { reject(op, '改到的日期已经过去'); continue }
        else { e.when = when; e.reminded.forIdx = []; e.notified = {} }
      } else if (op.op === 'reschedule') { reject(op, '改期却没给日期'); continue }
      touch(e, at, op.op, quote); applied.push({ op: op.op, id: e.id, quote }); continue
    }
    if (op.op === 'missed' && !FAILED.test(String(op.quote))) { reject(op, '判失约却没有“没办成”的原话'); continue }
    if (['done', 'cancel', 'missed'].includes(op.op)) {
      touch(e, at, op.op, quote)
      close(ledger, e, { done: 'done', cancel: 'cancelled', missed: 'missed' }[op.op], at)
      applied.push({ op: op.op, id: e.id, quote }); continue
    }
    reject(op, '不认识的操作')
  }
  ledger.rejected = [...(ledger.rejected || []), ...rejected].slice(-MAX_REJECTED)
  ledger.stats.rejected = (ledger.stats.rejected || 0) + rejected.length
  return { applied, rejected }
}

const CONFIRMED_WHY = '你确认过这一条，改动先放在台账里等你决定'
function holdForPlayer(e, { op, when, quote, turn }) {
  e.suggest = { op, when: when || null, quote: cut(quote, 60), turn }
}

function touch(e, at, op, quote) {
  e.touched = at
  if ((op === 'reschedule' || op === 'progress') && quote) e.evidence = quote // 证据换成最新的原文，免得旧日期误导
  e.log = [...(e.log || []), { turn: at.turn, op, quote }].slice(-MAX_LOG)
  e.reminded.count = 0; e.reminded.step = 0
  if (e.mentions) { e.mentions.lastIdx = at.idx; e.mentions.lastTurn = at.turn }
}

/** 本轮正文提到了哪些条目：记一票。没下文的被提起，重新打开。 */
export function noteMentions(ledger, ids, turn) {
  const T = ledger.clock ? ledger.clock.idx : null
  for (const id of new Set(ids || [])) {
    const e = ledger.entries.find(x => x.id === id) || reopen(ledger, id)
    if (!e) continue
    if (e.mentions.lastTurn !== turn) e.mentions.count += 1
    e.mentions.lastIdx = T; e.mentions.lastTurn = turn
  }
}

/** 记下主角名字（设置里填了以设置为准），并把它从人物名单里去掉。 */
export function setProtagonist(ledger, name) {
  const n = cut(name, 10)
  if (!n) return
  ledger.protagonist = n
  for (const e of ledger.entries) e.who = (e.who || []).filter(w => w !== n)
}

// —— 分量、相关性、静默 ——
/** 实际分量：玩家锁定的为准；正文提到 3 次以上升一档（故事投票）。 */
export function effectiveWeight(e) {
  if (e.weightLock && WEIGHTS.includes(e.weightLock)) return e.weightLock
  let lv = Math.max(0, WEIGHTS.indexOf(e.weight || 'mid'))
  if (e.mentions && e.mentions.count >= 3) lv += 1
  return WEIGHTS[Math.min(2, lv)]
}

/**
 * 相关性：用上一轮正文和变量算，不调用模型。scene = { text, place, tasks, turn }。
 * 结果写在 e.rel = { score, signals }。
 */
export function scoreRelevance(ledger, scene) {
  const hay = norm(scene && scene.text)
  const tasksHay = norm(((scene && scene.tasks) || []).join(' '))
  const placeHay = norm(scene && scene.place)
  const T = ledger.clock ? ledger.clock.idx : null
  const prot = ledger.protagonist
  for (const e of ledger.entries) {
    const signals = []
    let score = 0
    const who = (e.who || []).filter(w => w && w !== prot).map(norm).filter(w => w.length >= 2)
    if (e.toMe) { score += 2; signals.push('冲着主角来') }
    if (who.some(w => hay.includes(w) || tasksHay.includes(w))) { score += 2; signals.push('人物在场') }
    const p = norm(e.place)
    if (p.length >= 2 && (hay.includes(p) || placeHay.includes(p))) { score += 2; signals.push('地点吻合') }
    if (e.mentions && e.mentions.lastTurn != null && scene && scene.turn != null && scene.turn - e.mentions.lastTurn <= 1) { score += 1; signals.push('最近提起') }
    if (T != null && e.when && e.when.precision === 'day' && T >= e.when.idx - 1 && T <= e.when.idx) { score += 1; signals.push('到期') }
    if (e.weightLock === 'high') { score += 1; signals.push('你标了高') }
    e.rel = { score, signals }
  }
}

/**
 * 放手（没下文）：过期后已再提过一次、又过了几天仍无动静的，结束；没开提醒时，过期满 fadeMid 日结束。
 * 没有日期的，满 fadeMid 日没人提起就结束。手动备忘、冻结的不结束。返回结束了的条目。
 */
export function fade(ledger, settings) {
  settings = { ...DEFAULT_SETTINGS, ...(settings || {}) }
  const T = ledger.clock ? ledger.clock.idx : null
  if (T == null) return []
  const ended = []
  const grace = 3
  for (const e of [...ledger.entries]) {
    e.quiet = null
    if (e.status !== 'open' || e.frozen || e.source === 'manual') continue
    const last = maxDefined(e.touched && e.touched.idx, e.mentions && e.mentions.lastIdx, e.created && e.created.idx)
    if (e.when && !e.intent) {
      if (T <= e.when.end) continue
      if (last != null && last > e.when.end) { // 过期后有过动静：从那天起按没日期的算
        const left = (Number(settings.fadeMid) || 15) - (T - last)
        if (left <= 0) { close(ledger, e, 'faded', { turn: null, idx: T }); ended.push(e.id) } else e.quiet = { since: last, left }
        continue
      }
      const over = (e.notified || {})['over:' + e.when.end]
      const left = over != null ? grace - (T - over) : (Number(settings.fadeMid) || 15) - (T - e.when.end)
      if (left <= 0) { close(ledger, e, 'faded', { turn: null, idx: T }); ended.push(e.id); continue }
      e.quiet = { since: e.when.end, left }
      continue
    }
    if (last == null || T <= last) continue
    const left = (Number(settings.fadeMid) || 15) - (T - last)
    if (left <= 0) { close(ledger, e, 'faded', { turn: null, idx: T }); ended.push(e.id); continue }
    e.quiet = { since: last, left }
  }
  return ended
}

// —— 一轮的收尾：记下上一轮注入过的提醒 ——
/**
 * prev：上一轮的台账（其 plan 已在本轮注入）；ledger：本轮已应用操作后的台账（从 prev 复制而来）。
 * touchedIds：本轮被操作过的条目编号。
 */
export function settleReminders(ledger, prevPlan, prevClock, touchedIds) {
  const at = prevClock ? prevClock.idx : (ledger.clock ? ledger.clock.idx : null)
  for (const p of [...((prevPlan && prevPlan.world) || []), ...((prevPlan && prevPlan.player) || [])]) {
    if (p.ref && p.ref.startsWith('festival:')) { ledger.festivalsDone = [...new Set([...(ledger.festivalsDone || []), p.ref.slice(9)])].slice(-40); continue }
    if (!p.injected) continue
    const e = ledger.entries.find(x => x.id === p.id)
    if (!e) continue
    if (p.stage) e.notified = { ...(e.notified || {}), [p.stage]: at }
    const r = e.reminded
    r.lastIdx = at
    if (p.kind === 'due' || p.kind === 'npc') r.forIdx = [...new Set([...(r.forIdx || []), p.forIdx])].slice(-6)
    if (touchedIds.has(e.id)) continue
    if (p.kind !== 'overdue' && p.kind !== 'stale' && p.kind !== 'ask') continue
    r.count += 1
    r.step += 1
  }
}

const RANK = { high: 0, mid: 1, low: 2 }
const remindOn = settings => !(settings.remind === 'off' || settings.strength === 'archive')
/**
 * 算下一轮的提醒（V0.4）：到了该有动静的时间就提一次，过期仍无下文再提一次，然后放手（见 fade）。
 * 不看相关人物在不在场；相关性和分量只用来排先后。
 * world：进正文请求；player：今日备忘（主角的事，玩家看）。
 */
export function plan(ledger, settings = DEFAULT_SETTINGS) {
  settings = { ...DEFAULT_SETTINGS, ...(settings || {}) }
  const world = [], player = []
  const T = ledger.clock ? ledger.clock.idx : null
  const on = remindOn(settings)
  const story = ledger.calendar === 'story'
  const playerToStory = settings.playerToStory !== false
  if (T != null) {
    for (const e of ledger.entries) {
      if (e.status !== 'open' || e.frozen || e.intent) continue // 意向只记不提
      if (e.snoozeUntil != null && T < e.snoozeUntil) continue
      const w = e.when
      if (!w) continue
      const ew = effectiveWeight(e)
      const rel = e.rel || { score: 0, signals: [] }
      const notified = e.notified || {}
      const base = { id: e.id, toMe: !!e.toMe, title: e.title, who: (e.who || []).filter(x => x !== ledger.protagonist), side: e.side, kind_: e.kind, weight: ew, evidence: e.evidence, whenLabel: story ? relSpan(w.idx, w.end, T) : w.label, story, est: w.precision === 'estimate', rel: rel.score, signals: rel.signals, sortW: RANK[ew] }
      const inWindow = T >= w.idx - 1 && T <= w.end
      const overdue = T > w.end && (e.touched.idx == null || e.touched.idx < w.end)
      if (e.side === 'player') {
        if (inWindow) player.push({ ...base, kind: 'due', forIdx: w.idx, sort: w.idx })
        else if (overdue) player.push({ ...base, kind: 'overdue', days: T - w.end, sort: w.end })
      }
      if (!on) continue
      if (e.side === 'player' && (!playerToStory || e.source === 'manual')) continue // 手动备忘只给玩家看
      const scope = settings.scope || 'normal'
      if (!e.toMe && (((scope === 'normal' || scope === 'auto') && ew === 'low') || (scope === 'important' && ew !== 'high'))) continue // 只记不提
      const stage = inWindow ? 'due:' + w.idx : overdue ? 'over:' + w.end : null
      if (!stage || notified[stage] != null) continue
      const kind = e.side === 'player' ? (inWindow ? 'ask-due' : 'ask') : (inWindow ? 'due' : 'overdue')
      world.push({ ...base, kind, stage, forIdx: w.idx, days: overdue ? T - w.end : 0, sort: inWindow ? w.idx : w.end })
    }
    if (settings.festivals && on && (ledger.calendar || 'lunar') === 'lunar') { // 节令只在古风日历
      const { y } = fromIdx(T)
      for (const f of FESTIVALS) for (const yy of [y, y + 1]) {
        const idx = toIdx(yy, f.m, f.d), id = yy + '-' + f.m + '-' + f.d
        if (T >= idx - 1 && T <= idx && !(ledger.festivalsDone || []).includes(id))
          world.push({ ref: 'festival:' + id, kind: 'festival', title: f.name, whenLabel: dateLabel(idx), sortW: 3, sort: idx })
      }
    }
  }
  // 先到期的先提；同时到期的，分量高、相关人物在场的在前
  const order = (a, b) => a.sort - b.sort || (a.sortW ?? 1) - (b.sortW ?? 1) || (b.rel || 0) - (a.rel || 0)
  const max = Math.max(1, Math.min(8, Number(settings.maxPerTurn) || 3))
  // 自动挡：事多（超过每轮上限）时，等回应的和要紧的先提，其余顺延
  const key = p => (settings.scope === 'auto' && world.length > max ? (p.toMe || p.weight === 'high' ? 0 : 1) : 0)
  world.sort((a, b) => key(a) - key(b) || order(a, b)); player.sort(order)
  ledger.plan = {
    world: world.slice(0, max).map(p => ({ ...p, ref: p.ref || 'entry:' + p.id, injected: true, text: worldLine(p) })),
    player: player.map(p => ({ ...p, ref: 'entry:' + p.id, injected: true })),
    held: world.slice(max).map(({ id, title, kind, rel, signals, whenLabel, weight }) => ({ id, title, kind, rel, signals, whenLabel, weight })),
    overflow: Math.max(0, world.length - max),
    strength: on ? 'auto' : 'off',
  }
  return ledger
}

const quoteText = p => p.evidence ? '；原话「' + cut(p.evidence, 40) + '」' : ''
const whoText = p => (p.who && p.who.length ? '；' + p.who.join('、') : '')
function worldLine(p) {
  switch (p.kind) {
    case 'festival': return '· 节令：' + p.title + '（' + p.whenLabel + '）'
    case 'due': return p.toMe ? (p.est
      ? '· ' + p.title + (p.story ? '（按路程估，约' + p.whenLabel + '可到' : '（按路程约在' + p.whenLabel + '间可到') + whoText(p) + quoteText(p) + '）：可视情形安排送到，或交代路上耽搁'
      : '· ' + p.title + '（约 ' + p.whenLabel + whoText(p) + quoteText(p) + '）：到时候了，可视情形安排它来，或交代耽搁') : '· ' + p.title + '（约 ' + p.whenLabel + whoText(p) + quoteText(p) + '）'
    case 'overdue': return p.toMe ? (p.est
      ? '· ' + p.title + (p.story ? '（原估早该到了，已过约 ' + p.days + ' 天' : '（原估' + p.whenLabel + '间可到，至今未到') + whoText(p) + '）：可交代是迟了、路上出了岔子，或仍在途中'
      : '· ' + p.title + '（约 ' + p.whenLabel + '，已过 ' + p.days + ' 日还没来' + whoText(p) + quoteText(p) + '）：可交代是迟了、出了岔子，或另有缘故') : '· ' + p.title + '（约 ' + p.whenLabel + '，已过 ' + p.days + ' 日未见下文' + whoText(p) + quoteText(p) + '）'
    case 'stale': return '· ' + p.title + '（尚无下文' + whoText(p) + quoteText(p) + '）'
    case 'ask': return '· 主角答应的事：' + p.title + '（期限 ' + p.whenLabel + '，已过 ' + p.days + ' 日' + (p.who.length ? '；' + p.who.join('、') : '') + '）：' + (p.who.length ? p.who.join('、') + '可能问起' : '身边人可能提起') + '；主角怎么回应由玩家决定，不要替主角去办'
    case 'ask-due': return '· 主角答应的事：' + p.title + '（期限 ' + p.whenLabel + (p.who.length ? '；' + p.who.join('、') : '') + '）：' + (p.who.length ? p.who.join('、') + '可以问一句' : '身边人可以提一句') + '；主角怎么办由玩家决定，不要替主角去办'
    case 'npc': return '· ' + p.title + '（主角的事，定于 ' + p.whenLabel + '；身边人可顺口提一句，不要替主角去办，也不要写成已经办了）'
    default: return '· ' + p.title
  }
}

/** turnSection 文字。 */
export function renderWorld(ledger) {
  const plan = ledger && ledger.plan
  if (!plan || !plan.world || !plan.world.length) return ''
  const asOf = ledger.clock && ledger.calendar !== 'story' ? '（截至' + ledger.clock.label + '）' : ''
  return ['【敲敲门·该有动静的事】' + asOf + '以下事情按时间该有后续了。可视情形在这一轮或之后几轮安排：到了、迟了、出了岔子都可以；不必硬插进当前场景：', ...plan.world.map(p => p.text),
    ...(plan.overflow > 0 ? ['（另有 ' + plan.overflow + ' 项未列出。）'] : []),
    '结果不预设，消息传到主角需要合理途径；不要替主角做决定，不要为呼应这里而新造原文没有的约定、期限或后果。'].join('\n')
}

/** candidateSection 文字。 */
export function renderCandidates(ledger) {
  const items = ((ledger && ledger.plan && ledger.plan.player) || []).filter(p => p.weight !== 'low').slice(0, 3)
  if (!items.length) return ''
  return '主角眼下有这些到期或过期的事（由玩家决定做不做）：' + items.map(p => p.title + '（' + (p.kind === 'overdue' ? '已过期 ' + p.days + ' 日' : '约期 ' + p.whenLabel) + '）').join('；') +
    '。给出的行动选项里，可以有一个是去处理其中一件；也照常给出与之无关的选项。'
}

/** compactionSection 文字：备查清单，压缩后也不丢。 */
export function renderCompaction(ledger) {
  const open = ((ledger && ledger.entries) || []).filter(e => e.status === 'open' && e.evidence)
    .sort((a, b) => RANK[effectiveWeight(a)] - RANK[effectiveWeight(b)]).slice(0, 15)
  const faded = ((ledger && ledger.closed) || []).filter(c => c.status === 'faded').slice(-5)
  if (!open.length && !faded.length) return ''
  return [open.length ? '摘要里保留以下仍未了结的事的原句（不必评论）：' + open.map(e => '「' + e.evidence + '」').join('；') : '',
    faded.length ? '以下事后来没有下文，摘要里可一笔带过：' + faded.map(c => c.title).join('、') : ''].filter(Boolean).join('\n')
}

// —— 面板操作 ——
export function applyAction(ledger, action, settings) {
  const l = structuredClone(ledger)
  let e = action.id ? l.entries.find(x => x.id === action.id) : null
  const at = { turn: null, idx: l.clock ? l.clock.idx : null }
  const need = () => { if (!e) throw new Error('找不到这一条（可能已了结）') }
  switch (action.type) {
    case 'freeze': need(); e.frozen = true; break
    case 'unfreeze': need(); e.frozen = false; break
    case 'snooze': need(); if (at.idx == null) throw new Error('不知道今天的日期'); e.snoozeUntil = at.idx + Math.max(1, Math.min(60, Number(action.days) || 3)); break
    case 'unsnooze': need(); e.snoozeUntil = null; break
    case 'weight': need(); e.weightLock = WEIGHTS.includes(action.weight) ? action.weight : null; break
    case 'priority': need(); e.weightLock = ({ P1: 'high', P2: 'mid', P3: 'low' })[action.priority] || null; break
    case 'side': need(); e.side = action.side === 'world' ? 'world' : 'player'; e.confirmed = true; break
    case 'title': need(); e.title = cut(action.title, 20) || e.title; e.confirmed = true; break
    case 'confirm': need(); e.confirmed = true; e.intent = false; break // 确认无误（意向则算说定）
    case 'unconfirm': need(); e.confirmed = false; break
    case 'intent': need(); e.intent = true; e.confirmed = false; break
    case 'acceptSuggest': {
      need(); const sg = e.suggest; if (!sg) throw new Error('这一条没有待定的改动')
      e.suggest = null
      if (sg.op === 'reschedule' && sg.when) { e.when = sg.when; e.reminded.forIdx = []; e.notified = {}; touch(e, at, 'reschedule', sg.quote) }
      else if (sg.op === 'cancel' || sg.op === 'missed') { touch(e, at, sg.op, sg.quote); close(l, e, sg.op === 'cancel' ? 'cancelled' : 'missed', at) }
      break
    }
    case 'dismissSuggest': need(); e.suggest = null; break
    case 'setCalendar': { // 改本局日历：时钟重来，已有条目的日期作废（条目保留，变成无日期）
      const cal = ['lunar', 'gregorian', 'story'].includes(action.calendar) ? action.calendar : null
      if (!cal) throw new Error('不认识的日历')
      if (cal !== l.calendar) {
        l.calendar = cal; l.clock = cal === 'story' ? clockAt('story', 0, 'start') : null; l.clockHours = 0
        for (const x of l.entries) { x.when = null; x.notified = {} }
      }
      break
    }
    case 'when': {
      need(); if (!l.clock) throw new Error('不知道今天的日期')
      const w = action.inDays != null && action.inDays !== '' ? whenToRange({ offsetDays: Number(action.inDays) }, l.clock)
        : whenToRange({ month: Number(action.month), day: action.day === 'end' ? 'end' : (action.day ? Number(action.day) : undefined) }, l.clock)
      if (!w) throw new Error(l.calendar === 'story' ? '请填几天后（0–3650）' : '日期不对：月 1–12，日 1–' + (l.calendar === 'gregorian' ? '31' : '30'))
      e.when = w; e.reminded.forIdx = []; e.notified = {}; e.confirmed = true; e.suggest = null; break
    }
    case 'clearWhen': need(); e.when = null; e.confirmed = true; break
    case 'done': need(); touch(e, at, 'done', '（玩家在面板标记）'); close(l, e, 'done', at); break
    case 'cancel': need(); touch(e, at, 'cancel', '（玩家在面板标记）'); close(l, e, 'cancelled', at); break
    case 'reopen':
      if (!e) e = reopen(l, action.id)
      need(); e.status = 'open'; e.reminded.count = 0; e.reminded.step = 0; e.notified = {}
      e.mentions.lastIdx = at.idx // 重新打开后从今天起算静默
      break
    case 'delete': need(); l.entries = l.entries.filter(x => x !== e); break
    case 'addMemo': {
      if (!l.clock) throw new Error('不知道今天的日期，先推进一轮')
      const w = action.inDays != null && action.inDays !== '' ? whenToRange({ offsetDays: Number(action.inDays) }, l.clock)
        : whenToRange({ month: Number(action.month), day: Number(action.day) }, l.clock)
      if (!w) throw new Error(l.calendar === 'story' ? '请填几天后（0–3650）' : '日期不对：月 1–12，日 1–' + (l.calendar === 'gregorian' ? '31' : '30'))
      const title = cut(action.title, 20)
      if (!title) throw new Error('请写备忘内容')
      l.entries.push(newEntry(l, { title, who: [], side: 'player', kind: 'memo', when: w, evidence: cut(action.note, 60), source: 'manual' }, at))
      break
    }
    default: throw new Error('不认识的操作：' + action.type)
  }
  fade(l, settings)
  return plan(l, settings)
}
