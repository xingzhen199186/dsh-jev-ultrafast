# dsh-jev-ultrafast

English | [中文](README-zh.md) | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

> **One goal in, one tool call per step.** Give DeepSeek Harness one natural-language
> goal and let TypeSafe **Jev** drive the browser. The page is compressed into an
> indexed table of controls, and a single request decides both *which operation* to
> perform and *which element* to perform it on — so a session pays for one tool call
> instead of one model turn per click.

What that buys, in short:

- **One request per step.** The operation and its target come back together, so the
  model is not asked to look, think and click across three separate turns.
- **No selectors, coordinates or code in the loop.** Targets are indexes into a table
  the plugin mints from the live page, and freshness, visibility, geometry and
  occlusion are re-checked immediately before the input.
- **It brings its own browser.** When nothing is reachable, a run starts the Chrome or
  Edge you picked and connects to it — its own data directory, its own free port.
- **It follows the tab a click opens**, and closes only the tab it opened itself.
- **`blocked` is not `failed`.** A run that hits a brake stops as `blocked` and reports
  what was still operable on the page, so the stuck point is visible.
- **It reads long pages too.** A second tool scrolls a page one screen at a time and
  stitches the text back together, so a document longer than a screen comes back whole —
  without spending a single decision request.
- **`done` is checked, not taken on trust.** Write down what the finished page must show
  and the plugin goes looking for it; a run that claims to be finished without it comes
  back as `blocked`.
- **Every run leaves a raw trace.** Each run writes `trace.jsonl` into a temporary directory
  of its own — the request body and the response of every decision call and every text-model
  call, with the key scrubbed to `***` and anything past 20,000 characters cut off — plus, when
  screenshots are on, one `frames/NNNNNN.jpg` per step and a `frames.json` recording each
  frame's name and time. The result names that directory.
- **A dropped text-model call is retried; a dropped connection is not.** A 429, 503 or 529
  from the text model is retried up to twice, waiting 0.5 s and then 1 s; a network break is
  reported as it stands, which is where the upstream Python version draws the same line.
- **You can watch a run, not only read about it.** The host serves one inspector page (see
  "Watching a run" below): start a run by hand, watch the live screen, see which element each
  step is about to pick and how sure the model is, and pause, step or stop **before** the
  action is executed — or replay a finished run frame by frame.
- **You can start it without a model turn.** Type `/jev-ultrafast` and then what you want, in
  plain words: an address anywhere in the sentence is used as it is, and a sentence without one
  costs a single small text-model call to pick the starting site. The command line and its
  result stay in the UI; on its own the command explains itself and gives the inspector URL.

