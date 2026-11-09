// @vitest-environment jsdom
import './helpers/dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { PracticePreparation } from '../src/components/practice-preparation';

test('材料を変更したら送信確認を取り直し、選んだ根拠と補足で面接を作る', async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/local-session')) {
      return Response.json({ operationToken: 'a'.repeat(64) });
    }
    expect(new Headers(init?.headers).get('X-Interview-Token')).toBe('a'.repeat(64));
    if (String(url).endsWith('/analyze')) {
      expect(JSON.parse(String(init?.body))).toEqual({ markdown: '架空の判断', confirmed: true });
      return Response.json({
        analysisId: 'a',
        themes: [{ title: '構成の選択', heading: '本文', excerpt: '架空の判断' }],
      });
    }
    expect(JSON.parse(String(init?.body))).toMatchObject({
      analysisId: 'a',
      themeIndex: 0,
      background: '担当者',
    });
    return Response.json({
      interviewId: 'i',
      status: 'ready',
      theme: '構成の選択',
      createdAt: 1,
      activeMs: 0,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const onCreated = vi.fn();
  render(<PracticePreparation onCreated={onCreated} />);
  const source = screen.getByLabelText('経験Markdownの内容');
  await user.type(source, '架空');
  const consent = screen.getByRole('checkbox');
  await user.click(consent);
  await user.type(source, 'の判断');
  expect((consent as HTMLInputElement).checked).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  await user.click(consent);
  await user.click(screen.getByRole('button', { name: 'テーマを分析する' }));
  await user.click(await screen.findByRole('radio', { name: '構成の選択' }));
  await user.type(screen.getByLabelText('背景・担当（任意）'), '担当者');
  await user.click(screen.getByRole('button', { name: '面接を準備する' }));
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ interviewId: 'i' }));
});

test('ファイル選択では送信せず、OpenAIへの送信前に全文とUTF-8の量を表示する', async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<PracticePreparation onCreated={vi.fn()} />);
  const markdown = '# 架空の経験\n静的出力を選んだ。';
  await user.upload(
    screen.getByLabelText(/ファイルを選ぶ/),
    new File([markdown], 'experience.md', { type: 'text/markdown' }),
  );
  expect((screen.getByLabelText('経験Markdownの内容') as HTMLTextAreaElement).value).toBe(markdown);
  expect(
    screen.getByText(`${new TextEncoder().encode(markdown).length} / 32,768 バイト`),
  ).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: /OpenAI/ })).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});
