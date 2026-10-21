# 快速开始

这份流程面向 Windows + Edge。先确认负责人给你的书籍和目录范围；不要从朋友的历史进度推断自己的起点。

## 让 agent 接续操作

取得完整仓库后，把仓库根作为 agent 工作目录。支持仓库 skill 的 agent 调用 `$textbook-recorder`；其他 agent 显式读取 [.agents/skills/textbook-recorder/SKILL.md](../.agents/skills/textbook-recorder/SKILL.md)。若未自动发现，也可用这个路径指定。只复制 skill 文件不可用，必须保留仓库程序和参考文件。

给出书号、章节/节起止或来源页范围，以及允许追加的范围。agent 先核对书号连接，在空编辑器时采集，再导出目标节基线并确定追加序号，在一次范围授权内读图配题、审校及录入，无需逐题询问。原图/答案判断仍使用 agent 的额度；以下 CLI 只完成机械步骤。没有本地读图能力时只能准备待审材料，不能宣称原图已核对。

第一次安装及令牌授权仍由本机用户完成下面的步骤；之后 agent 可按[详细工作流](../.agents/skills/textbook-recorder/references/workflow.md)操作 shell。全任务沿用一个服务：`recorder:start` 启动或复用后台服务，`recorder:service` 保留为前台诊断入口。probe、collect、execute、verify、readback 和 reconcile 都经仓库 controller；不要让 agent 另写每条命令重建 `connectMcp` 连接的 runner。新书、新电脑先以 `--limit=1` 试录，不加 `--continue`；完整工作流描述不等于已经通过线上验收。

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

裁图需要 Python/Pillow；OCR 是可选的本机辅助。需要时使用 Python 3.11 的独立环境，不修改全局 Python。先安装裁图依赖：

```powershell
py -3.11 -m venv .venv-workflow
.venv-workflow\Scripts\python.exe -m pip install -r requirements-crop.txt
```

OCR 默认保留 PP-OCRv5 mobile 模型并使用 `gpu:0`、2 个 CPU 线程和低优先级。GPU OCR 建议使用单独环境：

```powershell
py -3.11 -m venv .venv-ocr-gpu
```

