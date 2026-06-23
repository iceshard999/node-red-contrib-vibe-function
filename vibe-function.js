const vm = require('vm');
const util = require('util');
const { isBlankNode, shouldGenerateInputSchema, buildSchemaPrompt, cleanSchemaResult } = require('./lib/schema-helpers');

module.exports = function(RED) {
    "use strict";

    // ========== 共享的 LLM 调用工具 ==========

    async function callLLM(configNodeId, promptContent) {
        let baseUrl = 'https://api.deepseek.com/anthropic';
        let model = 'deepseek-v4-pro[1m]';
        let apiKey;
        let apiFormat = 'anthropic';

        if (configNodeId) {
            const configNode = RED.nodes.getNode(configNodeId);
            if (configNode) {
                if (configNode.baseUrl)   baseUrl   = configNode.baseUrl;
                if (configNode.model)     model     = configNode.model;
                if (configNode.apiFormat) apiFormat = configNode.apiFormat;
                if (configNode.credentials && configNode.credentials.apiKey) {
                    apiKey = configNode.credentials.apiKey;
                }
            }
        }

        if (!apiKey) {
            throw new Error('请先配置 API Key');
        }

        let endpoint, headers, body;
        if (apiFormat === 'openai') {
            endpoint = `${baseUrl}/v1/chat/completions`;
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            };
            body = JSON.stringify({
                model,
                max_tokens: 4096,
                messages: [{ role: 'user', content: promptContent }]
            });
        } else {
            endpoint = `${baseUrl}/v1/messages`;
            headers = {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            };
            body = JSON.stringify({
                model,
                max_tokens: 4096,
                messages: [{ role: 'user', content: promptContent }]
            });
        }

        const response = await fetch(endpoint, { method: 'POST', headers, body });
        const data = await response.json();

        if (data.error) {
            throw new Error(data.error.message || JSON.stringify(data.error));
        }

        let rawText;
        if (apiFormat === 'openai') {
            if (data.choices && data.choices[0] && data.choices[0].message) {
                rawText = data.choices[0].message.content.trim();
            }
        } else {
            if (data.content && Array.isArray(data.content)) {
                const textBlock = data.content.find(b => b.type === 'text');
                if (textBlock && textBlock.text) {
                    rawText = textBlock.text.trim();
                } else if (data.content[0] && data.content[0].text) {
                    rawText = data.content[0].text.trim();
                }
            }
            if (!rawText && data.choices && data.choices[0] && data.choices[0].message) {
                rawText = data.choices[0].message.content.trim();
            }
        }

        if (!rawText) {
            throw new Error('未知的响应格式: ' + JSON.stringify(data).slice(0, 200));
        }

        return rawText;
    }

    function extractJSON(rawText) {
        let jsonStr = rawText;
        const jsonMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();
        return JSON.parse(jsonStr);
    }

    // ========== 配置节点 ==========

    function LLMFunctionConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.baseUrl = config.baseUrl;
        this.model = config.model;
        this.apiFormat = config.apiFormat || 'anthropic';
    }
    RED.nodes.registerType('vibe-function-config', LLMFunctionConfigNode, {
        defaults: {
            name: { value: '' },
            baseUrl: { value: 'https://api.deepseek.com/anthropic' },
            model: { value: 'deepseek-v4-pro[1m]' },
            apiFormat: { value: 'anthropic' }
        },
        credentials: {
            apiKey: { type: 'text' }
        }
    });

    // ========== Helper ==========

    function sendResults(node, send, msgs, cloneFirstMessage) {
        if (msgs == null) return;
        if (!Array.isArray(msgs)) msgs = [msgs];
        let msgCount = 0;
        for (let m = 0; m < msgs.length; m++) {
            if (msgs[m]) {
                if (!Array.isArray(msgs[m])) msgs[m] = [msgs[m]];
                for (let n = 0; n < msgs[m].length; n++) {
                    const msg = msgs[m][n];
                    if (msg !== null && msg !== undefined) {
                        if (typeof msg === 'object' && !Buffer.isBuffer(msg) && !Array.isArray(msg)) {
                            if (msgCount === 0 && cloneFirstMessage !== false) {
                                msgs[m][n] = RED.util.cloneMessage(msgs[m][n]);
                            }
                            msgCount++;
                        } else {
                            node.error(RED._("function.error.non-message-returned"));
                        }
                    }
                }
            }
        }
        if (msgCount > 0) send(msgs);
    }

    // ========== 节点运行时 ==========

    function LLMFunctionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node._config = config; // 保存 flow 配置引用，用于写回修复后的代码

        node.name = config.name;
        node.func = config.func || 'return msg;';
        node.outputs = parseInt(config.outputs) || 1;
        node.timeout = (parseInt(config.timeout) || 0) * 1000;
        node.ini = (config.initialize || '').trim();
        node.fin = (config.finalize || '').trim();
        node.libs = config.libs || [];
        node.debug = config.debug || false;
        node.description = config.description || '';
        node.inputSchema = config.inputSchema || '';
        node.outputSchema = config.outputSchema || '';
        node.configRef = config.configRef;

        if (RED.settings.functionExternalModules === false && node.libs.length > 0) {
            node.error(RED._("function.error.externalModuleNotAllowed"));
            return;
        }

        function buildFunctionText(userCode) {
            return "var results = null;" +
                "results = (async function(msg,__send__,__done__){" +
                    "var __msgid__ = msg._msgid;" +
                    "var node = {" +
                        "id:__node__.id," +
                        "name:__node__.name," +
                        "outputCount:__node__.outputCount," +
                        "log:__node__.log," +
                        "error:__node__.error," +
                        "warn:__node__.warn," +
                        "debug:__node__.debug," +
                        "trace:__node__.trace," +
                        "on:__node__.on," +
                        "status:__node__.status," +
                        "send:function(msgs,cloneMsg){ __node__.send(__send__,__msgid__,msgs,cloneMsg);}," +
                        "done:__done__" +
                    "};\n" +
                    userCode + "\n" +
                "})(msg,__send__,__done__);";
        }

        const sandbox = {
            console, util, Buffer, URL, URLSearchParams, Date,
            __node__: {
                id: node.id,
                name: node.name,
                outputCount: node.outputs,
                log: function() { node.log.apply(node, arguments); },
                error: function() { node.error.apply(node, arguments); },
                warn: function() { node.warn.apply(node, arguments); },
                debug: function() { node.debug.apply(node, arguments); },
                trace: function() { node.trace.apply(node, arguments); },
                send: function(send, id, msgs, cloneMsg) { sendResults(node, send, msgs, cloneMsg); },
                on: function() {
                    if (arguments[0] === "input") throw new Error(RED._("function.error.inputListener"));
                    node.on.apply(node, arguments);
                },
                status: function() { node.status.apply(node, arguments); }
            },
            context: {
                set: function() { node.context().set.apply(node, arguments); },
                get: function() { return node.context().get.apply(node, arguments); },
                keys: function() { return node.context().keys.apply(node, arguments); },
                get global() { return node.context().global; },
                get flow() { return node.context().flow; }
            },
            flow: {
                set: function() { node.context().flow.set.apply(node, arguments); },
                get: function() { return node.context().flow.get.apply(node, arguments); },
                keys: function() { return node.context().flow.keys.apply(node, arguments); }
            },
            global: {
                set: function() { node.context().global.set.apply(node, arguments); },
                get: function() { return node.context().global.get.apply(node, arguments); },
                keys: function() { return node.context().global.keys.apply(node, arguments); }
            },
            env: { get: function(envVar) { return RED.util.getSetting(node, envVar); } },
            setTimeout: function() {
                const func = arguments[0]; let timerId;
                arguments[0] = function() {
                    sandbox.clearTimeout(timerId);
                    try { func.apply(node, arguments); } catch(err) { node.error(err, {}); }
                };
                timerId = setTimeout.apply(node, arguments);
                node.outstandingTimers.push(timerId);
                return timerId;
            },
            clearTimeout: function(id) {
                clearTimeout(id);
                const index = node.outstandingTimers.indexOf(id);
                if (index > -1) node.outstandingTimers.splice(index, 1);
            },
            setInterval: function() {
                const func = arguments[0]; let timerId;
                arguments[0] = function() {
                    try { func.apply(node, arguments); } catch(err) { node.error(err, {}); }
                };
                timerId = setInterval.apply(node, arguments);
                node.outstandingIntervals.push(timerId);
                return timerId;
            },
            clearInterval: function(id) {
                clearInterval(id);
                const index = node.outstandingIntervals.indexOf(id);
                if (index > -1) node.outstandingIntervals.splice(index, 1);
            }
        };

        node.outstandingTimers = [];
        node.outstandingIntervals = [];

        // Debug 校验与修复
        let debugValidationCount = 0;
        const DEBUG_MAX_VALIDATIONS = 50; // 最多校验 50 次，避免无限循环

        async function validateOutput(outputMsg, inputMsg) {
            if (!node.outputSchema) return true;
            if (debugValidationCount >= DEBUG_MAX_VALIDATIONS) return true;
            debugValidationCount++;
            try {
                const prompt = `You are a validator. Check if this Node-RED function output matches the expected schema.

Input msg: ${JSON.stringify(inputMsg)}
Output msg: ${JSON.stringify(outputMsg)}
Expected output schema: ${node.outputSchema}

Reply EXACTLY "YES" if the output matches the schema, or "NO: <reason>" if it does not.`;

                const response = await callLLM(node.configRef, prompt);
                const ok = response.trim().toUpperCase().startsWith('YES');
                if (!ok) {
                    node.warn('[Debug] 输出不符合 Schema: ' + response.trim().substring(0, 120));
                }
                return ok;
            } catch (err) {
                // 校验失败不影响流程
                node.warn('[Debug] Schema 校验请求失败: ' + err.message);
                return true;
            }
        }

        async function autoFixCode(reason, inputMsg) {
            if (!node.debug) return null;
            const canCall = !!(node.configRef && RED.nodes.getNode(node.configRef));
            if (!canCall) return null;
            try {
                const prompt = `你是一个 Node-RED function 节点调试修复器。
以下代码需要修复，请返回修复后的代码。

原始描述：${node.description || '无'}
输入 Schema：${node.inputSchema || '无'}
输出 Schema：${node.outputSchema || '无'}

当前代码：
\`\`\`javascript
${node.func}
\`\`\`

收到的输入 msg：${JSON.stringify(inputMsg, null, 2)}

问题：${reason}

请只返回修复后的纯代码，不要包含任何解释、markdown 或 JSON 包装。直接输出可执行的 JavaScript 函数体。`;

                const fixedCode = await callLLM(node.configRef, prompt);
                const cleaned = fixedCode.replace(/```(?:javascript)?\s*\n?/g, '').trim();
                node.func = cleaned;

                // 重新编译脚本
                node.script = new vm.Script(buildFunctionText(cleaned), {
                    filename: 'Function:' + node.id,
                    displayErrors: true
                });

                // 写回 flow 配置 + 推送给编辑器
                if (node._config) {
                    node._config.func = cleaned;
                }
                try {
                    RED.comms.publish('vibe-function:code-fixed', {
                        nodeId: node.id,
                        func: cleaned
                    }, false);
                } catch (e) {
                    // comms 不可用也不影响
                }
                node.warn('[Debug] 代码已自动修复');

                return cleaned;
            } catch (fixErr) {
                node.error('[Debug] 自动修复失败: ' + fixErr.message);
                return null;
            }
        }

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

        function extractFirstOutputMsg(results) {
            if (!results) return null;
            // results 可能是: msg, [msg], [[msg]], [[msg1, msg2]]
            let arr = results;
            if (!Array.isArray(arr)) return arr;
            if (arr.length === 0) return null;
            if (Array.isArray(arr[0])) arr = arr[0];
            return arr[0] || null;
        }

        // 加载外部模块
        const moduleLoadPromises = [];
        if (node.hasOwnProperty("libs")) {
            node.libs.forEach(mod => {
                const vname = mod.var || mod.name;
                if (vname && vname !== "") {
                    if (sandbox.hasOwnProperty(vname) || vname === 'node') {
                        node.error(RED._("function.error.moduleNameError", { name: vname }));
                        return;
                    }
                    sandbox[vname] = null;
                    const spec = mod.module || mod.spec;
                    if (spec && spec !== "") {
                        moduleLoadPromises.push(
                            RED.import(spec).then(lib => {
                                sandbox[vname] = lib.default || lib;
                            }).catch(err => {
                                node.error(RED._("function.error.moduleLoadError", { module: spec, error: err.toString() }));
                                throw err;
                            })
                        );
                    }
                }
            });
        }

        const RESOLVING = 0, RESOLVED = 1;
        let state = RESOLVING;
        let messages = [];
        let processMessage = () => {};

        node.on("input", function(msg, send, done) {
            if (state === RESOLVING) {
                messages.push({ msg, send, done });
            } else if (state === RESOLVED) {
                processMessage(msg, send, done);
            }
        });

        Promise.all(moduleLoadPromises).then(() => {
            const context = vm.createContext(sandbox);

            let iniScript = null, iniOpt = null;
            if (node.ini) {
                const iniText = `
                (async function(__send__) {
                    var node = {
                        id:__node__.id,
                        name:__node__.name,
                        outputCount:__node__.outputCount,
                        log:__node__.log,
                        error:__node__.error,
                        warn:__node__.warn,
                        debug:__node__.debug,
                        trace:__node__.trace,
                        status:__node__.status,
                        send: function(msgs, cloneMsg) {
                            __node__.send(__send__, RED.util.generateId(), msgs, cloneMsg);
                        }
                    };
                    ` + node.ini + `
                })(__initSend__);`;
                iniOpt = { filename: 'Setup:' + node.id };
                if (node.timeout > 0) { iniOpt.timeout = node.timeout; iniOpt.breakOnSigint = true; }
                iniScript = new vm.Script(iniText, iniOpt);
            }

            node.script = new vm.Script(buildFunctionText(node.func), {
                filename: 'Function:' + node.id,
                displayErrors: true
            });

            let finScript = null, finOpt = null;
            if (node.fin) {
                const finText = `(function() {
                    var node = {
                        id:__node__.id,
                        name:__node__.name,
                        outputCount:__node__.outputCount,
                        log:__node__.log,
                        error:__node__.error,
                        warn:__node__.warn,
                        debug:__node__.debug,
                        trace:__node__.trace,
                        status:__node__.status,
                        send: function() { __node__.error("Cannot send from close function"); }
                    };
                    ` + node.fin + `
                })();`;
                finOpt = { filename: 'Cleanup:' + node.id };
                if (node.timeout > 0) { finOpt.timeout = node.timeout; finOpt.breakOnSigint = true; }
                finScript = new vm.Script(finText, finOpt);
            }

            let promise = Promise.resolve();
            if (iniScript) {
                context.__initSend__ = function(msgs) { node.send(msgs); };
                promise = iniScript.runInContext(context, iniOpt);
            }

            // Debug 启动检查
            if (node.debug) {
                const hasConfig = !!(node.configRef && RED.nodes.getNode(node.configRef));
                if (!hasConfig) {
                    node.warn('[Debug] 未选择 API 配置，自动修复不会生效。请在 Coding Tab 中选择 API 配置');
                }
            }

            processMessage = function(msg, send, done) {
                // 空白节点(无代码 + 无 inputSchema):直通输出,并按需后台推导 input schema
                if (isBlankNode(node.func, node.inputSchema)) {
                    sendResults(node, send, msg, false);
                    done();
                    const hasConfig = !!(node.configRef && RED.nodes.getNode(node.configRef));
                    if (shouldGenerateInputSchema(node.func, node.inputSchema, hasConfig) && !node._schemaGenerating) {
                        node._schemaGenerating = true;
                        generateInputSchema(msg);
                    }
                    return;
                }
                context.msg = msg;
                context.__send__ = send;
                context.__done__ = done;
                let opts = {};
                if (node.timeout > 0) { opts.timeout = node.timeout; opts.breakOnSigint = true; }

                async function runAndMaybeFix() {
                    // 第一阶段：执行脚本（同步错误在此捕获，如语法错误）
                    try {
                        node.script.runInContext(context, opts);
                    } catch (err) {
                        return handleError(err);
                    }
                    // 第二阶段：await 结果（用户代码逻辑错误在此 reject）
                    try {
                        const results = await context.results;
                        // Debug 模式：校验输出是否符合 Schema
                        if (node.debug && node.outputSchema) {
                            const outputMsg = extractFirstOutputMsg(results);
                            const isValid = await validateOutput(outputMsg, msg);
                            if (!isValid) {
                                return handleError(
                                    new Error('输出不符合 Schema: ' + node.outputSchema)
                                );
                            }
                        }
                        sendResults(node, send, results, false);
                        done();
                    } catch (err) {
                        return handleError(err);
                    }
                }

                async function handleError(err) {
                    if (err && err.hasOwnProperty("stack")) msg.error = err;
                    if (!node.debug) {
                        done(err);
                        return;
                    }
                    const errMsg = err.stack || err.message || String(err);
                    node.warn('[Debug] 代码执行出错，尝试自动修复...');
                    const fixed = await autoFixCode(errMsg, msg);
                    if (fixed) {
                        try {
                            node.script.runInContext(context, opts);
                            const results = await context.results;
                            // Debug 模式：修复后也校验输出
                            if (node.debug && node.outputSchema) {
                                const outputMsg = extractFirstOutputMsg(results);
                                const isValid = await validateOutput(outputMsg, msg);
                                if (!isValid) {
                                    node.warn('[Debug] 修复后输出仍不符合 Schema，停止重试');
                                }
                            }
                            sendResults(node, send, results, false);
                            done();
                            return;
                        } catch (retryErr) {
                            done(retryErr);
                            return;
                        }
                    }
                    done(err);
                }

                runAndMaybeFix();
            };

            state = RESOLVED;
            messages.forEach(m => processMessage(m.msg, m.send, m.done));
            messages = [];
        }).catch(err => {
            node.error(err);
        });

        node.on("close", function() {
            if (node.fin) {
                const ctx = vm.createContext(Object.assign({}, sandbox));
                try {
                    const s = new vm.Script(
                        `(function() {
                            var node = {
                                id:__node__.id, name:__node__.name,
                                outputCount:__node__.outputCount,
                                log:__node__.log, error:__node__.error,
                                warn:__node__.warn, debug:__node__.debug,
                                trace:__node__.trace, status:__node__.status,
                                send: function() { __node__.error("Cannot send from close function"); }
                            };
                            ` + node.fin + `
                        })();`,
                        { filename: 'Cleanup:' + node.id }
                    );
                    s.runInContext(ctx);
                } catch (err) { node.error(err); }
            }
            node.outstandingTimers.forEach(t => clearTimeout(t));
            node.outstandingIntervals.forEach(t => clearInterval(t));
        });
    }

    // Admin API: 即时切换 debug 模式（无需 redeploy）
    RED.httpAdmin.post('/vibe-function/debug-toggle/:id', function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node && node.type === 'vibe-function') {
            node.debug = !!req.body.debug;
            res.json({ ok: true, debug: node.debug });
        } else {
            res.status(404).send('Node not found');
        }
    });

    // Admin API: 获取节点当前运行中的代码
    RED.httpAdmin.get('/vibe-function/code/:id', function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node && node.type === 'vibe-function') {
            res.json({
                func: node.func || '',
                initialize: node.ini || '',
                finalize: node.fin || ''
            });
        } else {
            res.json({});
        }
    });

    // ========== Admin API: 生成代码 ==========

    RED.httpAdmin.post('/vibe-function/generate', async function(req, res) {
        const { description, configNodeId, inputSchema, outputSchema } = req.body;

        let schemaHint = '';
        if (inputSchema)  schemaHint += `\n输入 msg 结构：\n${inputSchema}`;
        if (outputSchema) schemaHint += `\n输出 msg 结构：\n${outputSchema}`;

        const promptContent = `你是一个 Node-RED function 节点代码生成器。
根据以下描述，生成三部分 JavaScript 代码，分别对应节点的三个生命周期。

1. On Start (初始化代码) — 节点启动时执行一次，用于初始化变量、建立连接。可用 context, node.send()。
2. On Message (消息处理) — 每次收到消息时执行，async function 内部。通过 return msg 输出，可用 node.send()。
3. On Stop (清理代码) — 节点停止时执行，用于清理资源、关闭连接。不能用 node.send()。

请严格按以下 JSON 格式输出，不要包含任何其他文字：

{
  "name": "节点名称（简短中文，如：时间格式化）",
  "initCode": "// On Start 代码",
  "funcCode": "// On Message 代码",
  "finalizeCode": "// On Stop 代码"
}

注意：
- 只返回 JSON，不要包含解释、注释或 markdown
- JSON 字符串中的换行用 \\n 转义，引号用 \\" 转义
- 如果某部分不需要代码，设为空字符串 ""
${schemaHint}
描述：${description}`;

        try {
            const rawText = await callLLM(configNodeId, promptContent);
            const result = extractJSON(rawText);
            res.json({
                name: result.name || '',
                initCode: result.initCode || '',
                funcCode: result.funcCode || '',
                finalizeCode: result.finalizeCode || ''
            });
        } catch(err) {
            RED.log.error(`[vibe-function] 生成失败: ${err.message}`);
            res.status(500).send(err.message);
        }
    });

    RED.nodes.registerType('vibe-function', LLMFunctionNode, {
        defaults: {
            name: { value: '' },
            func: { value: '\nreturn msg;' },
            outputs: { value: 1 },
            timeout: { value: 0 },
            initialize: { value: '' },
            finalize: { value: '' },
            libs: { value: [] },
            description: { value: '' },
            debug: { value: false },
            configRef: { value: '', type: 'vibe-function-config', required: false },
            inputSchema: { value: '' },
            outputSchema: { value: '' }
        },
        inputs: 1,
        outputs: 1,
        label: function() {
            return this.name || 'vibe-function';
        }
    });
};
