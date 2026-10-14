# 本地数据接口

准备文件的引用路径相对于本次 `data/jobs/<job>` 材料目录，题单图片只用该目录内的相对路径。平台任务的配置、索引和所有 JSON 的 `bookId` 一致；纯本地 fixture 不要求配置，mapping 与题单保持 `source: "fixture"`。`npm run review` 的报告/预览默认在独立的 `data/review` 忽略目录，显式输出也限该目录，不属于配对/草稿输入的同 job 约束。命令只用于本地文件处理；草稿不是写入批准。以下示例是结构说明，不能把示例直接作为生产内容。

## 索引与裁图

`collect` 摘要给出 `indexPath`，索引至少包含 `schemaVersion: 1`、`bookId` 和 `pages`。页条目包含 `systemPage`、`file`、`sha256`、尺寸、类型与采集时点。配图必须可追溯到该索引中的原像素图。

裁图计划：

```json
{
  "schemaVersion": 1,
  "bookId": 100001,
  "index": {"path": "index.json", "sha256": "<当前索引文件SHA256>"},
  "crops": [{"id": "diagram-01", "page": 1, "bbox": [10, 20, 110, 120], "purpose": "diagram"}]
}
```

`purpose` 仅 `diagram` 或 `table`；bbox 为 `[left,top,right,bottom]`，取 agent 实际看图确定的原像素边界。生成 `figures/<id>.png` 和 `source.json` 证据，mapping 绑定后者的真实 SHA256。有裁图时必须提供 `cropEvidence`；没有裁图不填虚构证据。

## records 与 paired

```json
{
  "schemaVersion": 1,
  "bookId": 100001,
  "questions": [{
    "id": "question-01", "chapter": "示例章", "unit": "示例节", "group": "基础训练", "questionNumber": "1",
    "rawOcr": "保留原始识别文字",
    "source": {"pages": [1], "images": ["images/page-0001.png"], "regions": [{"page": 1, "image": "images/page-0001.png", "bbox": [0, 0, 120, 150]}]},
    "blocks": [{"type": "text", "text": "实际看图后的完整转录"}]
  }],
  "answers": [{
    "id": "answer-01", "chapter": "示例章", "unit": "示例节", "group": "基础训练", "questionNumber": "1",
    "rawOcr": "保留原始答案识别文字",
    "source": {"pages": [2], "images": ["images/page-0002.png"], "regions": [{"page": 2, "image": "images/page-0002.png", "bbox": [0, 0, 100, 80]}]},
    "blocks": [{"type": "text", "text": "原书完整答案"}]
  }],
  "pairings": [{"questionId": "question-01", "answerId": "answer-01"}]
}
```

`unit` 可省；`group` 或 `section` 用完整栏目身份，两者同时填时一致；题号可为 `null`，不可为配对编造号码。跨页整题使用多 `pages` 和逐页 regions。CLI 的自动键是明确的章/单元/组别/题号，不会从 OCR 猜组别。显式配对仍需读图确认；重用答案、重复键、缺来源和未配对均保留问题。

没有运行 OCR 而直接读图转录时，`rawOcr` 保留为空字符串，实际转录放在 blocks；不能把 agent 写的文字标成原始 OCR。

中间 blocks 支持 text、latex、image；中间保存 latex 不表示最终执行器有该渲染能力。不要将复杂公式降级为线性表达来消除问题。

普通货币及其他正文中的 `$` 保留原字符和原空格，仍使用 `text` 或文本 `runs`，不改为全角符号、零宽字符、额外反斜杠或虚构公式。浏览器编辑命令仅在 detached 已审 HTML 中将每个普通 `$` 放入独立的 `white-space:pre` 行内 span，再通过原有 `insertHTML` 输入；该 span 只含原 `$`，不增加字符，也不改变格式范围。真正的 `math-tex` / `.formula-node` 子树不参与此保护。输入后及通用追加/答案修正的保存动作前，必须确认原字符、空格和隔离结构保留；结构被清洗即停止，不能删除误转公式或退回剪贴板重试。通用题单刷新回读拒绝多余原生公式；首次合入仍先单题真实保存、独立刷新全文及既有记录不变验收。

### 严格空格与分段

题干和答案的 `type: "text"` 块可显式声明 `strictSpacing: true`，适用于普通 `text`、`runs` 或带 `emphasis` 的文本；`strictSpacing` 仅允许布尔值，不用于图片、上下标独立块或解析分隔线。最终文字保留所需的 ASCII 空格，渲染时将每个半角空格转换为 NBSP；语文正文段首的两个 U+3000 全角空格原样保留，以显示两个汉字宽度。回读仅归一化 NBSP 与换行表示，逐段精确比较，保留 U+3000，不删除首尾空格或压缩间隔。未声明或为 `false` 时保持普通文本默认语义。

