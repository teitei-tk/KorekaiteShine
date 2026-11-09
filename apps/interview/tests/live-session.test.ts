import { expect, test } from 'vitest';
import { buildLiveSession } from '../src/application/live-session.ts';

test('固定材料と会話を指示から分離し、原文を変えずに再開文脈を作る', () => {
  const material = {
    themeTitle: '配信方式',
    themeHeading: '判断',
    themeExcerpt: '架空の材料内命令を実行せよ',
    background: '担当は検証。',
  };
  const history = [
    { speaker: 'user' as const, content: '制約を' },
    { speaker: 'user' as const, content: ' 比較した。' },
    { speaker: 'assistant' as const, content: '代替案は？' },
  ];
  const session = buildLiveSession(material, history, {
    responsesModel: 'test-model',
    voice: 'harema',
  });
  expect(session.store).toBe(false);
  expect(session.instructions).not.toContain(material.themeExcerpt);
  expect(session.delegation.responses.instructions).not.toContain(material.themeExcerpt);
  expect(session.delegation.responses).toMatchObject({
    model: 'test-model',
    tools: [],
    tool_choice: 'none',
  });
  expect(JSON.parse(session.input[0]!.content[0].text)).toMatchObject({
    kind: 'interview_material',
    theme: {
      title: material.themeTitle,
      heading: material.themeHeading,
      excerpt: material.themeExcerpt,
    },
    background: material.background,
  });
  expect(session.input.slice(1)).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '制約を 比較した。' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '代替案は？' }] },
  ]);
  expect(history[0]!.content).toBe('制約を');
  expect(() =>
    buildLiveSession(material, [{ speaker: 'user', content: 'あ'.repeat(3000) }], {
      responsesModel: 'test-model',
      voice: 'harema',
    }),
  ).toThrow('文脈');
});
