import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { verifyProductionArtifacts } from '../src/production.ts';
import { productionFixture } from './helpers/production-artifacts.ts';

test('走査対象ルートが生成ツリーから欠落すれば拒否する', async () => {
  const fixture = await productionFixture();
  await writeFile(join(fixture.project, 'src/routeTree.gen.ts'), "import './routes/__root'");
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow('生成ルートに不足');
});

test('生成ルートに診断が含まれれば拒否する', async () => {
  const fixture = await productionFixture();
  await writeFile(join(fixture.project, 'src/routeTree.gen.ts'), 'diagnostics');
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow(
    '本番ルートツリーに診断',
  );
});

test('本番ルートに未承認のファイルが増えれば拒否する', async () => {
  const fixture = await productionFixture();
  await writeFile(join(fixture.project, 'src/routes/extra.tsx'), '');
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow(
    '本番ルート走査対象に未確認',
  );
});

test('QueueトリガーのDLQが本番以外なら拒否する', async () => {
  const fixture = await productionFixture();
  fixture.configs.evaluation.triggers = [
    {
      type: 'queue',
      name: fixture.production.queues.evaluation.queue,
      deadLetterQueue: 'other-dlq',
    },
  ];
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow('本番以外のQueue');
});

test('未実装のサービスbindingを本番入口に混入できない', async () => {
  const fixture = await productionFixture();
  fixture.configs.ssr.env.SERVICE = { type: 'service', name: 'other-worker' };
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow(
    '未実装の本番入口に検証用binding',
  );
});

test('本番以外のQueueへの送信bindingを拒否する', async () => {
  const fixture = await productionFixture();
  fixture.configs.ssr.env.QUEUE = { type: 'queue', name: 'test-queue' };
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow('本番以外のQueue');
});

test('共有D1以外のDBへ接続する設定を拒否する', async () => {
  const fixture = await productionFixture();
  fixture.configs.ssr.env.DB.id = 'other-db';
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow(
    '本番共有D1設定に不整合',
  );
});

test('Worker設定の環境が本番以外なら拒否する', async () => {
  const fixture = await productionFixture();
  fixture.configs.ssr.env.APP_ENV.value = 'test';
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow(
    '本番Worker設定に不整合',
  );
});

test('配信チャンクが診断モジュールを含めば拒否する', async () => {
  const fixture = await productionFixture();
  fixture.audits.client.outputs[0].modules.push('/src/diagnostics/hidden.ts');
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow(
    '本番配信物へ診断コードが混入',
  );
});

test('監査後に内容が変更された配信物を拒否する', async () => {
  const fixture = await productionFixture();
  await writeFile(join(fixture.audits.client.outputDirectory, 'index.js'), 'changed');
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow(
    'モジュール監査後に配信物が変更',
  );
});

test('監査に出力先外のファイルが記録されていても読み取らない', async () => {
  const fixture = await productionFixture();
  fixture.audits.client.outputs.push({
    ...fixture.audits.client.outputs[0],
    fileName: '../outside.js',
  });
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow(
    '出力先がビルドディレクトリ外',
  );
});

test('監査済みの出力名でもシンボリックリンクは配信物として拒否する', async () => {
  const fixture = await productionFixture();
  await symlink('index.js', join(fixture.audits.client.outputDirectory, 'link.js'));
  fixture.audits.client.outputs.push({ ...fixture.audits.client.outputs[0], fileName: 'link.js' });
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow('未記録の本番配信物');
});

test('本番Workerの入口が監査に含まれなければ拒否する', async () => {
  const fixture = await productionFixture();
  fixture.audits.interview.modules[0].id = '/other/worker.ts';
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow(
    '本番入口を確認できません',
  );
});

test('空のビルド監査記録を受理しない', async () => {
  const fixture = await productionFixture();
  fixture.audits.client.modules = [];
  await fixture.save();
  await expect(verifyProductionArtifacts(fixture.project)).rejects.toThrow('ビルド監査情報が不足');
});

test('監査と配信物とWorker設定が整合する4環境の記録を受理する', async () => {
  const fixture = await productionFixture();
  await expect(verifyProductionArtifacts(fixture.project)).resolves.toEqual({
    environments: ['client', 'ssr', 'interview', 'evaluation'],
    routes: ['__root.tsx', 'api.interviews.ts', 'index.tsx'],
  });
});