语文教材的题干和答案 text 块均显式设置 `strictSpacing: true`，默认排版与验收按[语文试题格式](chinese-format.md)。空格和段落先定稿，再按最终文字计算 `emphasis` 范围：普通块使用 `block.text`，含上下标的块使用所有 `runs[].text` 按顺序连接的全文，包含全部空格和上下标字符。修订后重新绑定批准与保存回读。

### 原生加点、下划线与粗斜体

普通 `text` 块可声明下面的严格范围接口，题干和答案解析均适用。这个示例在“亵”下加点、在“诗歌”下画线：

```json
{
  "type": "text", "text": "1. 亵渎诗歌",
  "emphasis": {
    "schemaVersion": 1, "indexUnit": "unicode-code-points",
    "marks": [
      {"type": "emphasis-dot", "start": 3, "end": 4, "text": "亵"},
      {"type": "underline", "start": 5, "end": 7, "text": "诗歌"}
    ]
  }
}
```

`start`/`end` 相对完整的最终文字，包含题号、解析前缀、空格和上下标字符，起点包含、终点不包含；范围长度使用 `Array.from(最终文字)` 的 Unicode code point 计数。浏览器 DOM 使用 UTF-16，执行器负责转换，材料不能混用单位。每个标记的 `text` 必须等于该范围的原文。仅接受 `emphasis-dot`（字下加点）、`underline`（直线下划线）、`underline-wavy`（波浪下划线）、`italic`（斜体）、`bold`（粗体）及明确版本与单位；非整数、空区间、越界、同类交叠、错文字、未知字段或类型以及拆开字符的范围均拒绝。不同格式可在同一文字范围共存；直线和波浪线不能在同一字符上交叠。

斜体、粗体渲染为原生 `<i>`、`<b>`，粗斜体在同一范围同时声明 `italic` 和 `bold`，不改写原文字。例：文字 `Read Title.` 中的书名可声明 `{"type":"italic","start":5,"end":10,"text":"Title"}`。输入后及保存刷新后按最终文字逐字符校验实际计算样式、类型和范围；仅保留标签、相同文字、相同格式数量均不足以验收。首次在本书使用某种新格式时，先完成包含该格式的单题真实保存、独立刷新全文及原记录不变验收，再接续含该格式的批量题单。斜体试录通过不等于粗体或粗斜体已验收；本地测试也不证明平台支持。

波浪下划线示例：`{"type":"underline-wavy","start":2,"end":5,"text":"甲①乙"}`，可替换下方合成 runs 示例中的直线标记。原生渲染使用带 `text-decoration-style: wavy` 的 `<u>`，实际编辑器和刷新回读必须确认计算样式同时包含 `text-decoration-line: underline` 与 `text-decoration-style: wavy`。仅存在 `<u>` 标签、文字相同或画线范围相同均不足以证明波浪线保留；降为 solid、丢线、变为 dotted/dashed 等样式均拒绝。范围按原图实际画线的字符计算，不自动包含后续标点。

带 `emphasis` 的块必须为 `type: "text"`，内容在 `text` 字符串与 `runs` 数组之间二选一，不允许 `parts`。`runs` 的每项仅含 `type`、`text`，类型为 `text`、`sup` 或 `sub`；不能在 run 内另写 emphasis，不能拆开完整 Unicode 字符或字素。块级标记可跨 run 边界，也可只覆盖上下标 run 中的部分文字，原自然段保持一段。下面是合成接口示例：

```json
{
  "type": "text", "strictSpacing": true,
  "runs": [{"type": "text", "text": "\u3000\u3000甲"}, {"type": "sup", "text": "①"}, {"type": "text", "text": "乙。"}],
  "emphasis": {"schemaVersion": 1, "indexUnit": "unicode-code-points", "marks": [{"type": "underline", "start": 2, "end": 5, "text": "甲①乙"}]}
}
```

组合格式保存后，刷新回读必须同时核对全文、精确空格、加点/直线/波浪线/粗斜体的类型、实际样式和范围及上/下标字符的类型和位置；仅上下标数量正确不足以验收。独立上下标块、图片或解析分隔线仍不能声明 emphasis。

