# 独立运行时：多书并行、无头浏览器与本地诊断

这一版增加独立无头浏览器运行时和多书控制入口。旧配置继续使用原扩展连接，已有录入目录、登录环境和运行中的服务不会自动迁移。开发副本的离线测试不构成真实平台验收；每本新书仍要完成连接、基线、已审单题真实保存、刷新全文与旧记录不变验收。

## 三个改进

多书任务使用不同完整项目目录、端口、会话、浏览器 profile 和页面。每本书内部保持串行保存，不同书可以在各自服务中并行执行；一道题的回执与回读不会借用另一书的结果。用户级资源租约跨项目目录保护同一本书、同一项目和同一浏览器 profile，账号标签不能绕过书籍锁。共享 Edge Default 的扩展运行时保持独占。

`browserBackend: "headless"` 在自己的 profile 中启动无头浏览器，业务操作没有桌面窗口。它不附着当前 Edge、不将现有录入页切换成隐藏页面，也不依赖最小化后的网页定时器。实际文档、控件可见性、遮挡、编辑器焦点、选区、原生输入、普通界面保存回执和刷新回读继续检查；不会伪造 visibility/focus 或改用保存 API。

本地诊断汇总已有阶段耗时，显示慢在哪个阶段以及原命令、终止文件和待核对保存的绑定。新增只读命令终止收尾可处理已落盘却未及时返回的 probe/collect/verify/readback/reconcile；严格匹配原命令、参数摘要、书籍、子进程、时间和题单。它保留暂停、未知保存写锁和仍在途的状态请求屏障。执行成功的解锁范围没有扩大。

这些改进不保证固定的提速倍数。原图审校、完整保存验收和平台自身响应仍决定实际速度；先用诊断中的真实阶段耗时确定瓶颈。

## 每本书独立配置

从完整代码副本建立一书一目录，不复制其他书的真实配置、浏览器 profile、题单、来源素材、进度、批准或证据。依赖通过锁文件安装。

将 [headless 示例](../examples/recorder-headless.example.json)复制为各项目的 `config/recorder.json`，填写本次书号和不同端口。`browserProfileDir` 必须在该项目 `data/browser-profiles/` 的专属子目录。示例书号不是平台执行授权。

当前无头后端使用本机 Edge，并通过实际启动参数核对无头模式、专属 profile 和 Playwright 连接；未取得这些证明就拒绝操作。原扩展模式的登录或环境不会自动继承到新 profile。

新 profile 需要自己的正常登录。显式运行 `npm run recorder:browser-login` 时会打开这个新 profile 的可见登录窗口；手动登录并关闭该窗口后，业务服务才使用其持久登录状态无头执行。登录入口也受资源租约约束，不能与已占用该书或该 profile 的服务同时运行。开发与离线测试不会替用户登录真实平台。

用户明确要求复用登录态时，可以将已登录、已登记且空闲的 `readOnly: true` 专用 profile 中适用于 `https://easylearn.baidu.com` 的 cookie 迁移到另一本书的专用只读 profile。先正常关闭这两个专用 profile 的服务或登录窗口，确认原命令已终止、没有 pending 和未知保存，再显式指定两个独立 worker：

```powershell
npm run recorder:login-cookies -- --source-root=已登录只读worker绝对目录 --target-root=目标只读worker绝对目录
```

迁移只操作本次自有 profile 的本机 cookie，不访问 Edge Default，不复制整个 profile、localStorage、题单、素材或进度，不导航到平台或请求登录、刷新、保存接口。源包保存在源 worker 的 `data/login-cookies/*.dpapi.json`，由 Windows CurrentUser DPAPI 加密；输出仅包含 cookie 数量、名称、domain、path、加密包哈希和自建 context 的安全计数，不输出 cookie 值。计数覆盖所观察的 context 页面请求，不代表浏览器全部后台流量。

导入后私下关闭并重开目标 profile 核对持久 cookie；会话 cookie 保留原有效期，不改造成永久 cookie。`platformLoginVerified` 仍为 false，真正的平台有效性须在用户允许的书籍范围内通过普通只读 `probe` 验收。加密包可为同一明确源/目标书籍对再次使用，追加 `--reuse-package=源项目内加密包路径`，此时不重新打开源 profile。用户已授权目标书的修改测试或录入时，可以显式追加 `--allow-write-target` 导入其独立写入 worker；默认仍拒绝写入目标，源仍须为自有只读 worker。迁移不授予录入权限，两端在取得租约后还会重新检查空闲和未知保存状态。

先完成每书正常工作流所要求的准备与单题验收，再启动多书批量任务。多书支持不改变追加范围、缺答规则、哈希批准、未知保存恢复或审核提交权限。

## 多书控制

将 [fleet 示例](../examples/fleet.example.json)复制到管理项目的 `config/fleet.json`，给每个 worker 填写独立项目的实际绝对 `root`。项目目录和 profile 不得重复、嵌套或通过链接指向同一位置，书号与端口也必须唯一。

```powershell
npm run recorder:fleet -- plan --fleet=config/fleet.json
npm run recorder:fleet -- start --fleet=config/fleet.json --all
npm run recorder:fleet -- status --fleet=config/fleet.json
npm run recorder:fleet -- pause --fleet=config/fleet.json --book=book-a
```

`plan` 只读取并检查明确登记的项目。`start` 并行启动或复用各书本地 supervisor，不连接浏览器、不派发录入。`status` 默认仅查询本机内存快照；显式加 `--remote` 才查询每书浏览器状态。`pause` 只控制明确选中的书或显式 `--all`，不解除写入锁。fleet 不提供 execute、reconcile 或关闭所有浏览器的入口。

