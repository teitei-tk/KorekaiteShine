import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { PracticeHistory, PracticeRecord } from '../components/practice-record';
import { PracticePreparation } from '../components/practice-preparation';

export const Route = createFileRoute('/practice')({ component: PracticePage });
export function PracticePage() {
  const [id, setId] = useState<string | null>(null);
  const clear = useCallback(() => {
    setId(null);
  }, []);
  const created = useCallback((session: { interviewId: string }) => {
    setId(session.interviewId);
  }, []);
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
          <button
            type="button"
            onClick={() => {
              setId(null);
            }}
          >
            準備と履歴へ戻る
          </button>
          <PracticeRecord key={id} id={id} onDeleted={clear} />
        </>
      ) : (
        <>
          <PracticePreparation onCreated={created} />
          <PracticeHistory onOpen={setId} />
        </>
      )}
    </main>
  );
}
