# 快速开始

这份流程面向 Windows + Edge。先确认负责人给你的书籍和目录范围；不要从朋友的历史进度推断自己的起点。

## 让 agent 接续操作

取得完整仓库后，把仓库根作为 agent 工作目录。支持仓库 skill 的 agent 调用 `$textbook-recorder`；其他 agent 显式读取 [.agents/skills/textbook-recorder/SKILL.md](../.agents/skills/textbook-recorder/SKILL.md)。若未自动发现，也可用这个路径指定。只复制 skill 文件不可用，必须保留仓库程序和参考文件。

给出书号、章节/节起止或来源页范围，以及允许追加的范围。agent 先核对书号连接，在空编辑器时采集，再导出目标节基线并确定追加序号，在一次范围授权内读图配题、审校及录入，无需逐题询问。原图/答案判断仍使用 agent 的额度；以下 CLI 只完成机械步骤。没有本地读图能力时只能准备待审材料，不能宣称原图已核对。

第一次安装及令牌授权仍由本机用户完成下面的步骤；之后 agent 可按[详细工作流](../.agents/skills/textbook-recorder/references/workflow.md)操作 shell。新书、新电脑先试录一题，完整工作流描述不等于已经通过线上验收。

## 1. 安装与离线演练

安装 Node.js 22 或更高版本。先接受负责人发来的私有 GitHub 仓库邀请，用自己的受邀账号访问仓库。可以克隆：

```powershell
git clone https://github.com/F1ameyqq/textbook-recorder.git
Set-Location textbook-recorder
```

没有 Git 时，在仓库页选择 **Code → Download ZIP**，解压后在项目目录打开 PowerShell。然后运行：

```powershell
node --version
npm ci
npm run doctor
npm run demo
```

若 PowerShell 提示 `npm.ps1` 被执行策略禁止，把以上及后续命令中的 `npm` 换成 `npm.cmd`，例如 `npm.cmd ci`。无需修改全局执行策略。

`npm ci` 按锁文件安装依赖，包括固定版本的 `@playwright/mcp@0.0.83`。`doctor` 检查本机准备情况，`demo` 使用合成材料演练执行和回读，不连接或写入平台。离线检查通过不等于该电脑已通过真实录入验收。

首次 `doctor` 显示配置或令牌待配置是正常提示；完成下一步后再运行。

裁图需要 Python/Pillow；CPU OCR 是可选辅助。需要这些步骤时，建议安装 Python 3.11，并在项目中配置独立环境：

```powershell
py -3.11 -m venv .venv-workflow
.venv-workflow\Scripts\python.exe -m pip install -r requirements-crop.txt
```

仅在需要 CPU OCR 时再安装 `requirements-ocr.txt`：

```powershell
.venv-workflow\Scripts\python.exe -m pip install -r requirements-ocr.txt
```

仓库 Python 包装优先使用 `TEXTBOOK_RECORDER_PYTHON`，再查找 `.venv-workflow` / `.venv-ocr`，最后回退到 `python`。OCR 首次可能下载模型；新电脑实际模型运行未作为本版线上验收，`--dry-run` 只验证索引、哈希及选页，不做识别。不要复制朋友的环境目录或把全局 Python 改成项目环境。

## 2. 本地书籍与扩展配置

```powershell
$bookId = Read-Host '输入本次负责的书号'
npm run configure -- "--book-id=$bookId"
```

此命令按 `config/recorder.example.json` 的结构生成本地 `config/recorder.json`，不会覆盖已有配置。示例书号不是你的任务；必须输入负责人分配的实际 `bookId`。运行命令时题单的 `bookId` 必须与配置一致。

一书一份独立工作目录，配置、会话、题单、进度和素材一并隔离。换书时保留旧工作目录，从新仓库副本配置另一书；不要修改旧目录的 `bookId`，也不要删除会话文件来绕过书籍检查。仅调整同一书的端口等配置时，先关闭服务并保留原进度。

在 Edge 安装 [Playwright 扩展](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)（[官方安装说明](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)），登录目标录入页面。扩展权限可能涉及同一浏览器内其他页面；建议使用专门的工作窗口，关闭无关页面。

首次尚未配置令牌时，先在第一个项目终端运行：

```powershell
npm run recorder:service
```

