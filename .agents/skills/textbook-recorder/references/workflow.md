# Agent 工作流

以仓库根为工作目录。首次配置和扩展令牌按[快速开始](../../../../docs/quickstart.md)；执行期间只保留一个写入客户端，朋友之间不共同写同一节。一书一份工作目录。

全任务只启动并沿用一个服务：`recorder:start` 启动或复用后台服务，`recorder:service` 保留为前台诊断入口。普通 probe、collect、带目录 probe、execute、verify、readback 和 reconcile 都通过仓库 controller 使用该服务的浏览器连接。不要另写临时 `connectMcp` 脚本，也不要生成每条命令新建连接的 runner。首次导入令牌需要按快速开始关闭并重新启动一次，之后沿用服务到任务结束。服务仅可清理自己创建、身份可确认、无未知保存且两编辑器确认空白的临时页；用户已有页和历史未登记标签页保留，不能批量关闭或删除。

probe、collect、readback、reconcile 的 controller 命令使用 `--wait --summary` 在 CLI 内等待并返回摘要；默认最多等待 30 分钟，可用 `--timeout-ms=毫秒数`（1 到 3600000）调整。等待超时只结束本地等待，保留服务任务和进度，不重发命令；随后只读查看状态再判断。批处理 `recorder:execute` / `recorder:verify` 已在 CLI 内监督到终止。`npm run recorder:status` 给只读摘要：未连接时 GET/status 不主动建立初次浏览器连接；已有连接意外断线时，status/heartbeat 可按上限自动恢复一次，只有显式连接才重置该上限。只有定位异常确需完整字段时运行 `npm run recorder:status -- --details`。pause 不使用 `--wait`；暂停后通过只读 status 确认原任务已终止。不要让 agent 高频轮询或反复读取整份状态。

用户明确只要求本地 fixture 准备时，跳过书籍配置、服务、采集、probe 和平台基线，直接使用其提供的原图/索引、范围和起始序号，从本地读图与配对开始。mapping 与输出题单保持 `source: "fixture"`；报告说明起点来自用户材料，未验证生产目录，不执行平台命令。

## 范围与只读采集

记录用户授权的书号、目录起止、正文/答案来源范围及允许追加的范围。普通 `probe` 只核对书号与连接，返回 `recordCount: null`，不能用它认定目录为空或计算追加起点。先采集，再用明确章/节的 probe 导出基线；不要把印刷题号当 `target.record`。

服务启动后不会自行连接；已配置的项目终端执行：

```powershell
npm run recorder:start
```

启动命令返回后，同一项目终端执行不带目录参数的 `npm run recorder:probe -- --wait --summary`，由 CLI 等待本命令终止。此时两编辑器原本为空，才进行采集；不要先运行会选题的单节 probe、readback 或 verify。采集参数文件放在本次任务目录，例如 `data/jobs/job-01/collect.args.json`：

```json
{"from":1,"to":10,"output":"data/jobs/job-01"}
```

```powershell
node scripts/recorder-control.mjs collect data/jobs/job-01/collect.args.json --wait --summary
```

`from`/`to` 是经核对的平台来源图片序号，填写本次授权的真实范围；上例只演示参数。等待任务终止并读取摘要中的 `job.result.indexPath`。输出包含原页图及哈希索引。采集不保存题目；它要求两侧编辑器为空，非空就停止，不能清空旧题或假定未保存内容可丢弃来获得入口。失败保留原输出和状态，不盲目重放。

缓存续采检查的是既有本地文件与索引哈希，只证明这份本地快照完整，不能证明远端教材没有更新。原材料变动或需要重新采集时，使用新的已授权 job 目录，保留旧索引和材料，不覆盖它们来伪装同一快照。

## 采集后导出目录基线

`collect` 完成后，给本次目标节写 `data/jobs/job-01/probe.args.json`，名称使用实际平台完整标签：

```json
{"chapterLabel":"平台实际章名","sectionLabel":"平台实际节名","exportRecords":true}
```

```powershell
npm run recorder:probe -- data/jobs/job-01/probe.args.json --wait --summary
```

检查本 probe 的终止摘要中 `job.result.recordCount` 和 `job.result.recordsPath`；摘要保留路径和统计，不包含已有记录全文。确需完整诊断时用 controller 的 `--details`，其 result 位于服务状态的 `last.result` / 远端状态的 `remote.job.result`。另读导出的完整 records，确认已有正文/身份/来源及数量；首条追加的 `target.record` 为实际 `recordCount + 1`。这个单节 probe 会选择第 1 条，使已有题目的编辑器非空，所以不能倒置到采集之前，也不能为采集清空旧题。

