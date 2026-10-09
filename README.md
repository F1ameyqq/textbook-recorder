# 教材录入助手 · v0.3.0

让朋友的 agent 在仓库中完成原页采集、读图分题、答案配对、题单审校和指定范围的追加录入。CLI 负责机械步骤：保留来源与哈希、生成待审草稿、检查批准决定，以及逐题核对保存回执和刷新回读。遇到差异或保存结果未知就停止。

题目拆分、答案对应和原书覆盖由 agent 对照原图判断，也可以人工复核。本地脚本不调用云端大模型 API；CPU OCR 在本机运行识别模型，agent 读图和判断仍消耗其额度。本项目提供 agent 辅助的完整操作流程；采集及新书、新电脑的安装到录入流程仍需实际验收，不能据此承诺零额度、全自动或无人值守完成整本书。

## 让 agent 使用 skill

先取得完整仓库，再以仓库根作为 agent 工作目录。支持仓库 skill 发现的 agent 可调用 `$textbook-recorder`；未出现在列表时，可明确要求读取 [.agents/skills/textbook-recorder/SKILL.md](.agents/skills/textbook-recorder/SKILL.md)。其他 agent 也可显式读取该文件，使用自己的 shell 和本地读图工具按工作流操作，不需要相同的 CUA 插件。

给 agent 的任务可以写成：

```text
请使用 $textbook-recorder，处理我指定的书号和章节起止范围。
先核对书号连接，在空编辑器时采集原图，再导出范围内的目录基线，
按原图准备、审校并追加该范围，
最后提供保存回读与逐页覆盖报告。范围缺项一次向我确认。
```

用户可一次授权明确范围内的追加，agent 在范围内接续完成，不逐题重复确认。未知保存、删除或重建不自动扩入范围。缺参考答案如何处理也要沿用本次明确规则，不能套用别人的历史授权。

先用 `recorder:start` 启动或复用一个后台服务，本身不连接浏览器；`recorder:service` 保留为前台诊断入口。整个任务使用同一个服务，probe、collect、execute、verify、readback、reconcile 都经仓库 controller 沿用服务连接。不要让 agent 为每条命令生成重新 `connectMcp` 的 runner。controller 的 `--wait --summary` 和批处理 CLI 内部等待负责监督，状态默认给摘要，异常诊断才展开 `--details`，减少反复轮询和无关输出。原图判断仍由 agent 实际完成。

skill 依赖本仓库程序和参考文件；单独复制 `SKILL.md` 不构成安装。详细机械接口见[工作流](.agents/skills/textbook-recorder/references/workflow.md)和[数据接口](.agents/skills/textbook-recorder/references/schema.md)。

仓库 skill 目录采用 Codex 的 `.agents/skills` 约定；发现和调用方式见 [OpenAI 官方说明](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)。

## 当前范围

| 支持 | 本版边界 |
| --- | --- |
| 已审校题单的顺序追加 | 不批量删除、重建或覆盖已有不同内容，不提交审核 |
| 文本、普通上下标、独立居中的 PNG/JPEG 配图 | 通用原生复杂分式、加点字等特殊排版尚未支持；转入待审校，不把整题截成图片替代 |
| 来源页、答案八个半角空格间隔、保存身份及刷新回读检查 | 检查题单中的任务，不能自行证明原书没有漏题 |
| 持久进度、暂停、只读核对与受约束的恢复 | 结果未知时保留写入锁，不自动重发保存 |
| 合成离线演练和跨系统离线 CI | 实际网页录入目前面向 Windows + Edge；Ubuntu CI 不代表生产浏览器支持 |

结构有效不等于可执行。疑似分式、方框及替换字符会进入专项审校；原书线性表达或印刷方框的确认方式见审校规则，原书上下分式与未辨清字符继续阻止执行。

## 环境与第一次使用

需要 Node.js 22 或更高版本、Windows、Edge、已登录的目标录入页面及 [Playwright 浏览器扩展](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)（[官方安装说明](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)）。项目固定使用 `@playwright/mcp@0.0.83`；通过锁文件安装依赖。

裁图和可选 CPU OCR 使用 Python，建议 Python 3.11 的项目 `.venv-workflow`；依赖按仓库 `requirements-crop.txt` 或 `requirements-ocr.txt` 安装。初始化方式见[快速开始](docs/quickstart.md)。不用 OCR 也须用 agent 实际读图完成审校。

先接受私有仓库邀请，再从仓库页克隆或选择 **Code → Download ZIP**，解压后进入项目目录。克隆地址为 `https://github.com/F1ameyqq/textbook-recorder.git`，访问需要自己的受邀 GitHub 账号。

在项目目录打开 PowerShell：

```powershell
npm ci
npm run doctor
npm run demo
```

如果 PowerShell 提示禁止运行 `npm.ps1`，将命令中的 `npm` 换成 `npm.cmd`；无需修改全局执行策略。

一书使用一份独立工作目录；不要在已有进度的目录里改书号切换到另一书。旧配置、会话和证据保留，另一书从新的仓库副本开始配置。

`demo` 生成 `data/demo/batch.json`、合成配图和 `data/demo/preview.html`。仓库中的 [题单示例](examples/batch.example.json)也只用于学习结构，均为 `fixture`。不能把它们改成 `production` 向真实平台提交；真实题单须用自己的原书重新准备与审校。

初次 `doctor` 会提示尚未配置的项目。按 [配置示例](config/recorder.example.json)生成本地 `config/recorder.json`，必须填写负责人分配的实际书号：

```powershell
$bookId = Read-Host '输入本次负责的书号'
npm run configure -- "--book-id=$bookId"
```

