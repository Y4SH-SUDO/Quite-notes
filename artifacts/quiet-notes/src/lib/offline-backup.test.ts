import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomaticBackupRunner } from './offline-backup.ts';

test('automatic backup skips a snapshot made stale while it is being generated', async () => {
  let releaseSnapshot!: () => void;
  let snapshotCount = 0;
  const writes: string[] = [];
  const runner = new AutomaticBackupRunner(
    async () => {
      snapshotCount += 1;
      if (snapshotCount === 1) {
        await new Promise<void>(resolve => { releaseSnapshot = resolve; });
        return '{"revision":1}';
      }
      return '{"revision":2}';
    },
    async content => { writes.push(content); },
    () => {},
  );

  runner.request();
  const flush = runner.flush();
  await Promise.resolve();
  runner.request();
  releaseSnapshot();
  await flush;
  await runner.flush();

  assert.deepEqual(writes, ['{"revision":2}']);
});

test('automatic backup queues a fresh authoritative snapshot when data changes during file write', async () => {
  let revision = 1;
  let releaseWrite!: () => void;
  const writes: string[] = [];
  const runner = new AutomaticBackupRunner(
    async () => JSON.stringify({ revision }),
    async content => {
      writes.push(content);
      if (writes.length === 1) {
        await new Promise<void>(resolve => { releaseWrite = resolve; });
      }
    },
    () => {},
  );

  runner.request();
  const flush = runner.flush();
  await Promise.resolve();
  await Promise.resolve();
  revision = 2;
  runner.request();
  releaseWrite();
  await flush;
  await runner.flush();

  assert.deepEqual(writes, ['{"revision":1}', '{"revision":2}']);
});

test('a failed automatic replacement reports failure without claiming a successful backup', async () => {
  let file = 'previous-valid-backup';
  const statuses: string[] = [];
  const runner = new AutomaticBackupRunner(
    async () => '{"notes":[]}',
    async () => { throw new Error('The provider cannot safely replace this file.'); },
    status => statuses.push(status.kind),
  );

  runner.request();
  await runner.flush();

  assert.equal(file, 'previous-valid-backup');
  assert.deepEqual(statuses, ['pending', 'error']);
});
