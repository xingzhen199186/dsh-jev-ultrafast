# dsh-jev-ultrafast

English | [中文](README.md) | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> **One goal in, one tool call per step.** Give DeepSeek Harness one natural-language goal and let TypeSafe **Jev** drive the browser: the page is compressed into an indexed table of controls, and a single request decides both *which operation* to perform and *which element* to perform it on.

**What that saves.** The usual loop has the model look at the page, think one step, and click — one round trip per click. Here the looking and thinking go to the decision service, and the main model only states the goal and reads the result, so a multi-step task costs one tool call in the conversation.

A real run (measured on this machine, searching for a TV show):

```text
Goal:    search for the series "Dark Matter" and tell me about it
Result:  done · 2 steps · 5 decisions · 14.6 s
Ended at: Dark Matter Season 1 - Search — https://cn.bing.com/search?q=dark+matter+season+1
Page text (excerpt): about 12,300 results; season 1 episodes (S1 E5–E9); Douban 8.5/10
(21k ratings); plot and creators (Jakob Verbruggen and others)…
```

## What it does

- **One request per step.** The operation and its target come back together, so the model is not asked to look, think and click across three turns.
- **It brings its own browser.** When nothing is reachable, a run starts the Chrome or Edge you picked (its own data directory, its own free port), follows a tab a click opens, and closes only the tab it opened itself.
- **It waits for content to actually paint.** After an action it waits until the page text stops changing before judging, so "the shell loaded" is not mistaken for "the content arrived".
- **"Done" is verified.** Write what must be on the page when the task succeeds into `expect`; if it is not there the run reports `blocked` instead of trusting the model's own verdict.
- **Long documents are read in full.** The second tool scrolls screen by screen and stitches the text back together, spending no decision requests.
- **Every run keeps its raw log.** Each run writes `trace.jsonl` in a temp directory (requests and responses, credentials masked to `***`), and the result tells you where.
- **You can drive it without a model.** Typing `/jev-ultrafast` in the prompt box works too, and a URL in the sentence skips the model entirely.

## Install

Requirements: Node `^22.19.0 || >=24.0.0`, and the DeepSeek Harness `0.2.0-rc.1` generation.

```sh
dsh plugin --profile <profile> add github:xingzhen199186/dsh-jev-ultrafast#v0.1.0
```

pnpm does not run a source package's build script by default, so the first attempt fails: take the package key it prints, allow it in that profile's `pnpm-workspace.yaml`, and install again.

```yaml
allowBuilds:
  dsh-jev-ultrafast: true
```

Offline, use a locally packed tarball: `pnpm pack`, then `dsh plugin --profile <profile> add ./dsh-jev-ultrafast-0.1.0.tgz`.

**The desktop app takes a different route.** Its profile belongs to the application and the command line refuses it outright (`profile "desktop" is managed exclusively by the Electron application`). In the app, open **插件 → 添加插件**, paste the tarball's absolute path, press 立即启用, then **restart the app once** — the desktop boot payload is sent once at app start, and without a restart the plugin's page cannot get its own token (the tools themselves are fine).

After installing, set up three things in the settings page (decision service, text model, browser) and press **Launch and connect** in the browser block before a run.

To build from source: `pnpm install && pnpm build`; `pnpm test` runs the unit tests, `JEV_BROWSER=1 pnpm test` also runs the real-browser integration tests.

## Usage

| Entry point | What it does |
|---|---|
| Tool `jev_browser_task` | Take one natural-language goal (optionally with `expect`) and come back with the result and page text |
| Tool `jev_browser_read` | Read a long document screen by screen, de-duplicated and stitched, spending no decision requests |
| Command `/jev-ultrafast` | Say what to do in the prompt box; a URL in the sentence skips the model, no URL asks the text model for a start page |

## Configuration

Three blocks in the settings page (Settings → Jev browser):

| Block | What it sets |
|---|---|
| Decision service | TypeSafe Jev direct, or any OpenAI-compatible route; the credential comes from the DSH credential store, the plugin stores nothing of its own |
| Text model | Filling in field values, and the start-page fallback when a sentence carries no URL; can use a DSH built-in model or your own route |
| Browser | Pick Chrome or Edge; **Launch and connect** starts one with the plugin's own data directory — a profile of its own, separate from your daily browser, so log in once inside that window for any site that needs it and the login is kept |

Under **Advanced** you can set the decision output cap (default `393216`; when a server rejects it, the reply reports that server's own limit).

## Known limits

- The final page handed back to the tool is at most 6000 characters, and an `expect` marker is looked for on that last screen only — on a very long page the marker may sit further down, so "not confirmed" is not "not true".
- Only a tab a click opens is followed; the run never switches to a tab you already had.
- File uploads and drag-and-drop, and anything inside Shadow DOM, iframes or a canvas, have never been in the action space.
- "Content arrived" is judged from page text, not from the network: a page that only swaps images takes the no-change branch.
- Frame-by-frame screenshots are off by default; when on, the trace directory holds `frames/NNNNNN.jpg`.

## Relationship to upstream

This is an independent, unofficial TypeScript port of [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT, © 2026 Browser Use), packaged as a DeepSeek Harness bundle; the decision loop, the page-snapshot script and the prompts are adapted from upstream.

**Unofficial.** Not affiliated with, endorsed by, or sponsored by Browser Use or TypeSafe; "Browser Use", "TypeSafe" and "Jev" are trademarks of their respective owners, used here only to describe the origin and the interface this plugin calls.
**Bring your own key.** The plugin ships, bundles, proxies and resells no API access; it resolves your own credential from the DSH credential store at call time. Each step sends the page's control table to the decision service you configured; screenshots stay on this machine.

## License

MIT, see [LICENSE](LICENSE); upstream copyright and third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
