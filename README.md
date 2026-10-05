# dsh-jev-ultrafast

[English](README-en.md) | 中文 | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> 给 DeepSeek Harness 一句话目标。插件驱动真实浏览器把事办完。每一步「做什么操作、对哪个元素」由一个决策服务选定，不占主模型的对话轮次。

## 这是什么

它给 DeepSeek Harness（下称 DSH）补一条能力：**用一句自然语言目标驱动浏览器办事**。

常规做法是模型看页面、想一步、点一下。每个点击占一轮对话。这里换了分工：页面先压成一张**带编号的控件表**（下称**元素表**）。一次请求同时定「做什么操作」和「对哪个元素」。主模型只在开头出目标、结尾读结果。所以一趟多步任务只花一次工具调用。

它是插件（bundle），不是技能。它注册两个工具和一条斜杠命令：

| 入口 | 干什么 |
|---|---|
| 工具 `jev_browser_task` | 按一句话目标办事。可以带 `expect` 核验。跑完带回结果和最终页面的文字 |
| 工具 `jev_browser_read` | 一屏一屏读长页面，去重后拼回整篇。不花决策请求 |
| 命令 `/jev-ultrafast` | 在输入框里直接说要做什么。不必让主模型参与 |

一次真实运行（本机实测）：

```text
目标：搜索《人生复本》，告诉我它的大致信息
结果：完成 · 2 步 · 5 次决策 · 14.6 秒
最后停在：人生复本第一季 - 搜索 — https://cn.bing.com/search?q=人生复本第一季
页面上读到的内容（节选）：约 12,300 个结果；第 1 季分集（S1 E5–E9）；豆瓣 8.5/10（2.1 万人）……
```

## 上游来源

**这是一个移植项目，不是原创。** 上游是 [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)（MIT，© 2026 Browser Use）。上游是 Python 实现，约 690 行。本项目把它改写成 TypeScript，并打包成 DSH 插件。本项目自己的仓库在 [xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast)。

**它不是官方出品。** 本项目与 Browser Use、TypeSafe 没有隶属、背书或赞助关系。「Browser Use」「TypeSafe」「Jev」是各自所有者的商标。这里提到它们，只为了说明来源，以及说清插件在调用谁的接口。

从上游搬来的东西，逐件列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。要点如下：

| 上游文件 | 本项目文件 | 搬了什么 |
|---|---|---|
| `jev_ultrafast/snapshot.js` | `src/browser/snapshot.js` | 页面内的快照脚本，近乎原样 |
| `jev_ultrafast/questions.py` | `src/prompts.ts` | 决策用的提示词，近乎原样 |
| `jev_ultrafast/model.py` | `src/decision/*` | 元素表、一次请求定操作与目标、答案校验 |
| `jev_ultrafast/agent.py` | `src/loop.ts` | 主循环、过期决策的处理、文本值缓存 |
| `jev_ultrafast/browser.py` | `src/browser/*` | 新鲜度守卫、动作前的可见性与几何检查 |

上游依赖 `browser-harness`。它管浏览器连接、守护进程和权限弹窗。TypeScript 里没有对等物。本项目照 Chrome DevTools Protocol 重写了这一段，而且**零依赖**。

另外两处来路，仓库里只记了名字、没有可核实的链接，这里照实说明：

- **browser-use**：另一套浏览器智能体项目。本项目从它借了三件事：留痕地址脱敏（18 个登录回跳参数抹成 `REDACTED`）、编号落空时重新观察（连续超过 2 次才停）、内容藏在框架里时如实报告。
- **dsh-advisor-group**：同一作者的另一款 DSH 插件。本项目的文本供应商表、以及调用 DSH 模型服务的那一小片，是从它移植的（2026-09-29）。

## 需要先准备什么

1. **Node.js**：`^22.19.0 || >=24.0.0`。用 `node --version` 检查。
2. **DSH**：`0.2.0-rc.1` 一代。插件的依赖声明覆盖 `0.1.7-rc.2` 到 `0.3.0` 之前。
3. **一个浏览器**：Edge 或 Chrome。
4. **两把密钥**（按你选的路）：决策服务的密钥，以及文本模型的密钥。插件不内置密钥。它在调用时从 DSH 凭据库读你自己的。

## 安装

网页端（`dsh web`）：

```sh
dsh plugin --profile <profile> add github:xingzhen199186/dsh-jev-ultrafast#v0.1.0
```

pnpm 默认不跑源码包的构建脚本。第一次安装会失败。按它打印出来的包键，在那个 profile 的 `pnpm-workspace.yaml` 里放行，然后重装一次。

```yaml
allowBuilds:
  dsh-jev-ultrafast: true
```

离线时用本机打的包。先 `pnpm pack`，再：

```sh
dsh plugin --profile <profile> add ./dsh-jev-ultrafast-0.1.0.tgz
```

**桌面端另走一条路。** 桌面应用的 profile 由应用自己管。命令行会直接拒绝：`profile "desktop" is managed exclusively by the Electron application`。请这样做：