跨节任务分别导出每节基线，保留各自报告；每节首次追加前再 fresh probe 核对。若记录数或已有内容变化，停止写入并重核 mapping/批准版本，不静默平移已批准序号。章/节名无法准确提供且本次书范围已允许全书只读盘点时，可用 args `{"inventory":true}` 运行同一 probe 命令并保留 inventory 报告；不默认读取全书。

## OCR 和原图阅读

Python 是裁图和 CPU OCR 的可选依赖。需要时按[快速开始](../../../../docs/quickstart.md)在本仓库的 `.venv-workflow` 中配置，不改全局 Python；脚本包装优先使用 `TEXTBOOK_RECORDER_PYTHON` 或项目 `.venv-workflow` / `.venv-ocr`，最后回退到 `python`。若当前环境已有本脚本支持的 Python/PaddleOCR CPU 依赖，可先检查选页与来源哈希：

```powershell
npm run workflow:ocr -- --index=data/jobs/job-01/index.json --pages=1-10 --dry-run
```

实际 OCR 使用同一命令去掉 `--dry-run`，首次运行可能下载模型。也可用项目环境的 Python 直接调用 `scripts/ocr-pages.py`，`--index`/`--pages` 接口相同。明确选择正文及答案页；不把未授权全书自动加进范围，不自动切换模型来源或声称 OCR 已完成配题；没有 OCR 环境时可直接逐图阅读。OCR 的 raw/clean 文本、框位置、图像哈希均保留，清洗结果不能作为原书空格、公式或阅读顺序的证明。新电脑的 OCR 模型运行仍需实际验证，dry-run 只检查来源和选页。

先读原页，再用 OCR 辅助定位。按栏目、双栏、跨页关系建立逐页 candidate 清单。检查无编号填空/知识框图、具体开放问题和完整实践题。正文题号、组别和节标识不足以唯一配答时用明确 ID 配对；不能只用一个数字找答案。原文和参考答案有疑点就保留说明，不用常识纠正。

需要配图时按原像素 bbox 裁图，记录原页、原图哈希、bbox 和裁图哈希，保全图号、轴字与标签。只裁必要图/表，文字仍写文本。写好[裁图计划](schema.md)后运行：

```powershell
npm run workflow:crop -- --plan=data/jobs/job-01/crop-plan.json --output=data/jobs/job-01/source.json
```

计划、索引和证据同属本次 job；输出 `figures/<id>.png`，将真实 `source.json` 字节哈希写入 mapping。

## 配对与草稿

把 agent 看图所得写成同一任务目录的 `records.json`。原始 OCR 与人工转录分开保存，正文/答案记录保留各自原图区域。再运行：

```powershell
npm run workflow:pair -- --input=data/jobs/job-01/records.json --output=data/jobs/job-01/paired.json
npm run workflow:draft -- --input=data/jobs/job-01/paired.json --mapping=data/jobs/job-01/mapping.json --output=data/jobs/job-01/batch.draft.json
npm run review -- --manifest=data/jobs/job-01/batch.draft.json
```

配对 CLI 只构造保守候选，draft 始终 `pending`。查看输出 issues 和离线题答/原图预览，对照原图修正 `records.json` 或 mapping，再生成新文件；不要删除 issue 后直接批准。准备材料，包括原图/OCR、索引、records、paired、裁图证据、mapping、decisions 及草稿/批准题单，放在同一个 `data/jobs/<job>` 下，使用相对资产路径。`npm run review` 的报告和预览默认输出到独立的忽略目录 `data/review`，无需放回 job；指定输出也须在允许的 `data/review` 内。

配对后可用 `workflow:conflicts` 将问题题目和完整候选答案集中导出。已有明确 plan 与确认题序时，用 `workflow:mapping` 填写目录、起点和实际哈希，再实际补全作答要求及覆盖清单。草稿生成后，`workflow:materials` 按任务、当前预检问题或版本 diff 输出完整题及去重原图区域，减少反复读取整批材料。命令参数及待填写边界见[本地工具](../../../../docs/workflow-tools.md)；这些辅助不判断题序、解决配答或授予批准。

生成文件不会覆盖已有输出。修正后使用新的 paired/draft/decisions/approved 文件名，并将后续命令及哈希引用指向这一版；保留旧草稿和审校证据。

预览按题并排显示真实原图区域和录入内容，并提供逐题 issues、专项问题及覆盖候选的定位链接。修改草稿后可用 `npm run workflow:diff -- --before=<同 job 旧草稿> --after=<同 job 新草稿>` 查看差异与受影响的完整题；不会迁移旧批准。可选的 `workflow:job` 登记实际范围、文件哈希和版本，推导本地阶段，不连接平台或替代上面的基线顺序。具体接口按[本地工具](../../../../docs/workflow-tools.md)。

