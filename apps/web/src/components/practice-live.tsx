import { useEffect, useRef, useState } from 'react';
import { Temporal } from '@js-temporal/polyfill';
import type { InterviewServerEvent } from '@korekaite/api-contracts/events/interview-server';
import type { InterviewCommand } from '@korekaite/api-contracts/events/interview-client';
import { validateInterviewServerEvent } from '@korekaite/api-contracts/events/validators';
import { sessionToken } from '../lib/practice';
import { encodeMicrophoneFrame, openInterviewAudio } from '../lib/practice-audio';
import { createResponseMonitor } from '../lib/practice-response';

type State = Extract<InterviewServerEvent, { type: 'state' }>;
type Transcript = Extract<InterviewServerEvent, { type: 'transcript' }>;
const statuses = {
  ready: '開始前',
  connecting: '音声接続中',
  active: '面接中',
  paused: '一時停止中',
  reconnecting: '再開待ち',
  ending: '保存中',
  ended: '保存完了',
};
const messages = {
  AUDIO_USAGE_LIMIT: 'アプリ内の面接時間が本日の60分に達しました。日本時間の翌日から再開できます。',
  AUDIO_CONNECT_FAILED: '音声AIへの接続に失敗しました。再度開始してください。',
  INVALID_EVENT: '操作を確認できませんでした。',
  STALE_STATE: '面接の状態が変わりました。',
  NOT_OWNER: '別のタブが操作中です。',
  UNAVAILABLE: '面接に接続できませんでした。',
  CONTEXT_LIMIT: '会話が再開時の上限に達しました。',
};

