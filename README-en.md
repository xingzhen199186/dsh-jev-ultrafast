# dsh-jev-ultrafast

[中文](README.md) | English | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> Give DeepSeek Harness one goal in plain words. The plugin drives a real browser and finishes the job. A decision service picks the operation and the element for every step, so the work does not use the main model's conversation turns.

## What this is

It adds one capability to DeepSeek Harness (DSH): **drive a browser with one natural-language goal**.

The usual way is this. The model looks at the page. It thinks one step. It clicks. Every click uses one conversation turn. Here the work is split differently. The page first becomes an **element table**: a numbered table of controls. One request decides the operation and the element together. The main model only states the goal at the start and reads the result at the end. So a multi-step task costs one tool call.

It is a plugin (a bundle), not a skill. It registers two tools and one slash command:

| Entry point | What it does |
|---|---|
| Tool `jev_browser_task` | Finish one natural-language goal. It accepts an optional `expect` check. It returns the result and the text of the final page |
| Tool `jev_browser_read` | Read a long page screen by screen, de-duplicate the text and stitch it back together. This route spends no decision request |
| Command `/jev-ultrafast` | Say what to do in the prompt box. The main model does not have to take part |

One real run, measured on this machine:

```text
Goal:    search for the series "Dark Matter" and tell me about it
Result:  done · 2 steps · 5 decisions · 14.6 s
Ended at: Dark Matter Season 1 - Search — https://cn.bing.com/search?q=dark+matter+season+1
Page text (excerpt): about 12,300 results; season 1 episodes (S1 E5–E9); Douban 8.5/10
(21k ratings); plot and creators…
```

## Where it comes from

**This is a port, not an original work.** The upstream project is [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use). Upstream is Python, about 690 lines. This project rewrites it in TypeScript and packages it as a DSH plugin. This project's own repository is [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast).

**It is not official.** This project has no affiliation, endorsement or sponsorship from Browser Use or TypeSafe. "Browser Use", "TypeSafe" and "Jev" are trademarks of their respective owners. They appear here only to state the origin and to name the interface this plugin calls.

Every ported piece is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The main ones:

| Upstream file | File in this project | What was ported |
|---|---|---|
| `jev_ultrafast/snapshot.js` | `src/browser/snapshot.js` | The snapshot script that runs inside the page, almost unchanged |
| `jev_ultrafast/questions.py` | `src/prompts.ts` | The prompts for decisions, almost unchanged |
| `jev_ultrafast/model.py` | `src/decision/*` | The element table, one request that decides operation and target, answer validation |
| `jev_ultrafast/agent.py` | `src/loop.ts` | The main loop, the handling of stale decisions, the text-value cache |
| `jev_ultrafast/browser.py` | `src/browser/*` | The freshness guard, the visibility and geometry checks before an action |

Upstream depends on `browser-harness`. That library manages the browser connection, the daemon and the permission boxes. TypeScript has no equivalent. This project rewrote that part against the Chrome DevTools Protocol, and it uses **zero dependencies**.

Two more sources appear in the repository by name only, with no verifiable link. They are stated plainly here:

- **browser-use**: another browser-agent project. This project borrowed three things: redaction of login callback parameters in traces (18 parameters become `REDACTED`), re-observation when an index misses (the run stops only after more than 2 in a row), and honest reporting when the content sits inside a frame.
- **dsh-advisor-group**: another DSH plugin by the same author. The text-provider table and the small slice that calls the DSH model service came from it (2026-09-29).

## What you need first

1. **Node.js**: `^22.19.0 || >=24.0.0`. Check it with `node --version`.
2. **DSH**: the `0.2.0-rc.1` generation. The plugin's dependency range covers `0.1.7-rc.2` up to, but not including, `0.3.0`.
3. **A browser**: Edge or Chrome.
4. **Two keys**, for the routes you pick: one for the decision service and one for the text model. The plugin ships no key. It reads yours from the DSH credential store at call time.

## Install

It is one plugin, and one command. Replace `<profile>` with your own profile name (for example `web`):

```sh
dsh plugin --profile <profile> add github:xingzhen199186/dsh-jev-ultrafast
```

**Do not append `#v0.1.0`.** This project keeps its version number at 0.1.0 and does not change it with the content. That tag stops at 2026-10-01. Attach it and you install old code, more than a hundred commits behind. To pin one exact snapshot, put a commit hash after the `#` instead.

pnpm does not run a source package's build script by default. The first attempt fails. Take the package key it prints, allow it in that profile's `pnpm-workspace.yaml`, and install again.

```yaml
allowBuilds:
  dsh-jev-ultrafast: true
```

Offline, use a tarball packed on this machine. Run `pnpm pack` first, then:

```sh
dsh plugin --profile <profile> add ./dsh-jev-ultrafast-0.1.0.tgz
```