1. 在应用里点**插件 → 添加插件**。
2. 粘贴 tarball 的**绝对路径**。
3. 装完点「立即启用」。
4. **重启一次应用**。

第 4 步不是多余的。桌面端的启动负载只在应用启动时送一次。不重启，插件页面拿不到自己的令牌（工具本身是好的）。

## 怎么用

### 工具 `jev_browser_task`

给它一句话目标，它把事办完。也可以给 `expect`。`expect` 写成「做成时页面上必须出现什么」。核不上就报 `blocked`，不轻信模型的自我评价。

例：`goal` 填「找到这趟航班的最低价格并说明是多少」，`url` 填查询页地址，`expect` 填 `["¥"]`。

### 工具 `jev_browser_read`

给它一个网址，它一屏一屏读完、去重拼好交回来。这条路不花决策请求。读长文、读文档、读规范都用它。

页面高过一屏也没关系。每一屏的滚动都会重来一次，最后拼成一整篇。

### 命令 `/jev-ultrafast`

在输入框里直接说要做什么。

- `/jev-ultrafast https://www.example.com 找到价格并说明是多少` —— 句子里有网址。开跑前不调用任何模型。
- `/jev-ultrafast 查一下明天北京的天气` —— 句子里没有网址。若句子里点名了站点，本地就认出来。认得的站点有 13 个：百度、必应、谷歌、知乎、微博、豆瓣、淘宝天猫、京东、小红书、抖音、B 站、维基、GitHub。认不出才问一次文本模型。问不出就从搜索引擎开始，默认用必应。
- `/jev-ultrafast`（不带参数）—— 只回一段说明和交互式检查器的网址。

命令立刻返回。任务交给 DSH 的后台任务继续跑。会话头部的「任务」面板里能看到进度，也能停。跑完把结果交回来。

命令名只能用 ASCII，所以是 `/jev-ultrafast`。

### 交互式检查器

浏览器打开 `http://127.0.0.1:3080/jev-ultrafast/inspector`。换端口、换主机都对。在设置页的**浏览器**那一块按「打开交互式检查器」也能打开。

那里可以手动开始一次运行、看当前画面、看每一步选中哪个元素、看模型有多大把握。动作执行前可以「暂停 / 单步 / 停止」。也能回看以前跑过的运行，逐帧按真实节奏回放。

## 配置

设置页在**设置 → Jev 浏览器**。现有 **22 个字段**，全部属于「改后不用重启」那一类：保存即生效，也不会打断正在跑的任务。

### 两扇门

| 门 | 两条路 | 密钥 |
|---|---|---|
| 决策服务 | TypeSafe 官方直连；或 OpenRouter 的决策通道 | 从 DSH 凭据库读。插件不另存 |
| 文本模型 | 七个预设供应商；或 `dsh:<供应商 id>`（DSH 里已配好的模型） | 预设那条路用自己的密钥；DSH 内置那条路由 DSH 自己管 |

七个预设是：DeepSeek 官方、OpenRouter、阿里云百炼、智谱 AI、月之暗面 Kimi、硅基流动、OpenAI。

OpenRouter 那条路的模型名带一个波浪号：`~typesafe/jev-latest`。**这不是笔误。** 去掉它会被路由到一个不存在的模型。

两个供应商下拉都按来源分组。选「DSH 内置」时，密钥那一行换成一句「由 DSH 自己管」，不画粘贴框。

走 DSH 内置线路时，插件会带上当前会话的身份（`GenerateOptions.sessionId`）。按会话路由的线路需要它。缺了它，线路会拒答。

### 浏览器：两种连接方式

**你正在用的浏览器**（默认）。它直接用你现在的登录状态。第一次要这样做：

1. 在这个浏览器的地址栏里打开 `edge://inspect/#remote-debugging`（Chrome 用 `chrome://inspect/#remote-debugging`）。
2. 勾上「允许远程调试」。
3. 出现「允许远程调试？」的框时，点「允许」。也可以先在设置页按「连接你的浏览器」，把连接握在手里。

勾过这一次之后，开着关着都能用。关着的时候，插件会替你打开它——一个参数都不传，跟你双击图标等价（2026-10-03 起，「绝不启动你日常档案」那条红线按用户裁决移除）。它自己的调试口会随身带上。

**每个浏览器会话只允许一次。** 连上后插件一直握着这条连接。跑任务、读页面、开新标签都不再弹框。浏览器整个关掉重开，才算新会话，会再问一次。

**插件自己的浏览器**。它另开一份数据目录，与你日常那份互不干扰。需要登录的站点，在那个窗口里登录一次，之后一直保留。

选「你正在用的浏览器」时，那一块还有两件事可做：

- **看看能带走多少登录**：只数一数日常浏览器里有多少 cookie、分布在哪些域名。数完立刻断开，不写任何东西。
- **把登录灌进插件自己的浏览器**：把 cookie 写进去，写完逐站核对。它走调试通道读写，不碰档案文件。