服务启动不会自行连接浏览器。保留这个终端，在第二个项目终端运行：

```powershell
npm run recorder:probe
```

这次只读连接会弹出扩展 Welcome 页，首次连接允许尚未配置令牌。保持 Welcome 页打开，先复制令牌，暂时不要点 Allow；授权后页面可能关闭或切走。

从 Welcome 页的 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` 后复制令牌值，在第三个空闲项目终端运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-extension-auth.ps1
```

第一个终端正在运行服务，第二个终端可能仍等待 `probe` 连接，两者此时不能用于输入配置命令。按第三个终端的提示粘贴到隐藏输入中。令牌通过 Windows DPAPI 保存，不写入 `config/recorder.json`。不要把令牌粘贴到聊天或命令行参数中，也不要提交加密文件。每位朋友在自己的 Windows 用户下配置一次，不能复制其他人的现有 DPAPI 配置。

导入令牌后，回到 Welcome 页允许本次连接并选择正确的录入标签页。然后在空闲终端查看状态，等待初次连接任务终止，再关闭服务：

```powershell
npm run recorder:status
npm run recorder:stop
```

只有 `status` 确认 `pending` 为空、任务已终止后才运行 `stop`。重新运行 `npm run recorder:service`，让新连接读取令牌；再运行 `npm run doctor` 和 `npm run recorder:probe` 核对扩展及登录状态。后续通常不再需要重复点 Allow。

已有可用本机令牌时无需重复导入，直接按第 4 节启动服务。若上面已经重新启动服务，第 4 节沿用该服务，不要重复启动。

## 3. 准备与审校题单

agent 工作流的本地建议结构：

```text
config/recorder.json
data/jobs/job-01/index.json
data/jobs/job-01/images/
data/jobs/job-01/records.json
data/jobs/job-01/paired.json
data/jobs/job-01/mapping.json
data/jobs/job-01/batch.draft.json
data/jobs/job-01/review-decisions.json
data/jobs/job-01/batch.approved.json
data/jobs/job-01/figures/
data/jobs/job-01/progress.json
```

`npm run demo` 生成 `data/demo/batch.json`、合成配图和 `data/demo/preview.html`；`examples/batch.example.json` 也是合成 `fixture` 样例。可以查看它们学习字段，但不能只改书号和 `source` 就提交真实平台。自己的生产题单应从独立覆盖清单与原书材料准备。

采集使用 `node scripts/recorder-control.mjs collect <本地参数.json>`，明确 `from`、`to` 及 `output: "data/jobs/job-01"`，输出原页图和索引。它是只读操作，要求两编辑器原本为空；必须在会选题的单节 probe、readback、verify 之前完成，不能清空旧题来获得入口。采集通路尚需新书线上验收。CPU OCR 可按明确 index/pages 辅助，不能替代看原图。参数及完整命令见[工作流](../.agents/skills/textbook-recorder/references/workflow.md)。

普通 `npm run recorder:probe` 仅确认书号/连接，`recordCount: null` 不能作为目录基线。采集完成后，为目标节保存 `probe.args.json`，填写实际 `chapterLabel`、`sectionLabel` 和 `exportRecords: true`，再运行：

```powershell
npm run recorder:probe -- data/jobs/job-01/probe.args.json
npm run recorder:status
```

等待对应 probe job 终止，读取 result 的 `recordCount` 和 `recordsPath` 导出的已有记录；首条追加序号为数量加 1。跨节分别导出，每节首次追加前再 fresh 核对。单节 probe 会选中已有第 1 条题目，此后编辑器可能非空。需要全书 inventory 时，须在本次书范围授权内明确请求，不把普通连接当作全书盘点。

先逐页建立覆盖清单，再准备 `records.json` 和 mapping。原书页码与平台来源图片序号可能不同，必须在真实页面核对。`target.record` 是平台该节的记录序号；新增第一条须紧接平台已有记录，不能填印刷题号代替。

```powershell
npm run workflow:pair -- --input=data/jobs/job-01/records.json --output=data/jobs/job-01/paired.json
npm run workflow:draft -- --input=data/jobs/job-01/paired.json --mapping=data/jobs/job-01/mapping.json --output=data/jobs/job-01/batch.draft.json
npm run review -- --manifest=data/jobs/job-01/batch.draft.json
```

