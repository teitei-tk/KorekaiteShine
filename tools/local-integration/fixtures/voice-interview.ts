import { InterviewObject } from '../../../apps/interview/src/server/interview-object';
import { evaluationConfiguration } from '../../../apps/interview/src/application/evaluation-configuration';
import type {
  createLiveConnection,
  LiveHandlers,
  LiveClosed,
} from '../../../apps/interview/src/server/live-connection';

export class MockInterviewObject extends InterviewObject {
  protected override settings() {
    if (this.env.APP_ENV !== 'test') {
      throw new Error('音声代替はtest環境専用です。');
    }
    return {
      apiKey: 'fixture-only',
      responsesModel: 'mock',
      voice: 'marin' as const,
      evaluation: evaluationConfiguration('mock'),
    };
  }
  protected override connectLive(
    _options: Parameters<typeof createLiveConnection>[0],
    handlers: LiveHandlers,
  ) {
    let resolve!: (result: LiveClosed) => void;
    const closed = new Promise<LiveClosed>((done) => {
      resolve = done;
    });
    let writes = Promise.resolve();
    let number = 0;
    const ready = Promise.resolve().then(async () => {
      await handlers.onReady('mock-session');
      return 'mock-session';
    });
    return {
      ready,
      closed,
      request: () => true,
      abort: () => {
        resolve({ complete: false, reason: 'ABORTED', upstreamReason: null, usageSeconds: null });
      },
      sendAudio: () => {
        const event_id = `mock-answer-${++number}`;
        writes = writes.then(() =>
          handlers.onTranscript({
            type: 'session.input_transcript.delta',
            event_id,
            delta: '架空の回答です。',
            start_ms: 0,
            end_ms: 1000,
          }),
        );
        return true;
      },
      close: async () => {
        await ready;
        await writes;
        resolve({
          complete: true,
          reason: 'confirmed',
          upstreamReason: 'close_requested',
          usageSeconds: 1,
        });
        return closed;
      },
    };
  }
}
