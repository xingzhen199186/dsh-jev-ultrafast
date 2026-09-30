# dsh-jev-ultrafast

[English](README-en.md) | 中文 | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> 给 DeepSeek Harness 一句自然语言目标，浏览器里的事交给 TypeSafe 的 Jev 去决策：页面先压成一张带编号的控件表，一次请求同时定「做什么操作」和「对哪个元素」。

**它到底省下什么。** 常规做法是模型看页面、想一步、点一下，每个点击占一轮往返。这里把「看和想」交给决策服务，主模型只出目标、最后读结果——多步任务在对话里只花一次工具调用。

一次真实的运行（本机实测，搜一部剧）：

```text
目标：搜索《人生复本》，告诉我它的大致信息
结果：完成 · 2 步 · 5 次决策 · 14.6 秒
最后停在：人生复本第一季 - 搜索 — https://cn.bing.com/search?q=人生复本第一季
页面上读到的内容（节选）：约 12,300 个结果；第 1 季分集（S1 E5–E9）；豆瓣 8.5/10（2.1 万人）；
剧情与主创（雅各布·维尔布鲁根等）……
```

## 能做什么

- **一步一次请求。** 操作和目标一起回来，不用让模型分三轮去看、想、点。
- **浏览器它自己带。** 一个都连不上时，按你选的 Chrome / Edge 自己起一个（专属数据目录、端口自选）；点击点开的新标签页会跟过去，结束时只关自己开的那个。
- **会等正文真的画出来。** 点完一步先等内容停稳再判断，不把「骨架到了」当成「内容到了」。
- **「完成」是核对过的。** 把「做成时页面上必须有什么」写进 `expect`，页面上找不到就报 `blocked`，不轻信模型的自我评价。
- **长文档读得完。** 第二个工具一屏一屏收、拼回整篇，不花决策请求。
- **每一步都留底。** 每次运行在临时目录写一份 `trace.jsonl`（请求与响应，密钥一律抹成 `***`），结果里给出这个目录的路径。
- **能看着它跑，也能不经过模型叫它干活。** 检查器里可在动作执行前暂停 / 单步 / 停止，跑完的逐帧回看；输入框里打 `/jev-ultrafast` 加一句人话也能跑。

## 安装

环境：Node `^22.19.0 || >=24.0.0`，DeepSeek Harness `0.2.0-rc.1` 一代。

```sh
dsh plugin --profile <profile> add github:xingzhen199186/dsh-jev-ultrafast#v0.1.0
```

pnpm 默认不执行源码包的构建脚本，第一次会失败：按它打印的包键，在那个 profile 的 `pnpm-workspace.yaml` 里放行，再装一次。

```yaml
allowBuilds:
  dsh-jev-ultrafast: true
```

离线时用本机打好的包：`pnpm pack` 之后 `dsh plugin --profile <profile> add ./dsh-jev-ultrafast-0.1.0.tgz`。

**桌面端另走一条路。** 桌面应用的 profile 由应用自己管，命令行会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。在应用里点**插件 → 添加插件**，粘 tarball 的绝对路径，装完点「立即启用」，再**重启一次应用**——桌面端的启动负载只在应用启动时送一次，不重启的话插件页面拿不到自己的令牌（工具本身是好的）。

装完去设置页把三样配好（决策服务、文本模型、浏览器），跑之前记得按一下浏览器那块的**启动并连接**。

想自己改源码：`pnpm install && pnpm build`，`pnpm test` 跑单测，`JEV_BROWSER=1 pnpm test` 另跑真浏览器集成测试。

## 用法

| 入口 | 干什么 |
|---|---|
| 工具 `jev_browser_task` | 给一句话目标（可加 `expect` 核验），它跑完把结果与页面文字带回来 |
| 工具 `jev_browser_read` | 把长文档一屏一屏读全、去重拼接，不花决策请求 |
| 命令 `/jev-ultrafast` | 输入框里直接说要做什么；话里带网址不调模型，没带网址用文本模型问一次起点 |

`/jev-ultrafast` 不带参数时只回一段说明和检查器网址；检查器本身在 `/jev-ultrafast/inspector`。

## 配置

设置页（设置 → Jev 浏览器）三块：

| 块 | 说明 |
|---|---|
| 决策服务 | TypeSafe Jev 官方直连，或任意 OpenAI 兼容路由；钥匙从 DSH 凭据库取，插件不另存 |
| 文本模型 | 填表取值、以及整句没写网址时的起点兜底；可走 DSH 内置模型，也可自配路由 |
| 浏览器 | 选 Chrome / Edge，「启动并连接」会用插件自己的数据目录起一个 |

「高级设置」里能调单次决策的输出上限（默认 `393216`；被服务端拒绝时，回话会报出它自己的上限）。

## 已知限制

- 工具回给你的最终页面最多 6000 字，且只在最后一屏上找 `expect` 标记——很长页面上的标记可能在更下面，所以「没核上」只说明没确认，不等于没做成。
- 只跟进「点击打开」的新标签页，不会切到你本来就有的标签页。
- 上传文件、拖放，以及 Shadow DOM、iframe、canvas 里的元素，都不在动作空间里。
- 判断「内容到了」靠的是页面文字而不是网络：只换图片的页面会走无变化那条分支。
- 多帧截图的开关默认关着；开着时留痕目录里会有逐帧 `frames/NNNNNN.jpg`。

## 与上游的关系

这是 [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)（MIT，© 2026 Browser Use）的独立、非官方 TypeScript 移植，打包成 DeepSeek Harness 的 bundle；决策循环、页面快照脚本与提示词改写自上游。

**非官方。** 本项目与 Browser Use、TypeSafe 无隶属、无背书、无赞助关系；「Browser Use」「TypeSafe」「Jev」是各自所有者的商标，此处仅用于说明来源与本插件所调用的接口。
**密钥自备。** 插件不内置、不打包、不中转、不转售任何 API 访问；它在调用时从 DSH 凭据库解析你自己的密钥。每一步会把页面的控件表发给所配的决策服务，截图留在本机。

## 许可

MIT，见 [LICENSE](LICENSE)；上游版权与第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
