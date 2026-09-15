import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { cliVersion } from '../lib/superset.js';

function fakeProcess(mode) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = null;
  child.kill = (signal) => {
    child.killed = signal;
  };
  const spawnProcess = () => {
    queueMicrotask(() => {
      if (mode === 'success') {
        child.stdout.emit('data', 'fixture-version\n');
        child.emit('close', 0);
      } else if (mode === 'error') child.emit('error', new Error('missing CLI'));
      else if (mode === 'nonzero') {
        child.stdout.emit('data', 'unreliable version');
        child.emit('close', 1);
      }
    });
    return child;
  };
  return { child, spawnProcess };
}

test('CLI version startup check kills an unresponsive child after its deadline', async () => {
  const { child, spawnProcess } = fakeProcess('hang');
  expect(await cliVersion({ spawnProcess, timeoutMs: 1 })).toBeNull();
  expect(child.killed).toBe('SIGKILL');
});

test('CLI version startup check returns clean output and handles failures', async () => {
  const { child, spawnProcess } = fakeProcess('success');
  expect(await cliVersion({ spawnProcess })).toBe('fixture-version');
  expect(child.killed).toBeNull();
  for (const mode of ['error', 'nonzero']) {
    expect(await cliVersion({ spawnProcess: fakeProcess(mode).spawnProcess })).toBeNull();
  }
  expect(
    await cliVersion({
      spawnProcess: () => {
        throw new Error('spawn failed');
      },
    }),
  ).toBeNull();
});