按 [PaddlePaddle 官方安装选择器](https://www.paddlepaddle.org.cn/install/quick)选择本机 Windows、GPU 与匹配的 CUDA 构建，将其安装命令中的 `python` 换成 `.venv-ocr-gpu\Scripts\python.exe`。然后在同一环境安装项目使用的 OCR 包；能力与推理引擎的安装说明见 [PaddleOCR 官方文档](https://www.paddleocr.ai/latest/en/version3.x/installation.html)：

```powershell
.venv-ocr-gpu\Scripts\python.exe -m pip install "paddleocr==3.7.0" "Pillow==12.1.0"
```

已有经过验证的 GPU Python 时可直接指向它，无需移动或复制环境。`config/python.local.json` 仅允许下面两个字段，将示例改成该解释器的真实绝对路径；此文件已由 `config/*.local.json` 忽略，不提交到仓库：

```json
{
  "schemaVersion": 1,
  "ocrPython": "C:\\path\\to\\gpu-env\\Scripts\\python.exe"
}
```

OCR 解释器按 `TEXTBOOK_RECORDER_OCR_PYTHON` → `TEXTBOOK_RECORDER_PYTHON` → `config/python.local.json` 的 `ocrPython` → `.venv-ocr-gpu` → `.venv-workflow` → `.venv-ocr` → `python` 选择。两个环境变量都未显式设置时才读取本地 OCR 配置；被选中的显式路径必须是存在的可执行文件，错误配置直接报错。裁图保持原规则：`TEXTBOOK_RECORDER_PYTHON` → `.venv-workflow` → `.venv-ocr` → `python`，不读取 OCR 环境变量或 OCR 本地配置。

包装器只选择解释器，不改变设备参数。没有可用 GPU、GPU 版 Paddle 或对应驱动时，默认 OCR 明确失败，不会静默改用 CPU。需要 CPU OCR 时，保留使用原有 CPU 专用依赖，并在实际命令中显式选择 CPU；不要把 CPU 专用的 `requirements-ocr.txt` 安装到 GPU 环境：

```powershell
.venv-workflow\Scripts\python.exe -m pip install -r requirements-ocr.txt
npm run workflow:ocr -- --index=data/jobs/job-01/index.json --pages=1-10 --device cpu
```

OCR 首次可能下载模型；新电脑仍需实际验证所选解释器、依赖和模型运行，安装说明与其他电脑的有限样本结果不构成本机验收。`--dry-run` 只验证索引、哈希及选页，不做识别或 GPU 验收。OCR 输出仍需原图审校，不自动完成分题、覆盖或答案判断。

## 2. 本地书籍与扩展配置

```powershell
$bookId = Read-Host '输入本次负责的书号'
npm run configure -- "--book-id=$bookId"
```

此命令按 `config/recorder.example.json` 的结构生成本地 `config/recorder.json`，不会覆盖已有配置。示例书号不是你的任务；必须输入负责人分配的实际 `bookId`。运行命令时题单的 `bookId` 必须与配置一致。

一书一份独立工作目录，配置、会话、题单、进度和素材一并隔离。换书时保留旧工作目录，从新仓库副本配置另一书；不要修改旧目录的 `bookId`，也不要删除会话文件来绕过书籍检查。仅调整同一书的端口等配置时，先关闭服务并保留原进度。

在 Edge 安装 [Playwright 扩展](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)（[官方安装说明](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)），登录目标录入页面。扩展权限可能涉及同一浏览器内其他页面；建议使用专门的工作窗口，关闭无关页面。

首次尚未配置令牌时，先在项目终端运行：

```powershell
npm run recorder:start
```

`start` 启动或复用后台服务并返回，本身不连接浏览器。然后在同一项目终端运行：

```powershell
npm run recorder:probe -- --wait --summary
```

这次只读连接会弹出扩展 Welcome 页，首次连接允许尚未配置令牌。保持 Welcome 页打开，先复制令牌，暂时不要点 Allow；授权后页面可能关闭或切走。

从 Welcome 页的 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` 后复制令牌值，在另一个空闲项目终端运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-extension-auth.ps1
```

原终端仍等待 `probe` 连接，此时不能用于输入配置命令。按空闲终端的提示粘贴到隐藏输入中。令牌通过 Windows DPAPI 保存，不写入 `config/recorder.json`。不要把令牌粘贴到聊天或命令行参数中，也不要提交加密文件。每位朋友在自己的 Windows 用户下配置一次，不能复制其他人的现有 DPAPI 配置。

导入令牌后，回到 Welcome 页允许本次连接并选择正确的录入标签页。然后在空闲终端查看状态，等待初次连接任务终止，再关闭服务：

```powershell
npm run recorder:status
npm run recorder:stop
```

只有 `status` 确认 `pending` 为空、任务已终止后才运行 `stop`。重新运行 `npm run recorder:start`，让新服务连接读取令牌；再运行 `npm run doctor` 和 `npm run recorder:probe -- --wait --summary` 核对扩展及登录状态。后续通常不再需要重复点 Allow。

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

采集使用 `node scripts/recorder-control.mjs collect <本地参数.json> --wait --summary`，明确 `from`、`to` 及 `output: "data/jobs/job-01"`，输出原页图和索引。它是只读操作，要求两编辑器原本为空；必须在会选题的单节 probe、readback、verify 之前完成，不能清空旧题来获得入口。采集通路尚需新书线上验收。本机 OCR 可按明确 index/pages 辅助，默认 GPU，不能替代看原图。参数及完整命令见[工作流](../.agents/skills/textbook-recorder/references/workflow.md)。

普通 `npm run recorder:probe -- --wait --summary` 仅确认书号/连接，`recordCount: null` 不能作为目录基线。采集完成后，为目标节保存 `probe.args.json`，填写实际 `chapterLabel`、`sectionLabel` 和 `exportRecords: true`，再运行：

```powershell
npm run recorder:probe -- data/jobs/job-01/probe.args.json --wait --summary
```

CLI 等待对应 probe job 终止，读取终止摘要的 `job.result.recordCount` 和 `job.result.recordsPath`；摘要不包含已有记录全文，另读导出文件核对基线。首条追加序号为数量加 1。跨节分别导出，每节首次追加前再 fresh 核对。单节 probe 会选中已有第 1 条题目，此后编辑器可能非空。需要全书 inventory 时，须在本次书范围授权内明确请求，不把普通连接当作全书盘点。

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

为减少重复耗费 agent 额度，同一 job 已实际看过且 hash、bbox 相同的原图可在读图、转录、配对和审校阶段复用；修改后按 diff 定向定位受影响的完整题与来源区域。来源或范围变化需重新看图。当前内容和覆盖仍须实际审校，批准决定必须绑定新草稿 hash，不能自动复用旧批准或填写未做的检查。

## 4. 启动与只读核对

在项目终端启动或复用后台服务：

```powershell
npm run recorder:start
```

启动服务本身不会连接或写入网页。命令返回后，在同一项目终端运行：

```powershell
npm run recorder:status
npm run recorder:probe -- --wait --summary
npm run recorder:verify -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json
```

`status` 只读查看本地服务与任务摘要：未连接时 GET/status 不主动建立初次浏览器连接；已有连接意外断线时，status/heartbeat 可按上限自动恢复一次，只有显式连接才重置该上限。确需诊断时用 `npm run recorder:status -- --details` 展开完整字段；普通检查无需频繁读全量状态。不带目录参数的 `probe` 只确认书号和连接，不读取目录基线；`verify` 对已经准备的题单做只读回读，不新增题目。`verify` 放在原页采集完成之后；尚未录入的任务可能显示缺失，这是核对结果，不是执行批准。错误路由、书号不同或目录不匹配时先停止处理原因。

自动重连达到上限后，先排查连接原因，再用 `node scripts/recorder-control.mjs connect-status --summary` 显式连接。它不会重发原任务；仍须按原 pending、进度和保存证据处理恢复。

`probe`、`collect`、`readback`、`reconcile` 使用 controller 的 `--wait --summary`，批处理 CLI 自行等待终止。controller 默认最多等待 30 分钟，可用 `--timeout-ms=毫秒数`（1 到 3600000）调整；超时保留正在运行的任务，不重发命令，先只读查看状态。

## 5. 小批追加与验收

首次在这台电脑或这本书执行时，先录入一条：

```powershell
npm run recorder:execute -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=1
```

这次试录不加 `--continue`，不能连续提高 limit 绕过验收。CLI 等待任务终止后，确认真实保存回执和刷新回读通过。在整份题单已审校批准且处于本次授权范围内时，再继续：

```powershell
npm run recorder:execute -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=20 --continue
```

`execute` 省略 `--limit` 时每轮默认 20。`--continue` 仅在正常 limit 终止、`pending` 为空、`writeBlocked` 为 `false`、无错误且已处理题目保存与回读通过时自动接续下一轮。服务端同时检查暂停版本及原终止命令，轮次间 pause 也停止接续。pause、error、未知保存或写入锁都会停止；不能仅凭 `status: "stopped"` 就继续，遇到异常转入恢复流程。接续只完成当前批准题单，不增加授权范围。

暂停状态跨断线和服务重启保留，status、probe 等只读操作不解除暂停。用户已有明确恢复授权且原任务已终止安全时，先用原 manifest/state 执行不带 `--continue` 的 execute，通常沿用原 limit；确认该轮终止安全、保存与回读通过后才再次加 `--continue`。已有明确恢复授权即可操作，不额外重复确认；未知保存或写入锁仍先按恢复说明核对。

沿用同一题单、素材和进度路径；不要删除进度来重跑。执行会先核对已有完成任务，继续处理未完成部分。已有同内容会核对后跳过，已有不同内容停止。执行期间不要切换或编辑目标目录，也不要启动第二个执行客户端。

任务完成后运行只读 `verify`，核对数量、来源和内容，并与独立覆盖清单对照。不提供 `--limit` 时默认核对完整题单（最多 1000 条）：

```powershell
npm run recorder:verify -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json
```

显式提供较小 `--limit` 时只从题单开头核对一部分，不能称为整批通过。超过 1000 条的任务分成已授权且覆盖边界明确的题单。保存题单检查通过与原书覆盖完整是两项验收。

## 6. 暂停与关闭

```powershell
npm run recorder:pause
npm run recorder:status
```

等待状态确认任务终止，再运行：

```powershell
npm run recorder:stop
```

关闭断开程序自己的连接，保留用户网页和登录。服务仅可清理自己创建、身份可确认、无未知保存且两编辑器确认空白的临时页；用户已有页及历史未登记标签页保留，不能批量关闭或删除。遇到保存超时不要反复连接或再次执行；按[恢复说明](recovery.md)经同一服务的 controller 先只读核对当前失败题。
