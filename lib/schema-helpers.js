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
