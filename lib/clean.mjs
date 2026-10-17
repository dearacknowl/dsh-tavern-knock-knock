// 正文清洗：记账前去掉不是剧情的部分（思考、序言、选项、小剧场、摘要、状态栏、闪回、MVU 指令……）。纯函数。
// 从模型原始输出（rawText）按标签去：DSH 给的 text 已去掉标签外壳，分不清哪段是选项。
// 去掉的块另外返回，用来找日期、时间流逝这类标记。

// 整块去掉的标签（含内容）。大小写不敏感。
export const DEFAULT_DROP = [
  'think', 'thinking', 'conception', 'conclusion', 'reasoning', 'analysis', 'plan', 'planning',
  'prologue', 'branches', 'options', 'choices', 'choice', 'journey_choices', 'snow', 'theater', 'meow_FM', 'synopsis', 'summary_block',
  'user_now_status', 'world_situation', 'status', 'statusbar', 'status_bar', 'StatusPlaceHolderImpl', 'char_date',
  'memory_flashback', 'flashback', 'UpdateVariable', 'JSONPatch', 'details', 'style', 'script', 'iframe',
]
// 写到最后没闭合也一并去掉的（常被截断在结尾）
const TAIL_OPEN = ['branches', 'options', 'choices', 'journey_choices', 'snow', 'meow_FM', 'UpdateVariable', 'details', 'user_now_status']

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * raw：模型原始输出；plain：DSH 给的纯文本（兜底）。extra：设置里另加的标签（逗号或空格分隔）。
 * 返回 { text, blocks, removed, fallback }：text 给记账用；blocks 是去掉的块原文。
 */
export function cleanStory(raw, plain = '', extra = '') {
  const src = String(raw || '')
  if (!src.trim()) return { text: String(plain || ''), blocks: [], removed: 0, fallback: 'no-raw' }
  const tags = [...new Set([...DEFAULT_DROP, ...String(extra || '').split(/[\s,，、]+/).map(s => s.replace(/[<>/]/g, '').trim()).filter(Boolean)])]
  const blocks = []
  let s = src.replace(/\r\n?/g, '\n')
  // 没有开头标签的思考（预填充之后只剩 </think>）
  s = s.replace(/^[\s\S]*?<\/(think|thinking)\s*>/i, m => { blocks.push(m); return '' })
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/```[\s\S]*?(```|$)/g, m => { blocks.push(m); return '\n' })
  s = s.replace(/<\|[^|>]{1,40}\|>|<｜[^｜>]{1,40}｜>/g, '')
  for (const t of tags) {
    const re = new RegExp('<(' + esc(t) + ')(\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>', 'gi')
    s = s.replace(re, m => { blocks.push(m); return '\n' })
    s = s.replace(new RegExp('<' + esc(t) + '(\\s[^>]*)?\\/>', 'gi'), '')
  }
  for (const t of TAIL_OPEN) {
    const re = new RegExp('<' + esc(t) + '(\\s[^>]*)?>[\\s\\S]*$', 'i')
    s = s.replace(re, m => { blocks.push(m); return '' })
  }
  s = s.replace(/<\/?[A-Za-z_][\w:-]*(\s[^>]*)?>/g, '')   // 其余标签只去外壳
  s = s.replace(/<\/?[一-龥][^<>\n]{0,20}>/g, '')    // 中文标签外壳（<正文> 之类）
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const p = String(plain || '').trim()
  // 洗得几乎不剩（卡把正文整个包在某个标签里）：退回 DSH 的纯文本
  if (p.length > 200 && s.length < p.length * 0.25) return { text: p, blocks, removed: blocks.length, fallback: 'too-little' }
  return { text: s, blocks, removed: blocks.length, fallback: null }
}