同一 job 的读图、转录、配对和审校阶段，可复用已经实际看过且 source hash 与 bbox 都相同的原图及具体核对证据，避免重复加载同一像素。先确认材料引用没有改变；修订按 diff 定向打开受影响的完整题和对应来源区域。来源哈希、bbox、配对或覆盖范围变化时重新查看相关原图；若原图已经不在可判断的上下文中，也重新读取。复用图像不等于自动通过 checks，当前内容与覆盖仍要实际核对，并为新草稿形成新的 hash-bound 决定。

## 实际审校与批准

逐题实际查看正文、答案和裁图，并重新核对整题、来源、格式、答案间隔。按[审校规则](../../../../docs/review-rules.md)处理专项项。形成绑定当前草稿字节 SHA256 的 `review-decisions.json`，每题的 evidence 写具体原页/区域及核对结论。没有读图就不能填 `checks: true`。复杂格式或未辨字继续 pending，不伪造线性排版声明。

可先准备默认未通过的模板，再将实际完成的审校决定另存为后续批准使用的文件：

```powershell
npm run workflow:decisions -- --manifest=data/jobs/job-01/batch.draft.json --output=data/jobs/job-01/review-decisions.template.json
```

模板带当前草稿哈希、逐题来源引用，四项 checks、coverageChecked 均为 false，evidence 留空。引用只供定位，不代表读图完成。独立复核可重点检查跨页、无编号和配答冲突，由一位材料维护者统一修订；最终仍逐题审校并核对全部覆盖。

```powershell
npm run workflow:approve -- --manifest=data/jobs/job-01/batch.draft.json --decisions=data/jobs/job-01/review-decisions.json --output=data/jobs/job-01/batch.approved.json
npm run review -- --manifest=data/jobs/job-01/batch.approved.json
```

批准工具拒绝哈希失配，不替人判断内容，也不清除既有 issues。确认最终 `valid: true`、`readyForExecution: true`、逐页候选全部解决后，在已授权范围内执行；无需再逐题索要用户许可。

## 追加、接续和验收

首次在这本书或电脑上试录一题：

```powershell
npm run recorder:execute -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=1
```

这次试录不能加 `--continue`，不能连续提高 limit 绕过首题验收。CLI 内部等待终止后，确认真实保存回执、身份/来源和刷新回读通过。已有明确范围授权且整份题单已审校批准时，用同一 manifest/state 接续：

```powershell
npm run recorder:execute -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=20 --continue
```

`execute` 默认每轮最多处理 20 条，`--continue` 只在正常 limit 终止、pending 为空、无错误和写入锁、已处理题目保存与回读通过时自动提交下一轮，沿用同一份批准题单和原进度。服务端同时检查暂停版本及原终止命令，轮次间 pause 也停止接续。pause、error、未知结果、缺少终止证明或写入锁均停止；不要新建 state 重跑同题，不通过换题单或提高上限扩张授权。更大范围分成有明确覆盖边界且已授权的题单，每份独立保存证据。

暂停状态跨断线和服务重启保留，status、probe 等只读操作不解除暂停。用户已有明确恢复授权且原任务已终止安全时，先用原 manifest/state 执行不带 `--continue` 的 execute，通常沿用原 limit。例如原 limit 为 20：

```powershell
npm run recorder:execute -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json --limit=20
```

确认这一轮终止、无 pending/错误/写入锁且保存与回读通过后，才再次运行前面的 `--continue` 命令。已有明确恢复授权即可继续，不增加重复确认流程；未知保存或写入锁先按原任务恢复说明处理。

整批只读验收不需要手填题数：

```powershell
npm run recorder:verify -- --manifest=data/jobs/job-01/batch.approved.json --state=data/jobs/job-01/progress.json
```

`verify` 未给 `--limit` 时核对完整题单，最多 1000 条；显式给 limit 只核对从题单开头起的部分，不能称为整批通过。核对题单与原书覆盖是两项验收。遇到未知保存按[恢复说明](../../../../docs/recovery.md)只读 readback/reconcile 原 taskId 和 pendingPath；这些命令仍走同一 controller 和服务，可加 `--wait --summary`，不能以另一个任务解锁。

最终报告列出授权范围、候选总数/应录/排除/待确认、唯一已保存记录、整批回读结果与证据路径。保存通过与原书覆盖分开说明，未处理的特殊题及未验证的新电脑/新书流程如实列出。暂停或结束时等待 terminal 后 `npm run recorder:stop`，保留所有材料和进度。
