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
