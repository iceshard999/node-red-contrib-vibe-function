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
