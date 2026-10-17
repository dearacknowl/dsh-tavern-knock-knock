// 三种日历：古风（农历式，每月 30 日）/ 公历 / 故事天数。纯函数。
// 内部一律用整数日序 idx 比较先后、算天数差；不同日历只是 idx 的含义和写法不同：
// · lunar：idx = 年 × 360 + (月 − 1) × 30 + (日 − 1)（沿用 calendar.mjs）
// · gregorian：idx = 1970-01-01 起的天数（UTC）
// · story：idx = 故事第几天 − 1（开局那天为 0）
import { toIdx, fromIdx, dateLabel, cnNumber, monthNumber } from './calendar.mjs'

export const CALENDARS = ['lunar', 'gregorian', 'story']
export const CAL_LABEL = { lunar: '古风', gregorian: '公历', story: '故事天数' }

const DAY = 86400000
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const CN_MONTH = ['', '正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']

export function gIdx(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / DAY) }
export function gFrom(idx) { const t = new Date(idx * DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), w: t.getUTCDay() } }
const gDays = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** 相对今天的说法（故事天数日历用来写提醒）。 */
export function relLabel(idx, T) {
  const n = idx - T
  if (n === 0) return '今天'
  if (n === 1) return '明天'
  if (n === 2) return '后天'
  if (n === -1) return '昨天'
  const span = k => k < 14 ? k + '天' : k < 60 ? Math.round(k / 7) + '周' : k < 700 ? Math.round(k / 30) + '个月' : Math.round(k / 365) + '年'
  return n > 0 ? '约' + span(n) + '后' : '约' + span(-n) + '前'
}

export function makeCal(kind) {
  if (kind === 'gregorian') return {
    kind,
    label: idx => { const { m, d, w } = gFrom(idx); return m + '月' + d + '日（' + WEEK[w] + '）' },
    short: idx => { const { m, d } = gFrom(idx); return m + '月' + d + '日' },
    monthName: m => m + '月',
    /** 月、日 → idx；年份按今天推断（前后半年内）。日期不存在返回 null。 */
    monthDay(m, d, T) {
      const t = gFrom(T)
      let y = t.y
      if (t.m - m >= 6) y += 1; else if (m - t.m >= 6) y -= 1
      if (!Number.isInteger(d) || d < 1 || d > gDays(y, m)) return null
      return gIdx(y, m, d)
    },
    monthEnd(m, T) { const t = gFrom(T); let y = t.y; if (t.m - m >= 6) y += 1; else if (m - t.m >= 6) y -= 1; return gIdx(y, m, gDays(y, m)) },
    weekday(w, weeksAhead, T) { // w：1–7（周一…周日）；weeksAhead：0 本周 / 1 下周 / 2 下下周
      const t = gFrom(T), cur = t.w === 0 ? 7 : t.w
      const monday = T - (cur - 1)
      return monday + (weeksAhead || 0) * 7 + (w - 1)
    },
    dayOk: d => Number.isInteger(d) && d >= 1 && d <= 31,
  }
  if (kind === 'story') return {
    kind,
    label: idx => '第' + (idx + 1) + '天',
    short: idx => '第' + (idx + 1) + '天',
    monthName: () => '',
    monthDay: () => null, monthEnd: () => null, weekday: () => null,
    dayOk: () => false,
  }
  return {
    kind: 'lunar',
    label: dateLabel, short: dateLabel,
    monthName: m => CN_MONTH[m],
    monthDay(m, d, T) {
      if (!Number.isInteger(d) || d < 1 || d > 30) return null
      const t = fromIdx(T)
      let y = t.y
      if (t.m - m >= 6) y += 1; else if (m - t.m >= 6) y -= 1
      return toIdx(y, m, d)
    },
    monthEnd(m, T) { return this.monthDay(m, 30, T) },
    weekday: () => null,
    dayOk: d => Number.isInteger(d) && d >= 1 && d <= 30,
  }
}

// —— 从变量、正文里读日期 ——
const unwrap = v => (Array.isArray(v) && v.length && (typeof v[0] !== 'object' || v[0] === null) ? v[0] : v)

/** 一个值 → { cal, idx, era?, label } 或 null。认对象 {纪年,月,日} / {年,月,日}，以及“2024年5月3日”“2024-05-03”“万历十五年二月初五”“二月初五”这类字符串。 */
export function parseDateValue(v) {
  v = unwrap(v)
  if (v == null) return null
  if (typeof v === 'object' && !Array.isArray(v)) {
    const g = k => unwrap(v[k])
    const mRaw = g('月') ?? g('month'), dRaw = g('日') ?? g('day')
    const yRaw = g('年') ?? g('year'), era = g('纪年') ?? g('年号')
    if (mRaw != null && dRaw != null) {
      const m = typeof mRaw === 'number' ? mRaw : monthNumber(String(mRaw).replace(/月$/, '').replace(/^闰/, ''))
      const d = typeof dRaw === 'number' ? dRaw : cnNumber(String(dRaw).replace(/[日号]$/, ''))
      const yNum = Number(yRaw)
      if (m && d) {
        if (era == null && Number.isInteger(yNum) && yNum >= 1000 && d <= 31) return mk('gregorian', gIdx(yNum, m, d))
        if (d <= 30) {
          const ey = String(era ?? '').match(/([〇零一二两三四五六七八九十廿卅\d]+)年/)
          const y = (ey && cnNumber(ey[1])) || (Number.isInteger(yNum) ? yNum : 0)
          return { ...mk('lunar', toIdx(y, m, d)), era: era != null ? String(era) : undefined }
        }
      }
    }
    for (const k of ['日期', '当前日期', 'date', '时间', '当前时间']) if (v[k] != null && typeof unwrap(v[k]) !== 'object') { const r = parseDateValue(v[k]); if (r) return r }
    return null
  }
  return parseDateString(String(v))
}
function mk(cal, idx) { return { cal, idx, label: makeCal(cal).label(idx) } }

