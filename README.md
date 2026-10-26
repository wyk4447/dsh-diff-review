# dsh-diff-review

DeepSeek Harness 插件：模型**改文件之前**先请你审查，你点「接受」它才真正执行；侧边栏用编辑器风格展示原文与新文的对比并标出改动位置。

## 拦什么

| 操作 | 是否拦截 | 审查面板显示 |
|---|---|---|
| `write` 新建文件 | 是 | 新增，全文 `+N` |
| `write` 覆盖文件 | 是 | 统一 diff / 全文双栏 |
| `edit` 改文件 | 是 | 统一 diff / 全文双栏（标出改动行） |
| `pwsh` 里的删除/覆盖命令 | 是 | 命令原文 + 被删文件的原文 / 新文 diff（能确定时） |
| `read` / `glob` / `grep` 等只读 | 否 | — |

`pwsh` 不靠「记住有哪些命令」，而是按**形状**识别：只要这条命令可能改写文件，就先请你确认。判断依据是四类形状：

- **PowerShell 动词-名词约定**：`Set-` / `New-` / `Remove-` / `Clear-` / `Rename-` / `Move-` / `Copy-` / `Add-` / `Out-` / `Tee-` / `Write-` / `Save-` / `Export-` / `Import-` / `Compress-` / `Expand-` / `Restore-` 等前缀（所以 `Set-Item`、`New-Item`、`Tee-Object`、`Export-Csv`、`Rename-Item` 这些没被逐个列出的命令同样会拦）；只操作内存的 `New-Object`、`Add-Type`、`Set-Variable`、`Clear-Host` 之类显式放行；
- **.NET 成员调用**：`[System.IO.File]::Delete(...)`、`[IO.File]::WriteAllText(...)`、`[System.IO.Directory]::Delete(...)`；
- **把代码当字符串交给别的程序**：`cmd /c del`、`iex` / `Invoke-Expression`、`powershell -EncodedCommand`、`node -e`、`python -c`、`bash -c` 等；
- **原地改文件的外部工具**：`git clean` / `git checkout -- ` / `git reset` / `git stash`、`truncate`、`dd`、`shred`、`unlink`。

外加常见别名（`ri`/`rm`/`del`/`erase`/`rd`/`rmdir`/`clc`/`cli`/`ren`/`rni`/`mi`/`mv`/`sc`/`ac`/`cpi`/`cp`/`tee`/`ni`/`si`/`sp`/`mkdir`/`md`）与 `>` `>>` `2>` 重定向。带 `-WhatIf` 的干跑、只读管道、`Get-ChildItem` / `Get-Content` / `Select-String` / `git status` / `git log` / `git diff` 之类一律放行。脚本块里的命令同样算数：`if (Test-Path $t) { Remove-Item $t -Force }`、`foreach (...) { ... }`、`& { ... }` 都会照常拦下，藏在里面的删除不会漏；管道右端没有目标的（`Get-ChildItem 'D:/w' | Remove-Item -Force`）按「确认命令本身」处理。

**能算出新内容时就给完整 diff**：写入的是命令里就写死的文本，并且目标文件能读——面板就照常显示原文与新文的对照；`Add-Content` / `Out-File -Append` 按追加语义算，新文件按新增算。所谓「写死」包括三种：

- 引号里的字面文本：`Set-Content -Path 'a.txt' -Value 'hello'`、`'hello' > 'a.txt'`；
- 同一命令里先赋值、再写出去的变量：`$t = 'hello'; Set-Content -Path a.txt -Value $t`——插件按出现顺序跟踪赋值，写出去的内容就是那个字面值；
- .NET 调用的前两个实参：`[System.IO.File]::WriteAllText('a.txt', 'hello')`——路径和内容都是字面量时同样出真 diff，`[System.IO.File]::Delete('a.txt')` 出被删的原文；
- `$` 引号字符串里的插值，只要引用的变量同样能确定：`` $dir = 'D:\w'; $js = "line one`nline two"; Out-File "$dir/probe.js" -InputObject $js `` 会解析成真实路径 `D:\w\probe.js` 与真实的三行文本（反引号转义如 `` `n `` `` `t `` 一并还原）；
- **here-string**：多行内容通常这么写。`@'...'@` 原样当作字面文本（不插值），`@"..."@` 按双引号规则插值——引用的变量都确定时同样出真 diff。正文里的 `|`、`&`、花括号、引号都不会被当成命令分隔符。

