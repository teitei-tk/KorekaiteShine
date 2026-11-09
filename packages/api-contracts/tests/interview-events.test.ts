import { expect, test } from 'vitest';
import {
  validateInterviewClientEvent,
  validateInterviewServerEvent,
} from '../generated/events/validators.mjs';

test('面接操作は世代付きの許可したイベントだけを受け付ける', () => {
  expect(validateInterviewClientEvent({ type: 'start', commandId: 'c1', generation: 0 })).toBe(
    true,
  );
  expect(
    validateInterviewClientEvent({
      type: 'start',
      commandId: 'c1',
      generation: 0,
      instructions: '任意の指示',
    }),
  ).toBe(false);
  expect(
    validateInterviewClientEvent({
      type: 'playback',
      commandId: 'c2',
      generation: 1,
      audioOffsetMs: -1,
    }),
  ).toBe(false);
  expect(
    validateInterviewServerEvent({ type: 'error', commandId: null, code: 'INVALID_EVENT' }),
  ).toBe(true);
});
