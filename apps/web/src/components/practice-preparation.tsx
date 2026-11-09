import { useRef, useState } from 'react';
import type { components } from '@korekaite/api-contracts/http';
import { analyzeMarkdown, prepareInterview } from '../lib/practice';

export function PracticePreparation({
  onCreated,
}: {
  onCreated(session: components['schemas']['InterviewSession']): void;
}) {
  const [markdown, setMarkdown] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [analysis, setAnalysis] = useState<components['schemas']['SavedMaterialAnalysis'] | null>(
    null,
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [background, setBackground] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef('');
  const bytes = new TextEncoder().encode(markdown).byteLength;
  function changeMaterial(value: string) {
    setMarkdown(value);
    setConfirmed(false);
    setAnalysis(null);
    setSelected(null);
    setError('');
    attempt.current = '';
  }
  async function perform(action: () => Promise<void>) {
    setError('');
    setPending(true);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。');
    } finally {
      setPending(false);
    }
  }
  return (
    <fieldset disabled={pending} style={{ border: 0, margin: 0, padding: 0 }}>
      <h2>経験Markdown</h2>
      <p>
        1日の利用枠は分析10回、音声60分、新規評価10回です。音声は面接中の接続時間で計算します。料金はモデルと利用量に応じて決まります。
      </p>
      <label>
        ファイルを選ぶ{' '}
        <input
          type="file"
          accept=".md,.markdown,.txt,text/plain,text/markdown"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) {
              void perform(async () => {
                if (file.size > 32768) {
                  throw new Error('32 KiB 以下のファイルを選んでください。');
                }
                changeMaterial(await file.text());
              });
            }
          }}
        />
      </label>
      <p>
        <label>
          経験Markdownの内容
          <textarea
            rows={10}
            style={{ display: 'block', width: '100%' }}
            value={markdown}
            onChange={(event) => changeMaterial(event.target.value)}
          />
        </label>
        <small>{bytes.toLocaleString()} / 32,768 バイト</small>
      </p>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{' '}
        この内容をテーマ分析のためにOpenAIへ送信することを確認しました
      </label>
      <p>
        <button
          type="button"
          disabled={!confirmed || !markdown.trim() || bytes > 32768}
          onClick={() =>
            void perform(async () => {
              const result = await analyzeMarkdown(markdown);
              setAnalysis(result);
              setSelected(null);
              attempt.current = '';
            })
          }
        >
          テーマを分析する
        </button>
      </p>
      {analysis && (
        <section>
          <h2>面接のテーマ</h2>
          {analysis.themes.map((theme, index) => (
            <div key={index}>
              <label>
                <input
                  type="radio"
                  name="theme"
                  checked={selected === index}
                  onChange={() => {
                    setSelected(index);
                    attempt.current = '';
                  }}
                />{' '}
                {theme.title}
              </label>
              <blockquote>
                <small>{theme.heading}</small>
                <p style={{ whiteSpace: 'pre-wrap' }}>{theme.excerpt}</p>
              </blockquote>
            </div>
          ))}
          <label>
            背景・担当（任意）
            <textarea
              style={{ display: 'block', width: '100%' }}
              maxLength={4000}
              value={background}
              onChange={(event) => {
                setBackground(event.target.value);
                attempt.current = '';
              }}
            />
          </label>
          <p>
            <button
              type="button"
              disabled={selected === null}
              onClick={() =>
                void perform(async () => {
                  if (selected === null) {
                    return;
                  }
                  attempt.current ||= crypto.randomUUID();
                  onCreated(
                    await prepareInterview({
                      interviewId: attempt.current,
                      analysisId: analysis.analysisId,
                      themeIndex: selected,
                      background,
                    }),
                  );
                })
              }
            >
              面接を準備する
            </button>
          </p>
        </section>
      )}
      {pending && <p role="status">処理中…</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
