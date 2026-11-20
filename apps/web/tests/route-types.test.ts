import { expectTypeOf, test } from 'vitest';
import type { Register } from '@tanstack/react-start';
import type { getRouter } from '../src/router';

test('ビルド前の生成だけでStartのrouterとSSR型を登録する', () => {
  expectTypeOf<Register['router']>().toEqualTypeOf<ReturnType<typeof getRouter>>();
  expectTypeOf<Register['ssr']>().toEqualTypeOf<true>();
});