这些命令做本地配对、待审草稿和检查，不连接浏览器，也不会替你判断原书答案。agent 每题实际对照题目原图、答案原图和配图后，生成绑定当前草稿 SHA256 的 `review-decisions.json`，再导出批准题单：

```powershell
npm run workflow:approve -- --manifest=data/jobs/job-01/batch.draft.json --decisions=data/jobs/job-01/review-decisions.json --output=data/jobs/job-01/batch.approved.json
npm run review -- --manifest=data/jobs/job-01/batch.approved.json
```

不能未看图就批量填写 true；批准工具不会清除已有 issues。存在难辨字、来源冲突或特殊排版风险时保留待审校。接口见[数据说明](../.agents/skills/textbook-recorder/references/schema.md)，内容判断见[审校规则](review-rules.md)。输出文件不覆盖已有版本，修正后用新的文件名并更新后续引用。

报告还区分 `valid` 与 `readyForExecution`：结构有效但有未解决的专项项，仍不能执行。斜杠表达只有对照原图确认本题全部为线性排版后，才可填写 `review.specialReview.fractionLayoutConfirmed` 和 `sourceLayout: "linear"`；上下分式、未辨字与特殊强调不能用批准状态绕过。

命令输出 `preflight.json` 和离线 `preview.html` 路径，可在本地打开题答对照预览。它们不会修改题单或批准任务。再次运行相同题单时已有输出不会被覆盖，可指定新的 `--outputdir=data/review/下一次复核`。

新版预览可按题查看正文/答案原图区域，点击问题定位到内容块或覆盖候选。`workflow:decisions` 准备默认未通过的审校模板，`workflow:diff` 比较修订草稿，`workflow:job` 管理本地范围与文件版本；接口见[本地工作流工具](workflow-tools.md)。这些入口不连接平台，不继承批准，也不代替真实目录基线。

## 4. 启动与只读核对

服务尚未启动时，在第一个终端运行：

```powershell
npm run recorder:service
```

启动服务本身不会连接或写入网页。保留这个终端，在另一个项目终端运行：

```powershell
npm run recorder:status
npm run recorder:probe
npm run recorder:verify -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json
```

`status` 查看本地服务与任务状态；不带参数的 `probe` 只确认书号和连接，不读取目录基线；`verify` 对已经准备的题单做只读回读，不新增题目。`verify` 放在原页采集完成之后；尚未录入的任务可能显示缺失，这是核对结果，不是执行批准。错误路由、书号不同或目录不匹配时先停止处理原因。

## 5. 小批追加与验收

首次在这台电脑或这本书执行时，先录入一条：

```powershell
npm run recorder:execute -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=1
npm run recorder:status
```

等待任务终止，确认真实保存回执和刷新回读通过，再继续：

```powershell
npm run recorder:execute -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=20
npm run recorder:status
```

省略 `--limit` 时默认 20。到达上限或正常暂停时可能返回 `status: "stopped"`；它表示批次边界，不能仅凭这个值判断失败。先确认任务终止、`pending` 为空、`writeBlocked` 为 `false`、无错误，且已处理题目保存与回读通过，再重复上面的 `execute` 命令接续。遇到错误或写入锁则转入恢复流程。

沿用同一题单、素材和进度路径；不要删除进度来重跑。执行会先核对已有完成任务，继续处理未完成部分。已有同内容会核对后跳过，已有不同内容停止。执行期间不要切换或编辑目标目录，也不要启动第二个执行客户端。

任务完成后运行只读 `verify`，核对数量、来源和内容，并与独立覆盖清单对照。`verify` 也默认最多核对 20 条，而且每次从题单开头核对；整批超过 20 条时须显式设足够上限。例如真实题单有 30 条时：

```powershell
npm run recorder:verify -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=30
```

上限填写自己的实际题单条数，最大 1000。核对一部分不能称为整批通过。保存题单检查通过与原书覆盖完整是两项验收。

## 6. 暂停与关闭

```powershell
npm run recorder:pause
npm run recorder:status
```

等待状态确认任务终止，再运行：

```powershell
npm run recorder:stop
```

关闭断开程序自己的连接，保留用户网页和登录。遇到保存超时不要反复连接或再次执行；按[恢复说明](recovery.md)先只读核对当前失败题。
