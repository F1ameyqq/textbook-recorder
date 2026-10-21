# 本地审校与任务接续工具

这些工具帮助定位原图、修订题单和管理文件版本，不连接录入平台。原图判断、覆盖核对、哈希绑定批准及未知保存恢复仍按原工作流执行。所有命令从仓库根目录运行。

新增的 `workflow:prepare`、`workflow:patch`、`workflow:incident` 将机械准备步骤、局部修订和故障定位集中为离线入口。接口与两阶段接续示例见[离线准备与局部修订](local-preparation.md)。它们不生成批准或执行进度，也不连接平台；生产任务继续使用其原版本及原恢复流程。

## 集中定位配答冲突

在配对后、生成草稿前，可以将有问题的完整题目与候选答案集中导出：

```powershell
npm run workflow:conflicts -- --input=data/jobs/job-01/paired.json --records=data/jobs/job-01/records.json --index=data/jobs/job-01/index.json --output=data/jobs/job-01/pairing-conflicts.json
```

三个输入必须属于同一 job，paired 中的来源路径与原始字节哈希必须绑定这份 records。报告保留原配对、issues 和 review 状态，提供问题题目全文、候选答案全文、完整章/单元/栏目/题号身份、原图路径、区域与实际哈希。缺少候选或缺答时明确列出诊断，不猜答案或删除问题。

输出为只读定位 JSON，带 `referenceOnly: true` 和 `readyForExecution: false`；它不会改动输入、选择候选或生成批准。对照原图修订 records 后，以新文件名重新配对并生成报告。输出拒绝覆盖已有文件，不扫描与冲突题及候选无关的原图像素。

## 从已确认题序生成 mapping 骨架

使用后文任务登记的 `local-workflow-plan` 格式明确书号、source、正文及答案页、目标章/节、起点和本轮上限，再准备已经按原图确认的题序文件 `order.json`。例如：

```json
{
  "schemaVersion": 1,
  "kind": "confirmed-question-order",
  "bookId": 900001,
  "confirmed": true,
  "sections": [{"chapterLabel": "合成章", "sectionLabel": "合成节", "questionIds": ["question-01", "activity-01"]}]
}
```

`confirmed: true` 由实际核对题序者声明，仅确认排列，不表示完成审校或获得平台执行许可。列出的完整题必须与 paired 的任务集合及次序一致；不按题号、OCR 或文件名猜顺序。需要重排时，先修订 records 并重新生成 paired。

```powershell
npm run workflow:mapping -- --input=data/jobs/job-01/paired.json --plan=data/jobs/job-01/plan.json --order=data/jobs/job-01/order.json --index=data/jobs/job-01/index.json --output=data/jobs/job-01/mapping.template.json
```

生产材料另给 `--baseline=data/jobs/job-01/baseline.json`，只接受包含完整顺序记录的同书、同章/节基线；每节起点必须等于该基线记录数加一，冲突就拒绝生成。基线原始字节复制及多节格式见后文任务登记。fixture 使用明确给定的起点，不要求平台基线。已有裁图证据时可另给 `--crops=data/jobs/job-01/source.json`，由工具填写其实际哈希。

骨架采用现有 `new-system-draft-mapping` 接口，机械填写章/节、连续序号、输入及来源哈希，提供 `requiredFields` 提示。具体作答要求、缺答规则、逐页候选及排除理由、实际审校说明仍须补全；来源引用只供定位。检查默认为 false，evidence 为空，不复制旧检查或批准。未填写具体作答要求的骨架不能直接生成草稿；补全后另存 `mapping.json`，再走原 `workflow:draft` 与审校流程。执行前仍需核对实时平台基线，工具不会因基线变化静默平移已有序号。

`answerStatus: "provided"` 表示原书提供参考答案，不代表配对已确定；有候选但未配定时保留配对问题。`not-provided` 也不会授予缺答备注规则，缺答范围与本次用户授权仍按原接口处理。

`requiredFields` 是生成骨架时的待填写清单，手工补全后不会自动更新；实际完整性以新草稿的预检及原图审校为准。

## 原图对照与问题定位

```powershell
npm run review -- --manifest=data/jobs/job-01/batch.draft.json
```

预览按题显示正文及答案来源区域与录入内容。区域使用原图字节和 records 中的真实 bbox，不另造裁图或审校证据；跨页区域按已声明次序显示，可以展开整页看原像素。缺少区域时明确标记整页仅供定位，不能据此确认题目边界。已查缺答页可以通过冻结索引定位，但不会编造答案区域。

