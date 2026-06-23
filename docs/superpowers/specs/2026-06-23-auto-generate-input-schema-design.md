# 设计:输入消息时自动推导 input schema

日期:2026-06-23
节点:`vibe-function`(node-red-contrib-vibe-function)

## 背景与目标

`vibe-function` 节点用 `inputSchema` / `outputSchema` 作为提示词,帮助 LLM 生成与
自愈代码。新建一个空白节点时,这两个字段通常为空,用户需要手写 schema 才能让代码
生成有依据。

本功能让节点在"还没写代码、也没有 input schema"的状态下,收到第一条真实消息时,
自动把这条消息发给 LLM,推导出 `inputSchema` 并回填到节点配置,从而引导后续的代码
生成 —— 接上一个真实数据源、发一条消息,节点就自动学到了输入结构。

## 决策摘要

| 维度 | 决策 |
|---|---|
| 生成方式 | **LLM 生成**(把 sample msg 发给 LLM,产出带字段语义的 schema) |
| 触发条件 | **无代码 且 inputSchema 空**(outputSchema 不纳入判断) |
| 启用方式 | **总是启用**(选了 API 配置 + 满足触发条件即跑,无开关) |
| 消息处理 | **照常直通输出**到下游,生成为后台异步副作用 |
| schema 形式 | **自由文本结构描述**(与现有 `inputSchema` 字段一致),非严格 JSON Schema |

## 触发条件(全部满足才执行)

1. 节点收到 `input` 消息。
2. `func` 为空,或去除首尾空白后等于 `return msg;`(默认直通)→ 视为"没写代码"。
3. `inputSchema` 为空。
4. `node.configRef` 能取到有效的 `vibe-function-config` 节点(具备 API 调用能力)。
5. 当前没有正在进行的 schema 生成(in-flight 防重入标志)。

任一条件不满足 → 走原有逻辑,行为零变化。

## 行为流程

```
收到 msg
  ├─ 不满足触发条件 → 原样执行(直通 / 已有代码,进 vm 脚本)
  └─ 满足触发条件 →
       1. 立即把 msg 直通输出到下游(等价 return msg),不阻塞
       2. 置 in-flight 标志,后台异步:
            把这条 msg 采样发给 LLM,生成 input schema(字段名 + 类型 + 含义)
       3. 成功:
            - node.inputSchema = 生成结果(运行时)
            - node._config.inputSchema = 生成结果(写回 flow 配置)
            - RED.comms.publish('vibe-function:schema-generated', {nodeId, inputSchema})
            - node.warn 提示已生成
            - 清除 in-flight 标志
       4. 失败:
            - node.warn 记录错误,不影响流程
            - 清除 in-flight 标志(下一条消息仍可再试)
```

## 关键设计点

- **复用现有模式**
  - LLM 调用走现有 `callLLM(node.configRef, prompt)`。
  - 回写编辑器完全镜像现有的 `code-fixed`:runtime 端 `RED.comms.publish`,
    html 端 `RED.comms.subscribe`。
- **一次性 + 防并发**
  - 生成成功后 `inputSchema` 非空,触发条件 3 永久不再满足,天然一次性。
  - 首条消息生成期间可能并发多条消息;in-flight 标志保证只发一次 LLM 请求。
- **直通输出**
  - 满足条件时,因为本就没有用户代码,直接 `sendResults(node, send, msg, ...)`
    并 `done()`,不进入 vm 脚本执行。
- **生成内容形式**
  - `inputSchema` 是自由文本 textarea,现有 `generate` 接口把它当提示词用。
  - LLM 输出一段可读结构描述(字段名 + 类型 + 含义),风格与用户手写一致,
    避免严格 JSON Schema 的冗长。
- **采样裁剪**
  - 发给 LLM 的 msg 用 `JSON.stringify`,对超大 payload 截断(与现有 autoFix
    prompt 里 `JSON.stringify(inputMsg, null, 2)` 的做法一致,必要时加长度上限)。

## 改动文件

### `vibe-function.js`
- 在 `processMessage`(或其入口)前增加触发判断:满足条件时调用新函数
  `generateInputSchema(msg, send, done)`,并提前 return,不进 vm 执行。
- 新增 `generateInputSchema()` 函数:
  - 直通输出 msg + `done()`。
  - in-flight 标志(如 `node._schemaGenerating`)。
  - 构造 prompt → `callLLM` → 清洗结果 → 回写 `node.inputSchema`、
    `node._config.inputSchema` → `RED.comms.publish('vibe-function:schema-generated', ...)`。
- 新增 schema 推导 prompt(中文,要求只输出结构描述文本)。

### `vibe-function.html`
- 新增 `RED.comms.subscribe('vibe-function:schema-generated', function(topic, data){...})`:
  - 当 `data.nodeId === that.id` 时,把 `data.inputSchema` 填入
    `#node-input-inputSchema`。
  - `RED.notify` 提示"已自动推导输入 schema"。

## 错误处理

- LLM 调用失败 / 解析失败:`node.warn` 记录,清除 in-flight 标志,不向下游报错;
  下一条消息可再次尝试。
- 无 API 配置:不触发(条件 4 不满足),保持静默,不打扰用户。
- `RED.comms` 不可用:`try/catch` 包裹 publish,失败不影响运行时回写。

## 测试要点

- 空白节点(无 func、无 inputSchema)+ 有 API 配置:发一条 msg → 下游收到该 msg
  且编辑器 inputSchema 被填充。
- 已有代码 或 已有 inputSchema:发消息 → 不触发生成,行为不变。
- 无 API 配置的空白节点:发消息 → 直通输出,不报错,不生成。
- 生成期间连发多条消息:只产生一次 LLM 请求,其余消息照常直通。
- LLM 返回错误:流程不中断,warn 提示,后续消息可重试。

## 不做(YAGNI)

- 不加独立开关 / UI 复选框(总是启用)。
- 不做严格 JSON Schema 校验或类型推断引擎。
- 不自动生成 outputSchema(本功能只针对 inputSchema)。
- 不在生成期间缓冲 / 阻塞消息。
