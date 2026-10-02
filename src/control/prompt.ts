/**
 * What the control model is asked, and nothing else.
 *
 * Kept beside the checklist it has to satisfy: the prompt promises a shape, `checklist.ts`
 * enforces it, and the two are worth reading together. The wording is deliberately rigid —
 * a loose instruction here becomes a rule governing a run that nobody agreed to.
 */

/** One checklist request, in the two parts a model call needs. */
export interface ChecklistPromptInput {
  goal: string
  url: string
  title: string
}

/**
 * The system message, in the same words as the run-control note in `scratch/中控-提示词.md`.
 *
 * The rule that matters most is the one about not inventing names: a check built from a
 * parameter the model guessed is false the moment the run starts, and a false check is
 * exactly what would block a run that is doing fine.
 */
export const CHECKLIST_SYSTEM = [
  '你是浏览器任务的"看门人"。你会拿到一段任务原文和它开始时所在的页面。',
  '请写出 3 到 6 条**必须一直成立**的标志，用来在运行过程中核对"这件事还走在正路上"。',
  '',
  '硬要求：',
  '1. 只写**必须一直成立**的东西，不要复述整段任务、不要写步骤安排、不要写"应该怎么做"。',
  '2. 优先写本地能判的：',
  '   - url-contains：地址里必须一直含有某段字符（例如筛选参数、地点编号）；',
  '   - text-contains：页面上必须一直出现某个词（**只用任务原文里出现过的词**，不要自己编地名、编号或店名）；',
  '   - text-absent：页面上必须**不**出现某个词（例如"登录""验证码"这类挡路的词）。',
  '3. 本地判不了的、必须"看一眼才知道"的，才写成 ask，并且最多一条。',
  '4. 任务里若提到某个限定条件（地点、日期、城市、筛选、排序方式），它一旦被页面丢掉就是一个事故——这类恰恰最该写进来。',
  '5. 不要针对具体站点编造参数名，除非任务原文或当前地址里就有。',
  '',
  '只输出 JSON，不要解释、不要围栏以外的任何文字：',
  '{"goal":"一句话复述这次要达到的结果","checks":[',
  '  {"id":"landmark","say":"地址里一直带着这次要用的地标筛选","kind":"url-contains","value":"landmark="},',
  '  {"id":"target-name","say":"页面上一直出现任务里点名的地方","kind":"text-contains","value":"中关村生命科学园"}',
  ']}',
].join('\n')

/** The user message: the task, then the page the run starts on. */
export function checklistPrompt(input: ChecklistPromptInput): { system: string; user: string } {
  const user = [
    '任务原文：',
    input.goal,
    '',
    '开始时的页面：',
    `地址：${input.url}`,
    `标题：${input.title}`,
    '',
    '现在写出必须一直成立的标志。',
  ].join('\n')
  return { system: CHECKLIST_SYSTEM, user }
}