**Status:** version `0.1.0`, developer preview. Not published to npm — it installs from
a local tarball (see [Install](#install)). DeepSeek Harness itself is iterating fast, so
expect to re-check this plugin against it.

This is an independent, unofficial TypeScript port of
[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser
Use), packaged as a DeepSeek Harness bundle. Upstream is Python with a little
JavaScript; the loop, the page-snapshot script and the prompts here are rewritten
from it.

> **Not affiliated.** This project is not affiliated with, endorsed by, or sponsored
> by Browser Use or TypeSafe. "Browser Use", "TypeSafe" and "Jev" are their owners'
> trademarks, used here only to describe provenance and the API this plugin calls.
> No trademark licence is granted.
>
> **You bring your own key.** The plugin never ships, bundles, proxies or resells API
> access. It resolves your TypeSafe key from the DeepSeek Harness credential store at
> call time, and your use of that service is governed by TypeSafe's own terms.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.7-rc.2` and `0.2.0-rc.1` (both run here); the plugin declares `>=0.1.7-rc.2 <0.3.0-0` in `peerDependencies`, so a version outside that range is refused by the harness's compatibility gate before it loads, with the reason printed |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | Windows, macOS, Linux |
| Desktop app | Works in the Electron desktop app; its profile is managed by the application, so see the desktop paragraph under Install below |
| Browser | Chrome or Edge: pick one on the settings page and press 「启动并连接」, and the plugin starts it for you (its own profile directory, its own free port). You can also start one yourself with `--remote-debugging-port` and the plugin will find it — and when nothing is reachable at all, a task starts that browser itself, so the button is not a prerequisite |
| Credentials | `TYPESAFE_API_KEY`; plus a key for the text model when a field has to be typed — for a preset that default name is the vendor's own convention (for DeepSeek it is `DEEPSEEK_API_KEY`), and the DSH built-in routes need none |

## What it does

The plugin registers two tools.

**`jev_browser_task`** drives a page toward one goal, running the whole loop inside a
single call. It takes four arguments:

| Argument | Required | Meaning |
|---|---|---|
| `goal` | yes | The whole task in one sentence, including every value to type and every filter to set. The loop sees only this sentence and the current page, never your conversation. |
| `url` | yes | The page to open first. The action space has no "go to address" operation, so the entry point can only come from here. |
| `maxSteps` | no | Overrides the step budget for this run only, without touching the configuration. |
| `expect` | no | Strings the finished page must show, written down before the run and checked by the plugin afterwards. Prefix one with `!` to require that it must *not* be there. This is what keeps `done` from being the last word of the model that did the work. |

It returns `status` (`done` / `blocked` / `failed`), `reason`, `verification`, `url`,
`title`, `text`, `steps`, `decisions`, `elapsedMs`, `actions`, `elements`,
`omittedActions` and `textCalls`, plus the path of the run's own trace directory. When
`status` is `blocked` or `failed`, `elements` carries what was still operable on the page,
so it is clear where the run got stuck. `omittedActions` counts the controls a page offered
beyond the 250 that fit in the table; the step list marks a step the model itself was unsure
about (below half probability); and with screenshots switched on it also returns the
absolute path, inside the system temporary directory, of the last screen's picture.

**`jev_browser_read`** reads a page instead of acting on it. It takes `url`, and
optionally `maxScreens` (default 20) and `maxChars` (default 60000). It collects the
visible text one screen at a time, drops the lines consecutive screens share, and returns
the whole text, so a document longer than a screen comes back complete. It calls no
decision model and clicks nothing: this is the cheap route, and reading is the one thing
it does. It stops for one of four reasons — the page ended, the screen budget ran out, the
character budget ran out, or the page stopped scrolling — and says which one it was; a
screen that exactly filled the 6000-character single-screen limit is counted and flagged as
possibly cut off. A freshly opened tab swallows the first scroll event (found on a real
run), so a screen that did not move is pushed once more.

Why reading needs its own route: the snapshot is viewport-only by design. It drops every
line that is off screen and caps what is left at 6000 characters, and that same text rides
along with *every* decision request, so widening it would raise the price of every step.
The task tool therefore sees one screen; the reading tool walks the page.

**What a run leaves behind.** Every run writes into a temporary directory of its own: a
`trace.jsonl` holding the request body and the response of each decision call and each
text-model call, with the key scrubbed to `***` and anything past 20,000 characters
truncated; plus, when screenshots are on, one `frames/NNNNNN.jpg` per step and a
`frames.json` recording each frame's name and time. The result reports that directory, so
the raw exchange can be read back afterwards.

**Watching a run.** The host also serves an interactive inspector at
`http://127.0.0.1:3080/jev-ultrafast/inspector`. There you can start a run by hand, watch
the current screen, see which element each step is selecting and how sure the model is, and
pause, step or stop **before** the action is executed. A run that already happened can be
watched again: its frames play back at the pace they were taken, and each request's raw
JSON can be unfolded. The page is one whole HTML file emitted by the host rather than a
client bundle, so nothing has to be rebuilt to get it; only the page itself needs no token,
while every endpoint it calls takes the same token as the settings page.

### Or type the slash command (an address needs no model turn)

Type `/jev-ultrafast` in the composer and then say what you want:

- `/jev-ultrafast https://www.example.com find the price and say what it is` — runs once. The
  address may sit anywhere in the sentence, and a bare domain counts too
  (`/jev-ultrafast open example.com and find the price`). With an address in the line, nothing
  else is called before the run starts.
- `/jev-ultrafast 查一下明天北京的天气` — the same, only without an address. A site named in the
  sentence itself (百度, 必应, 谷歌, 知乎, 微博, 豆瓣, 淘宝/天猫, 京东, 小红书, 抖音, B站, 维基,
  GitHub) is read straight off, with no model call at all, and anything else starts at a search
  engine — a real place to begin, and one the running browser can leave on its own. The default is
  Bing (cn.bing.com) rather than Baidu: Baidu answers this plugin's own browser with a slider
  verification page, which no run can get past. No model is asked
  which site to open first: that question used to be asked here, it was the one step that kept being
  cut short before a run existed, and nothing about a run depends on it. After each step it waits
  for the page's text to actually arrive before looking again — up to 4 s, or 1.5 s when a step
  changes nothing — so a run is never reported finished on a page whose results have not been
  painted yet, and the answer quotes back what that page actually said.
- The command answers at once; the run continues in the background (watch or stop it in the
  session's jobs panel) and reports back when it ends. **If it is cut off halfway** — most often
  because DSH was restarted while it ran — the next use of the command says so first: which run
  never finished, that there is no result, and that re-sending the command starts it again. Only
  runs newer than your last successful one are mentioned, so the note neither vanishes nor nags.
- `/jev-ultrafast` on its own — prints this explanation and the inspector URL.

The command line and its result stay in the UI: they never become part of the conversation, and a
line with an address in it spends no model turn. The name must be lowercase ASCII (a DSH rule),
which is why it is `/jev-ultrafast` and not a Chinese name; the command name and the sentence
after it need a space between them, while the address may stand anywhere in that sentence.
Per-step pictures still follow the settings page's "a screenshot on every step" switch: with it
off, the run keeps only its raw exchange trace.

In a brand-new session the first one may leave the screen on the welcome page (as if nothing
happened) — send anything else and the command card is there.

The loop inside is four steps:

1. **Observe** — an in-page script reads the visible controls into an indexed table
   (role, name, current value, checked/selected state).
2. **Decide** — one TypeSafe request returns the operation (`CLICK`, `TYPE_TEXT`,
   `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`) together with a
   candidate target for every operation the page supports; only the target belonging
   to the chosen operation is executed.
3. **Type** — only when the operation is `TYPE_TEXT` does a small OpenAI-compatible
   model write the field value.
4. **Execute** — freshness, visibility, geometry and occlusion are re-checked
   immediately before the input, and the action is logged *before* its result is
   observed, so a navigation cannot erase it.

The model never emits selectors, coordinates or executable code: targets are indexes
into the observed table, minted by the plugin.

Three brakes bound a run: the action count reaches `maxSteps`; the decision calls
reach `2 × maxSteps`; or three consecutive steps leave the page unchanged. A run that
stops this way ends as `blocked`, not as a failure — it did not get there, it did not
crash.

The plugin opens its own connection to the browser and deliberately does **not** use
the `ctx.browserUse` provider slot: it needs to drive the page one step at a time at
its own pace, which is not what that slot's "hand the page to a provider" contract is
for.

**Not done yet:** the package is not on npm, so it installs from a local tarball or
directory; tool results currently use the generic card, and no custom rich card has
been written for it; multiple tabs are only handled as far as following a tab a click
opens (the run never switches to a tab you already had); file uploads and drag-and-drop,
as well as anything inside Shadow DOM, iframes or a canvas, have never been in the
action space, upstream or here.

Two limits of the evidence are worth knowing. The task tool hands back at most 6000
characters of the final page, and it looks for a success marker on that final screen
only — a marker parked further down a very long page is not found there, which is why a
failed check means "not confirmed" rather than "not true". The reading tool is how you
look further.

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-jev-ultrafast-0.1.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-jev-ultrafast'
```

**The desktop app takes a different route.** Its profile belongs to the application
and the command line refuses it outright (`profile "desktop" is managed exclusively
by the Electron application`). In the app, open **插件 → 添加插件**, paste the
tarball's **absolute path** (for example `C:\Users\you\dsh-jev-ultrafast-0.1.0.tgz`),
then press 立即启用, and **restart the app once**.

That restart is not the plugin being fussy; the reason sits outside it. The desktop
boot payload — the list of injections the page starts from — is sent once per
application start, and enabling a plugin happens after that. Without the restart the
plugin's settings page cannot see its own token and reports one line of Chinese
saying so, while the tool itself works fine. The web app has no such step: it renders
its index per request.

Two things have to be in place before a run.

First, a browser the plugin can reach. The shortest route is to pick one on the plugin's
own page: **Settings → Jev 浏览器**, choose Chrome or Edge in the browser block's dropdown,
then press 「启动并连接」. The plugin starts that browser's own executable with a
**profile directory of its own** (separate from the one you browse in — log in once inside
it and it keeps that state), lets the browser pick a free port, and leaves the address in
that profile directory, so no port number has to be typed and a restarted DSH finds it
again. Chrome and Edge have refused a debugging port on the default profile since version
136, which is why "the plugin starts a clean one" is also the only one-press form.
**That press is not required, though**: when no browser is reachable at all, a task starts
the chosen one itself and connects to it, and says so in its result. The button keeps its
other use — a site that needs a login gets that login once, by hand, inside that window.

You can also start a dedicated instance yourself and leave the button alone:

```sh
# Chrome
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/jev-profile --no-first-run
# Edge
msedge --remote-debugging-port=9222 --user-data-dir=/tmp/jev-profile --no-first-run
```

On Windows, spell the path out:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 --user-data-dir="C:\Users\<you>\jev-profile" `
  --no-first-run --no-default-browser-check
```

With `cdpUrl` left empty, the plugin looks in this order: the configured
address → the `BU_CDP_URL` / `BU_CDP_WS` environment variables → the port file the
browser itself wrote (including the two profile directories the plugin started) → the two
conventional ports 9222 and 9223. If none of them answers, it fails with a Chinese message
saying how to start a browser and mentioning that button. If yours is already listening
elsewhere, set `cdpUrl`. **With both browsers running, a task drives the one you chose in
the dropdown** — it sorts ahead of the other, instead of whichever started first winning.

Second, the two keys. The shortest route is to type them into the plugin's own page in
DSH's settings (the next section), which writes them into DSH's credential file; they can
also be stored as credentials (the decision key defaults to `TYPESAFE_API_KEY`, the text
model to the default name of whichever route is chosen) or exported in the environment
that starts DSH. A missing one produces a Chinese
error naming which key is absent. Keys are never written into configuration —
configuration holds the **variable names**.

## Configuration

Every key can be set from cordis.yml or from the plugin's own page in DSH's settings
(the next section). The names are flat — there is no nesting.

| Key | Type | Default | Description |
|---|---|---|---|
| `browserKind` | `chrome` \| `edge` | `chrome` | Which browser 「启动并连接」 starts, and which one a task starts by itself when nothing is reachable. It gets a profile directory of its own, so this only chooses which one. |
| `browserPath` | string | empty | Where that browser's executable lives. Only needed when it is installed outside the usual places (a portable copy, say). |
| `cdpUrl` | string | empty | The browser's debugging endpoint, for example `http://127.0.0.1:9222`. Empty means discover one. |
| `userDataDir` | string | empty | The browser's user-data directory. Only needed when the browser was started with a non-default `--user-data-dir`. |
| `decisionProvider` | `typesafe` \| `openrouter` | `typesafe` | Which door the decision service is reached through: TypeSafe's own endpoint, or OpenRouter's alpha route. See "Two routes" below. |
| `decisionEndpoint` | string | empty | Full address of the decision service. Empty uses the chosen provider's own; fill it in only for a resale route. |
| `decisionModel` | string | empty | Decision model name. Empty uses the chosen provider's own. |
| `decisionKeyRef` | string | empty | The decision key's **credential name** (an environment-variable name), not the key itself. Empty uses the chosen provider's own. |
| `textProvider` | string | `deepseek` | Which route the text model takes: a preset name (`deepseek`, `openrouter`, `bailian`, `zhipu`, `moonshot`, `siliconflow`, `openai`), or `dsh:<provider id>` (a model already configured in DSH). See "Which route the text model takes" below. |
| `textBaseUrl` | string | empty | OpenAI-compatible base URL of the text model. Empty uses the chosen route's own. |
| `textModel` | string | empty | Text model name. Empty uses the chosen route's own default model; the `dsh:` route has no default, so one has to be chosen. |
| `textKeyRef` | string | empty | The text model key's credential name. Empty uses the chosen route's own name; on the `dsh:` route DSH keeps the key itself. |
| `textReasoning` | `none` \| `auto` | `none` | `none` keeps the text model from thinking (typing a field is transcription, not reasoning); `auto` uses each vendor's default. On a DSH built-in route this setting is not sent: DSH and the model behind it decide, because models accept different values and dictating one can fail the whole call. |
| `maxSteps` | number | `60` | How many steps one task may take. The decision-call budget is twice this. |
| `screenshots` | boolean | `false` | Screenshot every step. Noticeably slower; usually left off. |

Configuration is validated by the Schemastery `Config` schema in `src/config.ts`, so an
invalid value fails at load time instead of running broken.

Both `keyRef` fields hold a credential *name* and carry the `credential-ref` role. Every
field is `volatile`, which is what lets the settings page save and take effect
immediately: a value changed while DSH is running is picked up by the next task, with no
restart. The *value* behind a name goes in the 密钥 row of the page's own block, which
writes DSH's own credential file — equally immediate.

### How much the small questions may write

The text model is asked three short things — the value of a field, which site a sentence is about,
and the settings page's own connection probe. Each of those requests carries one number: the most
the model may write back. It is not a target (a model stops when it is done), so it can only stop a
runaway or cut a real answer off. On a route where the model thinks first, the thinking and the
answer share that one budget, which is how "it said nothing" happens on a route whose reasoning
`HELPER_MAX_TOKENS` (393216) is therefore set well above anything one short answer could need, and
all three questions share it. The decision loop's own per-step calls carry no such cap.

Some routes refuse a number above their own model's maximum output before reading a word. That
refusal is not an answer about the question, so `askText` reads the limit the refusal names and asks
again with it — and when the sentence names no limit, with 8192. Only a refusal that mentions max
tokens is retried; every other error is passed on as it is.

### Which route the text model takes

The text model is used only for "typing into an input field", and it too picks a route of
its own. There are two kinds:

| Kind | What it is | Address and key |
|---|---|---|
| Preset (`deepseek`, `openrouter`, `bailian`, `zhipu`, `moonshot`, `siliconflow`, `openai`) | a table the plugin ships with | the address, the default model and the default credential name all come from that table; the key's value goes into DSH's credential file from the settings page's paste box |
| DSH built-in (`dsh:<provider id>`, for example `dsh:deepseek-official`) | a model already configured in DSH | the address and the key are both kept by DSH; the settings page picks a model only and draws no paste box |

Whichever route is chosen governs, and the other three fields follow it when left empty —
the same arrangement as the decision service below. The `dsh:` prefix is not decoration:
DSH may well have a provider named `deepseek` too, and with the prefix "the plugin's preset
deepseek" and "DSH's deepseek" are two options standing side by side, without either
displacing the other; and a value already saved will not be treated as the other one just
because DSH later registers a provider under the same name.

The presets take in only the OpenAI-protocol vendors because the text half needs nothing
more than "give one sentence, get one piece of JSON". Other protocols such as Anthropic or
Gemini work just as well through the DSH built-in route, with no gap in capability.

**Transient trouble is retried; a broken connection is not.** A text-model call that comes
back 429, 503 or 529 is retried up to twice, waiting 0.5 s and then 1 s. A network drop is
not retried at all and is reported as it stands — the same line the upstream Python version
draws.

**One trade-off**: the preset DeepSeek route's default credential name is written
`DEEPSEEK_API_KEY` by the vendor's convention, and DSH itself uses that name too — so that
route comes out of the box already "configured". To give it a key of its own, fill the
"key name" on the settings page's "advanced settings" with something else.

### Two routes to the decision service

The two doors differ in exactly three values — the address, the model name, and which
credential name holds the key. Because they belong together, the configuration names only
the door and lets the other three follow it; the page shows what an empty field will use as
its grey placeholder, so switching providers needs no copying and leaves nothing behind.

| Provider | Address | Model | Credential name |
|---|---|---|---|
| TypeSafe, direct | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` | `OPENROUTER_API_KEY` |

The leading tilde in OpenRouter's model name is not a typo: it is how that route spells the
same model, and dropping it asks for a model that does not exist. That route has also been
seen to want the request body wrapped in a `decisionsRequest` envelope, so on that door the
plugin sends the flat body first and retries once wrapped only when the body is refused with
400 or 422 — a refusal about shape rather than content. TypeSafe's own endpoint never wraps.
Neither door has been exercised against a live service from this machine, which has no key
for either.

**Where a key comes from.** The fields above hold names, not keys; DSH resolves the name,
in a fixed order: the process environment as inherited at startup, then the `refs:` section
of its own credential file `~/.dsh/.credentials.yaml`, then a `.env` in the working
directory, then `~/.dsh/.env`. The name is the variable name, with no prefix.

The shortest route is the plugin's own page (the 密钥 row in each block): it writes that
credential file for you, takes effect immediately, and needs no knowledge of where the file
is. The other two routes still work — set a same-named environment variable in the same
terminal before starting `dsh web`, or add one line under `refs:` in `.credentials.yaml`,
which DSH reloads by itself. A `.env` works too, but it may not define any name beginning
with `DSH_`, which makes DSH refuse to start.

One layer the page cannot change: **the environment inherited at startup wins, and is read
once, at that moment.** When a name's value comes from there, the page marks that row
「这一页改不了它」 and offers no input at all, saying why. That refusal is deliberate: a write
that appeared to succeed while resolution kept returning the old environment value would be
worse than an honest "this one is out of my reach".

## The plugin's page in DSH settings

Open **Settings → Jev 浏览器**. The page is four blocks — **浏览器**, **决策服务**,
**文本模型**, **任务** — and each one is laid out the same way: a line saying how that part
stands right now, then the controls that change it. Those state lines come from a real
round trip rather than a guess: "connected" means a debugging endpoint answered *and* a
snapshot came back from an actual tab, and "missing a key" sits directly above the box that
fixes it. The page never sends you to another part of the page to fix what it just reported.

The browser block carries one more thing: a 「用哪个浏览器」 dropdown (Chrome / Edge) and a
「启动并连接」 button. Press it and the plugin starts that browser and connects, writing the
result straight into this page. It saves the block first — that block only, so nothing
half-typed in another block is committed by it. When the executable cannot be found it lists
where it looked; open 高级设置 and fill in **浏览器程序** for a portable copy kept elsewhere. Below those sits one
more button, 「打开交互式检查器」, which takes you straight to the page described above; it builds
the address from wherever you are reading this, so it is right on any port.

Two things it can do that the tool itself cannot report. It says whether each credential
name resolves — never what the value is. And 测一次决策服务 sends one real decision
question, which is the only way to prove that the address, the model name and the key all
work together; that one spends a call, so it runs only when you press it.

Configuration is edited in the same blocks. Saves go through DSH's own config service, so
the validation and the "someone else just changed this" check are the harness's, not ours;
the change lands in the profile's patch layer as an id-targeted override. The 决策服务 and
文本模型 blocks each carry their own 保存: pressing one writes that block's own fields, the
overrides it keeps in 高级设置 included, and leaves the other block's unsaved edits alone.
The button at the bottom is called 保存全部改动 and writes every change on the page at once.
Either way the configuration goes first and the pasted keys after. That order is not
cosmetic: a credential name you have just typed into a field becomes storable only once the
configuration naming it is saved, so one press can switch a name *and* give it a value.

The provider is a dropdown, and the model box right under it may stay empty: the grey
placeholder then shows what that door will use, so switching providers needs no copying and
leaves nothing behind. The model is worth seeing next to its provider, which is why it sits in
the block; the address and the credential name are the overrides you touch once, and they wait
behind the 高级设置 disclosure at the bottom.

The 文本模型 block looks the same, with its dropdown split into two labelled groups:
「DSH 内置（由 DSH 管理地址和密钥）」 lists the models already configured in DSH, and
「插件预设（本插件直连）」 lists the presets the plugin brings; the option texts are the
suppliers' own names, with no prefix. One more grey line under the dropdown describes the
chosen supplier — where its address comes from, where to apply for its key; picking DSH
built-in draws no such line, because the key row below already says DSH owns both. With the
model left empty the route's own
default is used, and the candidate list in that box can be opened to pick one or typed
over. Picking a preset brings its address, model and credential name along with it, and the
paste box is drawn underneath as usual; picking DSH built-in replaces that key row with a
line saying DSH keeps it itself and draws no paste box — that route's address and key both
live in DSH, out of this page's reach.

The candidates in the 模型 box are no longer only the handful of names this plugin writes down:
the page asks the chosen supplier which models it serves right now, using that route's own address
and the key this plugin holds, and the answer becomes the candidate list with its count written
underneath. A read that fails says why on that line — a refused key, an unreachable address, a
supplier that did not answer — and the built-in names come back as the candidates. The request
changes nothing, the key is used on the host side and never reaches the page, and 获取模型列表 in
that block's action row asks again. A DSH built-in route is not asked: DSH already answers that
roster, and the address and key behind it are DSH's business.

That block's action row carries two more buttons. 测试连接 sends one real, minimal request — the
same one-key JSON a field asks for — through the route the boxes currently name, which is the only
way to know its address, model and key work together: a success adds a 刚测过 · 正常 line to the
block, and a failure shows the sentence it got instead, so a refused key, a model that will not
answer in JSON and an exhausted budget each read differently. It spends one call, so it happens on
a press and never on its own, and it tests what the boxes hold rather than what is saved — but the
**key** comes from the credential store, so a freshly pasted key needs 保存 first. 获取模型列表
changes nothing: it only asks that supplier what it serves. On a DSH built-in route the same button
is still there and needs no network: it reports the roster DSH already gave. Pressing it is a real re-read — on a DSH route the host asks DSH again for what that route serves now,
on a preset it asks the supplier. A DSH route answers locally in tens of milliseconds, so the button
keeps saying 正在获取… for at least 1.2 s (a slower answer is simply awaited) — a state nobody can read
is no feedback, and the eye is on the pointer when it clicks. When it succeeds it says nothing else, because the list is the answer. Only a failure keeps a line, with the reason. The 模型 box itself is a
real pick list whenever the list is complete — its supplier's own answer, or DSH's roster — so one
click shows every choice; it stays a text box only when the list is short and unverified, where
typing a name nobody listed is what matters. How many models came back is not a line of its own: it
is said only when the list could not be read at all.

Every service that needs a key has a 密钥 row under it. Its first line reports the state of
that name — "no value yet", "configured, from DSH's credential file", or "out of reach from
this page" — and the paste box follows it. Paste a value, press 保存 and it is written into
DSH's credential file, used by the next task with no restart; 清除 removes the entry from
that file. Afterwards the page shows only "configured" and where the value comes from —
DSH's credential interface answers whether a name is set, which layer won and whether it is
writable, and never hands the value to any page, so this page cannot show it even if it
wanted to. When the value comes from the launching environment there is no box at all, and
the line says so.

The page no longer spells out where the key file lives or what it does not protect against.
The path shows up where it matters: when a name is shadowed by the launching environment,
that row names the file and offers the two ways out. The rest belongs here rather than on
the page: the file is open to your own user account only, and DSH does not hand its path to
the model — but an AI's tool processes run as the same user, so they can read it. DSH's own
documentation puts it more gently than we do: it is discretion, not a boundary. Guarding
against a local AI needs the operating system's keychain, which does not exist yet.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test          # 168 unit tests across 15 files, no key and no network needed
pnpm run build
```

The browser layer has 14 integration tests of its own, skipped by default and run only
against a real browser:

```sh
JEV_BROWSER=1 pnpm exec vitest run tests/browser.integration.test.ts
```

On Windows that is `$env:JEV_BROWSER='1'; pnpm exec vitest run
tests/browser.integration.test.ts`. It connects to port 9222 by
default, or to whatever `JEV_CDP_URL` names.

You can also mount it without packaging: `dsh web --patch ./scratch/cordis.yml`, which
already points at this repository's built `lib/index.mjs`.

What has been verified so far: 168 unit tests pass, across 15 files; the 14 browser
integration tests pass, run here against Edge (the earlier 11 ran here against Chrome
153.0.8010.53 and Edge 154.0.4258.37, all green both times); and a
`pnpm pack` tarball installs and loads in a clean throwaway profile. The page's key section
was exercised against a throwaway instance in sixteen checks: store, the row flipping to
"comes from the credential file", the value still configured after a process restart, and
清除 returning the name to unconfigured; a name shadowed by the launch environment refuses
the write and says why; a name outside the page's list (403), an empty value, and a request
without the token are each refused; and across eight response bodies the value never
appeared once. The regrouped page was then walked through on a throwaway instance with the
packed tarball installed: one 保存 changes configuration and stores a key at the same time,
and both take effect immediately; a credential name typed into the form is allowed to store
a value in that same save; 清除 removes the entry from the file; and a name supplied by the
environment shows its state with no input box. Then 0.2.0-rc.1 and the desktop app were
each walked through too: the plugin clears the 0.2.0-rc.1 compatibility gate on the
strength of that `>=0.1.7-rc.2 <0.3.0-0` declaration (no `disabling profile plugin`
line in `--dump-config`); its index injections are still rebuilt per request there, so
the token the page receives is the one the tool's route accepts, and a request without
it is still refused with 403; the desktop install went through the app's own 添加插件
with the tarball's absolute path, and after an application restart the boot payload
contains `global/__JEV_ULTRAFAST_TOKEN__` and the page reports live state with no token
error; and editing 调试端口 on the desktop and saving writes that row into the profile's
patch layer, clearing it writes the cleared value, and the page stays usable across both
saves — which is what it looks like when a configuration field really is one that needs
no reload. A `dsh-plugin-dev check` passed at the time,
but that CLI ships with the plugin-development skill and is not on this machine's PATH
anymore, so that item was not re-run. 0.2.8 moved the model back into its own block, and that change
was checked in an instance with the real package installed: the decision model sits under its
supplier with a placeholder that follows it (TypeSafe shows `jev-latest`, OpenRouter
`~typesafe/jev-latest`), 高级设置 is left holding six items, and the note line under each
supplier read correctly in both states — OpenRouter's names its alpha channel and the tilde —
while picking DSH built-in no longer repeats what the hint above and the key row below already
say. The same version settled the wording of the 现在 line in the decision block: it now reports
the saved route, model **and credential name** together — the key box below keeps following the
draft, because a value has to be pasted before it can be saved, and a sentence mixing the saved
route with a draft key name described a state that never existed (seen live: with the supplier
switched but unsaved, the line still read `TypeSafe 官方直连 · jev-latest · 密钥 TYPESAFE_API_KEY
还没有值。` while the key row had already become `OPENROUTER_API_KEY`). 0.2.9 gave the two
service blocks their own save buttons and was checked the same way: with one unsaved edit
typed into each block, pressing the decision block's own 保存 stored that block's change
alone — the patch layer gained `decisionModel` and no `textModel` — while the text block
still reported one unsaved change and kept the value in its box. 0.2.12's 「启动并连接」 was
run for real against the same tarball-installed instance, twice: the dropdown opened on the
**Edge** stored the time before (so the choice survives a process restart); one press started
and connected **Chrome** (port 60856 — a random port, because the browser picks it rather
than 9222 being hard-coded); switching to Edge and pressing again connected **Edge**
(`Edg/154.0.4258.37`, port 60376) *while Chrome was still running*. That second round is
where the ordering fix shows: in the first implementation the state line still pointed at
Chrome, because discovery had not put the chosen browser first. Screenshot:
`scratch/review-0212-browser-block.png`; probe: `scratch/probe-0212c.js`. **No real decision
call has been made with a real key** — this machine has neither. The stage plan and its acceptance
criteria live in [`tasks/todo.md`](tasks/todo.md).

**0.2.13 is the first end-to-end run** (2026-09-29, asked for as 「用插件搜 DeepSeek DSH 桌面版的
下载页」). The browser half works: the tool really opened Bing and read back the page text and 20
actionable elements. The decision half stopped at **HTTP 401**, and the cause was not in the
plugin: the machine's two decision credentials (`OPENROUTER_API_KEY` and `TYPESAFE_API_KEY`) are
**the same 35-character value** (pasted into both fields), and neither service accepts it — sent
to OpenRouter it answers "Missing Authentication header" (it does not even recognize the shape;
a well-formed bogus key gets "User not found.", so it is genuinely reading the key), and sent to
TypeSafe's own endpoint it answers "Cannot authenticate with the server". Two facts came out of
the same investigation: `openrouter.ai`'s public endpoint answers 200 without a key (so the
network path is fine) and OpenRouter's alpha channel **does** take a bearer key (so the plugin's
OpenRouter door is viable — it just needs a real key). The run also exposed a real defect in the
plugin, fixed in this version: a refusal said only "HTTP 401", which cannot tell "this key is not
recognized" from "this request is not to the endpoint's taste". The service's own words now ride
along on one line, cut at 240 characters, with the key itself scrubbed to `***` first — pinned by
a unit test. Installed into the daily web profile, both artifacts byte-identical to the repo,
`--dump-config` exit 0.

**0.2.14 follows the tab a click opens** (the same day, later). The 0.2.13 run left a
revealing scene: three Bing result tabs really were open, while the run reported "the
page did not change for 3 steps" — every click had worked, the site had opened each
result in a new tab, and the run was watching only the tab it had attached to. Two
things changed. First, a step that leaves this tab on the same address while bringing a
new page into being now moves the run onto that page and says so, so the next decision
sees what the click did; a step where this tab's address *did* move stays put, and the
step line reports the new window instead of pretending nothing happened. The address is
the test rather than the whole page, because a search result turning "visited" redraws
the page it sits on — under the fingerprint rule this plugin first used, the live run
refused to follow on Bing for exactly that reason. Second, a run now closes only the tab
it created: the page it moved onto stays open, so what the task went looking for is still
there when it finishes. Seven new tests (three in the loop, two for the one line the user
reads, one real-browser integration test that clicks a `target="_blank"` link and asserts
the second page was read), plus one live run against the real decision service — Bing →
冯时 → the 百度百科 article: one step, followed, final page the article itself, where the
same goal took four steps and ended on Baike's own search page before the fix. Installed
into the daily web profile, both artifacts byte-identical to the repo, `--dump-config`
exit 0.

**0.2.15 has a task start the browser itself** (same day, later). The question was whether
the main model, calling this plugin from the conversation page, could start and connect
rather than sending the reader to the settings page first. It can: starting a browser is
entirely mechanical here (find the executable, hand it a profile directory, let it pick a
port, wait for the port to answer), and 0.2.12's button runs that same code. "A model has
no hands" meant a model cannot start a process by itself — a tool call is the plugin's own
hand, which is why the boundary moves rather than breaks. So a run now looks for a browser
first, and when nothing is reachable *and* nothing was pinned it starts the browser the
settings page names — same executable lookup, same profile directory, same port-file trick
— and says so in its result. Two edges are kept deliberately. A pinned `cdpUrl` or
`userDataDir` is an instruction rather than a hint: when one of those is set and dead, the
run reports that instead of starting a different browser, because starting a browser nobody
asked for is a worse answer than saying the address does not answer. And the model never
names an executable or a port: the executable comes from the settings, the port from the
browser itself. Verified: 7 new unit tests (`ensureBrowser` pinning when a browser is
started, which one, and when nothing is; `launchNote` pinning the one line the user reads),
126 passing in all; two live runs — one with the plugin's profile directory pointed at a
throwaway directory so that nothing was reachable, which really started Edge
(`Edg/154.0.4258.37`) and connected to it, after which that instance was asked to quit so
no window stayed behind; and one with a browser already running, which started nothing at
all. Installed into the daily web profile, both artifacts byte-identical, `--dump-config`
exit 0.

**Known limits, told plainly**: the desktop profile is still on 0.2.1 and the daily `dsh web`
on 3080 still runs the old artifacts until it is restarted, so updating the desktop app means
installing the tarball there again. The inspector page itself only picks up a new build after
one restart of `dsh web`, and its own click surface has not been clicked through in a real
browser yet — what a real browser has checked is the *semantics* of pause / step / stop (a
pause really does hold the click back, releasing really does click, stopping for good really
does not click). "Recording" means the frames replayed at the pace they were taken; no video
file is produced. The trace lands in the system temporary directory, contains page text, and
nothing cleans it up automatically.

## License

MIT. Portions are derived from jev-ultrafast (MIT, © 2026 Browser Use). The derived
files and their provenance are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the upstream notice is reproduced in
[LICENSE](LICENSE).
