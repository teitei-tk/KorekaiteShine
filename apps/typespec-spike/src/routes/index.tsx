import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { components } from '../../generated/api';
import { getInterviews } from '../lib/interviews';

export const Route = createFileRoute('/')({ component: InterviewPage });

function InterviewPage() {
  const [result, setResult] = useState<components['schemas']['InterviewList'] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    getInterviews(window.location.origin).then(
      (data) => {
        if (active) setResult(data);
      },
      () => {
        if (active) setError('面接一覧を取得できませんでした。');
      },
    );
    return () => {
      active = false;
    };
  }, [revision]);
  const statusLabels = {
    waiting: '評価待ち',
    running: '評価中',
    retrying: '自動再試行待ち',
    failed: '評価失敗',
    completed: '評価完了',
  };
  return (
    <main
      style={{
        maxWidth: 960,
        margin: '48px auto',
        padding: 24,
        fontFamily: 'sans-serif',
        lineHeight: 1.8,
      }}
    >
      <h1>面接一覧</h1>
      <p>ローカル連携検証用の架空データです。</p>
      <button
        type="button"
        onClick={() => {
          setResult(null);
          setError('');
          setRevision((value) => value + 1);
        }}
      >
        再取得
      </button>
      {error ? (
        <p role="alert">{error}</p>
      ) : !result ? (
        <p role="status">読み込み中…</p>
      ) : (
        <>
          <p role="status">{result.items.length}件の面接</p>
          <table cellPadding={12}>
            <thead>
              <tr>
                <th>日時</th>
                <th>テーマ</th>
                <th>材料</th>
                <th>時間</th>
                <th>評価状態</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {new Date(item.startedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                  </td>
                  <td>{item.theme}</td>
                  <td>{item.materialKind === 'code' ? 'コード' : '経験Markdown'}</td>
                  <td>{item.durationSeconds / 60}分</td>
                  <td>{statusLabels[item.evaluationStatus]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
