import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory } from '@tanstack/react-router';
import { expect, test, vi } from 'vitest';
import { Route } from '../src/routes/__root';
import { getRouter } from '../src/router';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  HeadContent: () => <title>面接一覧</title>,
  Outlet: () => <main>面接画面</main>,
  Scripts: () => <script src="/client.js" />,
}));
vi.mock('../src/routeTree.gen', () => ({ routeTree: Route }));

test('ドキュメント言語・メタ情報とコンテンツ、クライアントスクリプトを組み立てる', async () => {
  const router = getRouter();
  router.update({ history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  expect(router.state.matches[0].meta).toEqual([
    { charSet: 'utf-8' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { title: '面接一覧・ローカル検証' },
  ]);
  const Shell = Route.options.component!;
  const markup = renderToStaticMarkup(<Shell />);
  expect(markup).toContain('<html lang="ja">');
  expect(markup).toContain('<main>面接画面</main>');
  expect(markup).toContain('src="/client.js"');
  expect(router.options.scrollRestoration).toBe(true);
});
