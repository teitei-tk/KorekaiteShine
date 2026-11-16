import { DurableObject } from 'cloudflare:workers';
import type { D1Database, DurableObjectNamespace } from '@cloudflare/workers-types';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq } from 'void/db';
import { deletedInterviews, transcriptFragments } from '@korekaite/database/interviews';
import { createPrimaryDb } from '@korekaite/database/connection';
import { createInterviewSession } from '../application/interview-session';
import { createInterviewRoom } from '../application/interview-room';
import { evaluationConfiguration } from '../application/evaluation-configuration';
import { createLiveConnection, type LiveHandlers } from './live-connection';
import { loadInterview } from './repositories/interviews';

// 接続を失ったときに稼働確認前の時間を計上しないため、面接中のみ5秒ごとに記録する。
const audioCheckpointMs = 5000;

interface Bindings {
  DB: D1Database;
  APP_ENV: string;
  INTERVIEW_SESSION: DurableObjectNamespace;
  OPENAI_API_KEY?: string;
  RESPONSES_MODEL?: string;
  EVALUATION_MODEL?: string;
  LIVE_VOICE?: string;
}
interface Identity {
  actorId: string;
  interviewId: string;
}

export class InterviewObject extends DurableObject<Bindings> {
  private room?: ReturnType<typeof createInterviewRoom>;
  private identity?: Identity;

  protected settings() {
    const voice = this.env.LIVE_VOICE ?? 'marin';
    if (!['marin', 'harema', 'shida'].includes(voice) || !this.env.RESPONSES_MODEL?.trim()) {
      throw new Error('面接モデルの設定が必要です。');
    }
    return {
      apiKey: this.env.OPENAI_API_KEY ?? '',
      responsesModel: this.env.RESPONSES_MODEL,
      voice: voice as 'marin' | 'harema' | 'shida',
      evaluation: evaluationConfiguration(this.env.EVALUATION_MODEL ?? ''),
    };
  }
  protected connectLive(
    options: Parameters<typeof createLiveConnection>[0],
    handlers: LiveHandlers,
  ) {
    return createLiveConnection(options, handlers);
  }
  private async getRoom(identity: Identity) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const saved = this.identity ?? (await this.ctx.storage.get<Identity>('identity'));
      if (
        saved &&
        (saved.actorId !== identity.actorId || saved.interviewId !== identity.interviewId)
      ) {
        throw new Error('面接の対応が一致しません。');
      }
      if (this.room) {
        return;
      }
      const db = createPrimaryDb(this.env.DB);
      if (!(await loadInterview(db, identity.actorId, identity.interviewId))) {
        throw new Error('面接が見つかりません。');
      }
      const settings = this.settings();
      await this.ctx.storage.put('identity', identity);
      this.identity = identity;
      this.room = createInterviewRoom({
        createSession: (hooks) =>
          createInterviewSession({
            ...hooks,
            ...settings,
            db,
            ...identity,
            now: () => Temporal.Now.instant().epochMilliseconds,
            newJobId: () => crypto.randomUUID(),
            connect: (options, handlers) => this.connectLive(options, handlers),
          }),
        history: () =>
          db
            .select()
            .from(transcriptFragments)
            .where(eq(transcriptFragments.interviewId, identity.interviewId))
            .orderBy(asc(transcriptFragments.sequence)),
        schedule: async (state) => {
          const now = Temporal.Now.instant().epochMilliseconds;
          const deadline = state.deadline ?? (state.status === 'ending' ? now + 30000 : null);
          if (deadline === null) {
            await this.ctx.storage.deleteAlarm();
          } else {
            const alarmAt =
              state.status === 'active'
                ? Math.min(state.updatedAt + audioCheckpointMs, deadline)
                : deadline;
            await this.ctx.storage.setAlarm(Math.max(now + 1, alarmAt));
          }
        },
      });
    });
    return this.room!;
  }
  async fetch(request: Request): Promise<Response> {
    // Web Workerが本人確認後にこの内部bindingへ転送し、本人ヘッダーを上書きする。
    const actorId = request.headers.get('X-Interview-Actor');
    const interviewId = request.headers.get('X-Interview-ID');
    if (
      !actorId ||
      actorId.length > 200 ||
      !interviewId ||
      !/^[A-Za-z0-9_-]{1,100}$/u.test(interviewId) ||
      this.env.INTERVIEW_SESSION.idFromName(
        `${this.env.APP_ENV}:interview:${interviewId}`,
      ).toString() !== this.ctx.id.toString()
    ) {
      return new Response(null, { status: 404 });
    }
    if (request.method === 'DELETE') {
      const [marked] = await createPrimaryDb(this.env.DB)
        .select({ id: deletedInterviews.interviewId })
        .from(deletedInterviews)
        .where(
          and(
            eq(deletedInterviews.interviewId, interviewId),
            eq(deletedInterviews.actorId, actorId),
          ),
        );
      if (!marked) {
        return new Response(null, { status: 404 });
      }
      await this.ctx.blockConcurrencyWhile(async () => {
        this.room?.discard(interviewId);
        this.room = undefined;
        this.identity = undefined;
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
      });
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 426 });
    }
    if (!(await loadInterview(createPrimaryDb(this.env.DB), actorId, interviewId))) {
      return new Response(null, { status: 404 });
    }
    const room = await this.getRoom({ actorId, interviewId }).catch(() => null);
    if (!room) {
      return new Response(null, { status: 503 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const id = crypto.randomUUID();
    server.addEventListener('message', (message) => {
      if (typeof message.data === 'string' || message.data instanceof ArrayBuffer) {
        this.ctx.waitUntil(room.receive(id, message.data));
      }
    });
    const detach = () => this.ctx.waitUntil(room.detach(id));
    server.addEventListener('close', detach);
    server.addEventListener('error', detach);
    server.binaryType = 'arraybuffer';
    server.accept();
    try {
      await room.attach(id, {
        questionBoundaries: new URL(request.url).searchParams.has('questionBoundaries'),
        send: (data) => server.send(data),
        close: () => server.close(1000),
      });
    } catch {
      server.close(1011);
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async alarm(): Promise<void> {
    const identity = await this.ctx.storage.get<Identity>('identity');
    if (identity) {
      await (await this.getRoom(identity)).alarm();
    }
  }
}
