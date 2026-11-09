import { expect, it } from 'vitest';
import { createArtifact, validateMetadata } from './artifact.ts';
import { artifactFixture } from './tests/helpers/artifact.ts';
import { MARKER } from './policy.ts';
import { historyMarker } from './history.ts';

it('旧集約コメントの確認不能は元コメントへのリンク付きで別コメントにする', () => {
  const fixture = artifactFixture();
  fixture.metadata.history.issues.push({
    id: 3,
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `${MARKER}\n<!-- revision:${'d'.repeat(40)}:${fixture.metadata.base} -->\n${historyMarker(
      [
        {
          priority: 'P2',
          path: 'a.ts',
          line: 1,
          condition: 'condition',
          impact: 'impact',
          fix: 'fix',
        },
      ],
    )}`,
  });
  fixture.review.checks = [{ id: '3:1', status: 'unverified', evidence: '確認資料が不足' }];
  const artifact = fixture.create();
  expect(artifact.operations[0].kind).toBe('reply');
  expect(artifact.operations[0]).not.toHaveProperty('replyTo');
  expect(artifact.operations[0].body).toContain('#issuecomment-3');
  expect(artifact.operations[0].body).toContain('確認不能: 確認資料が不足');
});

it('生成元マーカーを含む本文がGitHubの上限を超えたら拒否する', () => {
  const fixture = artifactFixture();
  fixture.origin.run = '1'.repeat(60_000);
  expect(fixture.create).toThrow('GitHubコメント上限');
});

it('整合する利用量と修正確認省略を受理し完了サマリーを作る', () => {
  const f = artifactFixture();
  const artifact = createArtifact(f.metadata, f.review, f.origin, {
    input: 1,
    output: 2,
    total: 3,
  });
  expect(artifact.usage).toEqual({ input: 1, output: 2, total: 3 });
  expect(artifact.operations).toHaveLength(1);
  expect(artifact.operations[0].kind).toBe('summary');
});

it('使用量の合計が入力と出力の和に一致しなければ拒否する', () => {
  const f = artifactFixture();
  expect(() =>
    createArtifact(f.metadata, f.review, f.origin, { input: 1, output: 2, total: 4 }),
  ).toThrow('利用量が不正');
});

it('未完了のレビューを投稿用成果物へ変換しない', () => {
  const fixture = artifactFixture();
  fixture.review.status = 'incomplete';
  expect(fixture.create).toThrow('未完了の結果は投稿できません');
});

it('生成元の実行IDが不正なら成果物を作らない', () => {
  const fixture = artifactFixture();
  fixture.origin.run = '0';
  expect(fixture.create).toThrow('生成元が不正');
});

it('対象メタデータの変更行が0なら投稿成果物を作らない', () => {
  const fixture = artifactFixture();
  fixture.metadata.lines['a.ts'] = [0];
  expect(() => validateMetadata(fixture.metadata)).toThrow('成果物の対象が不正');
});
