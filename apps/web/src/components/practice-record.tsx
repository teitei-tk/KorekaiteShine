import { PracticeLive } from './practice-live';
import { useCallback, useEffect, useState } from 'react';
import type { components } from '@korekaite/api-contracts/http';
import {
  readDetail,
  readHistory,
  requestEvaluationRetry,
  deleteSavedInterview,
} from '../lib/practice';
import { Temporal } from '@js-temporal/polyfill';

type Schema = components['schemas'];
const statusLabels = {
  ready: '開始前',
  connecting: '接続中',
  active: '面接中',
  paused: '一時停止',
  reconnecting: '再接続待ち',
  ending: '終了処理中',
  ended: '終了',
};
const evaluationLabels = {
  pending: '評価待ち',
  running: '評価中',
  retry_wait: '再試行待ち',
  completed: '評価完了',
  failed: '評価失敗',
  cancelled: '評価取消',
};
const failureReasons: Readonly<Record<string, string>> = {
  EVALUATION_USAGE_LIMIT: '新規評価の日次上限に達しました。翌日以降に再評価できます。',
  AI_CONFIGURATION_INVALID: '評価モデルまたはAPIキーの設定を確認してください。',
  AI_REQUEST_REJECTED: '評価のリクエストが拒否されました。モデル設定と利用権限を確認してください。',
  AI_RATE_LIMITED: 'AIの利用制限に達しました。時間をおいて再評価してください。',
  AI_TIMEOUT: '評価の応答が制限時間内に返りませんでした。',
  INVALID_AI_RESULT: '評価結果の形式または引用の根拠を確認できませんでした。',
  EVALUATION_INPUT_UNAVAILABLE: '固定した評価入力を読み込めませんでした。',
};
const axes = {
  problem: '課題・制約',
  alternatives: '選択肢とトレードオフ',
  reasoning: '判断の根拠',
  action: '本人の行動・合意形成',
  learning: '結果・学び',
} as const;
const observations = {
  strengths: '強み',
  gaps: '改善点',
  unconfirmed: '確認できなかった点',
  practiceQuestions: '次に練習する質問',
} as const;
function timestamp(ms: number) {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO('Asia/Tokyo')
    .toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}
