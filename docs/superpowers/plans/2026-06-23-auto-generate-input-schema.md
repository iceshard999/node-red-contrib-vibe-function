# Auto-Generate Input Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `vibe-function` node has no code and no input schema, the first incoming message is sent to the LLM to derive `inputSchema`, which is written back to the node config — while the message itself passes straight through to downstream.

**Architecture:** Extract the pure, testable logic (trigger predicate, prompt builder, result cleaner) into a new `lib/schema-helpers.js` module unit-tested with Node's built-in `node --test`. Wire it into the node runtime (`vibe-function.js`) as an async side-effect that mirrors the existing `autoFixCode` / `code-fixed` pattern: call `callLLM`, write back to `node.inputSchema` + `node._config.inputSchema`, and push to the editor via `RED.comms.publish`. The editor (`vibe-function.html`) subscribes to the new comms topic and fills the `inputSchema` textarea.

**Tech Stack:** Node.js (>=22.9, runtime is v24.17.0), Node-RED 5.x contrib node, `node --test` + `node:assert` for unit tests (no new dependencies).

## Global Constraints

- Node engine floor: `>=16.0.0` per `package.json`; runtime in use is Node v24.17.0. Use only built-in test tooling (`node --test`, `node:test`, `node:assert`) — **no new npm dependencies**.
- "No code" means: `String(func).trim()` is `''` OR equals `'return msg;'` (the default is `'\nreturn msg;'`).
- "Empty input schema" means: `String(inputSchema).trim() === ''`.
- The triggering message MUST pass through to downstream unchanged (equivalent to `return msg;`), and generation MUST be a non-blocking background side-effect.
- Only ONE LLM request may fire while a generation is in flight (in-flight guard `node._schemaGenerating`).
- Generation only fires when a valid API config is resolvable: `!!(node.configRef && RED.nodes.getNode(node.configRef))`.
- Reuse existing helpers `callLLM(configRef, prompt)` and `sendResults(node, send, msgs, cloneFirst)`; mirror the existing `RED.comms.publish('vibe-function:code-fixed', …)` / `RED.comms.subscribe` pattern. New comms topic: `vibe-function:schema-generated`.
- All user-facing strings in Chinese, matching the existing node's style.

---

### Task 1: Pure schema-helpers module (TDD)

Create the pure, dependency-free logic and its tests. This is the only fully unit-testable part of the feature.

**Files:**
- Create: `lib/schema-helpers.js`
- Create: `test/schema-helpers.test.js`
- Modify: `package.json` (add `test` script)
- Modify: `.npmignore` (exclude `test/` and `docs/` from the published package)

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (CommonJS exports, consumed by Task 2):
  - `isNoCode(func: string): boolean` — true when func is empty or `'return msg;'` after trim.
  - `isBlankNode(func: string, inputSchema: string): boolean` — `isNoCode(func) && String(inputSchema).trim() === ''`.
  - `shouldGenerateInputSchema(func: string, inputSchema: string, hasConfig: boolean): boolean` — `isBlankNode(func, inputSchema) && !!hasConfig`.
  - `buildSchemaPrompt(msg: any): string` — returns the LLM prompt embedding a pretty-printed, length-capped (4000 chars) JSON sample of `msg`.
  - `cleanSchemaResult(rawText: string): string` — strips markdown code fences and trims.

- [ ] **Step 1: Write the failing test**

