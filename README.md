# node-red-contrib-vibe-function

AI 驱动的 Node-RED Function 节点，用自然语言描述需求，自动生成、校验、修复代码。基于 **DeepSeek API**（兼容 Anthropic 协议）。

## 安装

```bash
# 进入 Node-RED 目录
cd ~/.node-red

# 克隆或创建插件目录，放入 vibe-function.js 和 vibe-function.html
mkdir -p node-red-contrib-vibe-function
cp vibe-function.* node-red-contrib-vibe-function/
ln -s ../node-red-contrib-vibe-function node_modules/node-red-contrib-vibe-function

# 设置 API Key（二选一）
export DEEPSEEK_API_KEY=sk-xxxxx   # 环境变量
# 或在编辑面板中创建 vibe-function-config 配置节点

# 重启 Node-RED
node-red
```

## 快速上手

1. 从节点面板拖入 **Vibe Function**（橙色、function 分类）
2. 打开编辑面板 → **Coding** Tab
3. 在「描述」中写："解析输入的时间戳，格式化为 YYYY-MM-DD HH:mm:ss"
4. 点击 **✨ 生成代码**
5. 检查 On Message / On Start / On Stop 中的代码
6. 部署

## 界面

| Tab | 说明 |
|-----|------|
| **Coding** | 核心：API 配置、自然语言描述、一键生成代码 |
| **Schema** | 定义输入/输出 msg 结构，提供属性下拉快速添加 |
| **Setup** | Outputs 数量、Timeout、外部模块导入 (lodash, moment 等) |
| **On Start** | 初始化代码，节点启动时执行一次 |
| **On Message** | 消息处理函数，每次收到消息时执行 |
| **On Stop** | 清理代码，节点停止时执行 |

## 代码生成

一次生成三段代码，对应节点的三个生命周期：

- **On Start** — 初始化变量、建立连接（可用 `node.send()`）
- **On Message** — 消息处理逻辑（`async function`，可用 `await`、`node.send()`、`return msg`）
- **On Stop** — 清理资源、关闭连接（不可用 `node.send()`）

在 **Schema** Tab 中描述输入输出结构后，生成的代码会更精确：

```
Input Schema:
msg.payload = number (timestamp in ms)
msg.topic   = device ID

Output Schema:
msg.payload = "YYYY-MM-DD HH:mm:ss" formatted time string
```

## Debug 模式

节点上有一个 **🐛/</>** 切换开关，点击即可启用/禁用（无需重新部署）。

启用后，运行时会对每条消息执行两道检查：

### 1. 错误自动修复

代码抛出异常 → 错误 + 输入 + 上下文发送给 LLM → 返回修复后代码 → 自动重试

### 2. Schema 校验

代码正常执行 → 输出 msg 发送给 LLM 验证 → 对比 Output Schema → 不符合则自动修复

修复后的代码同时更新运行时和编辑器（重开编辑面板可见）。

## API 配置节点

在节点面板「配置」分类中拖入 **vibe-function-config**：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| API 格式 | `Anthropic Messages` | 可选 Anthropic 或 OpenAI 兼容格式 |
| Base URL | `https://api.deepseek.com/anthropic` | API 基础地址 |
| Model | `deepseek-v4-pro[1m]` | 模型名称 |
| API Key | *(必填)* | 凭证，加密存储 |

可创建多个配置节点供不同节点使用。未配置时回退到 `DEEPSEEK_API_KEY` 环境变量。

## 兼容的 API 提供商

同时支持 **Anthropic Messages** 和 **OpenAI Chat Completions** 两种 API 格式。

### Anthropic 格式

| 提供商 | Base URL | 示例 Model |
|--------|----------|------------|
| DeepSeek | `https://api.deepseek.com/anthropic` | `deepseek-v4-pro[1m]` |
| Anthropic 官方 | `https://api.anthropic.com` | `claude-sonnet-4-6` |

### OpenAI 格式

| 提供商 | Base URL | 示例 Model |
|--------|----------|------------|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI 官方 | `https://api.openai.com` | `gpt-4o` |
| Ollama (本地) | `http://localhost:11434` | `llama3` |
| 其他兼容代理 | 自定义地址 | 自定义 |

## 支持的内置 API

沙箱中可直接使用：

- `node.send(msg)` / `node.done()` — 消息控制
- `context` / `flow` / `global` — 上下文存储
- `env.get("VAR")` — 读取环境变量
- `util` — Node.js util 模块
- `Buffer` / `URL` / `Date` — 标准对象
- `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` — 定时器（自动清理）
- `console` — 日志输出

## 示例

### 时间格式化

**描述：** 解析输入的时间戳，转换为 "YYYY-MM-DD HH:mm:ss" 格式

**Input Schema:**
```
msg.payload = number (Unix timestamp in ms)
```

**Output Schema:**
```
msg.payload = "YYYY-MM-DD HH:mm:ss" formatted time string
```

**生成代码（On Message）：**
```javascript
let ts = msg.payload;
if (typeof ts === "string") ts = Number(ts);
if (ts < 1e12) ts *= 1000;
let d = new Date(ts);
let Y = d.getFullYear();
let M = String(d.getMonth() + 1).padStart(2, "0");
let D = String(d.getDate()).padStart(2, "0");
let h = String(d.getHours()).padStart(2, "0");
let m = String(d.getMinutes()).padStart(2, "0");
let s = String(d.getSeconds()).padStart(2, "0");
msg.payload = `${Y}-${M}-${D} ${h}:${m}:${s}`;
return msg;
```

### HTTP 响应处理

**描述：** 解析 HTTP 响应，提取状态码和 body，如果状态码不是 2xx 则设置 error

**Output Schema:**
```
msg.payload = parsed response body (object)
msg.statusCode = HTTP status code (number)
msg.error = error message if status not 2xx (string or undefined)
```

## License

MIT
