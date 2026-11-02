import { expect, test } from 'vitest';
import type { JobNotification } from '../generated/messages/types';
import { validateJobNotification } from '../generated/messages/validators.mjs';

test('契約版1と小文字UUID v4のジョブ通知を受け付ける', () => {
  const notification: JobNotification = {
    schemaVersion: 1,
    jobId: '7e318b72-f255-4f17-845b-714d487ae621',
  };
  expect(validateJobNotification(notification)).toBe(true);
});

test('未対応の契約版2を拒否する', () => {
  expect(
    validateJobNotification({
      schemaVersion: 2,
      jobId: '7e318b72-f255-4f17-845b-714d487ae621',
    }),
  ).toBe(false);
});

test('未知の項目を削除せず通知を拒否する', () => {
  const input = Object.freeze({
    schemaVersion: 1,
    jobId: '7e318b72-f255-4f17-845b-714d487ae621',
    extra: 'preserved',
  });
  expect(validateJobNotification(input)).toBe(false);
  expect(input.extra).toBe('preserved');
});

test('UUIDではないジョブIDを拒否する', () => {
  expect(validateJobNotification({ schemaVersion: 1, jobId: 'invalid-job-id' })).toBe(false);
});

test('小文字・ハイフン付き36文字のUUID v4以外を拒否する', () => {
  for (const jobId of [
    '7E318B72-F255-4F17-845B-714D487AE621',
    '7e318b72-f255-1f17-845b-714d487ae621',
    '7e318b72-f255-4f17-745b-714d487ae621',
    '7e318b72f2554f17845b714d487ae621',
    '7e318b72-f255-4f17-845b-714d487ae621\n',
  ]) {
    expect(validateJobNotification({ schemaVersion: 1, jobId }), jobId).toBe(false);
  }
});
