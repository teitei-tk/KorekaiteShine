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
  useEffect(() => setReady(true), []);
  const [scenario, setScenario] = useState<Scenario>('success');
  const [accepted, setAccepted] = useState<components['schemas']['CheckAccepted'] | null>(null);
  const [result, setResult] = useState<CheckStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useRef<ReturnType<typeof createDiagnosticRun> | null>(null);
  // 再描画前の連続操作も同時実行させない。
  const inFlight = useRef(false);

  async function submit(newRun: boolean) {
    if (!ready || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (newRun) {
        run.current = createDiagnosticRun(scenario, { baseUrl: window.location.origin });
        setAccepted(null);
        setResult(null);
      }
      // 新規作成の失敗はcatchへ進み、再送ボタンはrunがある場合だけ有効になる。
      setAccepted(await run.current!.start());
    } catch (cause) {
      if (cause instanceof DiagnosticValidationError && cause.code === 'VALIDATION_ERROR') {
        const locations = cause.details.map(
          (detail) => `${detail.location}${detail.path}: ${detail.code}`,
        );
        setError(`入力エラー：${locations.join('、')}（要求ID：${cause.requestId}）`);
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
      setResult(await getDiagnosticStatus(accepted.jobId, { baseUrl: window.location.origin }));
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
          const value = event.target.value;
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
        <button type="button" disabled={!ready || busy} onClick={() => void submit(true)}>
          新しい実行を開始
        </button>{' '}
        <button
          type="button"
          disabled={!ready || busy || !run.current || accepted !== null}
          onClick={() => void submit(false)}
        >
          同じ実行を再送
        </button>{' '}
        <button type="button" disabled={!ready || busy || !accepted} onClick={() => void refresh()}>
          状態を再取得
        </button>
      </p>
      <p>再送は元のシナリオと冪等キーを使います。新しい実行は別のジョブを作成します。</p>
      {busy && <p role="status">通信中…</p>}
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
      <p role="status">{statusLabels[result.status]}</p>
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