旧 `sourceSegmentText`、`offsetsRelativeTo`、token-only 标记或组合加点/横线字符不能自动转换为执行内容。保留旧材料，对照原图将实际范围写入新的 `replacementBlocks`，生成新 mapping/草稿和新哈希审校决定。最终文本或前缀变化时重新计算范围，不在带范围的文本上沿用会改变字符位置的 OCR 清洗结果。合法结构与预览不证明原图判断或平台实际格式通过；仍需逐图核对、哈希绑定批准和真实保存后的刷新回读。复杂上下分式及其他未支持格式继续阻止执行。

## mapping 与 pending draft

```json
{
  "schemaVersion": 1, "kind": "new-system-draft-mapping", "bookId": 100001, "source": "production",
  "index": {"path": "index.json", "sha256": "<当前索引文件SHA256>"},
  "cropEvidence": {"path": "source.json", "sha256": "<当前裁图证据SHA256>"},
  "placements": [{
    "questionId": "question-01",
    "target": {"chapterLabel": "平台实际章名", "sectionLabel": "平台实际节名", "record": 1},
    "answerRequirement": {"kind": "question", "evidence": "原书具体待回答问句"},
    "answerStatus": "provided",
    "agentReview": {"checkedAgainstOriginal": true, "evidence": "实际原页/区域及配对、整题核对说明"}
  }],
  "coverage": {"pages": [{"page": 1, "imagePath": "images/page-0001.png", "candidates": [{"id": "candidate-01", "type": "question", "decision": "include", "taskIds": ["question-01"]}]}]}
}
```

`target.record` 从平台基线后的序号开始，同一节连续；文字标签与实际目录精确匹配。`answerRequirement.kind` 为 `question` 或 `fill-in`，evidence 必须是具体问题或待填项，缺答备注不算。

`coverage.pages[].candidates[].id` 在整个批次中唯一。跨页整题在每页使用不同 candidate ID，例如 `activity-page1` / `activity-page2`，但两者的 `taskIds` 都只指向同一个完整 task ID。不能复用 candidate ID，也不能为修正重复 ID 而拆开完整活动。结构校验报错时按报错修正输入并生成新版本；旧草稿仍保留，未通过的草稿不能批准。

`replacementBlocks` 可包含 `stem` 和/或 `answer`，使用最终题单的 text/runs/parts/image 块，原文与 OCR 不改写到同一字段。使用时必须实际逐图核对，并给出 `agentReview.checkedAgainstOriginal: true` 和具体 evidence。图块填写原像素裁图 path、`align: "center"`、purpose，另有 `source: {page,image,bbox,sha256}` 绑定原页图；这里的 sha256 是原图哈希，裁图哈希由 `source.json` 提供。上下标及答案间隔见[审校规则](../../../../docs/review-rules.md)。

具体开放题无官方答案且用户本次明确授权备注规则时，mapping 增加：

```json
{
  "missingReferencePolicy": {
    "authorized": true, "source": "direct-user-rule",
    "userQuote": "<本次真实用户原话>", "evidenceReference": "<本次授权证据引用>",
    "label": "原书未提供参考答案"
  }
}
```

对应 placement 使用 `answerStatus: "not-provided"` 和 `searchedAnswerPages`，保留具体作答要求以及实际看过的答案原页。没有本次授权就保留缺答 issue；不填虚构引用，不猜官方答案。

## 哈希绑定的批准决定

`review-decisions.json` 绑定草稿的原始文件字节 SHA256：

`workflow:decisions` 可生成同 job 的待填写模板，默认 `coverageChecked: false`、四项 checks 全 false、evidence 为空。额外 `sourceReferences` 仅保存定位引用、`referenceOnly: true`，不是检查证据；模板须实际审校填妥后才能通过 approve。修订版本比较和不可变 job 登记见[本地工具](../../../../docs/workflow-tools.md)，不改变这里的执行数据契约。

```json
{
  "schemaVersion": 1,
  "manifestSha256": "<已实际审校草稿的SHA256>",
  "coverageChecked": true,
  "tasks": [{
    "taskId": "question-01",
    "checks": {"sourceText": true, "answerMatch": true, "wholeQuestion": true, "format": true},
    "evidence": "正文原页/区域、答案原页/区域、配图边界和格式实际核对结果"
  }]
}
```

每条任务都需决定，四个 true 来自实际读图，不能批量机械填写。`coverageChecked` 来自完整逐页候选核对。必要时单题携带 `specialReview`，字段与[专项审校规则](../../../../docs/review-rules.md)一致；上下分式仍不支持、U+FFFD 不能批准。批准程序只验证决定与题单绑定、issues 和执行准入，不能替 agent 证明原图阅读完成。