### 其余开关

常改的都在明面上。极少改的收在「高级设置」里，例如浏览器程序位置、数据目录、两扇门的地址与密钥名。

几个值得知道的开关：

- **识别自定义按钮**（默认开）：把用脚本挂了点击的普通元素也列为候选。很多网站的按钮是 `div` 或 `span`。关掉就只认原生控件。
- **浮层挡住时的处理**（默认开）：目标被浮层挡住、点不下去时，插件把挡路的那个元素和「按 Esc 关掉浮层」一起放进候选。于是模型可以自己关掉这一层。
- **多个新页面时跟哪一个**（默认开）：一步点开后冒出好几个新页面时，只跟地址或标题对得上这一步目标的那一个。都对不上就不跟，留在原页。
- **中控**（默认关）：开跑时让另一个模型写一份可核对的清单，运行中核验。标志不成立就不许宣布完成。它用「文本模型」那一栏的模型来写。

单次决策的输出上限默认 `393216`。被服务端拒绝时，插件从对方的回话里读出它自己的上限，再用那个数问一次。

## 行为边界

- **只关自己开的标签页。** 它跟到「点击打开」的新标签页后，那一页留着给你看。结束时只关它自己开的那个。
- **不接管你的标签页。** 它不会切到你本来就有的标签页。
- **绝不关闭、绝不直接写入你日常浏览器的档案，也绝不给它传调试参数。** 灌登录那条链对日常浏览器只有读。
- **不替你点弹框、不替你登录。** 「允许远程调试？」那个框由你点。
- **不内置、不中转、不转售任何 API 访问。** 只支持自带密钥。密钥不进配置文件，也不进会话记录。
- **每一步都留底。** 每次运行在临时目录写一份 `trace.jsonl`。里面是每一次决策请求与响应。密钥抹成 `***`，地址里的 `code`、`token` 这类登录回跳参数抹成 `REDACTED`。结果里给出这个目录的路径。

## 已知限制

- **工具交回的最终页面最多 6000 字**，`expect` 也只在**最后一屏**的文字里找。所以「没核上」只说明没在这儿确认，不等于事情没成。想看得更远就用 `jev_browser_read`。
- **绕路会消耗步数。** 例：让它去 B 站找动画区的排行榜，它可能先点搜索框、再进搜索结果页。目标入口不在页面上时，它没有别的路可走。
- **被遮挡的按钮会重试到上限。** 一个按钮被浮层盖住、又关不掉时，它会连试 7 次，然后停下，并点名遮挡它的东西。
- **两页来回会刹车。** 连续 9 次落地来回于两个页面就停手。真正需要来回超过 4 轮的任务也会被它停掉，结束语会点名这两页。
- **不进 iframe、Shadow DOM、canvas 里的元素。** 它会如实说「里面的内容看不到」。有内层地址就给出来。
- **不做文件上传与拖放。**
- **只换图片的页面会走「无变化」那条分支。** 插件按页面文字判断内容到没到，不看网络。
- **选「你正在用的浏览器」时，跑任务那几分钟你不能同时用它。** 那个调试开关开着期间，本机其他程序理论上也能连上它。
- **留痕在系统临时目录，含页面正文，不自动清理。**
- **五个语言的 README 的结构与内容已于 2026-10-05 对齐。**
- **版本号 0.1.0，而且不擅自改动。** 本插件没发布到 npm。代码在 GitHub 上。

## 开发与验证

```sh
pnpm install
pnpm typecheck   # 类型检查
pnpm test        # 单元测试
pnpm build       # 构建 lib/
pnpm pack        # 打出 tgz
```

真浏览器集成测试默认跳过。要跑就加环境变量：

```sh
JEV_BROWSER=1 pnpm test
```

当前套件：**44 个测试文件**、**724 个用例**。其中 **704 个通过、20 个跳过**。跳过的那 20 个需要真浏览器。

证据放在两处：

- **运行留痕**：每次运行写出 `trace.jsonl`。里面有每一次决策请求与响应，以及每一次文本模型调用。
- **工程说明** [ENGINEERING.md](ENGINEERING.md)：逐步记录改动，以及支撑它的实测数字与留痕编号。

## 来源与关联

- **上游**：[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)（MIT，© 2026 Browser Use）。
- **移植清单**：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。逐文件列出搬了什么、没搬什么。
- **TypeSafe Jev**：外部服务，不随本包分发。本包不含它的代码、模型权重或凭据。它的服务条款见 <https://typesafe.ai/legal/terms>。
- **本项目仓库**：[xingzhen199186/dsh-jev-ultrafast](https://github.com/xingzhen199186/dsh-jev-ultrafast)。
- **维护者的本机知识库**（不入版本库）里另有一份插件条目：记录安装、配置与逐次验证。

## 许可

MIT，见 [LICENSE](LICENSE)。上游版权与第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