That command line works only for profiles the command line manages. The desktop application manages its own `desktop` profile, and the command line refuses it: `profile "desktop" is managed exclusively by the Electron application`. On the desktop side, click **插件 → 添加插件** (Plugins → Add plugin) and paste the same address (or the tarball's absolute path), then **restart the application once** after you enable it.

That restart is not optional. The desktop boot payload is sent once, at application start. Without a restart, the plugin's settings page cannot get its own token. The tools themselves work.

## How to use

### Tool `jev_browser_task`

Give it one goal in plain words, and it finishes the job. You can also give `expect`. Write `expect` as "what must appear on the page when the task succeeds". If the check does not match, the run reports `blocked`. It does not trust the model's own verdict.

Example: `goal` = "find the lowest price for this flight and tell me what it is", `url` = the address of the search page, `expect` = `["¥"]`.

### Tool `jev_browser_read`

Give it one address. It reads screen by screen, de-duplicates the text and returns one document. This route spends no decision request. Use it for long articles, documents and specifications.

A page taller than one screen is no problem. It scrolls again for every screen and joins the parts into one text.

### Command `/jev-ultrafast`

Type what to do in the prompt box.

- `/jev-ultrafast https://www.example.com find the price and tell me what it is` — the sentence carries an address. No model is called before the run.
- `/jev-ultrafast what is the weather in Beijing tomorrow` — no address. If the sentence names a site, the plugin recognises it locally. It knows 13 sites: Baidu, Bing, Google, Zhihu, Weibo, Douban, Taobao and Tmall, JD, Xiaohongshu, Douyin, Bilibili, Wikipedia and GitHub. If it cannot recognise one, it asks the text model once. If that fails, the run starts from a search engine, and the default is Bing.
- `/jev-ultrafast` (no arguments) — returns a short explanation and the address of the interactive inspector.

The command returns at once. DSH's background job runs the task. The **任务** (Tasks) panel in the session header shows the progress and can stop it. The result comes back when the run ends.

The command name can use ASCII only, so it is `/jev-ultrafast`.

### Interactive inspector

Open `http://127.0.0.1:3080/jev-ultrafast/inspector` in a browser. Another port or host also works. You can open it from the settings page too, with the **打开交互式检查器** (Open the interactive inspector) button in the **Browser** block.

There you can start a run by hand, watch the current screen, see which element each step picked, and see how confident the model was. Before an action runs, you can pause, single-step or stop it. You can also review earlier runs and replay them frame by frame at the real pace.

## Configuration

The settings page is **设置 → Jev 浏览器** (Settings → Jev browser). It has **22 fields**. All of them belong to the "no restart needed" class: a save applies at once and does not interrupt a running task.

### The two doors

| Door | Two routes | Key |
|---|---|---|
| Decision service | TypeSafe direct; or the decision channel of OpenRouter | Read from the DSH credential store. The plugin stores nothing of its own |
| Text model | Seven preset providers; or `dsh:<provider id>` (a model already configured in DSH) | The preset route uses its own key; the DSH built-in route is managed by DSH |

The seven presets are DeepSeek official, OpenRouter, Alibaba Cloud Bailian, Zhipu AI, Moonshot Kimi, SiliconFlow and OpenAI.

On the OpenRouter route the model name carries a tilde: `~typesafe/jev-latest`. **This is not a typo.** Remove the tilde and the request is routed to a model that does not exist.

Both provider dropdowns group their entries by origin. When you pick a DSH built-in route, the key row becomes one sentence, "managed by DSH", and no paste box appears.

On a DSH built-in route the plugin sends the identity of the current session (`GenerateOptions.sessionId`). A route that routes by session needs it. Without it, the route refuses the call.

### Browser: the two connection modes

**The browser you are using** (the default). It uses your current logins. The first time, do this:

1. Open `edge://inspect/#remote-debugging` in that browser's address bar (`chrome://inspect/#remote-debugging` for Chrome).
2. Tick **Allow remote debugging**.
3. When the **Allow remote debugging?** box appears, click **Allow**. You can also hold the connection first, with the **连接你的浏览器** (Connect your browser) button on the settings page.

After you tick it once, the browser works open or closed. When it is closed, the plugin opens it for you — with no arguments at all, the same as a double-click on the icon (since 2026-10-03 the red line "never start your daily profile" was removed by the user's ruling). The browser brings its own debugging port with it.

**One allow per browser session.** After it connects, the plugin holds that one connection. Runs, page reads and new tabs do not ask again. Only closing the whole browser and opening it again makes a new session, and that session asks once more.

**The plugin's own browser.** It uses its own data directory, separate from your daily one. For a site that needs a login, log in once in that window, and the login stays.

With **the browser you are using** chosen, that block offers two more actions:

- **See how many logins can be carried over**: it only counts the cookies in your daily browser and the domains they cover. It disconnects at once and writes nothing.
- **Copy the logins into the plugin's own browser**: it writes the cookies in and checks the result site by site. It reads and writes through the debugging channel and never touches the profile files.

### The other switches

The common settings are visible. The rare ones sit under **高级设置** (Advanced settings): the browser program path, the data directory, and the addresses and key names of the two doors.

A few switches are worth knowing:

- **Recognise custom buttons** (on by default): ordinary elements with a click handler attached by script also become candidates. Many sites build their buttons from `div` or `span`. Turn this off to accept native controls only.
- **Handling when an overlay covers the target** (on by default): when an overlay covers the target and the click cannot land, the plugin adds the covering element and "close the overlay with Esc" to the candidates. The model can then close that layer itself.
- **Which new page to follow** (on by default): when one click opens several new pages, the run follows only the page whose address or title matches this step's goal. If none matches, it stays on the current page.
- **Control layer** (off by default): another model writes a checkable checklist at the start and verifies it during the run. The run may not report success while a marker is false. It uses the model from the **Text model** block.

The output cap of one decision is `393216` by default. When the server rejects it, the plugin reads that server's own limit from the reply and asks again with that number.

## Behaviour boundaries

- **It closes only the tabs it opened.** After it follows a tab that a click opened, that page stays for you to look at. At the end it closes only the tab it opened itself.
- **It does not take over your tabs.** It never switches to a tab you already had.
- **It never closes, and never writes directly into, the profile of your daily browser, and it never passes debugging arguments to it.** The login-copy chain only reads from your daily browser.
- **It does not click permission boxes for you, and it does not log in for you.** You click the **Allow remote debugging?** box.
- **It ships, proxies and resells no API access.** Bring your own key. A key never enters a configuration file or a session record.
- **Every step leaves a record.** Each run writes a `trace.jsonl` in a temp directory. It holds every decision request and response. Keys become `***`. Login callback parameters such as `code` and `token` in addresses become `REDACTED`. The result gives you the path of that directory.

## Known limits

- **The final page handed back to the tool is at most 6000 characters**, and `expect` is looked for in the **last screen** only. So "not confirmed" means it was not confirmed there; it does not mean the task failed. Use `jev_browser_read` to see further.
- **A detour costs steps.** Example: asked for the animation ranking on Bilibili, the run may click the search box first and then enter a search result page. When the target entry is not on the page, it has no other way.
- **A covered button is retried up to the limit.** When a button is covered by an overlay and the overlay cannot be closed, the run tries 7 times, stops, and names what covered the button.
- **A two-page ping-pong is braked.** After 9 landings that alternate between two pages, the run stops. A task that truly needs more than 4 rounds between two pages is stopped as well, and the closing line names the two pages.
- **It does not enter elements inside iframes, Shadow DOM or a canvas.** It states plainly that the content inside is not visible. If the inner page has an address, it gives that address.
- **No file upload and no drag-and-drop.**
- **A page that only swaps images takes the "no change" branch.** The plugin judges the arrival of content from page text, not from the network.
- **With "the browser you are using" chosen, you cannot use that browser while a run works.** While its debugging switch is on, other programs on this machine could in principle connect to it too.
- **Traces live in the system temp directory and hold page text. Nothing cleans them up automatically.**
- **All five READMEs were aligned in structure and content on 2026-10-05.**
- **The version number is 0.1.0, and it is not changed without the author's word.** The plugin is not published to npm. The code is on GitHub.

## Development and verification

```sh
pnpm install
pnpm typecheck   # type check
pnpm test        # unit tests
pnpm build       # build lib/
pnpm pack        # pack the tgz
```

The real-browser integration tests are skipped by default. To run them, set one environment variable:

```sh
JEV_BROWSER=1 pnpm test
```

The current suite: **44 test files** and **724 cases**. Of these, **704 pass and 20 are skipped**. The 20 skipped cases need a real browser.

The evidence lives in two places:

- **Run traces**: every run writes `trace.jsonl`. It holds every decision request and response, and every text-model call.
- **Engineering notes** [ENGINEERING.md](ENGINEERING.md): they record each change in order, with the measurements and trace ids that support it.

## Origin and related material

- **Upstream**: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use).
- **Port list**: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). It lists file by file what was ported and what was not.
- **TypeSafe Jev**: an external service, not distributed with this package. This package holds none of its code, model weights or credentials. Its terms of service are at <https://typesafe.ai/legal/terms>.
- **This project's repository**: [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast).
- **The maintainer's local knowledge base** (not in the repository) holds another entry for this plugin: its installation, its configuration and each verification.

## License

MIT, see [LICENSE](LICENSE). Upstream copyright and third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
