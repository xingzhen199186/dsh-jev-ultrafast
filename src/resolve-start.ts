/**
 * Where a run should start, when the sentence said everything except the address.
 *
 * The command's first word no longer has to be an address: "上百度查一下明天北京的天气" is a
 * complete request, and what is missing from it is only the page to open. Two things decide that
 * page, and neither of them is a model. A site named in the sentence is read straight off — 百度,
 * 知乎, B站 and the rest of the list below are names a person knows, so the code can know them too.
 * Everything else starts at a search engine, which is a real place to begin and one the running
 * browser can leave on its own.
 *
 * This used to be one small question to the text model, and it was the weakest step of the whole
 * command. It cost a wait before every run, a thinking model could spend the answer on its own
 * reasoning, and asking it here — from the command, before any run exists — turned out to be the one
 * place a text call kept being cut off, while the very same call succeeds inside a running run.
 * Reading the sentence offline cannot fail and needs no settings, so the run can no longer be lost
 * before it starts. The goal is never rewritten either: it stays the reader's own sentence, because
 * the decision loop reads it as written and this module has no business putting words in their mouth.
 */

/**
 * The sites a reader names in Chinese, known the way a person knows them.
 *
 * Names like 百度 or 知乎 need no model: asking "which site is this about" was the weakest link in
 * the whole command, and the list is short enough to keep exact.
 */
const NAMED_SITES: ReadonlyArray<{ pattern: RegExp; url: string }> = [
  { pattern: /百度|baidu/i, url: 'https://www.baidu.com' },
  { pattern: /必应|bing/i, url: 'https://cn.bing.com' },
  { pattern: /谷歌|google/i, url: 'https://www.google.com' },
  { pattern: /知乎/i, url: 'https://www.zhihu.com' },
  { pattern: /微博/i, url: 'https://weibo.com' },
  { pattern: /豆瓣/i, url: 'https://www.douban.com' },
  { pattern: /淘宝|天猫/i, url: 'https://www.taobao.com' },
  { pattern: /京东/i, url: 'https://www.jd.com' },
  { pattern: /小红书/i, url: 'https://www.xiaohongshu.com' },
  { pattern: /抖音/i, url: 'https://www.douyin.com' },
  { pattern: /哔哩哔哩|bilibili|B站/i, url: 'https://www.bilibili.com' },
  { pattern: /维基|wikipedia/i, url: 'https://zh.wikipedia.org' },
  { pattern: /github/i, url: 'https://github.com' },
]

/**
 * Where a sentence that names no site starts: a search engine is a real place to begin.
 *
 * Bing rather than Baidu, measured on 2026-09-30: Baidu answers this plugin's own browser with
 * 「百度安全验证」 and a slider to drag, so a run that starts there can never reach a result list;
 * the same query on cn.bing.com came back with the full result page. Kept in Chinese-language
 * mode, because that is what the sentences this command receives are written in.
 */
export const SEARCH_START = 'https://cn.bing.com'

/** One run's starting point, as resolved from a sentence. */
export interface ResolvedStart {
  url: string
  goal: string
}

/** The site this sentence names, or nothing. Offline, free, and exact about the names it knows. */
export function namedSite(text: string): string | null {
  for (const site of NAMED_SITES) if (site.pattern.test(text)) return site.url
  return null
}

/**
 * The starting point for a sentence that carries no address.
 *
 * Total and offline: it reads the names it knows and otherwise hands back the search engine, so
 * there is no way for this to fail and no way for a settings problem to cost the reader their run.
 */
export function resolveStart(text: string): ResolvedStart {
  const goal = text.trim()
  return { url: namedSite(goal) ?? SEARCH_START, goal }
}