配置命令不会覆盖已有文件。首次令牌尚未配置时，运行 `npm run recorder:start`，返回后在同一项目终端运行 `npm run recorder:probe -- --wait --summary`。保持弹出的扩展 Welcome 页打开，先复制 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` 后的令牌值，在另一个空闲项目终端配置自己的令牌；原终端正在等待连接，不能用于输入配置命令：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-extension-auth.ps1
```

令牌通过本地隐藏输入保存，使用 Windows DPAPI 加密；不要发到聊天、提交 Git 或复制给朋友。每台电脑、每个 Windows 用户各自配置。`doctor` 和 `demo` 不写入平台。

令牌导入后，回到 Welcome 页允许本次连接并选择正确的录入标签页。等初次 probe CLI 返回终止摘要后，再运行 `npm run recorder:stop`，重新运行 `npm run recorder:start` 使令牌生效。再运行 `npm run doctor` 和 `npm run recorder:probe -- --wait --summary` 检查准备情况。已有可用本机令牌时可直接启动服务；之后全任务沿用该服务。

[快速开始](docs/quickstart.md)说明连接、审校、执行及关闭步骤。先完成离线演练和只读核对，再录入自己的小批题单。

## 常用命令

```powershell
npm run review -- --manifest=data/jobs/job-01/batch.approved.json
npm run recorder:start
```

服务启动后尚未连接浏览器。启动命令返回后，在同一项目终端运行：

```powershell
npm run recorder:status
npm run recorder:probe -- --wait --summary
npm run recorder:verify -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json
npm run recorder:execute -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=1
npm run recorder:pause
npm run recorder:status
npm run recorder:stop
```

普通 `probe` 只核对书号与连接，`recordCount: null` 不是目录基线。需采集原图时，先在两编辑器原本为空时经 `node scripts/recorder-control.mjs collect <参数.json> --wait --summary` 采集，再运行带 `chapterLabel`、`sectionLabel`、`exportRecords: true` 参数文件的单节 `probe`；后者会选择已有题目并使编辑器非空。基线导出后按 `recordCount + 1` 准备 mapping。以上 verify/execute 用于材料和基线已准备好的题单；完整顺序见[工作流](.agents/skills/textbook-recorder/references/workflow.md)。

首本书、首台电脑先用 `--limit=1` 试录，不加 `--continue`。确认真实保存与刷新回读通过，整份题单已批准且处于既有授权范围内时，再运行：

```powershell
npm run recorder:execute -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=20 --continue
```

`execute` 默认每轮最多处理 20 条；`--continue` 只在正常 limit 终止、pending 为空、无错误或写入锁且已处理题目保存与回读通过时自动接续。服务端同时检查暂停版本及原终止命令，轮次间 pause 也停止接续。pause、error 和未知保存都会停止。沿用同一 manifest/state，不连续提高限制绕过试录或授权，不删除进度重跑。`verify` 不给 `--limit` 时默认核对整份题单（最多 1000 条）；显式较小上限只证明部分通过。命令返回任务标识不等于录入完成；以终止摘要、逐题保存证据和刷新回读为准。执行时保持目标页面可用，不在同一页面手动编辑。

暂停状态跨断线和服务重启保留，status、probe 等只读操作不解除暂停。用户已有明确恢复授权时，先用原 manifest/state 执行不带 `--continue` 的 execute，通常沿用原 limit；确认该轮终止安全后才再次 `--continue`。已有明确恢复授权即可操作，不增加重复确认流程；未知保存或写入锁仍按原任务恢复说明处理。

`recorder:status` 给只读摘要：未连接时 GET/status 不主动建立初次浏览器连接；已有连接意外断线时，status/heartbeat 可按上限自动恢复一次，只有显式连接才重置该上限。确需诊断时使用 `npm run recorder:status -- --details`。controller 默认等待上限为 30 分钟，可用 `--timeout-ms=毫秒数`（1 到 3600000）调整；超时保留任务和进度，先只读核对，不重发。pause 后须确认原任务已终止且 pending 为空，再运行 stop。服务仅可清理自己创建、身份可确认、无未知保存且两编辑器确认空白的临时页；用户已有页和历史未登记标签页保留，不能批量关闭或删除。

## 审校与协作

- [审校规则](docs/review-rules.md)：原书覆盖、分题、答案、图片和格式要求。
- [恢复说明](docs/recovery.md)：暂停、核对保存结果和保留未知状态。
- [协作约定](docs/collaboration.md)：分配书籍与目录、交接进度和共享仓库边界。
- [本地工作流工具](docs/workflow-tools.md)：逐题原图对照、问题定位、待填写审校模板、修订差异和任务版本登记。

朋友之间分配不同书籍或明确不重叠的目录。不能共同写同一节；本机运行锁不能阻止另一台电脑写入相同目录。

读图、转录、配对和审校阶段可复用同一 job 已实际看过且 hash、bbox 相同的原图；修订按 `workflow:diff` 定向定位受影响的完整题和来源区域。来源或范围变化仍需重新看图。当前内容与覆盖要实际核对，并为新草稿形成 hash-bound 批准；缓存和旧批准不能替代未完成的审校。

## 开发验证与仓库内容

```powershell
npm test
npm run demo
npm run check:share
```

CI 在 Windows、Ubuntu 的 Node.js 22/24 上运行纯离线测试、合成演练及共享内容扫描，不连接真实平台。依赖旧生产资产的浏览器及公式场景未纳入共享版 CI，CI 通过不代表实际网页验收。OCR 辅助脚本是可选能力；本版不把 Python/PaddleOCR 环境作为基础安装步骤，OCR 输出仍需原图审校。

私有 GitHub 仓库只共享程序、文档和合成样例。原书内容、题单、图片、平台记录、执行证据、账号、令牌及本地配置留在各自电脑；私有仓库也不适合存放这些材料。