export function PracticeHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const [cursor, setCursor] = useState<Schema['InterviewCursor'] | null>(null);
  const [page, setPage] = useState<Schema['InterviewHistory'] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setError('');
    // oxlint-disable-next-line promise/catch-or-return, promise/prefer-catch -- thenの第2引数で拒否を処理する終端のUI更新。 成功処理内の例外と元のPromiseの拒否を同じ失敗処理へ混同しない。
    readHistory(cursor, controller.signal).then(
      // oxlint-disable-next-line promise/always-return -- 終端の副作用コールバックであり、値は後続へ渡さない。
      (value) => {
        if (!controller.signal.aborted) {
          setPage(value);
        }
      },
      (error_) => {
        if (!controller.signal.aborted) {
          setError(error_ instanceof Error ? error_.message : '履歴を取得できませんでした。');
        }
      },
    );
    return () => {
      controller.abort();
    };
  }, [cursor, revision]);
  return (
    <section>
      <h2>面接履歴</h2>
      {error ? (
        <p role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setRevision(revision + 1);
            }}
          >
            再取得
          </button>
        </p>
      ) : page ? (
        page.items.length > 0 ? (
          <ul>
            {page.items.map((item) => (
              <li key={item.interviewId}>
                <button
                  type="button"
                  onClick={() => {
                    onOpen(item.interviewId);
                  }}
                >
                  {item.theme}
                </button>{' '}
                {timestamp(item.createdAt)} · {statusLabels[item.status]}
              </li>
            ))}
          </ul>
        ) : (
          <p>保存された面接はありません。</p>
        )
      ) : (
        <output style={{ display: 'block', marginBlock: '1em' }}>履歴を読み込み中…</output>
      )}
      {page?.next && (
        <button
          type="button"
          onClick={() => {
            setCursor(page.next);
          }}
        >
          以前の面接を見る
        </button>
      )}
      {cursor && (
        <button
          type="button"
          onClick={() => {
            setCursor(null);
          }}
        >
          最新の履歴へ
        </button>
      )}
    </section>
  );
}
function Report({
  report,
  sequences,
}: {
  report: Schema['InterviewEvaluation'];
  sequences: Map<string, number>;
}) {
  function citations(items: Schema['EvaluationEvidence'][]) {
    return items.map((item, i) => (
      // oxlint-disable-next-line react/no-array-index-key -- 状態を持たない表示専用の行。重複する本文も別々に表示する。
      <blockquote key={i}>
        <p>{item.quote}</p>
        {item.source === 'material' ? (
          <a href="#interview-material">材料の抜粋</a>
        ) : (
          item.fragmentIds.map((id) => {
            const sequence = sequences.get(id);
            return (
              sequence && (
                <a key={id} href={`#transcript-${sequence}`}>
                  発言{sequence}{' '}
                </a>
              )
            );
          })
        )}
      </blockquote>
    ));
  }
  return (
    <section>
      <h2>評価結果</h2>
      <p>{report.summary}</p>
      {Object.entries(axes).map(([key, title]) => {
        if (
          key !== 'problem' &&
          key !== 'alternatives' &&
          key !== 'reasoning' &&
          key !== 'action' &&
          key !== 'learning'
        ) {
          throw new Error('評価軸が不正です。');
        }
        const axis = report.axes[key];
        return (
          <section key={key}>
            <h3>{title}</h3>
            <strong>
              {axis.status === 'scored'
                ? `${axis.score} / 5`
                : axis.status === 'unconfirmed'
                  ? '未確認'
                  : '対象外'}
            </strong>
            <p>{axis.reason}</p>
            {citations(axis.evidence)}
          </section>
        );
      })}
      {Object.entries(observations).map(([key, title]) => {
        if (
          key !== 'strengths' &&
          key !== 'gaps' &&
          key !== 'unconfirmed' &&
          key !== 'practiceQuestions'
        ) {
          throw new Error('観察項目が不正です。');
        }
        const items = report[key];
        return (
          items.length > 0 && (
            <section key={key}>
              <h3>{title}</h3>
              {items.map((item, i) => (
                // oxlint-disable-next-line react/no-array-index-key -- 状態を持たない表示専用の行。重複する本文も別々に表示する。
                <div key={i}>
                  <p>{item.text}</p>
                  {citations(item.evidence)}
                </div>
              ))}
            </section>
          )
        );
      })}
      {report.consistency.length > 0 && (
        <section>
          <h3>発言の整合性</h3>
          {report.consistency.map((item, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- 状態を持たない表示専用の行。重複する本文も別々に表示する。
            <div key={i}>
              <strong>{item.status === 'resolved' ? '確認済み' : '要確認'}</strong>
              <p>{item.explanation}</p>
              {citations([item.first, item.second])}
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
export function PracticeRecord({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [detail, setDetail] = useState<Schema['InterviewDetail'] | null>(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [revision, setRevision] = useState(0);
  const refreshRevision = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timerState = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
    async function refresh() {
      try {
        const value = await readDetail(id, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        setDetail(value);
        setError('');
        if (
          value.evaluation &&
          ['pending', 'running', 'retry_wait'].includes(value.evaluation.status)
        ) {
          timerState.timer = setTimeout(() => {
            void refresh();
          }, 3000);
        }
      } catch (error_) {
        if (!controller.signal.aborted) {
          setError(error_ instanceof Error ? error_.message : '面接の記録を取得できませんでした。');
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timerState.timer);
    };
  }, [id, revision]);
  const evaluation = detail?.evaluation;
  return (
    <article>
      {error && <p role="alert">{error}</p>}
      {!detail && !error && (
        <output style={{ display: 'block', marginBlock: '1em' }}>面接の記録を読み込み中…</output>
      )}
      {detail && (
        <>
          <h2>{detail.session.theme}</h2>
          {detail.session.status !== 'ended' && (
            <PracticeLive id={id} onDeleted={onDeleted} onEnded={refreshRevision} />
          )}
          {detail.session.status === 'ended' && (
            <p>
              {statusLabels[detail.session.status]} · 面接時間{' '}
              {Math.floor(detail.session.activeMs / 60_000)}分
              {Math.floor(detail.session.activeMs / 1000) % 60}秒
            </p>
          )}
          {detail.audioRemainingMs !== undefined && (
            <p>
              今日のアプリ内面接時間の残り（記録取得時点）{' '}
              {Math.floor(detail.audioRemainingMs / 60_000)}分
              {Math.floor(detail.audioRemainingMs / 1000) % 60}秒
            </p>
          )}
          {detail.evaluation && (
            <output style={{ display: 'block', marginBlock: '1em' }}>
              {evaluationLabels[detail.evaluation.status]}
              {detail.evaluation.nextAttemptAt !== null &&
                ` · 次の試行 ${timestamp(detail.evaluation.nextAttemptAt)}`}
            </output>
          )}
          {evaluation?.status === 'failed' && (
            <section>
              <p>
                {failureReasons[evaluation.lastErrorCode ?? ''] ??
                  '評価を完了できませんでした。時間をおいて再評価してください。'}
              </p>
              <button
                type="button"
                disabled={retrying}
                onClick={() => {
                  void (async () => {
                    setRetrying(true);
                    setError('');
                    try {
                      await requestEvaluationRetry(id, evaluation.jobId);
                      setRevision((value) => value + 1);
                    } catch (error_) {
                      setError(
                        error_ instanceof Error
                          ? error_.message
                          : '再評価を受け付けられませんでした。',
                      );
                    } finally {
                      setRetrying(false);
                    }
                  })();
                }}
              >
                同じ条件で再評価する
              </button>
            </section>
          )}
          {detail.evaluation?.result && (
            <Report
              report={detail.evaluation.result}
              sequences={
                new Map(detail.transcripts.map((item) => [item.fragmentId, item.sequence]))
              }
            />
          )}
          <section id="interview-material">
            <h3>面接に使った材料</h3>
            <strong>{detail.material.heading}</strong>
            <blockquote style={{ whiteSpace: 'pre-wrap' }}>{detail.material.excerpt}</blockquote>
            {detail.background && <p>{detail.background}</p>}
          </section>
          <section>
            <h3>保存済みの文字起こし</h3>
            {detail.playback.map((receipt) => (
              <p
                key={receipt.generation}
              >{`音声接続 ${receipt.generation} で${receipt.audioOffsetMs / 1000}秒まで再生済み`}</p>
            ))}
            {detail.transcriptIncomplete && <p>文字起こしが一部欠けている可能性があります。</p>}
            <ol>
              {detail.transcripts.map((item) => (
                <li key={item.fragmentId} id={`transcript-${item.sequence}`}>
                  <strong>{item.speaker === 'user' ? 'あなた' : '面接官'}</strong> {item.content}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
      {detail && (
        <section>
          {confirmDelete ? (
            <>
              <p>
                「{detail.session.theme}
                」の会話、材料の抜粋、評価を削除します。元に戻すことはできません。
              </p>
              <button
                type="button"
                disabled={deleting}
                onClick={() => {
                  void (async () => {
                    setDeleting(true);
                    setError('');
                    try {
                      await deleteSavedInterview(id);
                      onDeleted();
                    } catch {
                      setError('削除の完了を確認できませんでした。もう一度お試しください。');
                    } finally {
                      setDeleting(false);
                    }
                  })();
                }}
              >
                この面接を削除する
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => {
                  setConfirmDelete(false);
                }}
              >
                キャンセル
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(true);
              }}
            >
              記録の削除
            </button>
          )}
        </section>
      )}
      <button
        type="button"
        onClick={() => {
          setRevision(revision + 1);
        }}
      >
        記録を更新
      </button>
    </article>
  );
}
