// Knock Knock · 敲敲门（宿主侧）
// 约定台账：每轮写完后由后台模型读正文、增删改台账（onTurnSettled 后台进行，不挡下一轮）；
// 结算任务只换算日期、排提醒；代码核对引文与日期。
// 该有后续的事 → 到时间 turnSection 告诉正文一次，过期再提一次，然后放手；主角的事另在面板、候选选项提醒玩家。
// 史事与条件条目（V0.3）：卡内世界书禁用条目或 packs/ 事件包 → 时间窗落地 → 消息传到时注入一次 → 进条目池。
// 用法见 README.md；史事条目写法见 史事条目写法.md。
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import * as L from './lib/ledger.mjs'
import * as B from './lib/bench.mjs'
import * as H from './lib/history.mjs'
import * as C from './lib/clean.mjs'
import * as K from './lib/cal.mjs'

export const name = 'dsh-tavern-knock-knock'
export const inject = ['tavern', 'llm']  // llm：直连后台模型做轻量提取（不带人物卡背景）

const PLUGIN = 'dsh-tavern-knock-knock'
const VERSION = '0.7.0'
const LATEST = Number.MAX_SAFE_INTEGER
const MODEL_TIMEOUT_MS = 90000
const TURN_BUDGET_MS = 240000
const WAIT_PREV_MS = 200000 // 结算任务等上一轮后台记账的上限（DSHT 结算任务 300 秒超时）
const REPLAY_ROUND_MS = 150000 // 回放每轮最多等这么久；超时记为出错，不退回后台 Agent 长等 // DSHT 的结算任务 300 秒超时；留出余量
const MAX_TOKENS = 6000
const errorText = e => String((e && e.code ? e.code + ' ' : '') + (e && e.message ? e.message : e)).slice(0, 400)