Create `test/schema-helpers.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const {
    isNoCode,
    isBlankNode,
    shouldGenerateInputSchema,
    buildSchemaPrompt,
    cleanSchemaResult
} = require('../lib/schema-helpers');

test('isNoCode: empty string is no code', () => {
    assert.strictEqual(isNoCode(''), true);
    assert.strictEqual(isNoCode('   '), true);
});

test('isNoCode: default passthrough is no code', () => {
    assert.strictEqual(isNoCode('\nreturn msg;'), true);
    assert.strictEqual(isNoCode('return msg;'), true);
});

test('isNoCode: real code is not no-code', () => {
    assert.strictEqual(isNoCode('msg.payload = 1;\nreturn msg;'), false);
});

test('isNoCode: null/undefined safe', () => {
    assert.strictEqual(isNoCode(undefined), true);
    assert.strictEqual(isNoCode(null), true);
});

test('isBlankNode: no code and empty schema', () => {
    assert.strictEqual(isBlankNode('return msg;', ''), true);
    assert.strictEqual(isBlankNode('return msg;', '   '), true);
});

test('isBlankNode: false when schema present', () => {
    assert.strictEqual(isBlankNode('return msg;', 'payload: number'), false);
});

test('isBlankNode: false when code present', () => {
    assert.strictEqual(isBlankNode('msg.x=1;return msg;', ''), false);
});

test('shouldGenerateInputSchema: needs config', () => {
    assert.strictEqual(shouldGenerateInputSchema('return msg;', '', true), true);
    assert.strictEqual(shouldGenerateInputSchema('return msg;', '', false), false);
});

test('buildSchemaPrompt: embeds sampled field names and returns a string', () => {
    const prompt = buildSchemaPrompt({ payload: 42, topic: 'sensor/1' });
    assert.strictEqual(typeof prompt, 'string');
    assert.ok(prompt.includes('payload'));
    assert.ok(prompt.includes('topic'));
});

test('buildSchemaPrompt: caps very large samples', () => {
    const big = { payload: 'x'.repeat(10000) };
    const prompt = buildSchemaPrompt(big);
    assert.ok(prompt.includes('truncated'));
});

test('buildSchemaPrompt: survives circular references', () => {
    const a = {}; a.self = a;
    assert.doesNotThrow(() => buildSchemaPrompt(a));
});

test('cleanSchemaResult: strips json code fences', () => {
    const raw = '```json\npayload: number\n```';
    assert.strictEqual(cleanSchemaResult(raw), 'payload: number');
});

test('cleanSchemaResult: passes plain text through trimmed', () => {
    assert.strictEqual(cleanSchemaResult('  payload: number  '), 'payload: number');
});

test('cleanSchemaResult: null safe', () => {
    assert.strictEqual(cleanSchemaResult(null), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/schema-helpers.test.js`
Expected: FAIL — `Cannot find module '../lib/schema-helpers'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/schema-helpers.js`:

```javascript
'use strict';

function isNoCode(func) {
    const f = String(func == null ? '' : func).trim();
    return f === '' || f === 'return msg;';
}

function isBlankNode(func, inputSchema) {
    return isNoCode(func) && String(inputSchema == null ? '' : inputSchema).trim() === '';
}

function shouldGenerateInputSchema(func, inputSchema, hasConfig) {
    return isBlankNode(func, inputSchema) && !!hasConfig;
}

function buildSchemaPrompt(msg) {
    let sample;
    try {
        sample = JSON.stringify(msg, null, 2);
    } catch (e) {
        sample = String(msg);
    }
    if (sample == null) sample = String(msg);
    if (sample.length > 4000) {
        sample = sample.slice(0, 4000) + '\n... (truncated)';
    }
    return `你是一个 Node-RED 消息结构分析器。
下面是一个节点收到的真实输入 msg 示例。请推导出它的输入结构(input schema),
用简洁的可读文本描述每个字段:字段名、类型、含义(能推断时)。

输入 msg 示例:
${sample}