**算不出来时只确认命令本身**：路径或内容只能由 shell 在运行时决定——通配符（`*` `?` `[` `]`）、没被赋过值的变量（`$env:TEMP\x`、`$(...)`、`${...}`）、运行期才算出来的值（`$t = 'a' + 'b'`、`Get-Date | Out-File f`）、属性或索引访问（`$a.Length`）。这时面板照常弹出、显示完整命令行，并明说「命令操作，无法预知最终内容」——不会假装列出被删的文件，也不会把这种情况说成「改动过大」。文件名里本来就有的 `$`（如 `a$b.txt`）不算展开，仍然按真实路径审查。

`$env:NAME` 是唯一例外：环境变量在闸门这一侧就能查出来，所以 `Remove-Item "$env:TEMP\a.txt","$env:TEMP\b.txt"` 会被还原成两个真实路径——落在临时目录里的照 `skipTemp` 放行，落在别处的照常请你确认。一个 `-Path` 里用逗号并列多个目标（`Remove-Item 'a.txt','b.txt'`）也按多个目标算，各自独立解析。同一条命令里反复写同一个文件（先 `[System.IO.File]::WriteAllText` 播种、再 `Set-Content` 覆盖）时，顶栏只写一次文件名，不会变成 `a.txt, a.txt`。

**不拦的**：只读工具；系统临时目录（`%TEMP%` / `%TMP%` / `/tmp`）；工作区下的 `.dsh/tmp/`（一次性脚本、导出、截图的默认落点）；插件自己的源码。除这几类以外，只要落盘就一定会先问你。

## 侧边栏

右侧栏新增「改动审查」标签页：

- 顶部：操作徽章（新增/修改/删除/命令）+ 文件名与所在目录分两行显示（像编辑器的标签页）+ `+N -N` + 视图切换 + 拒绝 + 接受。只有命令层面能确认的改动（`iex $code`、`git clean -fdx`）根本没有文件名，此时徽章写「命令」、下面直接给命令原文，不会把动词当成文件名
- 两种视图：
  - **改动视图**：统一 diff，左右两列行号，`+`/`-` 标记，未改动处折叠成「⋯ 未改动的 N 行」；被改写的那一行除了整行底色，改动到的那几个字还会再加一层更深的底色（IDEA 那种行内高亮）
  - **全文视图**：原文 / 新文左右并排，行号跟文件真实行号走，改动行在左边距画彩色竖条（编辑器 gutter 那种效果）；**拖动或滚动任意一侧，另一侧的行与列同步跟动**
- 多个待审查项在左侧列表里纵向排列，逐条接受或拒绝
- 代码区 13px/20px，等宽栈优先 JetBrains Mono → Fira Code → Cascadia Code → Consolas，关闭连字（连字会把 `!=`、`->` 画变形）；正文用系统无衬线，中文走雅黑
- 配色完全走宿主的 `--dsw-alias-file-diff-*` token，跟随亮/暗主题自动切换，不写死颜色
- 没有待审查项时显示空态，并把闸门的自检信息收进一张卡片里

## 安全阀

| 情形 | 行为 | 原因 |
|---|---|---|
| 侧边栏没打开 / 页面已关闭 | 直接放行 | 没人能审批时不能把 agent 卡死 |
| 你中断本轮（Esc） | 取消当次调用 | 跟随 `exec.signal` |
| 5 分钟没人理 | 放行 | 同上，未答复不等于拒绝 |
| 插件自己的源码 | 直接放行 | 否则插件坏了就再也修不了（自锁） |
| 临时目录下的文件 | 直接放行 | `skipTemp` |
| 工作区 `.dsh/tmp/` 下的文件 | 直接放行 | `skipScratch`，一次性脚本的默认落点 |
| 二进制 / 超大文件 | 降级为仅统计 | 读不出 UTF-8 时不假装能 diff |
| 命令写入的内容由 shell 决定 | 降级为仅确认命令 | 面板显示命令行，并说明原因 |

## 安装

### 从 GitHub 安装

```powershell
dsh plugin add https://github.com/wyk4447/dsh-diff-review.git
# 或简写
dsh plugin add github:wyk4447/dsh-diff-review
```

