import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PracticeHistory, PracticeRecord } from '../components/practice-record';
import { PracticePreparation } from '../components/practice-preparation';

export const Route = createFileRoute('/practice')({ component: PracticePage });
export function PracticePage() {
  const [id, setId] = useState<string | null>(null);
  return (
    <main
      style={{
        maxWidth: 760,
        margin: '40px auto',
        padding: 20,
        fontFamily: 'sans-serif',
        lineHeight: 1.65,
      }}
    >
      <h1>技術面接の練習</h1>
      {id ? (
        <>
          <button onClick={() => setId(null)}>準備と履歴へ戻る</button>
          <PracticeRecord key={id} id={id} onDeleted={() => setId(null)} />
        </>
      ) : (
        <>
          <PracticePreparation onCreated={(session) => setId(session.interviewId)} />
          <PracticeHistory onOpen={setId} />
        </>
      )}
    </main>
  );
}
