// 历法与约期解析：纯函数，不依赖 DSHT。
// 内部日序 idx = 年 × 360 + (月 − 1) × 30 + (日 − 1)，只用于比较先后与估算天数差（闰月不计）。

const DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 汉字或阿拉伯数字 → 整数（1–99），不认识返回 null。 */
export function cnNumber(text) {
  if (text == null) return null
  let s = String(text).trim()
  if (/^\d+$/.test(s)) return Number(s)
  if (s.startsWith('初')) s = s.slice(1)
  if (s === '廿') return 20
  if (s === '卅') return 30
  s = s.replace(/^廿/, '二十').replace(/^卅/, '三十')
  if (!/^[〇零一二两三四五六七八九十]+$/.test(s)) return null
  if (!s.includes('十')) {
    // “十五年”以外的写法如“一五”不常见；逐位读
    let n = 0
    for (const ch of s) n = n * 10 + DIGIT[ch]
    return n || null
  }
  const [tens, ones] = s.split('十')
  const t = tens === '' ? 1 : DIGIT[tens]
  const o = ones === '' ? 0 : DIGIT[ones]
  if (t == null || o == null) return null
  return t * 10 + o
}

const MONTH_WORD = { 正: 1, 冬: 11, 腊: 12, 臘: 12 }
export function monthNumber(text) {
  if (MONTH_WORD[text] != null) return MONTH_WORD[text]
  const n = cnNumber(text)
  return n >= 1 && n <= 12 ? n : null
}

const CN_DAY = ['', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九', '三十']
const CN_MONTH = ['', '正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']

export const toIdx = (y, m, d) => y * 360 + (m - 1) * 30 + (d - 1)
export function fromIdx(idx) {
  const y = Math.floor(idx / 360), r = idx - y * 360
  return { y, m: Math.floor(r / 30) + 1, d: (r % 30) + 1 }
}
export const dateLabel = idx => { const { m, d } = fromIdx(idx); return CN_MONTH[m] + CN_DAY[d] }

/** stat_data.时间 → { y, m, d, idx, era }；读不到返回 null。 */
export function gameDate(time) {
  if (!time || typeof time !== 'object') return null
  const m = Number(time['月']), d = Number(time['日'])
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1 || d > 30) return null
  const era = String(time['纪年'] ?? '')
  const match = era.match(/([〇零一二两三四五六七八九十廿卅\d]+)年/)
  const y = (match && cnNumber(match[1])) || 0
  return { y, m, d, idx: toIdx(y, m, d), era }
}

/** 相对今天的说法。 */
export function relDay(idx, today) {
  const n = idx - today
  if (n === 0) return '今日'
  if (n === 1) return '明日'
  if (n === 2) return '后日'
  if (n === -1) return '昨日'
  return n > 0 ? n + '日后' : '已过 ' + (-n) + ' 日'
}

const DAY_TOKEN = '初[一二三四五六七八九十]|[一二三]?十[一二三四五六七八九]?|廿[一二三四五六七八九]?|卅|[一二三四五六七八九]|\\d{1,2}'
const MONTH_RE = new RegExp('(闰)?(正|冬|腊|臘|十[一二]?|[一二三四五六七八九]|\\d{1,2})月(?:(' + DAY_TOKEN + ')[日号]?)?', 'g')
const DAY_RE = new RegExp('(初[一二三四五六七八九十]|[一二三]?十[一二三四五六七八九]?|廿[一二三四五六七八九]?|卅|\\d{1,2})(?:日|号)(之?[后内])?|([约于限至到])(' + DAY_TOKEN + ')(?=[前后]|左右)|(初[一二三四五六七八九十])', 'g')
const REL_RE = /(今日|今天|明日|明天|后日|后天)/g
const REL_OFFSET = { 今日: 0, 今天: 0, 明日: 1, 明天: 1, 后日: 2, 后天: 2 }
const SPAN_RE = /([一二两三四五六七八九十半\d]{1,3})(?:天|日)(?:之)?(?:后|内|为限)/g

function clip(text, index, length) {
  const start = Math.max(0, index - 12), end = Math.min(text.length, index + length + 12)
  return text.slice(start, end)
}

/**
 * 从一段文字里找出日期，相对 today（gameDate 的结果）解析成日序。
 * 返回 [{ idx, label, src }]，按日期排序、去重。只认明确的写法，宁漏勿错。
 */
const CUE_BEFORE = /约|定|限|须|应|待|拟|要|准|期|候|届|赶|择/
const CUE_AFTER = /^(之?前|以前|为限|截止|到期|交|动身|启程|上船|前来|来访)/
const CONT_RE = /^(?:[^。；;\n]{0,20}?[，、,和及与至到]\s*|[^\d。；;，、,\n〇零一二两三四五六七八九十廿卅]{1,4})(廿[一二三四五六七八九]|[一二三]?十[一二三四五六七八九]?|初[一二三四五六七八九十]|卅)(?![\d〇零一二两三四五六七八九十斤石文钱分厘个余名人日号年月岁里升斗两])/

