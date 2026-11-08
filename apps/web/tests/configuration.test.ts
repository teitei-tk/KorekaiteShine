import { expect, test, vi } from 'vitest';

const plugins = vi.hoisted(() => ({
  void: { name: 'void-test-plugin' },
  start: { name: 'start-test-plugin' },
  react: { name: 'react-test-plugin' },
}));
const factories = vi.hoisted(() => ({
  define: vi.fn((config: { plugins: { name: string }[] }) => config),
  defineVoid: vi.fn((config: Record<string, never>) => config),
  void: vi.fn(),
  start: vi.fn(),
  react: vi.fn(),
}));
vi.mock('vite', () => ({ defineConfig: factories.define }));
vi.mock('void/config', () => ({ defineConfig: factories.defineVoid }));
vi.mock('void', () => ({ voidPlugin: factories.void.mockReturnValue(plugins.void) }));
vi.mock('@tanstack/react-start/plugin/vite', () => ({
  tanstackStart: factories.start.mockReturnValue(plugins.start),
}));
vi.mock('@vitejs/plugin-react', () => ({
  default: factories.react.mockReturnValue(plugins.react),
}));

test('Web設定はVoid・Start・Reactを順に組み立ててViteへ渡す', async () => {
  const { default: viteConfig } = await import('../vite.config.ts');
  const expected = { plugins: [plugins.void, plugins.start, plugins.react] };
  expect(factories.void).toHaveBeenCalledOnce();
  expect(factories.start).toHaveBeenCalledOnce();
  expect(factories.react).toHaveBeenCalledOnce();
  expect(factories.define).toHaveBeenCalledExactlyOnceWith(expected);
  expect(viteConfig).toEqual(expected);
});

test('Void設定は追加の配置先やbindingを宣言せず既定構成を返す', async () => {
  const { default: config } = await import('../void.config.ts');
  expect(factories.defineVoid).toHaveBeenCalledExactlyOnceWith({});
  expect(config).toEqual({});
});
