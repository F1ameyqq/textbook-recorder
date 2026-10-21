# OCR 与公式离线对照工具

共享源码仅包含参数化的实验运行器、评分器和合成测试。原书页、题目真值、模型文件、推理结果、日志以及云端响应均保留在各自电脑的 `data/`，不随 Git 推送。

日常文字 OCR 使用 `workflow:ocr`，默认 GPU 0；Python 选择、设备验证和显式 CPU 用法见[快速开始](quickstart.md)。公式 M 模型的实验识别结果只是候选，未接入平台写入器。文本后处理的已选方案是 [MAX 与 v2 提示词](ocr-correction/README.md)。

| 工具 | 范围 |
| --- | --- |
| `scripts/benchmark-gpu-ocr.py` | 对明确提供的页图及审校区域运行指定本地 OCR，引擎和设备由参数选择。 |
| `scripts/run-guarded-ocr.py` | Windows/NVIDIA 单卡实验的采样式资源检查；不是硬资源隔离，不能承诺对共享设备零影响。 |
| `scripts/benchmark-formula-gpu.py` | 历史 S 型两式实验，保留其有限范围。 |
| `scripts/benchmark-formula-m-gpu.py` | M 型最多 16 式的对照运行器。 |
| `scripts/benchmark-formula-m-expanded-gpu.py` | M 型最多 40 式的扩展对照运行器。 |
| `scripts/score-ocr-benchmark.mjs` | Unicode 字符编辑距离、字符错误率及样本完全匹配率；严格指标与忽略空白的次要指标分列。 |
| `scripts/summarize-ocr-benchmark.mjs` | 汇总明确指定目录内的实验结果及资源记录。 |

这些运行器依赖各自声明的冻结输入格式与本地模型，不是任意教材的自动准备入口。公式脚本的 `--check-only` 只验证输入和模型文件，不加载 Paddle 或开始识别。资源门槛、审校绑定或输入检查失败时保留记录，不能删除失败证据以覆盖重跑。

评分器使用示例（输入应由操作者准备并确认）：

```powershell
node scripts/score-ocr-benchmark.mjs --truth=data/benchmark/truth.json --predictions=data/benchmark/predictions.json --output=data/benchmark/score.json
```

模型输出无论是否标为不确定，都需要按原图审校。实验结果不授予题单批准、平台访问或任务版本切换权限。
