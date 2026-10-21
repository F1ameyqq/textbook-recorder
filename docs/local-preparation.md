# 离线准备与局部修订

这些入口仅处理当前副本 `data/jobs/<job>/` 内明确提供的本地文件，不连接浏览器、服务、平台或云端模型，不读取真实登录配置。当前改造在独立副本验证，未替换任何运行中的录入任务。

## 统一准备入口

从已核对的范围、题序和来源开始。`records` 是已有转录，不是自动 OCR 分题；`order.confirmed` 只由实际确认题序者填写。所有输入 JSON 位于同一 job 根，图片仍通过 index 绑定该 job 中的真实字节。

```powershell
npm run workflow:prepare -- --plan=data/jobs/example/plan.json --records=data/jobs/example/records.json --index=data/jobs/example/index.json --order=data/jobs/example/order.json
```

入口自动配对、生成冲突报告、mapping 骨架，登记每份输入与产物的字节 SHA256，返回 `mapping-required`。骨架中的作答要求、候选覆盖、检查及 evidence 不自动补为通过。读图补全骨架后另存为 `mapping.checked.json`，再运行：

```powershell
npm run workflow:prepare -- --plan=data/jobs/example/plan.json --records=data/jobs/example/records.json --index=data/jobs/example/index.json --order=data/jobs/example/order.json --mapping=data/jobs/example/mapping.checked.json
```

第二阶段重新验证明确范围和题序，生成完整 pending 草稿、默认未通过的 decisions 模板、预检 JSON 和完整题材料 HTML/JSON，停在 `review-required`。错误或冲突保留在 `review-blocked`/`blocked-input`；生成文件不等于审校通过。需要实际审校后另存新决定文件，再按原 `workflow:approve` 流程处理。

每次显式调用产生 `prepare.v0001.json`、`prepare.v0002.json` 等不可覆盖收据，前后以原字节哈希链接。同 job 的书号、source 和初始 plan 原字节哈希固定；修改范围需新建独立准备 job。产物名称包含对应版本，审校材料在当前副本 `data/review/<job>-prepare-vNNNN/`。控制台只给阶段、数量、路径、哈希和简短待办；完整诊断在文件内。

收据是这次编排的本地登记，不是旧 `workflow:job` 注册快照，不授予执行许可。入口不自动调用旧任务的 status/register，以免读取运行中的 session/config。它拒绝包含原 state/progress/pending/intent 文件名或锁的 job；请使用独立准备 job，不能用新版本绕过原任务恢复。

production 材料仍需显式 `--baseline=data/jobs/example/baseline.json`，只能使用同书、同目录、连续完整记录的历史快照，起点必须精确匹配。fixture 不接受 baseline 改写起点。已有裁图使用 `--crops=.../source.json`；不推断页面、目录、题序、缺答授权或旧题修订。

骨架自动包含 `sourceBinding`，绑定 records、plan、order、index 及显式 baseline/crops 的原字节 SHA256。补全 mapping 时保留它；模板已有 provenance 也必须匹配当前来源哈希。来源、转录或配对变化时，旧 mapping 会被拒绝，须先不带 `--mapping` 生成新骨架，再实际核对并补全，不能静默重绑旧审校声明。仅文件版本名称变化且绑定字节相同的机械引用可更新到本次 paired；输入 mapping 的原字节哈希继续留在收据中。

## 局部修改接口

只修改准备材料 records 的 blocks 或 mapping 的 replacementBlocks，不能直接修改 pending/approved 题单、执行 state、服务器 ID、来源或目录。patch 必须绑定输入文件原始字节 SHA256，所有输入输出同 job，输出名称显式且不得已存在。

```json
{
  "schemaVersion": 1,
  "kind": "local-preparation-patch",
  "sourceSha256": "<records.json 原始字节 SHA256>",
  "operations": [{
    "op": "replace-text",
    "collection": "questions",
    "recordId": "q1",
    "blockIndex": 0,
    "expectedText": "原稿文字",
    "text": "实际看图确认后的完整新文字"
  }]
}
```

```powershell
npm run workflow:patch -- --input=data/jobs/example/records.json --patch=data/jobs/example/patch.json --output=data/jobs/example/records.v2.json
```

mapping 使用 `questionId` 和 `side: "stem" | "answer"` 替代 `collection/recordId`，定位对应的 replacementBlocks。该接口不增加作答要求、缺答授权或读图通过声明。修改后已有审校声明失效；mapping 中含 replacementBlocks 时，须实际重新核对并另存新的 agentReview 后再生成草稿。

带 emphasis/runs/parts 的块不接受只改文字，以免沿用错误的字符范围。改用 `replace-blocks`，提供 `expectedBlocksSha256` 和完整 `blocks`。旧 blocks 的哈希为 `SHA256(Buffer.from(JSON.stringify(oldBlocks ?? null)))`；新块仍需满足格式契约、保留原图片及来源，并按最终全文声明 Unicode code point 范围。工具只验证结构，不替人证明读图完成。原始 OCR、原书来源和未改题目保留。

随后用新 records 路径运行不带 `--mapping` 的 `workflow:prepare` 取得新来源绑定的骨架；实际复核并补全后，再带新的 mapping 路径生成草稿。若只修改 mapping 内容且 records 等来源不变，仍可直接提交新 mapping。所有新草稿和 decisions 都重新绑定新哈希，旧批准不会迁移。

## 精简异常包

```powershell
npm run workflow:incident -- --report=data/jobs/example/execute-report.json --manifest=data/jobs/example/approved.json --progress=data/jobs/example/progress.json --output=data/jobs/example/incident.json
```

`--report` 必须；`--manifest` 和 `--progress` 可选。三个文件必须是同 job 内明确指定的冻结 JSON 快照；准备失败时可直接使用 `prepare.vNNNN.json` 而省略另两项。入口不会跟随输入内的路径引用，不会访问真实 session/config、服务或平台。

异常包绑定输入原始字节哈希，白名单摘取有限的书号、命令/任务身份、阶段、计数、pending/writeBlocked、错误分类和只读调查建议。不复制完整题目、账号、Cookie、令牌或日志。缺失证据如实保持 unknown；已保存、未保存和可解锁都必须由原恢复流程确定。它不生成恢复执行命令、不删除锁、不重发保存。

需要从真实任务取材料时，先由原任务负责人在安全终止后导出冻结证据，再复制到独立 job；本轮不接触任何真实任务。

## 离线验证

```powershell
npm run test:preparation
```

测试使用本地合成 PNG、跨页题、配答冲突和伪造故障，不加载 OCR 模型、浏览器、登录资料或平台，也不启动录入服务。测试串行运行，限制对现有任务的资源竞争。结果仅证明本地软件及其拒绝路径，不等于新书平台验收，也尚未量化模型额度的实际降幅。
