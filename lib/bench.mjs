// 回放测试打分：把新一次提取出的操作，和 V0.2 实测里人工标注过的操作对照。
// 匹配是近似的（同一轮、同类操作、引文或标题有足够长的公共片段），结果供参考，不等于人工复核。
import { norm } from './ledger.mjs'

const FAMILY = { add: 'add', reschedule: 'move', progress: 'move', confirm: 'move', done: 'end', cancel: 'end', missed: 'miss' } // intent（意向，不提醒）不算登记，故意不配对
const compatible = (a, b) => FAMILY[a] === FAMILY[b] || (FAMILY[a] === 'move' && FAMILY[b] === 'add') || (FAMILY[a] === 'add' && FAMILY[b] === 'move')

/** 最长公共子串长度。 */
export function lcs(a, b) {
  a = norm(a); b = norm(b)
  if (!a || !b) return 0
  let best = 0
  const prev = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diag = 0
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0
      if (prev[j] > best) best = prev[j]
      diag = tmp
    }
  }
  return best
}

export function matches(op, label) {
  if (op.round !== label.round || !compatible(op.op, label.op)) return false
  return lcs(op.quote, label.evidence) >= 6 || lcs(op.title, label.title) >= 4
}

/**
 * results：[{ round, applied:[{op,title,quote,when}] }]；labels：[{ round, op, judge:'对'|'部分对'|'错', title, evidence, reason }]
 * 返回 { summary, details }。
 */
export function score(results, labels) {
  const ops = results.flatMap(r => (r.applied || []).map(a => ({ ...a, round: r.round })))
  const rounds = new Set(results.map(r => r.round))
  const scoped = labels.filter(l => rounds.has(l.round))
  const used = new Set()
  const details = []
  let good = 0, goodHit = 0, partial = 0, partialHit = 0, bad = 0, badRepeat = 0
  for (const lab of scoped) {
    const hit = ops.findIndex(o => matches(o, lab))
    if (hit >= 0) used.add(hit)
    if (lab.judge === '对') { good++; if (hit >= 0) goodHit++ }
    else if (lab.judge === '部分对') { partial++; if (hit >= 0) partialHit++ }
    else { bad++; if (hit >= 0) badRepeat++ }
    details.push({ round: lab.round, judge: lab.judge, op: lab.op, title: lab.title, evidence: lab.evidence, reason: lab.reason, now: hit >= 0 ? { op: ops[hit].op, title: ops[hit].title, quote: ops[hit].quote, when: ops[hit].when } : null })
  }
  const fresh = ops.filter((_, i) => !used.has(i))
  for (const o of fresh) details.push({ round: o.round, judge: '新', op: o.op, title: o.title, evidence: null, reason: '上次没有这条操作，需人工判断', now: { op: o.op, title: o.title, quote: o.quote, when: o.when } })
  details.sort((a, b) => a.round - b.round)
  return {
    summary: { good, goodHit, partial, partialHit, bad, badRepeat, totalOps: ops.length, fresh: fresh.length, intents: ops.filter(o => o.op === 'intent').length },
    details,
  }
}