装完在 profile 的 `package.json` 里是版本号/仓库形态，与其它插件一致。改代码后需重新装一次。

> 如果你 fork 了这个仓库，把上面两行的 `wyk4447` 换成你自己的用户名即可。

> Git 托管的插件靠 `prepare` 脚本构建，pnpm 默认会拦 `allowBuilds` 里的构建脚本。本插件**零依赖、没有任何 `prepare`/`install` 脚本**，所以正常情况不需要放行；只有当你在这个仓库里自己加了构建步骤时，才需要把 pnpm 打印的 key 写进 `~/.dsh/profiles/<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 下。

### 本地开发（软链）

调试插件本身时用 `link:`，改源码即生效于下次启动：

```powershell
# ~/.dsh/profiles/<profile>/package.json
#   dependencies 里加：
"dsh-diff-review": "link:<你 clone 下来的绝对路径>"
#   dsh.profile.bundles 里也要加 "dsh-diff-review"
```

改完 `lib/*.js` 需要重启 DSH 才生效（profile bundle 随 Host 启动加载，没有热重载）。

## 配置

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里给对应条目加 `config:`：

```yaml
- id: diff-review
  name: dsh-diff-review
  config:
    files: true          # 拦 write/edit
    shell: true          # 拦 pwsh 里的破坏性命令
    skipTemp: true       # 跳过系统临时目录
    skipScratch: true    # 跳过工作区 .dsh/tmp
    skipSelf: true       # 跳过插件自身（强烈建议保持 true）
    trace: true          # 写诊断日志到 ~/.dsh/logs/diff-review.log
    timeoutMs: 300000    # 文件审查超时（毫秒）
    shellTimeoutMs: 120000
```

所有键都可省略，缺省用上面的值。类型不符的键会被忽略（不做强制校验，插件零依赖）。

## 卸载

1. 删 `cordis.patch.yml` 里 `- id: diff-review` 那段（若你手动加过）
2. 从 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 里移除 `dsh-diff-review`
3. 重启 DSH

本插件**没有**关掉任何内置插件，也没有改写宿主的 `disabled` 列表，卸载不会留下副作用。

## 自测

两套离线测试，不连 GUI、不写真文件：

```powershell
node test\gate.test.mjs     # 闸门：拦截/放行/接受/拒绝/中断/自我豁免/兜底
node test\render.test.cjs   # 面板：空态诊断、改动视图、全文视图、删除态
```

> 别用 `node --run test` / `npm test`：Windows 上 Node 在含非 ASCII 字符的路径下会把它算成乱码路径而报「Can't find package.json」。`package.json` 里仍留了 `scripts.test`，放在纯 ASCII 路径下可用。

闸门测试用 mock 的 `ctx` 直接驱动真实的 `apply(ctx)`，覆盖 190 项断言：`not-armed` 放行、布防后挂起、`decide accept` 放行、`decide reject` 拒绝且 reason 带路径、`abort` 取消、`edit` diff 两侧、`pwsh` 删除挂起与接受、`pwsh` 字面写入出真 diff（覆盖 / 追加 / 重定向 / 新建文件四种）、同一命令里赋值后写出的变量（`$t = 'one'; Set-Content -Value $t`、反引号转义还原、`$p = 'D:/w/a.txt'; Remove-Item $p` 解析成真实文件、`$dir` 参与路径拼接、`"hello $n"` 插值）、运行期才算出来的值降级为命令级（`$t = 'a' + 'b'`、`$env:USERNAME`）、按形状识别的十六种改写命令（`Set-Item`/`Rename-Item`/`New-Item`/`Tee-Object`/`Export-Csv`/`[IO.File]::Delete`/`cmd /c del`/`iex`/`Invoke-Expression`/`node -e`/`python -c`/`powershell -EncodedCommand`/`git clean`/`git checkout --`/管道右端无目标）且参数是字面量时仍出真 diff、形状命中但没有文件名的条目（`iex`/`git clean`/管道右端）标记为命令级且不带路径（`op === 'shell'`、`displayPath` 为空，避免把动词当成文件名）、`-WhatIf`/`Get-ChildItem`/`Write-Host`/`New-Object`/`Add-Type`/`Clear-Host`/`git status`/`node --version` 放行、通配与变量目标的命令级确认（`$p`/`"${target}"`/`$out`）且文件名里的字面 `$` 不被误判、脚本块里的删除（`if (...) { ... }`、`foreach (...) { ... }`、`& { ... }`）、同一命令内赋值参与路径解析、逗号并列多个目标、同一文件被写两次时顶栏只出现一次而两个不同文件按顺序都出现、`$env:TEMP` 目标按临时目录放行、自我豁免、临时目录豁免、工作区 `.dsh/tmp` 豁免且不误豁免 `.dsh/tmpfoo`、`header.cwd` 缺失时用 `workingDirectory` 兜底、`ctx.get` 抛异常时仍能挂起。

面板测试用 `node:vm` 跑真实的 `lib/client.js`，桩掉 React/DOM/fetch：验证空态五行诊断、改动视图有 `+`/`-` 标记、改写行只有真正变化的那几个字被加深高亮（前缀不被误涂）、全文视图有双栏与 gutter 竖条、**拖动一侧另一侧同步且不回弹**、删除态第二栏显示「文件将被删除」、命令级审查不出空代码区且用「无法预知最终内容」而不是「改动过大」、命令级条目不再编造文件名（`iex $code` 的面板不显示任何文件名）。

## 排错

没被拦住时，先看日志，再看面板。

### 日志（推荐，不依赖打开侧栏）

`trace: true`（默认）时，每次闸门调用、挂起、裁决、路由拒绝都会追加一行到 `~/.dsh/logs/diff-review.log`（Windows 上是 `C:\Users\<你>\.dsh\logs\diff-review.log`）。

```powershell
Get-Content ~\.dsh\logs\diff-review.log -Tail 30
# 只看某个工具
Select-String -Path ~\.dsh\logs\diff-review.log -Pattern '"tool":"write"'
```

日志只记「状态变化」：轮询心跳首次出现或间断后恢复各记一次（`poller`），不会每 1.2s 刷屏。没有 `poller` 行就说明浏览器半从没连上，闸门必然一直是「未布防」。

典型序列：

```
... poller {"first":true,"gapMs":-1}          ← 侧栏连上了，闸门开始布防
... park {"tool":"write","path":"...","pending":1}   ← 拦下了，等你点按钮
... verdict {"id":"...","outcome":"accept"}   ← 你点了接受，随后工具真的执行
```

### 面板

打开右侧「改动审查」Tab，空态会直接列出闸门的诊断：

- `闸门已检查 N 次 · 最近工具 X · 结果 Y` —— `Y` 就是放行原因，见下表
- `布防 no · 心跳龄 -1ms` —— 说明页面从没轮询过，即 Tab 没打开
- `最近调用：write:not-armed → read:not-gated` —— 按时间顺序看最近 12 次

| `结果` | 含义 |
|---|---|
| `not-armed` | 侧边栏没在轮询（Tab 没开 / bundle 没加载），属正常放行 |
| `not-gated` | 工具不在拦截范围（如 `read`） |
| `no-session` | 拿不到会话工作目录 |
| `temp-skipped` / `scratch-skipped` / `self-skipped` | 命中系统临时目录 / 工作区 `.dsh/tmp` / 插件自身豁免 |
| `identical` / `edit-no-match` / `edit-ambiguous` | 改动本身无效或歧义，交给宿主自己报错 |
| `shell-not-destructive` | `pwsh` 命令不含破坏性操作 |

## 实现要点

- **闸门**：`tools/pre-execute` 的 async waterfall。挂起时只 await 一个 Promise，同时监听 `exec.signal`，宿主等多久都不会 abandon 我们的 promise。
- **通道**：自建同源 HTTP 路由 `/diff-review/api/{list,detail,decide}`，前面挂 `ctx.connection.requestRejection` 做浏览器信任校验。Electron 壳把 `dsh-app://app/` 的请求转发到 Host 并自动带认证 cookie，所以浏览器侧同源可达；从 Node 直接探测会 403，属正常。
- **diff**：自己算 LCS（`Int32Array` DP，超 400 万格降级为全删全增），零外部依赖。
- **布防**：侧边栏每 1.2s 轮询 `list`，该调用同时刷新心跳；心跳 180s 内有效才算「布防」，否则闸门一律放行。窗口不可见时 Chromium 会把 `setInterval` 压到约 60s 一跳，窗口必须留得比这个大，否则切走窗口就等于放行。
