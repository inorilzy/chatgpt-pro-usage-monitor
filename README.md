# ChatGPT Pro Usage Monitor

[![CI](https://github.com/inorilzy/chatgpt-pro-usage-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/inorilzy/chatgpt-pro-usage-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.9-blue.svg)](CHANGELOG.md)

一个运行在 ChatGPT 网页端的本机 Tampermonkey 用量估算器，用于记录 GPT-6 Pro 与 GPT-5.6 Sol Pro 的消息使用情况。

> [!IMPORTANT]
> 本项目是**本机估算器**，不是 OpenAI 官方用量页面。它根据当前浏览器中捕获到的普通 Chat 请求进行统计，可能因网页协议变化、未覆盖的请求通道或多设备使用而与官方结果不同。

![ChatGPT Pro Usage Monitor](docs/screenshot.png)

## 功能

- 展示 GPT-6 Pro 周用量（$200 档：200 条/周）。
- 展示 GPT-5.6 Sol Pro 今日用量（$200 档：170 条/天）。
- 展示 GPT-6 Pro 与 GPT-5.6 Sol Pro 今日合计用量（$200 档：200 条/天）。
- $200 档面板展开或折叠时均提供“6 Pro”和“5.6 Pro”快捷按钮；$100 档不显示。
- 支持 $100 / $200 套餐手动切换。
- 发送请求时立即暂记；服务端模型元数据到达后确认、改归或撤销。
- 每个请求独立跟踪，支持在多个对话之间切换并并发生成。
- 监听可观察的 `fetch`、XHR 和相关网页遥测，读取请求模型与响应模型元数据。
- 面板可拖动、折叠、缩放，并记忆位置和大小。
- 支持手动校准、单条修正、JSON 导入导出与识别日志。
- 不保存 prompt、思考内容、回答正文、附件、Cookie 或访问令牌。

## 额度规则

当前脚本内置的 $200 档展示规则：

| 计数器 | 上限 |
| --- | ---: |
| GPT-6 Pro 周用量 | 200 / 周 |
| GPT-5.6 Sol Pro 今日用量 | 170 / 天 |
| 两模型今日总用量 | 200 / 天 |

$100 档按两模型共用每周 50 条展示。套餐由用户在设置中手动选择，脚本不会自动读取账单或订阅信息。

额度和重置规则可能调整，最终以 OpenAI 官方页面和 ChatGPT 界面显示为准。

## 安装

### 直接安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或兼容的用户脚本管理器。
2. 打开 [chatgpt-pro-usage-monitor.user.js](https://raw.githubusercontent.com/inorilzy/chatgpt-pro-usage-monitor/main/chatgpt-pro-usage-monitor.user.js)。
3. 在用户脚本管理器中确认安装。
4. 刷新 `https://chatgpt.com/`。

### 从旧版升级

脚本保留了原有 `@name`、`@namespace` 和内部存储键，以尽量延续旧版记录。升级前仍建议先在面板中导出 JSON 备份。

安装或覆盖脚本后，对已经打开的 ChatGPT 页面执行一次强制刷新：

```text
Ctrl + Shift + R
```

确认面板右下角显示 `脚本 v1.2.9`，并确保没有同时启用多个旧版本。

## 计数逻辑

默认使用“发送即暂记，响应后纠正”：

```text
捕获明确的 Pro 生成请求
        ↓
立即创建 provisional 暂记并更新进度条
        ↓
收到服务端模型元数据
        ↓
一致：确认记录
另一个 Pro：移动到对应计数器
明确非 Pro：撤销该条 Pro 估算
```

回答是否完整结束，不再是计数的必要条件。切换到另一个对话不会主动删除上一条请求；每条请求以独立 ID 跟踪。

明确的 HTTP 失败会按本机估算策略撤销。请求已经发出，但因切换、停止生成或断流而无法确认时，会保留为暂记，因为脚本无法判断官方是否已经消耗额度。

更完整的技术说明见 [docs/detection.md](docs/detection.md)。

## 面板大小与位置

- 拖动面板标题区域可移动。
- 拖动右下角缩放角标可调整整体大小。
- 设置中可选择 70%—160% 的缩放比例。
- 双击缩放角标可恢复默认大小。
- 大小、位置、折叠状态和套餐选项均保存在本机。

## 隐私

脚本只在当前网页中被动观察 ChatGPT 自己发出的请求，并将统计记录保存在用户脚本管理器的本机存储中。

保存内容主要包括：

- 时间戳；
- 模型与档位标识；
- 请求、会话和消息 ID；
- 接口路径；
- 暂记、确认、撤销等诊断状态。

脚本不会主动上传统计记录，也不会保存对话正文、附件或登录凭据。

## 已知限制

- ChatGPT 网页内部接口和模型字段不是稳定公开 API，官方更新后可能失效。
- 未覆盖的 WebSocket、EventSource、Worker 内部请求或提前缓存的原始网络函数可能造成漏计。
- 多设备、多浏览器或清除网站/脚本数据不会自动同步。
- 当前存储未按多个 ChatGPT 账号自动隔离；切换账号后需要自行检查套餐与校准。
- “模型已确认”只表示网页中观察到的模型标识被核对，不代表官方扣额度确认，也不评价回答质量。

## 本地验证

仓库中的本地模拟测试覆盖发送时暂记、并发会话、模型改归、HTTP 失败、断流保留、重复事件去重、存储恢复与缩放记忆等场景。

```bash
python tests/test_local_simulation.py
node --check chatgpt-pro-usage-monitor.user.js
```

测试依赖 Python、Playwright 和 Chromium。详见 [tests/TEST_REPORT.md](tests/TEST_REPORT.md)。这些测试是本地模拟，不是真实 ChatGPT 账号的端到端额度验证。

## 参考与致谢

模型元数据检测思路参考了以下项目；本仓库为独立实现，不捆绑其源代码：

- [zjm54321/chatgpt-scripts](https://github.com/zjm54321/chatgpt-scripts)
- [CwithW/gpt-web-routing-detect-tampermonkey](https://github.com/CwithW/gpt-web-routing-detect-tampermonkey)

额度说明参考：

- [OpenAI Help Center — GPT-5.6 and GPT-6 Pro in ChatGPT](https://help.openai.com/en/articles/20001354-gpt-5-6)

## 许可证

[MIT](LICENSE)