要求:
- 只输出结构描述文本,不要包含任何解释、markdown 代码块或 JSON 包装。
- 描述 msg 顶层及嵌套字段,标明类型(string / number / boolean / object / array 等)。
- 风格简洁,便于作为后续代码生成的提示。`;
}

function cleanSchemaResult(rawText) {
    return String(rawText == null ? '' : rawText)
        .replace(/```(?:json|javascript|text)?\s*\n?/gi, '')
        .replace(/```/g, '')
        .trim();
}

module.exports = {
    isNoCode,
    isBlankNode,
    shouldGenerateInputSchema,
    buildSchemaPrompt,
    cleanSchemaResult
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/schema-helpers.test.js`
Expected: PASS — all tests pass (15 passing).

- [ ] **Step 5: Add test script and exclude test/docs from package**

In `package.json`, add a `scripts` block (the file currently has no `scripts` key — insert it after the `"license"` line or alongside existing top-level keys):

```json
  "scripts": {
    "test": "node --test test/"
  },
```

Append to `.npmignore` (new lines at end of file):

```
test/
docs/
```

- [ ] **Step 6: Run via npm to confirm wiring**

Run: `npm test`
Expected: PASS — `node --test test/` discovers and runs the suite, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/schema-helpers.js test/schema-helpers.test.js package.json .npmignore
git commit -m "feat: pure helpers for input-schema auto-generation"
```

---

### Task 2: Wire generation into the node runtime

Hook the trigger into the node's message processing and add the async generation side-effect. This part is RED-coupled; verify manually in Node-RED.

**Files:**
- Modify: `vibe-function.js` (require helpers near top of `module.exports`; add trigger branch at the top of `processMessage`; add `generateInputSchema` inside `LLMFunctionNode`)

**Interfaces:**
- Consumes (from Task 1): `isBlankNode`, `buildSchemaPrompt`, `cleanSchemaResult` from `./lib/schema-helpers`.
- Consumes (existing in `vibe-function.js`): `callLLM(configRef, prompt)`, `sendResults(node, send, msgs, cloneFirst)`, `node._config`, `node.configRef`, `RED.nodes.getNode`, `RED.comms.publish`.
- Produces: runtime behavior + comms event `vibe-function:schema-generated` with payload `{ nodeId, inputSchema }` (consumed by Task 3).

- [ ] **Step 1: Require the helpers**

In `vibe-function.js`, at the very top of the file (before or just after the existing `const vm = require('vm');` / `const util = require('util');` lines), add:

```javascript
const { isBlankNode, buildSchemaPrompt, cleanSchemaResult } = require('./lib/schema-helpers');
```

- [ ] **Step 2: Add the `generateInputSchema` function**

Inside `LLMFunctionNode(config)`, add this function next to the existing `autoFixCode` definition (after `autoFixCode`, before `extractFirstOutputMsg`):

```javascript
        async function generateInputSchema(sampleMsg) {
            try {
                const prompt = buildSchemaPrompt(sampleMsg);
                const raw = await callLLM(node.configRef, prompt);
                const schema = cleanSchemaResult(raw);
                if (schema) {
                    node.inputSchema = schema;
                    if (node._config) {
                        node._config.inputSchema = schema;
                    }
                    try {
                        RED.comms.publish('vibe-function:schema-generated', {
                            nodeId: node.id,
                            inputSchema: schema
                        }, false);
                    } catch (e) {
                        // comms 不可用也不影响运行时回写
                    }
                    node.warn('[Schema] 已自动推导输入 schema');
                }
            } catch (err) {
                node.warn('[Schema] 自动推导失败: ' + err.message);
            } finally {
                node._schemaGenerating = false;
            }
        }
```

- [ ] **Step 3: Add the trigger branch at the top of `processMessage`**

In `vibe-function.js`, `processMessage` currently begins with:

```javascript
            processMessage = function(msg, send, done) {
                context.msg = msg;
                context.__send__ = send;
```

Insert the trigger branch as the FIRST statements inside `processMessage`, before `context.msg = msg;`:

```javascript
            processMessage = function(msg, send, done) {
                // 空白节点(无代码 + 无 inputSchema):直通输出,并按需后台推导 input schema
                if (isBlankNode(node.func, node.inputSchema)) {
                    sendResults(node, send, msg, false);
                    done();
                    const hasConfig = !!(node.configRef && RED.nodes.getNode(node.configRef));
                    if (hasConfig && !node._schemaGenerating) {
                        node._schemaGenerating = true;
                        generateInputSchema(msg);
                    }
                    return;
                }
                context.msg = msg;
                context.__send__ = send;
```

(Leave the rest of `processMessage` unchanged.)

- [ ] **Step 4: Syntax check**

Run: `node -e "require('./vibe-function.js')"`
Expected: FAIL with a Node-RED-specific error such as `module.exports` expecting `RED`, OR no output — but NOT a `SyntaxError`. The goal here is only to confirm the file parses. If you see `SyntaxError`, fix it.

A cleaner parse-only check that avoids the runtime requirement:

Run: `node --check vibe-function.js`
Expected: PASS — no output, exit code 0 (file is syntactically valid).

- [ ] **Step 5: Manual verification in Node-RED**

There is no automated Node-RED harness in this project, so verify by hand:

1. Restart Node-RED so it reloads the node:
   `node-red` (Ctrl-C the running instance first).
2. In the editor, drop a fresh `vibe-function` node. Leave code empty (default), leave Input Schema empty, and select a valid API config in the Coding tab.
3. Wire an `inject` node (set its payload to an object, e.g. JSON `{"payload":42,"topic":"sensor/1"}`) → `vibe-function` → `debug` node. Deploy.
4. Click inject.
   - Expected: the `debug` node shows the message passed through unchanged.
   - Expected: within a few seconds, the node logs `[Schema] 已自动推导输入 schema` and (after Task 3) the editor's Input Schema field is populated.
5. Negative checks:
   - With Input Schema already filled: inject → no generation, message passes through normally.
   - With real code in the function body: inject → runs the code as before, no generation.
   - With no API config selected on a blank node: inject → message passes through, no error, no generation.

- [ ] **Step 6: Commit**

```bash
git add vibe-function.js
git commit -m "feat: auto-generate input schema on first message in runtime"
```

---

### Task 3: Editor live-update of the Input Schema field

Subscribe in the editor to the new comms topic and fill the textarea, mirroring the existing `code-fixed` handler.

**Files:**
- Modify: `vibe-function.html` (add a `RED.comms.subscribe` block next to the existing `code-fixed` subscription, around line 188-196)

**Interfaces:**
- Consumes (from Task 2): comms event `vibe-function:schema-generated` with `{ nodeId, inputSchema }`.
- Produces: editor side-effect (fills `#node-input-inputSchema`, shows a notification).

- [ ] **Step 1: Add the subscribe handler**

In `vibe-function.html`, locate the existing block (around line 188):

```javascript
            // ========== Debug 自动修复代码推送 ==========
            RED.comms.subscribe('vibe-function:code-fixed', function(topic, data) {
                if (data && data.nodeId === that.id) {
                    $('#node-input-func').val(data.func);
                    RED.notify('🛠️ Debug 模式已自动修复代码并更新编辑器', {
                        type: 'success',
                        timeout: 5000
                    });
                }
            });
```

Immediately AFTER that block (still inside the same `oneditprepare` scope where `that` is defined), add:

```javascript
            // ========== 自动推导 input schema 推送 ==========
            RED.comms.subscribe('vibe-function:schema-generated', function(topic, data) {
                if (data && data.nodeId === that.id) {
                    $('#node-input-inputSchema').val(data.inputSchema);
                    RED.notify('🧩 已自动推导输入 schema 并更新编辑器', {
                        type: 'success',
                        timeout: 5000
                    });
                }
            });
```

- [ ] **Step 2: Manual verification in Node-RED**

1. Restart Node-RED and reload the editor (hard refresh the browser to pick up the new HTML).
2. Repeat Task 2 / Step 5 scenario 3-4 with the node's edit dialog open.
   - Expected: when generation completes, the Input Schema textarea fills in automatically and a green notification `🧩 已自动推导输入 schema 并更新编辑器` appears.
3. Deploy after the field fills, reopen the node — confirm the schema persisted into the flow.

- [ ] **Step 3: Commit**

```bash
git add vibe-function.html
git commit -m "feat: editor live-update of auto-generated input schema"
```

---

## Self-Review

**Spec coverage:**
- LLM generation → Task 1 `buildSchemaPrompt` + Task 2 `callLLM`. ✓
- Trigger: no code & empty inputSchema → Task 1 `isBlankNode` + Task 2 branch. ✓
- Always enabled (no toggle) → Task 2 branch has no flag gate beyond config presence. ✓
- Message passes through → Task 2 `sendResults(...)` + `done()` before generation. ✓
- Free-text schema form → Task 1 prompt asks for plain text, `cleanSchemaResult` strips fences. ✓
- Persist + push to editor → Task 2 sets `node.inputSchema` / `node._config.inputSchema` / publishes comms; Task 3 fills the field. ✓
- One-shot + in-flight guard → `node._schemaGenerating` in Task 2; once `inputSchema` set, `isBlankNode` is false. ✓
- No-config blank node passes through silently → Task 2 `hasConfig` check. ✓
- Failure non-fatal → Task 2 `try/catch` + `node.warn`, finally clears guard. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete; manual-verification steps are explicit because no Node-RED test harness exists. ✓

**Type consistency:** `isNoCode` / `isBlankNode` / `shouldGenerateInputSchema` / `buildSchemaPrompt` / `cleanSchemaResult` names and signatures match between Task 1 exports and Task 2 imports. Comms topic `vibe-function:schema-generated` and payload `{ nodeId, inputSchema }` match between Task 2 (publish) and Task 3 (subscribe). ✓

Note: `shouldGenerateInputSchema` is exported and tested in Task 1 for completeness/clarity, though Task 2's runtime branch composes `isBlankNode` + an inline `hasConfig` check (so the message can also pass through on a blank node that has no API config). This is intentional, not a gap.
