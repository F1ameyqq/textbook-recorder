# 教材录入助手 · v0.2.0

把已经对照原书审校的 JSON 题单，按指定书籍和目录顺序追加到录入平台。执行器逐题检查保存回执，并刷新回读题干、答案、来源页和图片；遇到差异或保存结果未知就停止。

题目拆分、答案对应和原书覆盖需要人工或模型辅助审校。执行阶段不调用模型。本项目提供半自动工作流，尚未完成新书、其他电脑及完整安装流程的实际验收，不能据此承诺全自动或无人值守完成整本书。

## 当前范围

| 支持 | 本版边界 |
| --- | --- |
| 已审校题单的顺序追加 | 不批量删除、重建或覆盖已有不同内容，不提交审核 |
| 文本、普通上下标、独立居中的 PNG/JPEG 配图 | 通用原生复杂分式、加点字等特殊排版尚未支持；转入待审校，不把整题截成图片替代 |
| 来源页、答案八个半角空格间隔、保存身份及刷新回读检查 | 检查题单中的任务，不能自行证明原书没有漏题 |
| 持久进度、暂停、只读核对与受约束的恢复 | 结果未知时保留写入锁，不自动重发保存 |
| 合成离线演练和跨系统离线 CI | 实际网页录入目前面向 Windows + Edge；Ubuntu CI 不代表生产浏览器支持 |

结构有效不等于可执行。疑似分式、方框及替换字符会进入专项审校；原书线性表达或印刷方框的确认方式见审校规则，原书上下分式与未辨清字符继续阻止执行。

## 环境与第一次使用

需要 Node.js 22 或更高版本、Windows、Edge、已登录的目标录入页面及 Playwright 浏览器扩展。项目固定使用 `@playwright/mcp@0.0.83`；通过锁文件安装依赖。

在项目目录打开 PowerShell：

```powershell
npm ci
npm run doctor
npm run demo
```

一书使用一份独立工作目录；不要在已有进度的目录里改书号切换到另一书。旧配置、会话和证据保留，另一书从新的仓库副本开始配置。

`demo` 生成 `data/demo/batch.json`、合成配图和 `data/demo/preview.html`。仓库中的 [题单示例](examples/batch.example.json)也只用于学习结构，均为 `fixture`。不能把它们改成 `production` 向真实平台提交；真实题单须用自己的原书重新准备与审校。

初次 `doctor` 会提示尚未配置的项目。按 [配置示例](config/recorder.example.json)生成本地 `config/recorder.json`，必须填写负责人分配的实际书号：

```powershell
$bookId = Read-Host '输入本次负责的书号'
npm run configure -- "--book-id=$bookId"
```

配置命令不会覆盖已有文件。然后配置自己的扩展令牌：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-extension-auth.ps1
```

令牌通过本地隐藏输入保存，使用 Windows DPAPI 加密；不要发到聊天、提交 Git 或复制给朋友。每台电脑、每个 Windows 用户各自配置。`doctor` 和 `demo` 不写入平台。

配置后再运行 `npm run doctor` 检查准备情况。

[快速开始](docs/quickstart.md)说明连接、审校、执行及关闭步骤。先完成离线演练和只读核对，再录入自己的小批题单。

## 常用命令

```powershell
npm run review -- --manifest=data/jobs/batch.json
npm run recorder:service
```

服务启动后尚未连接浏览器。在另一个项目终端运行：

```powershell
npm run recorder:status
npm run recorder:probe
npm run recorder:verify -- --manifest=data/jobs/batch.json --state=data/jobs/progress.json
npm run recorder:execute -- --manifest=data/jobs/batch.json --state=data/jobs/progress.json --limit=20
npm run recorder:pause
npm run recorder:stop
```

`execute` 默认最多处理 20 条。达到上限后的正常 `stopped` 不等于失败；确认 `pending` 为空、`writeBlocked` 为 `false`、无错误且已处理题目回读通过后，可用同一题单和进度路径再次执行接续。整批只读核对应显式设置足够的 `--limit`，详见快速开始。命令返回任务标识不等于录入完成；以状态中的终止结果、逐题保存证据和刷新回读为准。执行时保持目标页面可用，不在同一页面手动编辑。

## 审校与协作

- [审校规则](docs/review-rules.md)：原书覆盖、分题、答案、图片和格式要求。
- [恢复说明](docs/recovery.md)：暂停、核对保存结果和保留未知状态。
- [协作约定](docs/collaboration.md)：分配书籍与目录、交接进度和共享仓库边界。

朋友之间分配不同书籍或明确不重叠的目录。不能共同写同一节；本机运行锁不能阻止另一台电脑写入相同目录。

## 开发验证与仓库内容

```powershell
npm test
npm run demo
npm run check:share
```

CI 在 Windows、Ubuntu 的 Node.js 22/24 上运行纯离线测试、合成演练及共享内容扫描，不连接真实平台。依赖旧生产资产的浏览器及公式场景未纳入共享版 CI，CI 通过不代表实际网页验收。OCR 辅助脚本是可选能力；本版不把 Python/PaddleOCR 环境作为基础安装步骤，OCR 输出仍需原图审校。

私有 GitHub 仓库只共享程序、文档和合成样例。原书内容、题单、图片、平台记录、执行证据、账号、令牌及本地配置留在各自电脑；私有仓库也不适合存放这些材料。