export function apply(ctx) {
  if (!(ctx.tavern.apiVersion >= 2) || typeof ctx.tavern.settlementTask !== 'function') {
    console.warn(PLUGIN + ': 需要较新的 DSH Tavern（插件接口第 2 版且支持 settlementTask），未启用')
    return
  }

  // —— 整局数据：设置、错误、诊断 ——
  const queues = new Map()
  const serial = (gameId, task) => {
    const next = (queues.get(gameId) || Promise.resolve()).then(task, task)
    queues.set(gameId, next.catch(() => {}))
    return next
  }
  async function readGame(gameId) {
    const d = await ctx.tavern.readGameData({ gameId }).catch(() => null)
    return d && typeof d === 'object' ? d : {}
  }
  const writeGame = (gameId, change) => serial(gameId, async () => {
    const d = await readGame(gameId)
    change(d)
    await ctx.tavern.saveGameData({ gameId, data: d })
  }).catch(e => console.warn(PLUGIN + ': 写整局数据失败: ' + errorText(e)))
  // 实际生效的设置：自动挡时由 AUTO_SETTINGS 覆盖
  const settingsOf = async gameId => L.effectiveSettings((await readGame(gameId)).settings)
  const memErrors = new Map()
  function recordError(gameId, where, error) {
    const entry = { at: Date.now(), where, error: errorText(error) }
    memErrors.set(gameId, [...(memErrors.get(gameId) || []), entry].slice(-30))
    console.warn(PLUGIN + ': ' + where + ' 失败: ' + entry.error)
    writeGame(gameId, d => { d.errors = [...(d.errors || []), entry].slice(-30) })
  }

  // —— 模型调用：先直连 llm（不带人物卡背景），不行再退回 runAgent / runTask ——
  function llmService() {
    try { return ctx.llm || (typeof ctx.get === 'function' ? ctx.get('llm') : null) || null } catch { return null }
  }
  // 推理强度：提取是简单的读文记账，不需要深思。默认 low。
  const effortCache = new Map()
  async function effortIds(llm, sel) {
    const key = sel.provider + '/' + sel.model
    if (!effortCache.has(key)) {
      let ids = []
      try { const info = typeof llm.resolveModelInfo === 'function' ? await llm.resolveModelInfo(sel.provider, sel.model) : null; ids = ((info && info.reasoning && info.reasoning.efforts) || []).map(e => e && e.id).filter(Boolean) } catch {}
      effortCache.set(key, ids)
    }
    return effortCache.get(key)
  }
  async function pickEffort(llm, sel, wanted) {
    if (!wanted || wanted === 'model') return null
    const ids = await effortIds(llm, sel)
    const order = wanted === 'off' ? ['off', 'none', 'minimal', 'low'] : ['low', 'minimal', 'off', 'none']
    return order.find(id => ids.includes(id)) || null
  }
  // 提取用模型：设置里选了就用它，否则用本局后台模型
  async function extractModel(gameId) {
    const chosen = String((await settingsOf(gameId)).model || '')
    if (chosen.includes('\u0001')) { const [provider, model] = chosen.split('\u0001'); if (provider && model) return { provider, model, chosen: true } }
    return await ctx.tavern.backgroundModel({ gameId }).catch(() => null)
  }
  // 用量：不同服务商字段不一样，能认的都认
  function readUsage(u, acc) {
    if (!u || typeof u !== 'object') return
    const num = (...ks) => { for (const k of ks) { const v = k.split('.').reduce((o, x) => (o && typeof o === 'object' ? o[x] : undefined), u); if (Number.isFinite(v)) return v } return null }
    const input = num('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'input')
    const output = num('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'output')
    const cache = num('cacheReadTokens', 'cacheReadInputTokens', 'cache_read_input_tokens', 'cachedTokens', 'cached_tokens', 'prompt_cache_hit_tokens', 'inputTokenDetails.cacheReadTokens', 'prompt_tokens_details.cached_tokens', 'cacheRead')
    if (input != null) acc.input = input
    if (output != null) acc.output = output
    if (cache != null) acc.cacheRead = cache
  }
  async function streamOnce(llm, sel, { system, userText, signal, effort, maxTokens }) {
    const messages = [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'plugin', plugin: PLUGIN } }]
    let stream
    if (typeof llm.prepareCall === 'function') {
      const cfg = { provider: sel.provider, model: sel.model, maxTokens }
      if (effort) cfg.reasoningEffort = effort
      const prepared = await llm.prepareCall(cfg, signal)
      stream = prepared.stream({ ...prepared.config, messages, system, signal })
    } else stream = llm.stream({ provider: sel.provider, model: sel.model, maxTokens, messages, system, signal })
    let deltas = '', blocks = '', finish = null
    const usage = {}
    for await (const ev of stream) {
      if (!ev) continue
      if (ev.type === 'text-delta' && typeof ev.text === 'string') deltas += ev.text
      else if (ev.type === 'block-end' && ev.block && ev.block.type === 'text') blocks += ev.block.text || ''
      else if (ev.type === 'finish') { finish = ev.reason; readUsage(ev.usage || (ev.reason && ev.reason.usage), usage) }
      if (ev.type === 'usage') readUsage(ev.usage || ev, usage)
      else if (ev.usage && ev.type !== 'finish') readUsage(ev.usage, usage)
    }
    if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) throw new Error('模型调用失败：' + ((finish.failure && (finish.failure.message || finish.failure.code)) || finish.kind))
    return { text: deltas || blocks, truncated: !!(finish && finish.kind === 'max-tokens'), usage }
  }
  /** 一次提取调用：直连 → 截断或空回复时关掉推理再试一次 → 后台 Agent。 */
  async function callModel({ gameId, system, user, signal, runAgent, deadline = Infinity }) {
    const started = Date.now()
    const left = () => deadline - Date.now()
    const attempts = []
    const llm = llmService()
    const sel = await extractModel(gameId)
    const userText = user + '\n\n（按上面的要求，只输出一个 JSON 对象。）'
    const meta = { inChars: system.length + userText.length }
    if (llm && sel && (typeof llm.prepareCall === 'function' || typeof llm.stream === 'function')) {
      const wanted = (await settingsOf(gameId)).effort
      const plans = [{ effort: await pickEffort(llm, sel, wanted), maxTokens: MAX_TOKENS }]
      const off = await pickEffort(llm, sel, 'off')
      plans.push({ effort: off && off !== plans[0].effort ? off : plans[0].effort, maxTokens: MAX_TOKENS + 4000 })
      for (const p of plans) {
        if (attempts.length && left() < 45000) { attempts.push('时间不够，不再重试'); break }
        try {
          const timeout = AbortSignal.timeout(Math.max(10000, Math.min(MODEL_TIMEOUT_MS, left())))
          const sig = signal ? AbortSignal.any([signal, timeout]) : timeout
          const t0 = Date.now()
          const r = await streamOnce(llm, sel, { system, userText, signal: sig, ...p })
          r.ms = Date.now() - t0
          if (r.text.trim() && !(r.truncated && !/\}\s*$/.test(r.text.trim()))) return { text: r.text, via: '直连', ms: Date.now() - started, attempts, usage: r.usage, outChars: r.text.length, ...meta }
          attempts.push((r.truncated ? '输出被截断' : '没有返回文字') + '（' + Math.round(r.ms / 1000) + ' 秒）')
        } catch (e) { if (signal && signal.aborted) throw e; attempts.push(/abort|timeout/i.test(errorText(e)) ? '直连超时' : errorText(e)) }
      }
    } else attempts.push(!llm ? '取不到 llm 服务' : '这局没有后台模型')
    if (left() < 40000) throw new Error('提取超时：' + attempts.join('；'))
    const prompt = system + '\n\n' + userText
    const agentSignal = Number.isFinite(deadline) ? (signal ? AbortSignal.any([signal, AbortSignal.timeout(left())]) : AbortSignal.timeout(left())) : signal
    const res = runAgent ? await runAgent({ prompt, signal: agentSignal }) : await ctx.tavern.runTask({ gameId, prompt, signal: agentSignal })
    const text = (res && res.text) || ''
    return { text, via: '后台 Agent', ms: Date.now() - started, directError: attempts.join('；'), attempts, outChars: text.length, ...meta }
  }
  /** 调用并解析；JSON 修补不了就重问一次。 */
  async function callAndParse(args) {
    const res = await callModel(args)
    try { return { res, reply: L.parseReply(res.text) } }
    catch (e) {
      if (args.deadline && args.deadline - Date.now() < 60000) throw e
      const again = await callModel({ ...args, user: args.user + '\n\n（上一次的回复不是合法 JSON，请严格只输出一个 JSON 对象。）' })
      const reply = L.parseReply(again.text)
      return { res: { ...again, ms: res.ms + again.ms, retried: true }, reply }
    }
  }

  // —— 本轮玩家输入：turnSection 被调用时记下，留给随后的结算任务 ——
  const inputs = new Map() // gameId -> Map(turn -> input)
  const rememberInput = (gameId, turn, input) => {
    if (!inputs.has(gameId)) inputs.set(gameId, new Map())
    const m = inputs.get(gameId); m.set(turn, String(input || ''))
    if (m.size > 20) m.delete(m.keys().next().value)
  }
  const inputOf = (gameId, turn) => (inputs.get(gameId) && inputs.get(gameId).get(turn)) || ''

  const sceneOf = (variables, settings, text, input, turn) => {
    const tasksRaw = variables && variables.stat_data && variables.stat_data['当前事务']
    const tasks = Array.isArray(tasksRaw) ? tasksRaw.map(t => String(t)).slice(0, 15) : []
    const place = L.readPath(variables, settings.placePath)
    return { text: String(input || '') + '\n' + String(text || ''), place: typeof place === 'string' ? place : (place ? JSON.stringify(place) : ''), tasks, turn }
  }

  // —— 史事目录：卡内世界书（禁用条目）+ 插件 packs/ 事件包 ——
  const catalogs = new Map() // gameId -> { at, era, cat }
  let packsCache = null
  async function loadPacks() {
    if (packsCache) return packsCache
    const out = []
    try {
      const dir = new URL('./packs/', import.meta.url)
      for (const f of (await readdir(dir)).filter(n => n.endsWith('.json'))) {
        try { const p = JSON.parse(await readFile(new URL(f, dir), 'utf8')); out.push({ file: f, era: String(p.era || ''), entries: Array.isArray(p.entries) ? p.entries : [] }) }
        catch (e) { out.push({ file: f, error: errorText(e), entries: [] }) }
      }
    } catch {}
    return (packsCache = out)
  }
  async function catalogOf(gameId, era, { fresh = false } = {}) {
    const c = catalogs.get(gameId)
    if (!fresh && c && c.era === era && Date.now() - c.at < 300000) return c.cat
    const card = await ctx.tavern.getCard({ gameId }).catch(() => null)
    const book = card && (card.character_book || (card.data && card.data.character_book))
    const fromCard = H.parseEntries((book && book.entries) || [], { era, source: 'card' })
    const packs = await loadPacks()
    const fromPacks = packs.filter(p => !p.error && (!p.era || !era || H.eraName(era) === p.era)).map(p => H.parseEntries(p.entries, { era, source: 'pack:' + p.file }))
    const cat = H.mergeCatalogs(fromCard, ...fromPacks)
    for (const p of packs) if (p.error) cat.warnings.push('事件包 ' + p.file + ' 读不了：' + p.error)
    cat.counts = { card: fromCard.events.length + fromCard.conds.length, packs: fromPacks.reduce((n, c) => n + c.events.length + c.conds.length, 0) }
    catalogs.set(gameId, { at: Date.now(), era, cat })
    return cat
  }

  // —— 处理一轮 ——
  // 0.4.2：记账不挡下一轮。
  // · 结算任务（挡下一轮，但很快）：换算日期、排提醒，不调模型；若上一轮的后台记账还没完，先等它（最多 WAIT_PREV_MS）。
  // · onTurnSettled（不挡）：后台读本轮正文记账，存回本轮。编辑正文、重新生成后会对新版本再记一次。
  // · 后台没来得及（超时、出错、DSH 重启）：本轮标为 pending，下一轮记账时把这一轮的正文一并带上补记。
  const jobs = new Map()  // gameId -> { turn, version, ac, at, promise }
  const shown = new Map() // gameId:turn -> 生成这一轮时实际注入的提醒（plan），用来判断哪些已经提过
  async function processTurn({ gameId, turn, textVersion, text, rawText, variables, input, signal, runAgent, extract, force = false, earlier = null, wait = null }) {
    const settings = await settingsOf(gameId)
    const prevRec = turn > 1 ? await ctx.tavern.readTurnData({ gameId, turn: turn - 1 }) : null
    const prev = L.migrate(prevRec ? prevRec.data : null)
    const l = structuredClone(prev)
    l.warnings = []
    const start = earlier ? (prev.turnStart || prev.clock || null) : (prev.clock || null)
    l.turnStart = prev.clock || null
    // 正文清洗：去掉思考、选项、小剧场、摘要、状态栏……；去掉的块里找日期和“时间流逝”
    const cl = C.cleanStory(rawText, text, settings.ignoreTags)
    text = cl.text
    const mk = K.markersFrom(cl.blocks)
    // 日历：本局第一次定下后不再自动改（设置里可手动改）
    const vclock = L.clockFromVariables(variables, settings.datePath)
    if (!l.calendar) { l.calendar = settings.calendar && settings.calendar !== 'auto' ? settings.calendar : vclock ? vclock.cal : mk.date ? 'gregorian' : 'story'; l.calendarAuto = !(settings.calendar && settings.calendar !== 'auto') }
    // 自动判成“故事天数”后，前几轮又出现了真日期（第一轮恰好没写）：趁台账里还没有带日期的事，改过去
    const late = vclock ? vclock.cal : mk.date ? 'gregorian' : null
    if (l.calendarAuto && l.calendar === 'story' && late && !l.entries.some(e => e.when) && (l.clock ? l.clock.idx : 0) < 30) { l.calendar = late; l.clock = null; l.clockHours = 0 }
    const cal = l.calendar
    let clockSource = null
    if (vclock && vclock.cal === cal) { l.clock = vclock; clockSource = 'variable' }
    else if (mk.date && cal === 'gregorian' && (!l.clock || mk.date.idx >= l.clock.idx)) { l.clock = L.clockAt('gregorian', mk.date.idx, 'marker'); clockSource = 'marker' }
    else {
      if (!l.clock && cal === 'story') l.clock = L.clockAt('story', 0, 'start')
      if (mk.hours && l.clock) { L.advanceClock(l, mk.hours, 'elapsed-marker'); clockSource = 'elapsed-marker' }
    }
    if (settings.protagonist) L.setProtagonist(l, settings.protagonist)
    const touched = new Set()
    const cat = settings.history !== false && l.clock && cal === 'lunar' ? await catalogOf(gameId, l.clock.era || '').catch(e => { l.warnings.push('读史事失败：' + errorText(e)); return null }) : null
    const checks = cat ? H.pendingChecks(l, cat, { seed: gameId }) : { hist: [], conds: [] }
    let reply = null
    const info = { turn, at: Date.now(), gate: null, pending: false, via: null, applied: [], rejected: 0, ms: 0, directError: null, today: null, usage: null, inChars: null, outChars: null, repaired: false, retried: false }
    if (wait) info.wait = wait
    info.calendar = cal
    if (cl.removed || cl.fallback) info.cleaned = { removed: cl.removed, fallback: cl.fallback }
    if (settings.extract && !extract) info.pending = true // 结算任务的快速一步：等后台记账
    if (settings.extract && extract) {
      info.gate = force ? 'manual' : (checks.hist.length || checks.conds.length) ? 'history' : earlier ? 'catch-up' : settings.gate === 'keywords' ? L.shouldExtract(String(earlier ? earlier.text : '') + input, text, l) : 'every'
      if (info.gate) {
        if (earlier) info.catchUp = earlier.turn
        const tasks = Array.isArray(variables && variables.stat_data && variables.stat_data['当前事务'])
          ? variables.stat_data['当前事务'].map(t => String(t).split(/[｜|]/)[0]).slice(0, 15) : []
        const call = await callAndParse({ gameId, system: L.promptFor(cal), user: L.buildUserMessage({ ledger: l, start, input, text, tasks, extra: H.checksText(checks), earlier }), signal, runAgent, deadline: Date.now() + TURN_BUDGET_MS })
        const res = call.res; reply = call.reply
        Object.assign(info, { attempts: res.attempts && res.attempts.length ? res.attempts : null, via: res.via, ms: res.ms, directError: res.directError || null, usage: res.usage && Object.keys(res.usage).length ? res.usage : null, inChars: res.inChars, outChars: res.outChars, repaired: reply.repaired, retried: !!res.retried })
        info.today = reply.today
        if (!settings.protagonist && reply.protagonist && !l.protagonist) L.setProtagonist(l, reply.protagonist)
        if (!clockSource) { // 变量、正文标记都没给时间：用模型说的日期，或“过了多久”（不许倒退）
          if (reply.today && cal !== 'story') {
            const base = l.clock || L.clockAt(cal, cal === 'gregorian' ? K.gIdx(2001, Number(reply.today.month) || 1, 1) : (Number(reply.today.month) - 1) * 30, 'model')
            const r = L.whenToRange({ month: reply.today.month, day: reply.today.day }, base)
            if (r && r.idx === r.end && (!l.clock || r.idx >= l.clock.idx)) { l.clock = L.clockAt(cal, r.idx, 'model', l.clock && l.clock.era); clockSource = 'model' }
          }
          if (!clockSource && reply.elapsed && l.clock) { L.advanceClock(l, reply.elapsed, 'model-elapsed'); clockSource = 'model-elapsed' }
        }
        const corpus = (earlier ? String(earlier.input || '') + '\n' + String(earlier.text || '') + '\n' : '') + String(input || '') + '\n' + String(text || '')
        const out = L.applyOps(l, reply.ops, { corpus, turn, start })
        out.applied.forEach(a => touched.add(a.id))
        info.applied = out.applied.map(a => ({ ...a, title: titleOf(l, a.id) }))
        info.rejected = out.rejected.length
        L.noteMentions(l, [...reply.mentioned, ...touched], turn)
        l.stats.calls = (l.stats.calls || 0) + 1; l.stats.via = res.via
      } else l.stats.skipped = (l.stats.skipped || 0) + 1
    }
    info.clockSource = clockSource
    if (!l.clock) l.warnings.push('不知道游戏日期：变量里读不到，正文和模型也没给出。可在设置里改日期变量路径，或把日历改成「故事天数」。')
    // 哪些提醒已经提过：以生成这一轮时实际注入的为准（后台记账可能在那之后才改了上一轮的提醒）
    const seen = shown.get(gameId + ':' + turn) || prev.plan
    L.settleReminders(l, seen, prev.clock, touched)
    H.settleNews(l, seen && seen.news)
    const scene0 = sceneOf(variables, settings, text, input, turn)
    if (cat) info.history = H.stepHistory(l, cat, { seed: gameId, place: scene0.place, corpus: String(input || '') + '\n' + String(text || ''), turn, reply, settings })
    info.faded = L.fade(l, settings)
    const scene = sceneOf(variables, settings, text, input, turn)
    l.place = String(scene.place || '').slice(0, 30)
    L.scoreRelevance(l, scene)
    L.plan(l, settings)
    l.plan.news = cat ? H.newsEntries(l, cat, { max: settings.newsMax }) : []
    l.turn = turn
    l.lastRun = info
    if (info.via) l.runs = [...(prev.runs || []).filter(x => x.turn < turn), { turn, ms: info.ms, via: info.via, applied: info.applied.length, rejected: info.rejected, input: info.usage && info.usage.input, cacheRead: info.usage && info.usage.cacheRead, inChars: info.inChars }].slice(-12)
    await ctx.tavern.saveTurnData({ gameId, turn, textVersion, data: l })
    return info
  }
  const titleOf = (l, id) => { const e = l.entries.find(x => x.id === id) || (l.closed || []).find(x => x.id === id); return e ? e.title : '' }

  async function inputFor(gameId, turn) {
    const m = inputOf(gameId, turn)
    if (m) return m
    const hist = await ctx.tavern.getHistory({ gameId, from: turn, to: turn }).catch(() => [])
    return (hist && hist[0] && hist[0].input) || ''
  }

  /** 后台记一轮。已经记过这个版本就不再记。 */
  async function runExtract(gameId, t, signal) {
    if (signal.aborted) return
    const settings = await settingsOf(gameId)
    if (!settings.extract) return
    const cur = await ctx.tavern.readTurnData({ gameId, turn: t.turn })
    if (cur && cur.turn === t.turn && cur.textVersion === t.textVersion && cur.data && cur.data.lastRun && cur.data.lastRun.turn === t.turn && !cur.data.lastRun.pending) return
    const wait = cur && cur.turn === t.turn && cur.data && cur.data.lastRun ? cur.data.lastRun.wait || null : null
    // 上一轮没记上（pending）→ 一并补记
    let earlier = null
    if (t.turn > 1) {
      const p = await ctx.tavern.readTurnData({ gameId, turn: t.turn - 1 })
      if (p && p.turn === t.turn - 1 && p.data && p.data.lastRun && p.data.lastRun.pending) {
        const h = await ctx.tavern.getHistory({ gameId, from: t.turn - 1, to: t.turn - 1 }).catch(() => [])
        if (h && h[0] && h[0].text) earlier = { turn: t.turn - 1, input: h[0].input || '', text: C.cleanStory(h[0].rawText, h[0].text, settings.ignoreTags).text }
      }
    }
    try {
      await processTurn({ gameId, turn: t.turn, textVersion: t.textVersion, text: t.text, rawText: t.rawText, variables: t.variables, input: await inputFor(gameId, t.turn), signal, extract: true, earlier, wait })
    } catch (e) {
      if (signal.aborted || (e && (e.code === 'TAVERN_PLUGIN_STALE_VERSION' || e.code === 'TAVERN_PLUGIN_TURN_UNAVAILABLE'))) return // 这一版正文已被重写或回退，结果作废
      recordError(gameId, '后台记账（第 ' + t.turn + ' 轮）', e) // 本轮保持 pending，下一轮补记
    }
  }
  function startExtract(gameId, t) {
    const old = jobs.get(gameId)
    if (old && old.turn === t.turn && old.version === t.textVersion) return old.promise
    if (old && old.turn >= t.turn) old.ac.abort() // 同一轮的旧版本（编辑、重新生成）或已回退的轮次
    const before = old && old.turn < t.turn ? old.promise.catch(() => {}) : Promise.resolve()
    const ac = new AbortController()
    const job = { turn: t.turn, version: t.textVersion, ac, at: Date.now() }
    job.promise = before.then(() => runExtract(gameId, t, ac.signal)).finally(() => { if (jobs.get(gameId) === job) jobs.delete(gameId) })
    jobs.set(gameId, job)
    return job.promise
  }
  /** 等这一局正在进行的后台记账（最多 ms 毫秒）。返回等了多久；没等完返回 null。 */
  async function settleJobs(gameId, ms, signal) {
    const job = jobs.get(gameId)
    if (!job) return 0
    const t0 = Date.now()
    let timer
    const timeout = new Promise(r => { timer = setTimeout(() => r('timeout'), ms) })
    const aborted = signal ? new Promise(r => signal.addEventListener('abort', () => r('timeout'), { once: true })) : null
    const r = await Promise.race([job.promise.then(() => 'done', () => 'done'), timeout, ...(aborted ? [aborted] : [])])
    clearTimeout(timer)
    return r === 'done' ? Date.now() - t0 : null
  }

  ctx.tavern.settlementTask({
    name: 'ledger',
    title: '约定台账',
    phase: 'after',
    async run({ gameId, turn, textVersion, text, rawText, variables, signal }) {
      let wait = null
      const job = jobs.get(gameId)
      if (job && job.turn < turn) { // 上一轮还在后台记账：等它，免得这一轮基于没记完的台账
        const ms = await settleJobs(gameId, WAIT_PREV_MS, signal)
        if (ms == null) { job.ac.abort(); wait = { turn: job.turn, ms: Date.now() - job.at, gaveUp: true } }
        else if (ms > 200) wait = { turn: job.turn, ms }
      } else if (job) job.ac.abort()
      try {
        await processTurn({ gameId, turn, textVersion, text, rawText, variables, input: inputOf(gameId, turn), signal, extract: false, wait })
      } catch (e) {
        if ((signal && signal.aborted) || (e && e.code === 'TAVERN_PLUGIN_STALE_VERSION')) return
        recordError(gameId, '约定台账（第 ' + turn + ' 轮）', e)
      }
    },
  })

  ctx.tavern.onTurnSettled(t => startExtract(t.gameId, t).catch(e => recordError(t.gameId, '后台记账', e)))

  ctx.tavern.onTimelineChanged(({ gameId }) => {
    const r = jobs.get(gameId)
    if (r) r.ac.abort()
  })

  const latestOf = async gameId => {
    const rec = await ctx.tavern.readTurnData({ gameId, turn: LATEST })
    return rec ? { ...rec, data: L.migrate(rec.data) } : null
  }

  // —— 下一轮正文：世界的事（备查） ——
  ctx.tavern.turnSection({
    name: 'reminders',
    position: 'after',
    text: async ({ gameId, turn, input }) => {
      rememberInput(gameId, turn, input)
      try {
        const rec = await latestOf(gameId)
        if (rec && rec.turn < turn) { shown.set(gameId + ':' + turn, structuredClone(rec.data.plan || {})); if (shown.size > 50) shown.delete(shown.keys().next().value) }
        return rec ? L.renderWorld(rec.data) : ''
      }
      catch (e) { recordError(gameId, '注入提醒', e); return '' }
    },
  })
  // —— 候选选项：主角的事 ——
  ctx.tavern.candidateSection({
    name: 'player-due',
    text: async ({ gameId }) => { try { const rec = await latestOf(gameId); return rec ? L.renderCandidates(rec.data) : '' } catch { return '' } },
  })
  // —— 上下文压缩：备查清单 ——
  ctx.tavern.compactionSection({
    name: 'open-commitments',
    text: async ({ gameId }) => { try { const rec = await latestOf(gameId); return rec ? L.renderCompaction(rec.data) : '' } catch { return '' } },
  })

  // —— 史事：消息传到的那一轮注入一次；主角已知的进条目池 ——
  if (typeof ctx.tavern.worldbookSource === 'function') ctx.tavern.worldbookSource({
    name: 'world-news',
    entries: async ({ gameId }) => {
      try { const rec = await latestOf(gameId); return rec && rec.data.plan && rec.data.plan.news ? rec.data.plan.news.map(n => ({ title: n.title, content: n.content })) : [] }
      catch (e) { recordError(gameId, '注入史事消息', e); return [] }
    },
  })
  if (typeof ctx.tavern.worldbookEntries === 'function') ctx.tavern.worldbookEntries({
    name: 'world-known',
    entries: async ({ gameId }) => {
      const rec = await latestOf(gameId)
      if (!rec || !rec.data.clock) return []
      const settings = await settingsOf(gameId)
      if (settings.history === false) return []
      const cat = await catalogOf(gameId, rec.data.clock.era || '')
      return H.poolEntries(rec.data, cat)
    },
  })

  // —— 重建台账（手动任务）——
  async function rebuild({ gameId, turn, textVersion, variables, input, signal, runAgent }) {
    if (!turn) throw new Error('这一局还没有正文')
    await settleJobs(gameId, 120000) // 先让正在进行的后台记账存完，免得重建结果被它覆盖
    const settings = await settingsOf(gameId)
    const n = Math.max(5, Math.min(300, Number(String(input || '').trim()) || settings.rebuildTurns))
    const cur = await latestOf(gameId)
    const l = cur && cur.turn <= turn ? structuredClone(cur.data) : L.emptyLedger()
    const vclock = L.clockFromVariables(variables, settings.datePath)
    if (!l.calendar) l.calendar = settings.calendar && settings.calendar !== 'auto' ? settings.calendar : vclock ? vclock.cal : 'story'
    if (vclock && vclock.cal === l.calendar) l.clock = vclock
    if (!l.clock && l.calendar === 'story') l.clock = L.clockAt('story', 0, 'start')
    if (!l.clock) throw new Error('不知道游戏日期，无法重建（检查设置里的日期变量路径，或把日历改成「故事天数」）')
    if (settings.protagonist) L.setProtagonist(l, settings.protagonist)
    const rows = []
    for (let from = Math.max(2, turn - n + 1); from <= turn; from += 50) {
      const part = await ctx.tavern.getHistory({ gameId, from, to: Math.min(turn, from + 49) })
      rows.push(...part)
    }
    // 每轮标上当轮日期，模型才能按说话那天换算“明日”“后日”
    for (const r of rows) {
      const cl = C.cleanStory(r.rawText, r.text, settings.ignoreTags)
      r.text = cl.text
      try {
        const t = await ctx.tavern.getTurn({ gameId, turn: r.turn }); const c = t && L.clockFromVariables(t.variables, settings.datePath)
        const m = !c && l.calendar === 'gregorian' ? K.markersFrom(cl.blocks).date : null
        const d = c && c.cal === l.calendar ? c : m
        r.date = d ? d.label : null; r.idx = d ? d.idx : null
      } catch { r.date = null }
    }
    const chunks = []
    let buf = '', firstIdx = null
    for (const r of rows) {
      const piece = '【第' + r.turn + '轮' + (r.date ? ' · ' + r.date : '') + '】' + (r.input ? '玩家：' + String(r.input).slice(0, 200) + '\n' : '') + '正文：' + String(r.text || '').slice(0, 1500) + '\n'
      if (buf.length + piece.length > 10000 && buf) { chunks.push({ corpus: buf, firstIdx }); buf = ''; firstIdx = null }
      if (firstIdx == null && r.idx != null) firstIdx = r.idx
      buf += piece
    }
    if (buf) chunks.push({ corpus: buf, firstIdx })
    let applied = 0, rejected = 0, via = null, done = 0
    const overall = Date.now() + 540000 // 手动任务 600 秒超时；留出余量，来不及的块留到下次
    for (const ch of chunks) {
      if (signal && signal.aborted) break
      if (overall - Date.now() < 90000) break
      const { res, reply } = await callAndParse({ gameId, system: L.rebuildPromptFor(l.calendar), user: L.buildRebuildMessage({ ledger: l, corpus: ch.corpus }), signal, runAgent, deadline: Math.min(overall, Date.now() + TURN_BUDGET_MS) })
      done++
      via = res.via
      if (!settings.protagonist && reply.protagonist && !l.protagonist) L.setProtagonist(l, reply.protagonist)
      const out = L.applyOps(l, reply.ops.map(o => ({ ...o })), { corpus: ch.corpus, turn, start: ch.firstIdx != null ? { idx: ch.firstIdx } : null })
      L.noteMentions(l, [...reply.mentioned, ...out.applied.map(a => a.id)], turn)
      applied += out.applied.length; rejected += out.rejected.length
    }
    for (const e of l.entries) if (e.source === 'model' && e.created && e.created.turn === turn) e.source = 'rebuild'
    L.fade(l, settings)
    L.scoreRelevance(l, sceneOf(variables, settings, rows.length ? rows[rows.length - 1].text : '', '', turn))
    L.plan(l, settings)
    l.turn = turn
    l.lastRun = { turn, at: Date.now(), gate: 'rebuild', via, applied: [], rejected, ms: 0, rebuild: { turns: rows.length, chunks: chunks.length, chunksDone: done, applied } }
    await ctx.tavern.saveTurnData({ gameId, turn, textVersion, data: l })
    writeGame(gameId, d => { d.lastRebuild = { at: Date.now(), turns: rows.length, chunks: chunks.length, chunksDone: done, applied, rejected, via } })
  }
  ctx.tavern.manualTask({
    name: 'rebuild',
    title: '重建约定台账',
    description: '读最近若干轮正文，整理出仍未了结的约定（会调用后台模型，轮数多时要等一会儿）',
    input: { label: '读最近多少轮（留空用设置里的轮数）', placeholder: '例如 60' },
    async run(args) {
      try { await rebuild(args) } catch (e) { recordError(args.gameId, '重建台账', e); throw e }
    },
  })

  // —— 回放测试：用 V0.2 甲局 25 轮原样再提取一遍，对照已标注结果 ——
  const replays = new Map() // gameId -> { ac, done, total, startedAt, round }
  // 回放测试的样本是开发用的；发布包里不带，面板上就不显示回放
  let benchOk = null
  async function hasBench() {
    if (benchOk == null) benchOk = await readFile(new URL('./bench/v02-jia.json', import.meta.url)).then(() => true, () => false)
    return benchOk
  }
  async function runReplay(gameId, ac) {
    const bench = JSON.parse(await readFile(new URL('./bench/v02-jia.json', import.meta.url), 'utf8'))
    const settings = await settingsOf(gameId)
    const sel = await extractModel(gameId)
    const prog = replays.get(gameId)
    prog.total = bench.turns.length
    let l = L.emptyLedger(), prevClock = null
    const results = []
    for (const t of bench.turns) {
      if (ac.signal.aborted) break
      prog.round = t.round
      l.clock = { idx: t.idx, label: t.label, source: 'variable', era: bench.era }
      if (settings.protagonist) L.setProtagonist(l, settings.protagonist)
      const start = prevClock || l.clock
      const row = { round: t.round, label: t.label, via: null, ms: 0, applied: [], rejected: [], error: null }
      const roundStart = Date.now()
      try {
        const { res, reply } = await callAndParse({ gameId, system: L.SYSTEM_PROMPT, user: L.buildUserMessage({ ledger: l, start, input: t.input, text: t.text, tasks: t.tasks }), signal: ac.signal, deadline: Date.now() + REPLAY_ROUND_MS })
        Object.assign(row, { via: res.via, ms: res.ms, usage: res.usage || null, inChars: res.inChars, outChars: res.outChars, attempts: res.attempts && res.attempts.length ? res.attempts : null })
        if (!settings.protagonist && reply.protagonist && !l.protagonist) L.setProtagonist(l, reply.protagonist)
        const out = L.applyOps(l, reply.ops, { corpus: t.input + '\n' + t.text, turn: t.round, start })
        row.applied = out.applied.map(a => ({ op: a.op, id: a.id, title: titleOf(l, a.id), quote: a.quote, when: whenOf(l, a.id) }))
        row.rejected = out.rejected.map(r => ({ op: r.op, title: r.title, quote: r.quote, why: r.why }))
        L.noteMentions(l, [...reply.mentioned, ...out.applied.map(a => a.id)], t.round)
        L.fade(l, settings)
      } catch (e) { if (ac.signal.aborted) break; row.error = errorText(e); row.ms = Date.now() - roundStart }
      results.push(row)
      prog.done = results.length
      prevClock = l.clock
      await writeGame(gameId, d => { d.replayPartial = { at: Date.now(), done: results.length, total: bench.turns.length, results } })
    }
    const score = B.score(results, bench.labels)
    const summary = { at: Date.now(), version: VERSION, model: sel ? sel.provider + '/' + sel.model : null, effort: settings.effort, aborted: ac.signal.aborted, rounds: results.length, ...score.summary,
      avgMs: results.length ? Math.round(results.reduce((s, r) => s + (r.ms || 0), 0) / results.length) : 0,
      direct: results.filter(r => r.via === '直连').length, errors: results.filter(r => r.error).length }
    await writeGame(gameId, d => { d.replay = { summary, details: score.details, results }; delete d.replayPartial })
    return summary
  }
  const whenOf = (l, id) => { const e = l.entries.find(x => x.id === id); return e && e.when ? e.when.label : null }

  // —— 面板接口 ——
  ctx.tavern.handle(PLUGIN + '/status', async ({ gameId } = {}) => {
    if (!gameId) throw new Error('缺少 gameId')
    const rec = await latestOf(gameId)
    const game = await readGame(gameId)
    const errs = [...(game.errors || []), ...(memErrors.get(gameId) || [])]
      .filter((e, i, all) => all.findIndex(x => x.at === e.at && x.where === e.where) === i).sort((a, b) => a.at - b.at).slice(-30)
    const run = jobs.get(gameId)
    const rp = replays.get(gameId)
    return {
      version: VERSION, turn: rec ? rec.turn : null, ledger: rec ? rec.data : null,
      preview: rec ? L.renderWorld(rec.data) : '', candidates: rec ? L.renderCandidates(rec.data) : '',
      settings: { ...L.DEFAULT_SETTINGS, ...(game.settings || {}) }, effective: L.effectiveSettings(game.settings), errors: errs,
      extractModel: await extractModel(gameId).then(m => m ? { name: m.provider + ' / ' + m.model, chosen: !!m.chosen } : null, () => null),
      lastRebuild: game.lastRebuild || null, diag: game.diag || null,
      running: run ? { turn: run.turn, since: run.at } : null,
      replay: { available: await hasBench(), progress: rp && !rp.finished ? { done: rp.done || 0, total: rp.total || 0, round: rp.round || null, since: rp.startedAt } : null, last: game.replay ? game.replay.summary : null, partial: !rp && game.replayPartial ? { done: game.replayPartial.done, total: game.replayPartial.total, at: game.replayPartial.at } : null },
      kindLabel: L.KIND_LABEL,
      history: await historyStatus(gameId, rec),
    }
  })
  async function historyStatus(gameId, rec) {
    const settings = await settingsOf(gameId)
    if (settings.history === false) return { enabled: false }
    const l = rec && rec.data
    const era = l && l.clock ? l.clock.era || '' : ''
    const cat = await catalogOf(gameId, era).catch(e => ({ events: [], conds: [], warnings: ['读史事失败：' + errorText(e)], counts: { card: 0, packs: 0 } }))
    const st = (l && l.hist) || {}, cs = (l && l.conds) || {}
    return {
      enabled: true, counts: cat.counts, warnings: cat.warnings.slice(0, 20),
      events: cat.events.map(ev => { const x = st[ev.id] || {}; return { id: ev.id, title: ev.title, source: ev.source, reliability: ev.reliability, place: ev.place, level: ev.level, window: ev.date.label, land: ev.land, pre: !!ev.pre, stage: x.stage || 'pending', landLabel: x.landLabel || null, arriveLabel: x.arriveLabel || null, verdict: x.verdict || null, reason: x.reason || null, manual: !!x.manual } }),
      conds: cat.conds.map(c => { const x = cs[c.id] || {}; return { id: c.id, title: c.title, source: c.source, met: !!x.met, injected: !!x.injected, quote: x.quote || '', byKeys: !!c.allKeys } }),
      news: (l && l.plan && l.plan.news) || [],
    }
  }
  ctx.tavern.handle(PLUGIN + '/history-detail', async ({ gameId, id } = {}) => {
    const rec = await latestOf(gameId)
    const cat = await catalogOf(gameId, rec && rec.data.clock ? rec.data.clock.era || '' : '')
    const ev = cat.events.find(e => e.id === id), c = cat.conds.find(e => e.id === id)
    if (ev) return { title: ev.title, pre: ev.pre, fact: ev.fact, visible: ev.visible, spread: ev.spread.text, keys: ev.keys }
    if (c) return { title: c.title, cond: c.cond, content: c.content, keys: c.keys }
    throw new Error('找不到这一条')
  })
  ctx.tavern.handle(PLUGIN + '/history-reload', async ({ gameId } = {}) => {
    packsCache = null
    const rec = await latestOf(gameId)
    const cat = await catalogOf(gameId, rec && rec.data.clock ? rec.data.clock.era || '' : '', { fresh: true })
    return { ok: true, counts: cat.counts, warnings: cat.warnings }
  })
  ctx.tavern.handle(PLUGIN + '/replay-detail', async ({ gameId } = {}) => {
    const game = await readGame(gameId)
    return game.replay || null
  })

  async function mutateLatest(gameId, change) {
    await settleJobs(gameId, 120000) // 后台正在记最新一轮：等它存完再改，免得被覆盖
    const rec = await ctx.tavern.readTurnData({ gameId, turn: LATEST })
    if (!rec) throw new Error('还没有数据：先推进一轮')
    const next = change(L.migrate(rec.data), await settingsOf(gameId))
    await ctx.tavern.saveTurnData({ gameId, turn: rec.turn, textVersion: rec.textVersion, data: next })
    return { ok: true }
  }
  ctx.tavern.handle(PLUGIN + '/action', async ({ gameId, action } = {}) => {
    if (!gameId || !action) throw new Error('缺少参数')
    try {
      if (String(action.type || '').startsWith('hist')) {
        const rec = await latestOf(gameId)
        const cat = await catalogOf(gameId, rec && rec.data.clock ? rec.data.clock.era || '' : '')
        return await mutateLatest(gameId, (l, s) => { H.applyHistAction(l, cat, action); l.plan.news = H.newsEntries(l, cat, { max: s.newsMax }); return l })
      }
      return await mutateLatest(gameId, (l, s) => L.applyAction(l, action, s))
    }
    catch (e) { recordError(gameId, '面板操作 ' + action.type, e); throw e }
  })
  ctx.tavern.handle(PLUGIN + '/settings', async ({ gameId, settings } = {}) => {
    if (!gameId || !settings) throw new Error('缺少参数')
    const D = L.DEFAULT_SETTINGS
    const int = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(Number(v) || d)))
    const clean = {
      mode: settings.mode === 'manual' ? 'manual' : 'auto',
      modelHintSeen: !!settings.modelHintSeen,
      extract: settings.extract !== false,
      remind: settings.remind === 'off' ? 'off' : 'auto',
      scope: ['important', 'normal', 'all'].includes(settings.scope) ? settings.scope : D.scope,
      gate: settings.gate === 'keywords' ? 'keywords' : 'every',
      calendar: ['lunar', 'gregorian', 'story'].includes(settings.calendar) ? settings.calendar : 'auto',
      ignoreTags: String(settings.ignoreTags || '').replace(/[^\w\u4e00-\u9fa5,，、\s-]/g, '').trim().slice(0, 200),
      playerToStory: settings.playerToStory !== false,
      fadeMid: int(settings.fadeMid, 2, 120, D.fadeMid),
      maxPerTurn: int(settings.maxPerTurn, 1, 8, D.maxPerTurn),
      festivals: settings.festivals !== false,
      rebuildTurns: int(settings.rebuildTurns, 5, 300, D.rebuildTurns),
      datePath: String(settings.datePath || D.datePath).trim().slice(0, 100) || D.datePath,
      placePath: String(settings.placePath || D.placePath).trim().slice(0, 100) || D.placePath,
      protagonist: String(settings.protagonist || '').trim().slice(0, 10),
      effort: ['low', 'off', 'model'].includes(settings.effort) ? settings.effort : D.effort,
      model: typeof settings.model === 'string' && settings.model.includes('\u0001') ? settings.model.slice(0, 300) : '',
      skin: settings.skin === 'host' ? 'host' : 'ancient',
      history: settings.history !== false,
      newsMax: int(settings.newsMax, 1, 5, D.newsMax),
      newsDays: int(settings.newsDays, 0, 90, D.newsDays),
    }
    await writeGame(gameId, d => { d.settings = clean })
    const eff = L.effectiveSettings(clean)
    await mutateLatest(gameId, l => { if (eff.protagonist) L.setProtagonist(l, eff.protagonist); L.fade(l, eff); return L.plan(l, eff) }).catch(() => {})
    return { ok: true, settings: clean }
  })
  ctx.tavern.handle(PLUGIN + '/clear-errors', async ({ gameId } = {}) => {
    memErrors.delete(gameId)
    await writeGame(gameId, d => { d.errors = [] })
    return { ok: true }
  })
  // 重新提取最新一轮
  ctx.tavern.handle(PLUGIN + '/reextract', async ({ gameId, turn } = {}) => {
    const state = await ctx.tavern.getTurnState({ gameId })
    if (!state || state.busy) throw new Error('正文或后台还在进行中，稍后再试')
    if (turn != null && Number(turn) !== state.turn) throw new Error('只能重新提取最新一轮（第 ' + state.turn + ' 轮）')
    const t = await ctx.tavern.getTurn({ gameId, turn: state.turn })
    if (!t) throw new Error('读不到最新一轮')
    const job = jobs.get(gameId)
    if (job) job.ac.abort()
    try {
      const info = await processTurn({ gameId, turn: t.turn, textVersion: t.textVersion, text: t.text, rawText: t.rawText, variables: t.variables, input: await inputFor(gameId, t.turn), extract: true, force: true })
      return { ok: true, info }
    } catch (e) { recordError(gameId, '重新提取', e); throw e }
  })
  ctx.tavern.handle(PLUGIN + '/rebuild', async ({ gameId, turns } = {}) => {
    await ctx.tavern.startTask({ gameId, name: 'rebuild', input: turns ? String(turns) : '' })
    return { ok: true }
  })
  ctx.tavern.handle(PLUGIN + '/replay', async ({ gameId, stop } = {}) => {
    if (!gameId) throw new Error('缺少 gameId')
    const cur = replays.get(gameId)
    if (stop) { if (cur && !cur.finished) cur.ac.abort(); return { ok: true } }
    if (cur && !cur.finished) throw new Error('回放测试已在进行中')
    const ac = new AbortController()
    const prog = { ac, done: 0, total: 0, startedAt: Date.now(), finished: false }
    replays.set(gameId, prog)
    runReplay(gameId, ac).catch(e => recordError(gameId, '回放测试', e)).finally(() => { prog.finished = true })
    return { ok: true }
  })
  // 导出数据：设置、台账、逐轮记账与提醒、错误，可选附正文。给玩家存档或发给作者排查。
  ctx.tavern.handle(PLUGIN + '/export', async ({ gameId, turns, withText } = {}) => {
    if (!gameId) throw new Error('缺少 gameId')
    const N = Math.max(1, Math.min(200, Math.round(Number(turns) || 60)))
    const rec = await latestOf(gameId)
    const game = await readGame(gameId)
    const last = rec ? rec.turn : 0
    const perTurn = []
    // 轮号可能不连续（回退、删除过的轮次）：只导出实际存在的轮次
    const exist = new Map()
    if (last) for (let from = Math.max(1, last - N + 1); from <= last; from += 50) {
      const rows = await ctx.tavern.getHistory({ gameId, from, to: Math.min(last, from + 49) }).catch(() => null)
      if (!rows) { exist.clear(); break }
      for (const x of rows) exist.set(x.turn, x)
    }
    for (let t = last; t >= 1 && t > last - N; t--) {
      if (exist.size && !exist.has(t) && t !== last) continue
      const r = await ctx.tavern.readTurnData({ gameId, turn: t }).catch(() => null)
      if (!r || r.turn !== t) { perTurn.push({ turn: t, data: '这一轮没有插件数据' }); continue }
      const d = L.migrate(r.data)
      perTurn.push({ turn: t, date: d.clock ? d.clock.label : null, run: d.lastRun || null,
        nextTurnTold: ((d.plan && d.plan.world) || []).map(p => p.text), playerDue: ((d.plan && d.plan.player) || []).map(p => p.title + '（' + p.kind + '）'),
        held: ((d.plan && d.plan.held) || []).map(x => x.title), open: (d.entries || []).length, warnings: d.warnings || [] })
    }
    const texts = withText && last ? [...exist.values()].sort((a, b) => a.turn - b.turn).map(x => ({ turn: x.turn, input: x.input || '', text: x.text || '' })) : null
    const card = typeof ctx.tavern.getCard === 'function' ? await ctx.tavern.getCard({ gameId }).catch(() => null) : null
    const sel = await extractModel(gameId).catch(() => null)
    return {
      plugin: PLUGIN, version: VERSION, exportedAt: new Date().toISOString(),
      card: card ? card.name || (card.data && card.data.name) || null : null, latestTurn: last,
      settings: { ...L.DEFAULT_SETTINGS, ...(game.settings || {}) }, effective: L.effectiveSettings(game.settings),
      extractModel: sel ? sel.provider + ' / ' + sel.model + (sel.chosen ? '' : '（本局后台模型）') : null,
      ledger: rec ? rec.data : null,
      turns: perTurn.reverse(),
      texts,
      errors: [...(game.errors || []), ...(memErrors.get(gameId) || [])].filter((e, i, all) => all.findIndex(x => x.at === e.at && x.where === e.where) === i).sort((a, b) => a.at - b.at),
      diag: game.diag || null, lastRebuild: game.lastRebuild || null, replay: game.replay ? game.replay.summary : null,
    }
  })
  // 模型目录（供设置里选「提取用模型」）
  ctx.tavern.handle(PLUGIN + '/models', async () => {
    const llm = llmService()
    if (!llm || typeof llm.listProviders !== 'function') return []
    const groups = await Promise.all(llm.listProviders().map(async p => {
      try {
        const models = await llm.listModels(p.id)
        return { provider: p.id, providerName: p.name || p.id, models: models.filter(m => !Array.isArray(m.inputModalities) || m.inputModalities.includes('text')).map(m => ({ id: m.id, name: m.name || m.id })) }
      } catch { return { provider: p.id, providerName: p.name || p.id, models: [] } }
    }))
    return groups.filter(g => g.models.length)
  })
  // 诊断：试一次模型调用，看走的是哪条路
  ctx.tavern.handle(PLUGIN + '/diag', async ({ gameId } = {}) => {
    const started = Date.now()
    try {
      const res = await callModel({ gameId, system: '你是格式测试器。无论用户说什么，只回复这一个 JSON：{"ok":true,"word":"万历"}', user: '你好', signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) })
      const sel = await extractModel(gameId)
      const effort = sel && llmService() ? await pickEffort(llmService(), sel, (await settingsOf(gameId)).effort) : null
      const efforts = sel && llmService() ? await effortIds(llmService(), sel) : []
      const diag = { at: Date.now(), effort: effort || (efforts.length ? '跟随模型' : '跟随模型（这个模型没有可调的推理档位）'), model: sel ? (sel.chosen ? '' : '本局后台模型 ') + sel.provider + '/' + sel.model : null, ok: /"ok"\s*:\s*true/.test(res.text), systemFollowed: /万历/.test(res.text), via: res.via, ms: Date.now() - started, directError: res.directError || null, usage: res.usage || null, reply: String(res.text).slice(0, 200) }
      await writeGame(gameId, d => { d.diag = diag })
      return diag
    } catch (e) {
      const diag = { at: Date.now(), ok: false, error: errorText(e), ms: Date.now() - started }
      await writeGame(gameId, d => { d.diag = diag })
      return diag
    }
  })
}