`preflight.json` 的 `diagnostics` 提供级别、代码、字段或块位置、页/题锚点、建议修改的输入和处理说明。预览中的问题可以点击跳到对应题干、答案或覆盖候选。`review.issues` 和专项阻断保持可见；建议只是定位，不能删 issue 或直接填 true 来消除问题。

预览为无脚本的本地 HTML，只嵌入经过检查的 PNG/JPEG，不连接网络，不提供批准或平台写入按钮。

## 生成定向审校材料包

入口只接受能从冻结来源重新生成的完整 pending 草稿，为指定任务、当前预检问题或修订差异选择完整题目。每次恰选一种方式：

```powershell
npm run workflow:materials -- --manifest=data/jobs/job-01/batch.draft.json --tasks=question-01,activity-01
npm run workflow:materials -- --manifest=data/jobs/job-01/batch.draft.json --diagnostics=all
npm run workflow:materials -- --manifest=data/jobs/job-01/batch.draft.v2.json --diff=data/review/job-01-diff/diff.json
```

`--diagnostics` 支持 `error`、`warning`、`review`、`all`；问题由当前完整题单的预检产生。diff 须绑定当前原始字节哈希与路径，工具重新读取同 job 的前后版本计算差异，不能只相信外部填入的 affectedTaskIds。可用 `--outputdir=data/review/job-01-materials-v2` 指定新的输出目录，已有结果不会覆盖。

材料包提供 `materials.json` 和无脚本、无网络请求的 `materials.html`，包含所选完整题干、答案、配对记录与候选、相关逐页覆盖上下文、原图区域及实际哈希。跨页题保留全部已声明来源区域；相同原图字节和 bbox 的重复区域共用一个区域引用，各题的引用次序仍保留。JSON 的原图路径便于直接读图，HTML 嵌入原图字节供离线对照。

题单含解析分隔线时，材料 HTML 用本地横线与“解析”文字标识分区，JSON 保留原块。不加载平台分隔线图片；平台原生图片和实际排版仍需原通路验收。

这些引用仅供定位，不是读图证据。定向包不修改完整题单、不复制已批准 checks，也不生成子集批准。首次逐页覆盖仍查看全部正文页；来源或配对变化时重新检查受影响的完整题，新草稿仍要形成绑定完整字节哈希的审校决定。空选择或仅少量材料不能报告为整批通过。

`workflow:draft` 返回 `valid: false`、退出码 1 时，若摘要给出 `outputPath`，可能已经保留了可供审校的 pending 阻断草稿，仍可用 materials 定位问题。结构或来源错误导致生成前抛错时则没有草稿；先读错误和实际输出，不为取得成功退出码删除 issue 或补虚构授权。

## 准备待填写的审校决定

```powershell
npm run workflow:decisions -- --manifest=data/jobs/job-01/batch.draft.json --output=data/jobs/job-01/review-decisions.template.json
```

入口只接受能够从冻结 paired、mapping、索引与原图重新生成的 pending 草稿。同 job 路径及实际哈希必须一致，输出不能覆盖已有文件。草稿有未解决问题时仍可准备模板，不能据此执行。

模板自动填入当前草稿原始字节 SHA256、每题 taskId 和定位用的来源引用。`coverageChecked` 及四项 `checks` 全部为 false，`evidence` 为空；不会复制旧批准或专项确认。`sourceReferences.referenceOnly` 表明引用只供寻找材料，不是实际读图证明。

逐题实际查看原图，解决输入中的问题后，将实际审校结论另存为 `review-decisions.checked.json`，写清具体原页/区域和结论。若修订导致草稿变化，须重新为新草稿生成模板；旧哈希决定不能批准新版本。

```powershell
npm run workflow:approve -- --manifest=data/jobs/job-01/batch.draft.json --decisions=data/jobs/job-01/review-decisions.checked.json --output=data/jobs/job-01/batch.approved.json
npm run review -- --manifest=data/jobs/job-01/batch.approved.json
```

## 比较修订版本

```powershell
npm run workflow:diff -- --before=data/jobs/job-01/batch.draft.v1.json --after=data/jobs/job-01/batch.draft.v2.json
```

比较必须是同 job、同书、同 source 的题单。输出 `diff.json` 与 `diff.html` 到 `data/review`，对照题干、答案、平台位置、来源、配对、审校说明和逐页覆盖。覆盖变化会提示相关完整跨页题；索引或裁图证据变化保守提示整批复核。无效或重复覆盖页须先修正，避免把丢失的登记当成无变化。

