# OCR 纠错：MAX 提示词 v2

用户已选择使用 MAX 推理强度。这里保存可复核的提示词和参考配置，尚未接入或修改任何正在运行的录入任务。

- [system-v2.txt](system-v2.txt)：从已冻结试验逐字节复制的 system 提示词。
- [profile.json](profile.json)：所选模型参数、输入输出约定和集成状态。
- [结果摘要](../ocr-correction-results.md)：同一批 50 道题的对照结果、局限与证据哈希。

`profile.json` 是项目内的配置材料，含说明性元数据；它不是可以直接发送给服务商的完整 API 请求，也不是通用 API 命令。`systemPromptFile` 等字段不代表服务商会自动读取本地文件。集成方需要显式加载提示词、映射受支持的请求参数、构造 user 消息，并验证响应协议。

已测参数为 `deepseek-flash`、`thinking.type=enabled`、`reasoning_effort=max`、`max_tokens=65536`。测试客户端的超时为 600 秒，自动重试为 0；这些客户端设置不能直接当成请求正文参数。模型名称是服务商别名，不保证永久固定到同一后台快照。

当前提示词针对每批 25 道题：输入包含整页原始 OCR `pages`，以及题目边界、按阅读顺序提取的 `rawText` 和独立 M 公式候选 `questions`。这些字段名称只描述已测输入约定，并不构成完整 JSON Schema。原图、人工真值、参考答案和旧模型输出不进入模型请求；原图留给离线复核。改变批量大小、输入结构或模型参数后，应重新验证兼容性和效果。

输出应为含 `decisions` 数组的 JSON，每个输入 ID 恰好出现一次，每项包含 `id`、`action`、`candidateText`、`needsImage`、`reason`。`KEEP` / `REVIEW` 须逐字符保留 `rawText`，`CORRECT` 须实际改变文本，`REVIEW` 须标记 `needsImage=true`。协议完整并不等于转录正确；仅复核 `needsImage=true` 的题，在这次样本中仍会漏掉 3 道错题。

本包不包含执行器、输入题文、原图、凭据或模型推理正文。已有测试曾出现一次远端结果未知的连接失败；额外发送必须有明确授权，不能通过自动重试消除或覆盖失败证据。

提示词 SHA-256：

```text
057269e3244acea8c2c18060a814e5bdb902c6f96049217ffb58bc316a684fb3
```