/**
 * 从一段文字里找出日期，相对 today（gameDate 的结果）解析成日序。
 * 返回 [{ idx, label, src, cue }]，按日期排序、去重。只认明确的写法，宁漏勿错。
 * cue：日期前后有“约、定、限、须……前、为限”之类表示约定的字眼。
 */
export function extractDates(text, today) {
  if (!text || !today) return []
  const out = []
  const s = String(text)
  const taken = []
  const used = (a, b) => taken.some(([x, y]) => a < y && b > x)
  const push = (idx, label, start, length) => {
    const before = s.slice(Math.max(0, start - 6), start), after = s.slice(start + length, start + length + 4)
    out.push({ idx, label, src: clip(s, start, length), cue: CUE_BEFORE.test(before) || CUE_AFTER.test(after) })
    taken.push([start, start + length])
  }
  // 1. 带月份的；同一句里紧跟的“，廿六……，廿七……”按同月处理
  for (const m of s.matchAll(MONTH_RE)) {
    const month = monthNumber(m[2])
    if (!month) continue
    // 排除“一月之内”这类时长：月后紧跟“之内/内/余/后/间”且没有日
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 2)
    if (!m[3] && /^(之内|之后|内|余|后|间)/.test(after) && m[2] !== '正' && m[2] !== '腊' && m[2] !== '冬') continue
    const day = m[3] ? cnNumber(m[3]) : 1
    if (!day || day > 30) continue
    let y = today.y
    if (today.m - month >= 6) y += 1 // 现在腊月，提到正月 → 明年；三月提到正月仍是今年
    push(toIdx(y, month, day), CN_MONTH[month] + (m[3] ? CN_DAY[day] : '（月初）'), m.index, m[0].length)
    if (!m[3]) continue
    let pos = m.index + m[0].length
    for (let guard = 0; guard < 6; guard++) {
      const c = s.slice(pos).match(CONT_RE)
      if (!c) break
      const start = pos + c[0].length - c[1].length
      const d2 = cnNumber(c[1])
      if (!d2 || d2 > 30 || used(start, start + c[1].length)) break
      push(toIdx(y, month, d2), CN_MONTH[month] + CN_DAY[d2], start, c[1].length)
      pos = start + c[1].length
    }
  }
  // 2. 只有日的
  for (const m of s.matchAll(DAY_RE)) {
    if (used(m.index, m.index + m[0].length)) continue
    const token = m[1] || m[4] || m[5]
    const day = cnNumber(token)
    if (!day || day > 30) continue
    // “三日后”“五日内”是时长，不是日期（除非写成“初三日”）
    if (m[2] && !token.startsWith('初') && day <= 10) continue
    let y = today.y, month = today.m
    if (day < today.d - 5) { month += 1; if (month > 12) { month = 1; y += 1 } }
    push(toIdx(y, month, day), CN_MONTH[month] + CN_DAY[day], m.index, m[0].length)
  }
  // 3. 今日、明日、后日（“日后”里的“后日”不算）
  for (const m of s.matchAll(REL_RE)) {
    if (used(m.index, m.index + m[0].length)) continue
    if (m[0] === '后日' && /[日天]$/.test(s.slice(0, m.index))) continue
    push(today.idx + REL_OFFSET[m[0]], dateLabel(today.idx + REL_OFFSET[m[0]]), m.index, m[0].length)
  }
  // 4. 时长：“三日后”“十天内” → 今天 + N（本身就是约定）
  for (const m of s.matchAll(SPAN_RE)) {
    if (used(m.index, m.index + m[0].length)) continue
    const n = m[1] === '半' ? 15 : cnNumber(m[1])
    if (!n || n > 60) continue
    const idx = today.idx + n
    push(idx, dateLabel(idx) + '（' + m[0] + '）', m.index, m[0].length)
    out[out.length - 1].cue = true
  }
  const seen = new Map()
  for (const d of out.sort((a, b) => a.idx - b.idx)) {
    const prev = seen.get(d.idx)
    if (!prev) seen.set(d.idx, d)
    else if (d.cue && !prev.cue) prev.cue = true
  }
  return [...seen.values()]
}

/** 节令表（农历）。 */
export const FESTIVALS = [
  { m: 1, d: 1, name: '元旦（正旦）' }, { m: 1, d: 15, name: '元宵（上元）' }, { m: 2, d: 2, name: '中和节' },
  { m: 3, d: 3, name: '上巳' }, { m: 5, d: 5, name: '端午' }, { m: 7, d: 7, name: '七夕' },
  { m: 7, d: 15, name: '中元' }, { m: 8, d: 15, name: '中秋' }, { m: 9, d: 9, name: '重阳' },
  { m: 10, d: 1, name: '寒衣节' }, { m: 12, d: 8, name: '腊八' }, { m: 12, d: 23, name: '祭灶（小年）' },
  { m: 12, d: 29, name: '岁除将至' },
]
