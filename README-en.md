# dsh-jev-ultrafast

[中文](README.md) | English | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> The DeepSeek Harness plugin built on jev-ultrafast: drive a real browser with plain-language goals in a DSH conversation, with the Jev model doing the browser control.

## What this is

It adds one capability to DeepSeek Harness (DSH from here on): **drive a browser from a goal written in plain words**.

The usual way is that the model looks at the page, thinks one step, and clicks once. Every click costs one conversation turn. This project splits the work differently. The page is first pressed into a **numbered control table** (the **element table**). One request fixes both "which operation" and "on which element". The main model speaks only at the start, to give the goal, and at the end, to read the result. So a multi-step job costs one tool call.

It is a plugin (a bundle), not a skill. It registers two tools and one slash command:

| Entry | What it does |
|---|---|
| Tool `jev_browser_task` | Does the job for a goal written in one sentence. It accepts `expect` for verification. It brings back the result and the text of the final page |
| Tool `jev_browser_read` | Reads a long page screen by screen and stitches it back together, without duplicates. It spends no decision request |
| Command `/jev-ultrafast` | Says what to do right in the input box. The main model does not have to take part |

## Where it comes from

**This is a port, not original work.** The upstream project is [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use). Upstream is a Python implementation of about 690 lines. This project rewrites it in TypeScript and packages it as a DSH plugin. This project's own repository is [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast).

**It is not an official product.** This project has no affiliation with, endorsement from, or sponsorship by Browser Use or TypeSafe. "Browser Use", "TypeSafe" and "Jev" are trademarks of their respective owners. They are named here only to state the origin and to say whose interfaces the plugin calls.

What was taken from upstream is listed item by item in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The essentials:

| Upstream file | This project's file | What was taken |
|---|---|---|
| `jev_ultrafast/snapshot.js` | `src/browser/snapshot.js` | The in-page snapshot script, almost unchanged |
| `jev_ultrafast/questions.py` | `src/prompts.ts` | The decision prompts, almost unchanged |
| `jev_ultrafast/model.py` | `src/decision/*` | The element table, one request for operation and target, answer checking |
| `jev_ultrafast/agent.py` | `src/loop.ts` | The main loop, stale-decision handling, the text-value cache |
| `jev_ultrafast/browser.py` | `src/browser/*` | The freshness guard, the visibility and geometry checks before an action |

Upstream depends on `browser-harness`. It handles browser connections, the daemon and permission dialogs. TypeScript has no equivalent. This project rewrote that part against the Chrome DevTools Protocol.

## What you need first

1. **A DSH**: either the web end (`dsh web`) or the desktop application — either one is fine. The plugin supports both ends, so install it on the end you are using. It wants the `0.2.0-rc.1` generation (the plugin's dependency declaration covers `0.1.7-rc.2` up to before `0.3.0`).
2. **A browser**: Edge or Chrome.
3. **Keys** (depending on the route you pick): one for the decision service and one for the text model. The plugin holds no key of its own. At call time it reads yours from the DSH credential store.

## Install

Web end:

```sh
dsh plugin --profile web add dsh-jev-ultrafast
```

Restart DSH once after installing.

Desktop end:

Click **插件 (Plugins)** in the left sidebar to open the plugin page, then click **添加插件 (Add plugin)**; type `dsh-jev-ultrafast` (or this project's repository address, or a local directory path), then click **安装 (Install)**. The "install source" (安装源) in that dialog defaults to **npm 官方源**; if the network is slow in China, switch to **中国大陆镜像源**. After it installs, enable it as prompted, then **restart the application once**.

## How to use

Just say what you want in the input box, in plain words:

“用浏览器打开 https://www.example.com 该网页读取内容”

“用jev浏览器搜索美剧《人生复本》”

“调用插件dsh-jev-ultrafast打开这个页面 https://www.example.com ”

Or

- `/jev-ultrafast https://www.example.com 找到价格并说明是多少` — the sentence names an address. No model is called before the run starts.
- `/jev-ultrafast 查一下明天北京的天气` — the sentence names no address. If it names a site, that site is recognized locally. There are 13 recognized sites: 百度、必应、谷歌、知乎、微博、豆瓣、淘宝天猫、京东、小红书、抖音、B 站、维基、GitHub. Only when none is recognized does it ask the text model once. If that answers nothing, the run starts from a search engine, Bing by default.

## Configuration

The settings page is under **设置 (Settings) → Jev 浏览器 (Jev browser)**.

### The two doors

| Door | Two routes | Key |
|---|---|---|
| Decision service | TypeSafe direct; or the OpenRouter decision channel | Read from the DSH credential store. The plugin stores none of its own |
| Text model | Seven preset providers; or `dsh:<provider id>` (a model already configured in DSH) | The preset route uses its own key; the DSH built-in route is managed by DSH itself |

### Browser: the two connection modes

**The browser you are already using** (the default). It uses your current login state directly. The first time, do this:

1. In that browser's address bar, open `edge://inspect/#remote-debugging` (`chrome://inspect/#remote-debugging` for Chrome).
2. Tick "允许远程调试" (Allow remote debugging).
3. When the "允许远程调试?" (Allow remote debugging?) box appears, click Allow. You can also press "连接你的浏览器" (Connect your browser) on the settings page first, to hold the connection yourself.

Once you have ticked it, it works whether the browser is open or closed. When it is closed, the plugin opens it for you — with no arguments at all, the same as double-clicking the icon (since 2026-10-03 the red line "never start your daily profile" was removed by the user's ruling). Its own debugging port comes with it.

**Once per browser session only.** After it connects, the plugin holds that connection. Running tasks, reading pages and opening new tabs do not bring the box back. Only closing the browser completely and opening it again counts as a new session, and then it asks once more.

**The plugin's own browser.** It uses a separate data directory, independent of your daily one. For a site that needs a login, log in once in that window and it stays.

When "the browser you are already using" is selected, that block offers two more things:

- **See how much login can be carried over**: it only counts how many cookies the daily browser holds and which domains they are on. It disconnects immediately after counting and writes nothing.
- **Pour the login into the plugin's own browser**: it writes the cookies in and then checks site by site. It reads and writes over the debugging channel and does not touch the profile files.

## Development and verification

```sh
pnpm install
pnpm typecheck   # type check
pnpm test        # unit tests
pnpm build       # build lib/
pnpm pack        # produce the tgz
```

The real-browser integration tests are skipped by default. To run them, add the environment variable:

```sh
JEV_BROWSER=1 pnpm test
```

## License

MIT, see [LICENSE](LICENSE). The upstream copyright and the third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
