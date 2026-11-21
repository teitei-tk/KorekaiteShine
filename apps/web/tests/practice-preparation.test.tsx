// @vitest-environment jsdom
import { parseJson } from '@korekaite/api-contracts/json';
import './helpers/dom';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert, expect, test, vi } from 'vitest';
import { PracticePreparation } from '../src/components/practice-preparation';

test('材料を変更したら送信確認を取り直し、選んだ根拠と補足で面接を作る', async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/local-session')) {
      return Response.json({ operationToken: 'a'.repeat(64) });
    }
    expect(new Headers(init?.headers).get('X-Interview-Token')).toBe('a'.repeat(64));
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/analyze')) {
      assert.ok(typeof init?.body === 'string');
      expect(parseJson(init.body)).toEqual({ markdown: '架空の判断', confirmed: true });
      return Response.json({
        analysisId: 'a',
        themes: [{ title: '構成の選択', heading: '本文', excerpt: '架空の判断' }],
      });
    }
    assert.ok(typeof init?.body === 'string');
    expect(parseJson(init.body)).toMatchObject({
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
  const onCreated = vi.fn<Parameters<typeof PracticePreparation>[0]['onCreated']>();
  render(<PracticePreparation onCreated={onCreated} />);
  const source = screen.getByLabelText('経験Markdownの内容');
  await user.type(source, '架空');
  const consent = screen.getByRole('checkbox');
  await user.click(consent);
  await user.type(source, 'の判断');
  assert.ok(consent instanceof HTMLInputElement);
  expect(consent.checked).toBe(false);
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
  render(
    <PracticePreparation
      onCreated={vi.fn<Parameters<typeof PracticePreparation>[0]['onCreated']>()}
    />,
  );
  const markdown = '# 架空の経験\n静的出力を選んだ。';
  await user.upload(
    screen.getByLabelText(/ファイルを選ぶ/u),
    new File([markdown], 'experience.md', { type: 'text/markdown' }),
  );
  expect(screen.getByLabelText<HTMLTextAreaElement>('経験Markdownの内容').value).toBe(markdown);
  expect(
    screen.getByText(`${new TextEncoder().encode(markdown).length} / 32,768 バイト`),
  ).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: /OpenAI/u })).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

test('空の選択を無視し、サイズ超過と読み取り失敗を伝える', async () => {
  const user = userEvent.setup();
  render(
    <PracticePreparation
      onCreated={vi.fn<Parameters<typeof PracticePreparation>[0]['onCreated']>()}
    />,
  );
  const input = screen.getByLabelText(/ファイルを選ぶ/u);
  fireEvent.change(input, { target: { files: [] } });
  expect(screen.queryByRole('alert')).toBeNull();
  await user.upload(input, new File(['x'.repeat(32_769)], 'large.md'));
  expect(screen.getByRole('alert').textContent).toMatch(/32 KiB/u);
  const file = new File(['x'], 'error.md');
  vi.spyOn(file, 'text').mockRejectedValue('read failed');
  await user.upload(input, file);
  expect(screen.getByRole('alert').textContent).toMatch(/操作を完了/u);
});

test('確認済みの32768バイトは送信でき、32769バイトでは分析要求を送らない', async () => {
  const user = userEvent.setup();
  const markdown = `${'あ'.repeat(10_922)}ab`;
  const analyze = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/local-session')) {
      return Response.json({ operationToken: 'a'.repeat(64) });
    }
    assert.ok(typeof init?.body === 'string');
    analyze(parseJson(init.body));
    return Response.json({
      analysisId: 'boundary',
      themes: [{ title: '境界での判断', heading: '本文', excerpt: markdown.slice(0, 8) }],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <PracticePreparation
      onCreated={vi.fn<Parameters<typeof PracticePreparation>[0]['onCreated']>()}
    />,
  );
  const source = screen.getByLabelText('経験Markdownの内容');
  fireEvent.change(source, { target: { value: markdown } });
  await user.click(screen.getByRole('checkbox'));
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'テーマを分析する' });
  expect(button.disabled).toBe(false);
  await user.click(button);
  await screen.findByRole('radio', { name: '境界での判断' });
  expect(analyze).toHaveBeenCalledExactlyOnceWith({ markdown, confirmed: true });
  fireEvent.change(source, { target: { value: `${markdown}c` } });
  await user.click(screen.getByRole('checkbox'));
  expect(button.disabled).toBe(true);
  await user.click(button);
  expect(analyze).toHaveBeenCalledTimes(1);
});
