import { createLlmBackend } from './llm.mjs';
import { createMockBackend } from './mock.mjs';
const registry = new Map([
  ['llm', createLlmBackend],
  ['mock', createMockBackend],
]);
function registerBackend(name, factory) {
  registry.set(name, factory);
}
function createBackend(name, services = {}) {
  const factory = registry.get(name);
  if (!factory) throw new Error(`未知模型后端：${name}`);
  return factory(services);
}
export { createBackend, registerBackend };
