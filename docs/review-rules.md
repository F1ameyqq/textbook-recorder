# 审校规则

执行器只能核对题单里列出的任务。题单准备者负责确认原书覆盖、题目边界、答案对应及表示方式；另一人复核后再批准。OCR 或模型输出作为草稿，原图是审校依据。

## 覆盖与分题

逐页记录候选内容、阅读顺序、来源页、应录或排除理由。跨页、跨栏内容需合并到同一题，无题号的知识框图、填空、表格和开放问题也要检查，不能只按已有平台列表倒推题数。

有具体待回答问题即保留，即使没有答题线或印刷题号。纯知识说明、活动流程或宽泛项目安排，没有独立作答要求时排除。同一实践题内的步骤、小问和必要背景保持整体，不为了增加条数拆碎。边界不确定时记入待确认，不能据此宣称覆盖完整。

`target.record` 按平台该节顺序填写，章、节名称需与真实目录一致，包括空格。题单中的任务 ID 唯一，同一节序号连续。原书印刷编号保留在题干中，与平台记录序号分别核对。

## 题干、答案与来源

普通题干、选项、说明和计算过程录为文本。保留原小问、选项标签、表格信息、单位及必要上下文。难辨字对照原图放大检查，不能用常识或外部版本替换原书。

每题分别核对正文与答案原图。答案跨页时保留完整过程；复合题不能只录最后结果。原书疑似错字或参考答案冲突需留下审校说明，由负责人决定，不能静默纠正。

每条任务填写 `answerRequirement`：`kind` 为 `question` 或 `fill-in`，`evidence` 记录具体问句或待填项。`answerStatus` 为 `provided` 或 `not-provided`；缺答备注不能代替作答要求的证据。

开放题无官方答案时不猜答案。只有负责人确认采用此规则，才使用“原书未提供参考答案”，并记录查过的答案范围。没有官方答案本身不是排除具体问题的理由。

`source.pages` 与 `source.answerPages` 填平台来源图片序号，均为非空、不重复正整数数组。跨页题保留全部相关页；数组第一项是保存关联的主要来源。不能把扫描书的印刷页码直接当作平台图片序号。

## 文本、图片和格式

- 配图使用原像素裁图，保全坐标轴、接线端、字母、图号及必要标签；不要夹入相邻题文字。
- 仅配图、必要框图或表格作为图片。每个图片块填写 `purpose: "diagram"` 或 `"table"`；普通题干和文字选项不能整题截图。
- 每张图片单独成段，`align: "center"`；图片后的文字另起左对齐段落。
- 图片仅用 PNG/JPEG，使用题单目录内的相对路径；不链接到私人绝对路径或外部图片。
- 简单上下标用 `runs` 中的 `sup`、`sub`，不能把指数、变量下标或单位位置改错。
- 多个已确认填空答案用 `parts`，相邻答案保留八个半角空格。HTML 使用八个不换行空格保持显示；不能用全角空格、制表符或折叠后的普通比较代替。
- 含上下标的多答案段落用 `runs` 并标记 `strictSpacing: true`，每个答案间隔仍需逐一核对八个半角空格。

本版没有通用原生复杂分式、加点字等特殊格式渲染器。原书使用上下分式或特殊强调时，将任务留在待审校并交人工处理；不能用斜杠自行改写几何关系，也不能用整题图片规避文本要求。

疑似斜杠分式或方框字符会产生专项待审项。`valid: true` 只表示结构可供预览；专项问题未解决时 `readyForExecution` 为 `false`，不能执行。报告的 `requiresSpecialReview` 列出全部专项项及 `resolved` 状态，`unresolvedSpecialReview` 列出尚未解除的项。

对照原图确认后，可在该任务的 `review.specialReview` 中声明：

```json
{
  "fractionLayoutConfirmed": true,
  "sourceLayout": "linear",
  "printedSquaresConfirmed": true
}
```

各字段可省略；`sourceLayout` 仅允许 `linear` 或 `stacked`，两个 `Confirmed` 仅允许布尔值。`fractionLayoutConfirmed: true` 与 `sourceLayout: "linear"` 必须同时成立，才表示本题所有疑似斜杠表达在原书中均为线性排版，可解除该风险项。原书是上下分式时填 `stacked`，本版仍阻止执行，不能为通过校验谎报线性。

原文确实印有 `□` 或 `■` 时，才可设置 `printedSquaresConfirmed: true`；OCR 丢字形成的方框需重新辨字。Unicode 替换字符 `U+FFFD` 始终阻止执行，不能用确认字段解除。这些字段记录人工判断，程序不会据此证明原图已核对；只填写本题实际需要且已经完成的确认。

逐页候选登记在 `coverage.pages` 中。候选 `type` 为 `question`、`knowledge-construction`、`whole-activity` 或 `non-question`；`decision: "include"` 对应恰好一个完整任务，跨页题在每个来源页都登记映射。纯流程或说明使用 `non-question`、`decision: "exclude"`、空 `taskIds` 及具体 `reason`。待定项未解决前不能通过覆盖验收。可用 `imagePath` 附本地原页图，便于预览核对。

## 合成结构示例

以下仅演示结构，`source: "fixture"` 不是生产题单。真实书号、目录、来源和答案需重新核对。

```json
{
  "schemaVersion": 1,
  "kind": "new-system-batch",
  "bookId": 1,
  "source": "fixture",
  "coverage": { "pages": [{
    "page": 1,
    "candidates": [{
      "id": "synthetic-candidate-1",
      "type": "question",
      "decision": "include",
      "taskIds": ["synthetic-section-record-1"]
    }]
  }] },
  "tasks": [{
    "id": "synthetic-section-record-1",
    "target": {
      "chapterLabel": "示例章",
      "sectionLabel": "示例节",
      "record": 1
    },
    "source": { "pages": [1], "answerPages": [2] },
    "answerRequirement": {
      "kind": "fill-in",
      "evidence": "依次填写两个答案。"
    },
    "answerStatus": "provided",
    "stem": { "blocks": [
      { "type": "text", "text": "合成演练：依次填写两个答案。" }
    ] },
    "answer": { "blocks": [
      { "type": "text", "parts": ["示例甲", "示例乙"] }
    ] },
    "review": {
      "status": "pending",
      "issues": ["示例未做生产审校"],
      "checks": {
        "sourceText": false,
        "answerMatch": false,
        "wholeQuestion": false,
        "format": false
      }
    }
  }]
}
```

审校通过后才设置 `review.status: "approved"`、`issues: []`，且四项 `review.checks` 均为 `true`。四项分别对应原文、答案归属、整题完整性和格式。专项项也必须全部解决。`npm run review` 检查结构、资产及风险，不代表人工审校已经完成。执行器不会批准仍有问题的题目。

## 两项验收

题单保存验收核对唯一服务器记录、真实业务成功回执、刷新回读、全文、图片字节与居中、上下标、答案间隔及来源。原书覆盖验收则核对候选清单与题单一一对应，所有排除项有理由，待确认项已解决。题单数量正确不能代替原书覆盖核对。
