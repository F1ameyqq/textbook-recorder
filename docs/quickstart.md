# 快速开始

这份流程面向 Windows + Edge。先确认负责人给你的书籍和目录范围；不要从朋友的历史进度推断自己的起点。

## 1. 安装与离线演练

安装 Node.js 22 或更高版本，取得仓库后在项目目录打开 PowerShell：

```powershell
node --version
npm ci
npm run doctor
npm run demo
```

`npm ci` 按锁文件安装依赖，包括固定版本的 `@playwright/mcp@0.0.83`。`doctor` 检查本机准备情况，`demo` 使用合成材料演练执行和回读，不连接或写入平台。离线检查通过不等于该电脑已通过真实录入验收。

首次 `doctor` 显示配置或令牌待配置是正常提示；完成下一步后再运行。

## 2. 本地书籍与扩展配置

```powershell
$bookId = Read-Host '输入本次负责的书号'
npm run configure -- "--book-id=$bookId"
```

此命令按 `config/recorder.example.json` 的结构生成本地 `config/recorder.json`，不会覆盖已有配置。示例书号不是你的任务；必须输入负责人分配的实际 `bookId`。运行命令时题单的 `bookId` 必须与配置一致。

一书一份独立工作目录，配置、会话、题单、进度和素材一并隔离。换书时保留旧工作目录，从新仓库副本配置另一书；不要修改旧目录的 `bookId`，也不要删除会话文件来绕过书籍检查。仅调整同一书的端口等配置时，先关闭服务并保留原进度。

在 Edge 安装 Playwright 浏览器扩展，登录目标录入页面。首次连接时按扩展页面提示选择正确的录入标签页，并确认浏览器授权。扩展权限可能涉及同一浏览器内其他页面；建议使用专门的工作窗口，关闭无关页面。

从 Welcome 页的 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` 后复制令牌值，运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-extension-auth.ps1
```

按提示粘贴到隐藏输入中。令牌通过 Windows DPAPI 保存，不写入 `config/recorder.json`。不要把令牌粘贴到聊天或命令行参数中，也不要提交加密文件。每位朋友在自己的 Windows 用户下配置一次，不能复制其他人的现有 DPAPI 配置。

已有可用本机令牌时无需重复导入。配置完成后再运行 `npm run doctor`；扩展是否启用、平台登录是否有效由之后的 `probe` 核对。

## 3. 准备与审校题单

本地建议结构：

```text
config/recorder.json
data/jobs/batch.json
data/jobs/figures/
data/jobs/progress.json
```

`npm run demo` 生成 `data/demo/batch.json`、合成配图和 `data/demo/preview.html`；`examples/batch.example.json` 也是合成 `fixture` 样例。可以查看它们学习字段，但不能只改书号和 `source` 就提交真实平台。自己的生产题单应从独立覆盖清单与原书材料准备。

先逐页建立覆盖清单，再制作 `batch.json`。原书页码与平台来源图片序号可能不同，必须在真实页面核对。`target.record` 是平台该节的记录序号；新增第一条须紧接平台已有记录，不能填印刷题号代替。

```powershell
npm run review -- --manifest=data/jobs/batch.json
```

这个命令做本地题单检查，不连接浏览器，也不会替你判断原书答案。每题对照题目原图、答案原图和配图后，才可设置 `review.status` 为 `approved` 且 `review.issues` 为空。存在难辨字、来源冲突或特殊排版风险时保留待审校。详见[审校规则](review-rules.md)。

报告还区分 `valid` 与 `readyForExecution`：结构有效但有未解决的专项项，仍不能执行。斜杠表达只有对照原图确认本题全部为线性排版后，才可填写 `review.specialReview.fractionLayoutConfirmed` 和 `sourceLayout: "linear"`；上下分式、未辨字与特殊强调不能用批准状态绕过。

命令输出 `preflight.json` 和离线 `preview.html` 路径，可在本地打开题答对照预览。它们不会修改题单或批准任务。再次运行相同题单时已有输出不会被覆盖，可指定新的 `--outputdir=data/review/下一次复核`。

## 4. 启动与只读核对

在第一个终端运行：

```powershell
npm run recorder:service
```

启动服务本身不会连接或写入网页。保留这个终端，在另一个项目终端运行：

```powershell
npm run recorder:status
npm run recorder:probe
npm run recorder:verify -- --manifest=data/jobs/batch.json --state=data/jobs/progress.json
```

`status` 查看本地服务与任务状态；`probe` 连接目标页面并读取当前目录情况；`verify` 对题单做只读回读，不新增题目。尚未录入的任务可能显示缺失，这是核对结果，不是执行批准。错误路由、书号不同或目录不匹配时先停止处理原因。

## 5. 小批追加与验收

首次在这台电脑或这本书执行时，先录入一条：

```powershell
npm run recorder:execute -- --manifest=data/jobs/batch.json --state=data/jobs/progress.json --limit=1
npm run recorder:status
```

等待任务终止，确认真实保存回执和刷新回读通过，再继续：

```powershell
npm run recorder:execute -- --manifest=data/jobs/batch.json --state=data/jobs/progress.json --limit=20
npm run recorder:status
```

省略 `--limit` 时默认 20。到达上限或正常暂停时可能返回 `status: "stopped"`；它表示批次边界，不能仅凭这个值判断失败。先确认任务终止、`pending` 为空、`writeBlocked` 为 `false`、无错误，且已处理题目保存与回读通过，再重复上面的 `execute` 命令接续。遇到错误或写入锁则转入恢复流程。

沿用同一题单、素材和进度路径；不要删除进度来重跑。执行会先核对已有完成任务，继续处理未完成部分。已有同内容会核对后跳过，已有不同内容停止。执行期间不要切换或编辑目标目录，也不要启动第二个执行客户端。

任务完成后运行只读 `verify`，核对数量、来源和内容，并与独立覆盖清单对照。`verify` 也默认最多核对 20 条，而且每次从题单开头核对；整批超过 20 条时须显式设足够上限。例如真实题单有 30 条时：

```powershell
npm run recorder:verify -- --manifest=data/jobs/batch.json --state=data/jobs/progress.json --limit=30
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