export function PracticeLive({
  id,
  onEnded,
  onDeleted,
}: {
  id: string;
  onEnded(): void;
  onDeleted?(): void;
}) {
  const socket = useRef<WebSocket | null>(null);
  const latest = useRef<State | null>(null);
  const media = useRef<Awaited<ReturnType<typeof openInterviewAudio>> | null>(null);
  const [responseMonitor] = useState(createResponseMonitor);
  const questionChange = useRef<{
    generation: number;
    commandId: string;
    requestedAt: number;
    hasText: boolean;
    hasAudio: boolean;
    stop: 'pause' | 'finish' | null;
  } | null>(null);
  const [changingQuestion, setChangingQuestion] = useState(false);
  const takeoverDisconnectGeneration = useRef<number | null>(null);
  const permission = useRef<AbortController | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [fragments, setFragments] = useState<Transcript[]>([]);
  const [error, setError] = useState('');
  const [disconnected, setDisconnected] = useState(false);
  const reconnect = useRef({ until: 0, delay: 1000, resume: false });
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(0);
  const ended = useRef(onEnded);
  const removed = useRef(onDeleted);
  useEffect(() => {
    removed.current = onDeleted;
  }, [onDeleted]);
  useEffect(() => {
    ended.current = onEnded;
  }, [onEnded]);
  function clearQuestionChange() {
    questionChange.current = null;
    setChangingQuestion(false);
  }
  function acceptQuestion() {
    if (questionChange.current?.hasText && questionChange.current.hasAudio) {
      clearQuestionChange();
    }
  }
  function release() {
    clearQuestionChange();
    releaseMedia();
  }
  function releaseMedia() {
    takeoverDisconnectGeneration.current = null;
    responseMonitor.reset();
    permission.current?.abort();
    permission.current = null;
    media.current?.close();
    media.current = null;
  }
  function canChangeQuestion(current: State) {
    return (
      current.status === 'active' &&
      current.canControl &&
      !questionChange.current?.stop &&
      current.generation !== questionChange.current?.generation
    );
  }
  function command(type: InterviewCommand['type']) {
    if (!latest.current || socket.current?.readyState !== 1) {
      return;
    }
    const commandId = crypto.randomUUID();
    if (type === 'rephrase' || type === 'skip') {
      if (!canChangeQuestion(latest.current)) {
        return;
      }
      questionChange.current = {
        generation: latest.current.generation,
        commandId,
        requestedAt: performance.now(),
        hasText: false,
        hasAudio: false,
        stop: null,
      };
      setChangingQuestion(true);
      setError('');
      media.current?.stopPlayback();
      responseMonitor.expectOpening(performance.now());
    }
    socket.current.send(
      JSON.stringify({
        type,
        commandId,
        generation: latest.current.generation,
      }),
    );
  }
  useEffect(() => {
    setState(null);
    setDisconnected(false);
    setError('');
    setFragments([]);
    setPending(false);
    const address = new URL(`/api/interviews/${encodeURIComponent(id)}/live`, window.location.href);
    address.searchParams.set('questionBoundaries', '1');
    address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
    const attempt = new AbortController();
    const retryTimerContext = {
      retryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      handshake: undefined as ReturnType<typeof setTimeout> | undefined,
      terminal: false,
    };
    function disconnectedPeer() {
      clearTimeout(retryTimerContext.handshake);
      const retry = reconnect.current;
      if (latest.current) {
        retry.resume = Boolean(
          media.current &&
          latest.current.canControl &&
          ['active', 'connecting'].includes(latest.current.status),
        );
      }
      release();
      setDisconnected(true);
      latest.current = null;
      setPending(false);
      if (!retryTimerContext.terminal) {
        const time = performance.now();
        retry.until ||= time + 60000;
        if (time + retry.delay < retry.until) {
          retryTimerContext.retryTimer = setTimeout(() => {
            if (performance.now() < retry.until) {
              setRevision((value) => value + 1);
            }
          }, retry.delay);
          retry.delay = Math.min(retry.delay * 2, 5000);
        }
      }
    }
    async function connect() {
      if (revision > 0) {
        try {
          await sessionToken(AbortSignal.any([attempt.signal, AbortSignal.timeout(10000)]));
        } catch {
          if (!attempt.signal.aborted) {
            setError('ローカルサーバーに接続できません。起動時のURLを確認してください。');
            disconnectedPeer();
          }
          return;
        }
      }
      if (attempt.signal.aborted) {
        return;
      }
      const peer = new WebSocket(address);
      peer.binaryType = 'arraybuffer';
      socket.current = peer;
      const windowLeft = reconnect.current.until
        ? reconnect.current.until - performance.now()
        : 10000;
      retryTimerContext.handshake = setTimeout(
        () => peer.close(),
        Math.max(1, Math.min(10000, windowLeft)),
      );
      const headerState = {
        header: null as Extract<InterviewServerEvent, { type: 'audio' }> | null,
      };
      const saved = new Map<string, Transcript>();
      peer.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
        try {
          if (typeof data !== 'string') {
            const audio = headerState.header;
            headerState.header = null;
            if (!audio || !(data instanceof ArrayBuffer) || audio.byteLength !== data.byteLength) {
              throw new Error();
            }
            if (
              latest.current?.status === 'active' &&
              latest.current.canControl &&
              latest.current.generation === audio.generation &&
              questionChange.current?.generation !== audio.generation
            ) {
              const receivedVersion = responseMonitor.playbackVersion();
              media.current?.play(data, () => {
                if (
                  peer.readyState === 1 &&
                  latest.current?.generation === audio.generation &&
                  latest.current.canControl &&
                  questionChange.current?.generation !== audio.generation
                ) {
                  if (responseMonitor.played(data, receivedVersion) && questionChange.current) {
                    questionChange.current.hasAudio = true;
                    acceptQuestion();
                  }
                  peer.send(
                    JSON.stringify({
                      type: 'playback',
                      commandId: crypto.randomUUID(),
                      generation: audio.generation,
                      audioOffsetMs: audio.endOffsetMs,
                    }),
                  );
                }
              });
            }
            return;
          }
          const event = JSON.parse(data);
          if (headerState.header || !validateInterviewServerEvent(event)) {
            throw new Error();
          }
          switch (event.type) {
            case 'state': {
              if (event.interviewId !== id) {
                throw new Error();
              }
              const change = questionChange.current;
              // 質問切替では、旧接続の終了待ちにも同じタブがマイクを保持する。
              const closingOldQuestion =
                change &&
                event.status === 'reconnecting' &&
                event.canControl &&
                event.generation === change.generation + 1;
              if (
                (latest.current?.canControl && !event.canControl) ||
                (!closingOldQuestion &&
                  ['paused', 'reconnecting', 'ending', 'ended'].includes(event.status) &&
                  (latest.current?.status !== event.status ||
                    latest.current.generation !== event.generation) &&
                  !(
                    event.status === 'reconnecting' &&
                    !event.canControl &&
                    event.generation === takeoverDisconnectGeneration.current
                  ))
              ) {
                release();
              }
              clearTimeout(retryTimerContext.handshake);
              const resume =
                reconnect.current.resume && performance.now() < reconnect.current.until;
              reconnect.current = { until: 0, delay: 1000, resume: false };
              if (
                event.status === 'active' &&
                event.canControl &&
                (latest.current?.status !== 'active' ||
                  latest.current.generation !== event.generation ||
                  !latest.current.canControl)
              ) {
                responseMonitor.expectOpening(performance.now());
              }
              latest.current = event;
              if (
                change?.stop &&
                event.canControl &&
                event.generation !== change.generation &&
                (event.status === 'active' ||
                  (!closingOldQuestion && event.status === 'reconnecting') ||
                  (change.stop === 'finish' && event.status === 'connecting'))
              ) {
                clearQuestionChange();
                command(change.stop);
              }
              if (resume && event.status === 'reconnecting') {
                void begin('resume');
              }
              setState(event);
              setNow(Temporal.Now.instant().epochMilliseconds);
              if (event.status === 'ended') {
                retryTimerContext.terminal = true;
                ended.current();
              }
              break;
            }
            case 'deleted':
              if (event.interviewId !== id) {
                throw new Error();
              }
              release();
              peer.close();
              retryTimerContext.terminal = true;
              removed.current?.();
              break;
            case 'audio':
              headerState.header = event;
              break;
            case 'transcript':
              if (
                questionChange.current &&
                event.speaker === 'assistant' &&
                event.content.trim() &&
                event.generation === latest.current?.generation &&
                event.generation !== questionChange.current.generation
              ) {
                questionChange.current.hasText = true;
                acceptQuestion();
              }
              saved.set(event.fragmentId, event);
              setFragments([...saved.values()].sort((a, b) => a.sequence - b.sequence));
              break;
            case 'error': {
              const change = questionChange.current;
              setError(messages[event.code]);
              if (
                change?.stop &&
                event.code === 'AUDIO_CONNECT_FAILED' &&
                latest.current?.canControl
              ) {
                // 直後に届く再開待ちの世代で停止を送る。古い世代へ送ると拒否される。
                releaseMedia();
              } else {
                if (change && event.commandId === change.commandId) {
                  clearQuestionChange();
                  if (
                    change.stop &&
                    latest.current?.canControl &&
                    latest.current.status === 'active'
                  ) {
                    command(change.stop);
                  }
                }
                if (
                  !latest.current?.canControl ||
                  event.code === 'AUDIO_USAGE_LIMIT' ||
                  event.code === 'AUDIO_CONNECT_FAILED'
                ) {
                  release();
                }
              }
              setPending(false);
              break;
            }
            case 'ack':
              break;
          }
        } catch {
          setError('音声接続を再開してください。');
          release();
          peer.close();
        }
      };
      peer.onclose = () => {
        peer.onclose = null;
        disconnectedPeer();
      };
      peer.onerror = () => setError('面接画面とローカルサーバーの接続が切れました。');
    }
    void connect();
    return () => {
      attempt.abort();
      clearTimeout(retryTimerContext.retryTimer);
      clearTimeout(retryTimerContext.handshake);
      const peer = socket.current;
      if (peer) {
        peer.onclose = null;
        peer.onmessage = null;
        peer.onerror = null;
        peer.close();
      }
      release();
      latest.current = null;
      socket.current = null;
    };
  }, [id, revision]);
  useEffect(() => {
    if ((state?.status !== 'active' && !changingQuestion) || disconnected) {
      return;
    }
    const timer = setInterval(() => setNow(Temporal.Now.instant().epochMilliseconds), 500);
    return () => clearInterval(timer);
  }, [state?.status, disconnected, changingQuestion]);
  async function begin(type: 'start' | 'resume' | 'takeover') {
    const initial = latest.current;
    if (!initial || permission.current) {
      return;
    }
    const controller = new AbortController();
    permission.current = controller;
    setPending(true);
    setError('');
    try {
      const audio = await openInterviewAudio(
        controller.signal,
        (bytes) => {
          const current = latest.current;
          const peer = socket.current;
          if (
            !controller.signal.aborted &&
            !questionChange.current &&
            current?.status === 'active' &&
            current.canControl &&
            peer?.readyState === 1
          ) {
            if (peer.bufferedAmount > 256 * 1024) {
              release();
              peer.close();
              setError('音声の送信が追いつかず接続を停止しました。');
              return;
            }
            peer.send(encodeMicrophoneFrame(current.generation, bytes));
            responseMonitor.capture(bytes, performance.now());
          }
        },
        () => {
          stop('pause');
          setError('マイクが切断されました。');
        },
      );
      if (
        controller.signal.aborted ||
        latest.current?.generation !== initial.generation ||
        socket.current?.readyState !== 1
      ) {
        audio.close();
        if (permission.current === controller) {
          release();
        }
        return;
      }
      media.current = audio;
      // 引き継ぎ時は旧接続の切断で世代が一つ進んでから、新しい接続が始まる。
      if (type === 'takeover') {
        takeoverDisconnectGeneration.current = initial.generation + 1;
      }
      command(type);
    } catch {
      if (!controller.signal.aborted) {
        release();
        setError('マイクの使用許可と入力機器を確認してください。');
      }
    } finally {
      if (!permission.current || permission.current === controller) {
        setPending(false);
      }
    }
  }
  function stop(type: 'pause' | 'finish') {
    const change = questionChange.current;
    if (
      change &&
      (latest.current?.generation === change.generation || latest.current?.status !== 'active')
    ) {
      change.stop = type;
      releaseMedia();
      return;
    }
    release();
    command(type);
  }
  const waitingForText =
    questionChange.current?.hasAudio &&
    !questionChange.current.hasText &&
    performance.now() - questionChange.current.requestedAt >= 20_000;
  const elapsed =
    (state?.activeMs ?? 0) +
    (state?.status === 'active' && state.activeSince !== null
      ? Math.max(0, Math.min(now, state.deadline ?? now) - state.activeSince)
      : 0);
  const turns: {
    speaker: Transcript['speaker'];
    generation: number;
    content: string;
    id: string;
  }[] = [];
  for (const item of fragments) {
    const last = turns.at(-1);
    if (
      !item.startsQuestion &&
      last?.speaker === item.speaker &&
      last.generation === item.generation
    ) {
      last.content += item.content;
    } else {
      turns.push({
        speaker: item.speaker,
        generation: item.generation,
        content: item.content,
        id: item.fragmentId,
      });
    }
  }
  const question = turns
    .slice()
    .reverse()
    .find((turn) => turn.speaker === 'assistant');
  return (
    <section>
      <h3>音声面接</h3>
      <p role="status">
        {disconnected ? '切断' : state ? statuses[state.status] : '接続中'} ·{' '}
        {Math.floor(elapsed / 60000)}分{Math.floor(elapsed / 1000) % 60}秒
      </p>
      {state?.status === 'active' && elapsed >= 15 * 60000 && (
        <p>
          15分が経過しました。今回の判断を振り返り、話し終えたら評価へ進んでください。面接は20分で終了します。
        </p>
      )}
      {disconnected ? (
        <button
          onClick={() => {
            reconnect.current.until = performance.now() + 60000;
            reconnect.current.delay = 1000;
            setRevision((value) => value + 1);
          }}
        >
          再接続
        </button>
      ) : (
        state && (
          <fieldset disabled={pending} style={{ border: 0, padding: 0 }}>
            {state.status === 'ready' && (
              <button onClick={() => void begin('start')}>マイクを許可して開始</button>
            )}
            {!changingQuestion &&
              ((state.status === 'paused' && state.canControl) ||
                state.status === 'reconnecting') && (
                <button onClick={() => void begin('resume')}>マイクを許可して再開</button>
              )}
            {!state.canControl && ['active', 'connecting', 'paused'].includes(state.status) && (
              <button onClick={() => void begin('takeover')}>このタブで引き継ぐ</button>
            )}
            {changingQuestion && (
              <p role="status">質問を切り替えています。新しい質問を聞いてからお答えください。</p>
            )}
            {state.canControl && (state.status === 'active' || changingQuestion) && (
              <>
                {waitingForText ? (
                  <p role="status">
                    質問の文字がまだ届いていません。「音声をつなぎ直す」を押して再開できます。
                  </p>
                ) : (
                  responseMonitor.isWaitingTooLong(performance.now()) && (
                    <p role="status">
                      面接官の音声を待っています。聞こえない場合は「音声をつなぎ直す」を押し、マイクを許可して再開してください。
                    </p>
                  )
                )}
                <button onClick={() => stop('pause')}>一時停止</button>
                <button onClick={() => stop('pause')}>音声をつなぎ直す</button>
                <button disabled={!canChangeQuestion(state)} onClick={() => command('rephrase')}>
                  言い換えを依頼
                </button>
                <button disabled={!canChangeQuestion(state)} onClick={() => command('skip')}>
                  質問を見送る
                </button>
              </>
            )}
            {(state.canControl || ['ready', 'reconnecting'].includes(state.status)) && (
              <button onClick={() => stop('finish')}>終了して評価する</button>
            )}
          </fieldset>
        )
      )}
      {error && <p role="alert">{error}</p>}
      {question && (
        <>
          <h4>現在の質問</h4>
          <p>{question.content}</p>
        </>
      )}
      {turns.length > 0 && (
        <>
          <h4>保存された会話</h4>
          <ol>
            {turns.map((turn) => (
              <li key={turn.id}>
                <strong>{turn.speaker === 'user' ? 'あなた' : '面接官'}</strong> {turn.content}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