export function parseDateString(s) {
  s = String(s || '')
  let m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/)
  if (m) { const y = +m[1], mo = +m[2], d = +m[3]; if (mo >= 1 && mo <= 12 && d >= 1 && d <= gDays(y, mo)) return mk('gregorian', gIdx(y, mo, d)) }
  m = s.match(/(?:([^\s，,]{1,6}?[〇零一二两三四五六七八九十廿\d]+)年)?\s*(闰)?(正|冬|腊|臘|十[一二]?|[一二三四五六七八九])月\s*(初[一二三四五六七八九十]|[一二三]?十[一二三四五六七八九]?|廿[一二三四五六七八九]?|卅)/)
  if (m) {
    const mo = monthNumber(m[3]), d = cnNumber(m[4])
    const ey = m[1] ? m[1].match(/([〇零一二两三四五六七八九十廿\d]+)$/) : null
    const y = (ey && cnNumber(ey[1])) || 0
    if (mo && d && d <= 30) return { ...mk('lunar', toIdx(y, mo, d)), era: m[1] ? m[1] + '年' : undefined }
  }
  return null
}

/** 变量里的日期：先按设置的路径读，读不到就在 stat_data 里找名字像日期的字段（最多三层）。 */
export function dateFromVariables(variables, path, readPath) {
  if (!variables) return null
  const direct = path ? parseDateValue(readPath(variables, path)) : null
  if (direct) return { ...direct, path }
  const root = variables.stat_data && typeof variables.stat_data === 'object' ? variables.stat_data : null
  if (!root) return null
  const KEY = /日期|时间|date|time/i
  const seen = []
  const walk = (o, p, depth) => {
    if (!o || typeof o !== 'object' || depth > 3 || seen.length) return
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('$') || k.startsWith('_')) continue
      if (KEY.test(k)) { const r = parseDateValue(v); if (r) { seen.push({ ...r, path: p + k }); return } }
      const u = unwrap(v)
      if (u && typeof u === 'object' && !Array.isArray(u)) walk(u, p + k + '.', depth + 1)
    }
  }
  walk(root, 'stat_data.', 1)
  return seen[0] || null
}

/** 正文标记（从清洗掉的状态块、摘要里找）：最后出现的公历日期，以及“时间流逝：N 小时/天”。 */
export function markersFrom(blocks) {
  const hay = (blocks || []).join('\n')
  let date = null
  const re = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/g
  let m
  while ((m = re.exec(hay))) { const y = +m[1], mo = +m[2], d = +m[3]; if (mo >= 1 && mo <= 12 && d >= 1 && d <= gDays(y, mo)) date = mk('gregorian', gIdx(y, mo, d)) }
  let hours = null
  const el = hay.match(/(?:时间流逝|经过时间|流逝时间|时间经过)\s*[:：]\s*(?:约|大约)?\s*([\d.]+|[一二两三四五六七八九十半]+)\s*(分钟|小时|个小时|天|日|周|个月|月|年)/)
  if (el) {
    const n = /^[\d.]+$/.test(el[1]) ? Number(el[1]) : el[1] === '半' ? 0.5 : cnNumber(el[1])
    const unit = { 分钟: 1 / 60, 小时: 1, 个小时: 1, 天: 24, 日: 24, 周: 168, 个月: 720, 月: 720, 年: 8760 }[el[2]]
    if (Number.isFinite(n) && unit) hours = n * unit
  }
  return { date, hours }
}

/** 一段时间相对今天的说法（不带“约”）：“明天”“3至7天后”“2至3个月后”“这几天”。 */
export function relSpan(a, b, T) {
  if (b == null || a === b) return relLabel(a, T).replace(/^约/, '')
  const x = a - T, y = b - T
  if (y < 0) return relLabel(b, T).replace(/^约/, '')
  if (x <= 0) return y < 14 ? '这几天' : '眼下到' + relLabel(b, T).replace(/^约/, '')
  const [div, name] = y < 14 ? [1, '天'] : y < 60 ? [7, '周'] : y < 700 ? [30, '个月'] : [365, '年']
  const p = Math.max(1, Math.round(x / div)), q = Math.max(p, Math.round(y / div))
  return (p === q ? p : p + '至' + q) + name + '后'
}
