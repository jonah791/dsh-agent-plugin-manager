/**
 * 插件管理器 client Remote contribution（namespace 'pluginManager'，与 host PluginManagerRemoteService 一致）。
 * @module dsh-agent-plugin-manager/client/remote
 */
import type { TypertRemoteContribution, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

const pluginSchema = z.object({
  name: z.string(), version: z.string(), source: z.string(),
  purpose: z.string(), tools: z.array(z.string()), built: z.boolean(),
  status: z.string(), profiles: z.array(z.string()),
  config: z.record(z.string(), z.unknown()).optional(),
})

const listResult: TypertCodec = { mode: 'strict', typeSymbol: 'pluginManager#ListResult', schema: z.object({ plugins: z.array(pluginSchema) }) }
const inspectResult: TypertCodec = { mode: 'strict', typeSymbol: 'pluginManager#InspectResult', schema: z.object({ plugin: pluginSchema.nullable() }) }
const nameRequest: TypertCodec = { mode: 'strict', typeSymbol: 'pluginManager#NameRequest', schema: z.object({ name: z.string(), profile: z.string().optional() }) }
const createRequest: TypertCodec = { mode: 'strict', typeSymbol: 'pluginManager#CreateRequest', schema: z.object({ name: z.string(), description: z.string().optional() }) }
const opResult: TypertCodec = { mode: 'strict', typeSymbol: 'pluginManager#OpResult', schema: z.union([
  z.object({ ok: z.literal(true), note: z.string().optional(), dir: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]) }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    pluginManager: {
      list: () => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ plugins: unknown[] }>>
      inspect: (req: { name: string }) => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ plugin: unknown }>>
      start: (req: { name: string; profile?: string }) => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ ok: boolean; error?: string; note?: string }>>
      stop: (req: { name: string; profile?: string }) => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ ok: boolean; error?: string; note?: string }>>
      unmount: (req: { name: string; profile?: string }) => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ ok: boolean; error?: string; note?: string }>>
      create: (req: { name: string; description?: string }) => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ ok: boolean; error?: string; dir?: string }>>
    }
  }
}

const reqParam = (codec: TypertCodec) => [{ name: 'req', wire: 'req', source: 'json', codec }] as const

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-agent-plugin-manager',
  descriptors: [
    { id: 'dsh-agent-plugin-manager#pluginManager/list', service: 'pluginManagerRemote', namespace: 'pluginManager', method: 'list', implementation: 'dsh-agent-plugin-manager', invocation: { kind: 'direct' }, parameters: [], result: listResult, sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 } },
    { id: 'dsh-agent-plugin-manager#pluginManager/inspect', service: 'pluginManagerRemote', namespace: 'pluginManager', method: 'inspect', implementation: 'dsh-agent-plugin-manager', invocation: { kind: 'direct' }, parameters: reqParam(nameRequest), result: inspectResult, sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 } },
    { id: 'dsh-agent-plugin-manager#pluginManager/start', service: 'pluginManagerRemote', namespace: 'pluginManager', method: 'start', implementation: 'dsh-agent-plugin-manager', invocation: { kind: 'direct' }, parameters: reqParam(nameRequest), result: opResult, sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 } },
    { id: 'dsh-agent-plugin-manager#pluginManager/stop', service: 'pluginManagerRemote', namespace: 'pluginManager', method: 'stop', implementation: 'dsh-agent-plugin-manager', invocation: { kind: 'direct' }, parameters: reqParam(nameRequest), result: opResult, sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 } },
    { id: 'dsh-agent-plugin-manager#pluginManager/unmount', service: 'pluginManagerRemote', namespace: 'pluginManager', method: 'unmount', implementation: 'dsh-agent-plugin-manager', invocation: { kind: 'direct' }, parameters: reqParam(nameRequest), result: opResult, sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 } },
    { id: 'dsh-agent-plugin-manager#pluginManager/create', service: 'pluginManagerRemote', namespace: 'pluginManager', method: 'create', implementation: 'dsh-agent-plugin-manager', invocation: { kind: 'direct' }, parameters: [{ name: 'req', wire: 'req', source: 'json', codec: createRequest }], result: opResult, sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 } },
  ],
}

export default TYPERT_REMOTE