差异报告只比较冻结文件声明，不证明当前资产仍有效，不移植旧检查或生成批准。即使内容未变，草稿字节哈希变化也须重新绑定完整批准决定。需要再次输出时明确指定新目录：

```powershell
npm run workflow:diff -- --before=data/jobs/job-01/batch.draft.v1.json --after=data/jobs/job-01/batch.draft.v2.json --outputdir=data/review/job-01-diff-second-check
```

## 登记任务范围、阶段与版本

此入口是可选的本地接续辅助。先在同 job 准备 `plan.json`，只写本次已经明确的范围。以下为 fixture 结构示例，不能改成真实追加授权：

```json
{
  "schemaVersion": 1,
  "kind": "local-workflow-plan",
  "bookId": 900001,
  "source": "fixture",
  "scope": {
    "pages": [1, 2, 3],
    "sections": [{"chapterLabel": "合成章", "sectionLabel": "合成节", "startRecord": 1, "recordLimit": 20}]
  }
}
```

生产任务可另保留本次真实 `authorizationEvidence: {userQuote, evidenceReference}`。登记文件不能授予追加或缺答权限。`scope.pages` 包含本次正文及答案材料，起点仍须来自原平台基线；fixture 使用用户材料给出的起点。

```powershell
npm run workflow:job -- --action=init --job=data/jobs/job-01 --plan=data/jobs/job-01/plan.json
npm run workflow:job -- --action=next --job=data/jobs/job-01 --role=draft
```

`init` 创建不可覆盖的 `job.json`。`next` 返回当前未占用的版本路径和已经登记的输入引用，不占用路径、不生成题单；实际生成入口仍拒绝覆盖。完成文件后使用其真实字节哈希登记：

```powershell
$artifactHash = (Get-FileHash -LiteralPath 'data/jobs/job-01/draft.v0001.json' -Algorithm SHA256).Hash.ToLowerInvariant()
npm run workflow:job -- --action=register --job=data/jobs/job-01 --role=draft --file=data/jobs/job-01/draft.v0001.json "--sha256=$artifactHash"
npm run workflow:job -- --action=status --job=data/jobs/job-01
```

支持角色：index、baseline、records、paired、mapping、draft、decisions、approved、state。每次登记产生 `job.vNNNN.json`，绑定上一快照字节哈希；旧快照保留。批准登记须能从原草稿和实际审校决定重新验证。

单节 probe 的原导出通常位于 `data/persistent-executor/jobs/<本次命令>/scope-records.json`。先将原始字节原样复制到本 job 根目录，核对复制前后 SHA256 相同，再作为 baseline 登记；保留原报告。跨节可使用 `{kind: "local-section-baselines", bookId, scopes: [各原报告]}`，顶层与各报告 bookId 一致。缺身份、题序不连续或记录顺序异常会被拒绝，不能仅用 recordCount 代替完整快照。

`status` 从实际文件、来源哈希及进度推导本地阶段和阻断原因。只看到了文件不能算采集、生产保存或覆盖验收通过；`platformExecutionAllowed` 和 `platformAcceptanceVerified` 始终为 false。生产首次追加前仍通过原 CLI 重核实时基线、终止状态及单题试录。

state 是原执行器持续更新的文件。先用原 `recorder:status` 确认任务终止、pending 和未知保存已解除，再使用同一原路径和当前实际哈希更新登记，不新建 state 接续。旧登记哈希与当前进度失配时，本地 status 会暂时阻断。快照只保存历史引用和哈希，不备份 state 每次的旧内容；原执行器进度和恢复证据继续保留。出现 pending、保存意图、未知结果或原运行锁时，本地入口只提示原恢复流程，不删除锁、重发保存或换题单。正常接续继续使用原 `recorder:execute` 和 `recorder:verify`。

## 独立复核分工

在明确范围内，可由一个 agent 初读原图、建立完整候选与转录，另一个 agent 只读复核跨页活动、无编号内容、答案配对冲突和格式风险。复核者返回具体页/区域及发现，由材料维护者统一修订新版本，避免同时改同一 JSON。

风险复核帮助发现问题，不能替代初读者的逐页覆盖检查和每题实际审校。最终批准仍覆盖完整题单并绑定当前字节哈希；只有一位客户端执行平台写入。
