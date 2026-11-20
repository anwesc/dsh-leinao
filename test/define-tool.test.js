import test from 'node:test'
import assert from 'node:assert/strict'

import { compileParameters, defineTool, ToolArgsError, validateArgs } from '../src/define-tool.js'
import { registerPersonaTools } from '../src/tools.js'

test('define-tool: 简写参数表编译成对象根 schema', () => {
  const schema = compileParameters({
    name: { type: 'string', required: true, description: '名字' },
    pinned: { type: 'boolean' },
  })
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      name: { type: 'string', description: '名字' },
      pinned: { type: 'boolean' },
    },
    required: ['name'],
  })
  assert.deepEqual(compileParameters(), { type: 'object', properties: {} })
})

test('define-tool: 参数校验覆盖缺必填、类型、非对象与 enum', () => {
  const schema = compileParameters({
    name: { type: 'string', required: true },
    count: { type: 'number' },
    mode: { type: 'string', enum: ['a', 'b'] },
  })
  assert.deepEqual(validateArgs(schema, { name: 'x' }), [])
  assert.deepEqual(validateArgs(schema, {}), ['name: required'])
  assert.deepEqual(validateArgs(schema, { name: 'x', count: '1' }), ['count: expected number'])
  assert.deepEqual(validateArgs(schema, null), ['$: expected an object'])
  assert.deepEqual(validateArgs(schema, { name: 'x', mode: 'c' }), ['mode: expected one of a, b'])
})

test('define-tool: execute 先校验再执行，默认 output 渲染成文本', async () => {
  let calls = 0
  const tool = defineTool({
    name: 't',
    description: 'd',
    parameters: { value: { type: 'string', required: true } },
    execute: async (args) => {
      calls += 1
      return `echo:${args.value}`
    },
  })
  await assert.rejects(() => tool.execute({}), (error) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS')
  assert.equal(calls, 0)
  assert.equal(await tool.execute({ value: 'hi' }), 'echo:hi')
  assert.equal(calls, 1)
  assert.deepEqual(tool.output.render({}, 'hi'), [{ type: 'text', text: 'hi' }])
  assert.deepEqual(tool.output.schema, { type: 'string' })
})

test('define-tool: 已是对象根 schema 时原样使用', () => {
  const parameters = { type: 'object', properties: { a: { type: 'string' } }, required: [] }
  const tool = defineTool({ name: 't', description: 'd', parameters, execute: async () => '' })
  assert.equal(tool.parameters, parameters)
})

test('define-tool: 类脑的 12 个工具都能编译成合法定义', () => {
  const tools = new Map()
  const ctx = { tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } } }
  registerPersonaTools(ctx, defineTool, {
    dataDir: 'D:/tmp-leinao-define',
    deviceId: 'dev',
    refresh: () => ({ state: { phase: 'seed', pages: {}, observations: {}, profile: {} } }),
    record: () => ({}),
    verifyEvidence: () => true,
    getConfig: () => ({}),
    render: () => '',
    writeExport: () => '',
    writeUserModel: () => '',
    writeExportZip: () => '',
    userName: () => '老大',
  })
  assert.equal(tools.size, 12)
  for (const [name, tool] of tools) {
    assert.equal(tool.parameters.type, 'object', name)
    assert.equal(typeof tool.description, 'string', name)
    assert.equal(typeof tool.execute, 'function', name)
    assert.equal(typeof tool.output.render, 'function', name)
  }
  assert.deepEqual(tools.get('persona_seed').parameters.required, ['name'])
  assert.deepEqual(tools.get('persona_pin').parameters.required, ['axis'])
  assert.deepEqual(tools.get('persona_state').parameters, { type: 'object', properties: {} })
})