从每本书自己的根目录，按原批准和 manifest/state 分别使用原 `recorder:probe`、`recorder:execute`、`recorder:verify` 等命令。两个不同书的独立 execute 可以同时运行；同一本书不能通过另一目录或更改 accountScope 接管。

## 快速状态与问题定位

```powershell
npm run recorder:status -- --local
npm run recorder:diagnose
npm run recorder:diagnose -- --job=原命令ID
```

`status --local` 只请求本地 `/health`，不进入浏览器。它明确标记 `statusSource: local-health`，可能尚未包含刚发生的网页变化，不用于等待验收、连接或解锁。

`diagnose` 仅读取本项目的 session 和 job-result，不请求服务、不连接浏览器、不改变原文件。报告标记 `source: local-files` 和 `productionChecked: false`；按阶段累计耗时排序，同时保留原保存的 manifest/state/taskId 绑定。历史命令报告不能代替当前任务的终止证据。报告不输出题干、答案、导出记录、命令正文或控制凭据。

等待超时后保留原任务，不重发。未知保存先按[恢复说明](recovery.md)核对原命令；不能因为发现终止文件、阶段耗时或一个通用 writePerformed 字段就重试保存。

## 与正在运行的旧录入共存

运行中的旧目录继续使用原代码和连接。不要把新版复制覆盖到该目录，不更换其依赖、profile、窗口模式或桥接，不为测试关闭或重启它。

新租约无法自动约束尚未接入该机制的旧服务。旧录入结束前，不在新版启动与旧任务相同书号的服务；其他新书也先完成独立 profile 和本书验收，再进行平台并发测试。租约只覆盖同一机器同一操作系统用户，不能替代跨电脑的目录分工。

真实平台验收应逐步进行：先一书单题，再两本不同书各自单题，同时核对独立来源、ID、序号、完整内容、刷新回读和旧记录不变。只有真实验收通过后才能报告线上多书并行和无窗口录入可用。

## 已授权草稿修改往返测试

用户明确授权修改现有草稿题时，可使用专用 `draft-roundtrip`，不适用于普通追加授权。计划种类为 `draft-runtime-roundtrip`，来源为冻结的 `server-snapshot`，绑定用户原话、书号、目录、末题原 ID 及完整目录原始八字段文件的 SHA256。此计划不冒充原图审校题单，也不能用于普通 execute。

固定流程仅在原答案后增加临时标记，通过原生编辑器和失焦正常保存，再恢复原始答案 HTML 并正常保存。每次均先核对新鲜的草稿状态、原 ID、来源、原题干及完整目录，发出请求前拦截内容越界；两次业务回执和刷新全文比对通过后才解锁。仅选择普通段落文字答案，不删除或新建题目。

```powershell
node scripts/recorder-control.mjs draft-roundtrip data/jobs/本次作业/roundtrip.args.json --wait --details
```

参数文件仅接受 `manifest` 和 `state` 路径。manifest 是上述冻结计划；state 必须是尚不存在的专用 journal 路径。入口仅支持独立 headless 后台写入 worker；readOnly、扩展模式和重复 journal 均拒绝执行。

失败后保留原进程、计划、基线和 journal，先用同一参数文件执行 `reconcile` 只读核对。只有原进程持续观察到一次已成功且已刷新核对的临时保存、从未开始恢复、连接及 journal 未改变时，`draft-roundtrip-restore` 才能单次恢复原答案。恢复请求已发出但结果未知时禁止再发；跨进程或磁盘上零请求计数不能构成恢复许可。测试成功只证明该次修改保存与恢复，不代表新题追加、删除重建或长期批量任务已经验收。

## 首轮离线开发验证

2026-10-14 首轮完整离线回归共 1363 项：1360 通过、0 失败、3 跳过。新增无头链路、跨书隔离、暂停恢复、终止证据与诊断测试均通过；分享范围扫描及差异空白检查通过。完整日志保留在开发副本 `data/runtime-validation/full-tests-final.log`。

跳过项分别依赖未复制的真实书籍本地 fixture 和 Windows 文件符号链接权限；对应目录 junction 的越界拒绝已有独立测试。跳过项没有被计作通过。

真正固定 MCP 的离线链路使用全新临时 headless profile，验证 init-page 加载、受约束编辑、选区、上下标及原生回读，并阻断页面网络请求；这不是录入平台保存验收。两个本地 supervisor 的组合验证用禁止浏览器连接的 mock，证明独立状态与暂停控制。这一轮没有访问真实教材或启动线上录入。

## 后续只读验证

实际平台验证使用独立 `readOnly: true` 配置和专用 profile；controller、会话及桥接均拒绝 execute 和补题修复。自有 headless context 在平台导航前安装网络屏障，阻断平台 POST、PUT、PATCH、DELETE 以及已知保存地址。每条命令记录绑定书籍、命令 ID 和连接的网络计数，保留刷新导出的完整记录及比较结果。网络证据不保存请求正文、查询参数、认证值或 cookie。

选定目录需真实刷新两次，比较有序 ID、正文、答案和来源字段，并确认两个服务的实际执行区间重叠、profile 与进程独立。带 ` > ` 的章节路径逐级匹配根及直属子节点，避免跨单元命中同名节；所有加载和路径等待共用原目录时限。完整盘点仍拒绝当前未支持的嵌套目录，不用部分盘点冒充全书结果。

只读验证结果不能作为真实保存、多书并行写入或整书覆盖的验收。后续回归与实际测试证据保留在开发副本 `data/runtime-validation/`，与首轮离线日志分开；历史失败日志保留。
