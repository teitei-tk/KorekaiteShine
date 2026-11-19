import type { components } from '@korekaite/api-contracts/http';
import { useEffect, useRef, useState } from 'react';
import { createDiagnosticRun, DiagnosticValidationError, getDiagnosticStatus } from './client';

type CheckStatus = components['schemas']['CheckStatus'];
type Scenario = CheckStatus['scenario'];
const scenarioLabels: Record<Scenario, string> = {
  success: '正常終了',
  retry_then_success: '一度失敗してから成功',
  exhaust_retries: '4回失敗してDLQへ退避',
};

export function DiagnosticPage() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  const [scenario, setScenario] = useState<Scenario>('success');
  const [accepted, setAccepted] = useState<components['schemas']['CheckAccepted'] | null>(null);
  const [result, setResult] = useState<CheckStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useRef<ReturnType<typeof createDiagnosticRun> | null>(null);
  // 再描画前の連続操作も同時実行させない。
  const inFlight = useRef(false);

  const previousRun = run.current;
  async function submit(newRun: boolean, selectRun: () => ReturnType<typeof createDiagnosticRun>) {
    if (!ready || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const current = selectRun();
      run.current = current;
      if (newRun) {
        setAccepted(null);
        setResult(null);
      }
      setAccepted(await current.start());
    } catch (error_) {
      if (error_ instanceof DiagnosticValidationError && error_.code === 'VALIDATION_ERROR') {
        const locations = error_.details.map(
          (detail) => `${detail.location}${detail.path}: ${detail.code}`,
        );
        setError(`入力エラー：${locations.join('、')}（要求ID：${error_.requestId}）`);
      } else {
        setError('受付結果を確認できません。同じ実行を再送して確認してください。');
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    if (!ready || inFlight.current || !accepted) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await getDiagnosticStatus(accepted.jobId, { baseUrl: globalThis.location.origin }));
    } catch {
      setError('状態を取得できませんでした。通信または応答形式を確認し、再取得してください。');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 800,
        margin: '40px auto',
        padding: 24,
        fontFamily: 'sans-serif',
        lineHeight: 1.8,
      }}
    >
      <h1>ローカル接続診断</h1>
      <p>架空データでWeb → DO → Queue → 評価Consumer → D1の接続を確認します。</p>
      <label htmlFor="diagnostic-scenario">シナリオ</label>{' '}
      <select
        id="diagnostic-scenario"
        value={scenario}
        disabled={!ready || busy}
        onChange={(event) => {
          const { value } = event.target;
          if (
            value === 'success' ||
            value === 'retry_then_success' ||
            value === 'exhaust_retries'
          ) {
            setScenario(value);
          }
        }}
      >
        <option value="success">{scenarioLabels.success}</option>
        <option value="retry_then_success">{scenarioLabels.retry_then_success}</option>
        <option value="exhaust_retries">{scenarioLabels.exhaust_retries}</option>
      </select>
      <p>
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() =>
            void submit(true, () =>
              createDiagnosticRun(scenario, { baseUrl: globalThis.location.origin }),
            )
          }
        >
          新しい実行を開始
        </button>{' '}
        <button
          type="button"
          disabled={!ready || busy || !run.current || accepted !== null}
          onClick={previousRun ? () => void submit(false, () => previousRun) : undefined}
        >
          同じ実行を再送
        </button>{' '}
        <button type="button" disabled={!ready || busy || !accepted} onClick={() => void refresh()}>
          状態を再取得
        </button>
      </p>
      <p>再送は元のシナリオと冪等キーを使います。新しい実行は別のジョブを作成します。</p>
      {busy && <output style={{ display: 'block', marginBlock: '1em' }}>通信中…</output>}
      {error && <p role="alert">{error}</p>}
      {accepted && (
        <section aria-label="受付結果">
          <h2>受付済み</h2>
          <p>ジョブID：{accepted.jobId}</p>
          <p>シナリオ：{scenarioLabels[accepted.scenario]}</p>
          <p>受付日時：{accepted.acceptedAt}</p>
          <p>受付は完了を意味しません。状態を再取得して確認してください。</p>
        </section>
      )}
      {result && <DiagnosticResult result={result} />}
    </main>
  );
}

const statusLabels: Record<CheckStatus['status'], string> = {
  pending: '処理待ち',
  running: '実行中',
  retry_wait: '再試行待ち',
  completed: '正常完了',
  failed: 'ジョブ失敗',
  cancelled: '中止',
};
const checkLabels = { pending: '未確認', passed: '確認済み', not_expected: '対象外' };

export function DiagnosticResult({ result }: { result: CheckStatus }) {
  return (
    <section aria-label="診断結果">
      <h2>診断結果</h2>
      <output style={{ display: 'block', marginBlock: '1em' }}>
        {statusLabels[result.status]}
      </output>
      <dl>
        <dt>ジョブID</dt>
        <dd>{result.jobId}</dd>
        <dt>試行回数</dt>
        <dd>{result.attemptCount}</dd>
        <dt>更新日時</dt>
        <dd>{result.updatedAt}</dd>
        <dt>次回試行日時</dt>
        <dd>{result.nextAttemptAt ?? 'なし'}</dd>
        <dt>最終エラーコード</dt>
        <dd>{result.lastErrorCode ?? 'なし'}</dd>
        <dt>DO保存</dt>
        <dd>{checkLabels[result.checks.doPersistence]}</dd>
        <dt>Consumer正常完了</dt>
        <dd>{checkLabels[result.checks.consumerCompletion]}</dd>
        <dt>DLQ受信</dt>
        <dd>{checkLabels[result.checks.dlqReceipt]}</dd>
      </dl>
    </section>
  );
}
