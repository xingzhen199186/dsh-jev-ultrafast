# dsh-jev-ultrafast

[English](README-en.md) | 中文 | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

[![License: MIT](https://img.shields.io/github/license/xingzhen199186/dsh-jev-ultrafast?style=flat)](LICENSE)
[![version](https://img.shields.io/github/v/tag/xingzhen199186/dsh-jev-ultrafast?label=version&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/tags)
[![stars](https://img.shields.io/github/stars/xingzhen199186/dsh-jev-ultrafast?label=%E2%98%85&style=flat)](https://github.com/xingzhen199186/dsh-jev-ultrafast/stargazers)
![dsh plugin](https://img.shields.io/badge/dsh-plugin-000000?style=flat)

> jev-ultrafast 的 DeepSeek Harness 插件实现，在dhs对话中用自然语言驱动真实浏览器，利用jev模型实现浏览器操控。

## 这是什么

它给 DeepSeek Harness（下称 DSH）补一条能力：**用一句自然语言目标驱动浏览器办事**。

常规做法是模型看页面、想一步、点一下。每个点击占一轮对话。这里换了分工：页面先压成一张**带编号的控件表**（下称**元素表**）。一次请求同时定「做什么操作」和「对哪个元素」。主模型只在开头出目标、结尾读结果。所以一趟多步任务只花一次工具调用。

它是插件（bundle），不是技能。它注册两个工具和一条斜杠命令：

| 入口 | 干什么 |
|---|---|
| 工具 `jev_browser_task` | 按一句话目标办事。可以带 `expect` 核验。跑完带回结果和最终页面的文字 |
| 工具 `jev_browser_read` | 一屏一屏读长页面，去重后拼回整篇。不花决策请求 |
| 命令 `/jev-ultrafast` | 在输入框里直接说要做什么。不必让主模型参与 |

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

上游依赖 `browser-harness`。它管浏览器连接、守护进程和权限弹窗。TypeScript 里没有对等物。本项目照 Chrome DevTools Protocol 重写了这一段。

## 需要先准备什么

1. **Node.js**：`^22.19.0 || >=24.0.0`。用 `node --version` 检查。
2. **DSH**：`0.2.0-rc.1` 一代。插件的依赖声明覆盖 `0.1.7-rc.2` 到 `0.3.0` 之前。
3. **一个浏览器**：Edge 或 Chrome。
4. **两把密钥**（按你选的路）：决策服务的密钥，以及文本模型的密钥。插件不内置密钥。它在调用时从 DSH 凭据库读你自己的。

## 安装

要装的是同一个插件，命令也一样。把 `<profile>` 换成你自己的配置名（例如 `web`）：

```sh
dsh plugin --profile <profile> add github:xingzhen199186/dsh-jev-ultrafast
```

**不要接 `#v0.1.0`。** 本项目的版本号固定为 0.1.0，不随内容变；那个 tag 停在 2026-10-01，接上去装到的是旧代码（比现在落后一百多个提交）。想钉住一个固定快照，就把 `#` 后面换成具体的提交号。

pnpm 默认不跑源码包的构建脚本。第一次安装会失败。按它打印出来的包键，在那个 profile 的 `pnpm-workspace.yaml` 里放行，然后重装一次。

```yaml
allowBuilds:
  dsh-jev-ultrafast: true
```

离线时用本机打的包。先 `pnpm pack`，再：

```sh
dsh plugin --profile <profile> add ./dsh-jev-ultrafast-0.1.0.tgz
```

上面这条命令行只对命令行管的 profile 有效。桌面应用的 `desktop` profile 由应用自己管，命令行会直接拒绝：`profile "desktop" is managed exclusively by the Electron application`。桌面端这样装：在左侧导航栏点**插件**进入插件页面，再点**添加插件**；在输入框里填本项目的仓库地址（`https://github.com/xingzhen199186/dsh-jev-ultrafast`）或本机目录路径，然后点**安装**。对话框里的「安装源」默认是 **npm 官方源**，国内网络慢可以换「中国大陆镜像源」。装好后按提示启用，再**重启一次应用**。

那一次重启不是多余的。桌面端的启动负载只在应用启动时送一次。不重启，插件页面拿不到自己的令牌（工具本身是好的）。

## 怎么用

在输入框里直接用自然语言说要做什么：

“用浏览器打开https://www.zhihu.com/question/2089740005770008568/answer/2090104616759325588该网页读取内容”
“用jev浏览器搜索美剧《人生复本》”
“调用插件dsh-jev-ultrafast打开这个页面……”

或

- `/jev-ultrafast https://www.example.com 找到价格并说明是多少` —— 句子里有网址。开跑前不调用任何模型。
- `/jev-ultrafast 查一下明天北京的天气` —— 句子里没有网址。若句子里点名了站点，本地就认出来。认得的站点有 13 个：百度、必应、谷歌、知乎、微博、豆瓣、淘宝天猫、京东、小红书、抖音、B 站、维基、GitHub。认不出才问一次文本模型。问不出就从搜索引擎开始，默认用必应。


## 配置

设置页在**设置 → Jev 浏览器**。

### 两扇门

| 门 | 两条路 | 密钥 |
|---|---|---|
| 决策服务 | TypeSafe 官方直连；或 OpenRouter 的决策通道 | 从 DSH 凭据库读。插件不另存 |
| 文本模型 | 七个预设供应商；或 `dsh:<供应商 id>`（DSH 里已配好的模型） | 预设那条路用自己的密钥；DSH 内置那条路由 DSH 自己管 |

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

## 许可

MIT，见 [LICENSE](LICENSE)。上游版权与第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
