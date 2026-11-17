import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true });
}

declare module '@tanstack/react-router' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- TanStackの宣言マージにはinterfaceが必要。
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

// ビルド時に生成されるfooterへ依存せず、単独の型検査でもStartを登録する。
declare module '@tanstack/react-start' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- TanStack Startの宣言マージにはinterfaceが必要。
  interface Register {
    ssr: true;
    router: Awaited<ReturnType<typeof getRouter>>;
  }
}
