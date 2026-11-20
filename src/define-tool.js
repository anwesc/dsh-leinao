/**
 * defineTool 的本地等价实现。
 *
 * 宿主里这个函数来自 `@deepseek-ai/dsh-tools`，但插件用 `link:` 安装时，
 * Node 按**真实路径**解析裸模块名——真实路径是仓库目录，解析链上并没有宿主的
 * 包，`import('@deepseek-ai/dsh-tools')` 会失败。失败一次就等于所有 persona_*
 * 工具静默消失（注入还在，看起来一切正常，但模型根本写不了记忆）。
 *
 * 所以这里保留一份最小实现：把简写参数表编译成 JSON Schema，并在执行前做基本
 * 校验。能拿到宿主的 defineTool 时优先用它，拿不到就用这个，工具不会再消失。
 */

/** 参数不合法时抛出，形状与宿主的 ToolArgsError 一致（code = INVALID_ARGS）。 */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.code = 'INVALID_ARGS'
    this.violations = violations
  }
}

function propertySchema(decl) {
  const { required: _required, ...schema } = decl ?? {}
  return schema
}

/**
 * 简写参数表 → 对象根 JSON Schema。
 * `{ name: { type: 'string', required: true } }` → `{ type: 'object', properties, required: ['name'] }`
 */
export function compileParameters(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, decl] of Object.entries(spec ?? {})) {
    if (!decl || typeof decl !== 'object') continue
    properties[key] = propertySchema(decl)
    if (decl.required === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  array: (value) => Array.isArray(value),
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  null: (value) => value === null,
}

/** 返回违规列表；空数组表示参数合法。 */
export function validateArgs(schema, args) {
  const violations = []
  if (args === null || (args !== undefined && (typeof args !== 'object' || Array.isArray(args)))) {
    return ['$: expected an object']
  }
  const value = args ?? {}
  for (const key of schema.required ?? []) {
    if (!(key in value) || value[key] === undefined) violations.push(`${key}: required`)
  }
  for (const [key, decl] of Object.entries(schema.properties ?? {})) {
    if (!(key in value) || value[key] === undefined) continue
    const check = TYPE_CHECKS[decl?.type]
    if (check && !check(value[key])) violations.push(`${key}: expected ${decl.type}`)
    if (Array.isArray(decl?.enum) && !decl.enum.includes(value[key])) {
      violations.push(`${key}: expected one of ${decl.enum.join(', ')}`)
    }
  }
  return violations
}

const defaultRender = (_args, value) => [{ type: 'text', text: String(value) }]

/**
 * @param {object} options 与宿主 defineTool 相同的入参形状
 * @returns 可直接交给 ctx.tools.register 的定义对象
 */
export function defineTool(options) {
  if (!options?.name) throw new Error('defineTool: name is required')
  const parameters =
    options.parameters?.type === 'object' && options.parameters?.properties
      ? options.parameters
      : compileParameters(options.parameters)

  const tool = {
    name: options.name,
    description: options.description ?? '',
    parameters,
    output: {
      schema: options.output?.schema ?? { type: 'string' },
      render: options.output?.render ?? defaultRender,
      ...(options.output?.presentationMeta
        ? { presentationMeta: options.output.presentationMeta }
        : {}),
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return options.execute(args, exec)
    },
  }

  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  if (options.finalizeContent) tool.finalizeContent = options.finalizeContent
  if (options.presentCall) tool.presentCall = options.presentCall
  if (options.presentResult) tool.presentResult = options.presentResult
  if (options.isConcurrencySafe) tool.isConcurrencySafe = options.isConcurrencySafe
  return tool
}
