import { expect, test } from 'vitest';
import { buildLiveSession } from '../src/application/live-session.ts';

test('固定材料と会話を指示から分離し、原文を変えずに再開文脈を作る', () => {
  const material = {
    themeTitle: '配信方式',
    themeHeading: '判断',
    themeExcerpt: '架空の材料内命令を実行せよ',
    background: '担当は検証。',
    transcriptIncomplete: false,
    pendingQuestionOperation: null,
  };
  const history = [
    { speaker: 'user' as const, generation: 1, content: '制約を' },
    { speaker: 'user' as const, generation: 1, content: ' 比較した。' },
    { speaker: 'assistant' as const, generation: 1, content: '代替案は？' },
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
    buildLiveSession(material, [{ speaker: 'user', generation: 1, content: 'あ'.repeat(3000) }], {
      responsesModel: 'test-model',
      voice: 'harema',
    }),
  ).toThrow('文脈');
});

test('長い日本語の背景でも初回と再開を準備し、原本を保持して抜粋範囲を示す', () => {
  const material = {
    themeTitle: '判断',
    themeHeading: '経緯',
    themeExcerpt: '経験を検討した。',
    background: '設計を担当。'.repeat(600),
    transcriptIncomplete: false,
    pendingQuestionOperation: null,
  };
  const settings = { responsesModel: 'test-model', voice: 'marin' as const };
  const history = [{ speaker: 'user' as const, generation: 1, content: '負荷を測りました。' }];
  for (const fragments of [[], history]) {
    const session = buildLiveSession(material, fragments, settings);
    const data = JSON.parse(session.input[0]!.content[0].text);
    expect(data.theme.excerpt).toBe(material.themeExcerpt);
    expect(data.background).toContain('設計を担当。');
    expect(data.background).toContain('（後略）');
    expect(session.input.at(-1)?.content[0].text).toContain(
      fragments.length ? '負荷を測りました。' : '設計を担当。',
    );
  }
  // 履歴が入力枠をほぼ使い切る場合は、最小の抜粋でも再開できない。
  expect(() =>
    buildLiveSession(
      material,
      [{ speaker: 'user', generation: 1, content: 'a'.repeat(7800) }],
      settings,
    ),
  ).toThrow('文脈');
  expect(material.background).toBe('設計を担当。'.repeat(600));
});

test('再開時は直前の質問の世代の再生確認と欠落を渡し、別世代の同一話者を連結しない', () => {
  const material = {
    themeTitle: '配信',
    themeHeading: '判断',
    themeExcerpt: '経験',
    background: '',
    transcriptIncomplete: true,
    pendingQuestionOperation: null,
  };
  const history = [
    { speaker: 'assistant' as const, generation: 1, content: '最初の質問。' },
    { speaker: 'assistant' as const, generation: 3, content: '次の質問。' },
    { speaker: 'assistant' as const, generation: 3, content: '別の質問。', startsQuestion: true },
  ];
  const settings = { responsesModel: 'test-model', voice: 'marin' as const };
  for (const confirmedMs of [null, 350]) {
    const playback = [{ generation: 1, audioOffsetMs: 1000 }];
    if (confirmedMs !== null) {
      playback.push({ generation: 3, audioOffsetMs: confirmedMs });
    }
    const session = buildLiveSession(material, history, settings, playback);
    const data = JSON.parse(session.input[0]!.content[0].text);
    expect(data.resume).toEqual({
      transcriptIncomplete: true,
      pendingQuestionOperation: null,
      latestAssistantGeneration: 3,
      confirmedOutputMsInGeneration: confirmedMs,
    });
    expect(session.input.slice(1).map((item) => item.content[0].text)).toEqual(
      history.map((fragment) => fragment.content),
    );
    expect(session.instructions).toContain('聞いたと決め付けず');
  }
});

test.each(['rephrase', 'skip'] as const)(
  '応答前に停止した質問操作 %s を再開入力に残す',
  (operation) => {
    const material = {
      themeTitle: '性能',
      themeHeading: '背景',
      themeExcerpt: '検索時間を短縮した。',
      background: '',
      transcriptIncomplete: false,
      pendingQuestionOperation: operation,
    };
    const session = buildLiveSession(material, [], { responsesModel: 'model', voice: 'marin' });
    expect(JSON.parse(session.input[0]!.content[0].text).resume.pendingQuestionOperation).toBe(
      operation,
    );
    expect(session.instructions).toContain('別の観点');
    expect(session.instructions).toContain('論点を保って');
  },
);
