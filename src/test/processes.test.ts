import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { killProcessTree, spawnProcessTree, stopProcessTree } from '../utils/processes';
import { makeTempDir, removeDir } from './helpers';

let tmp: string;
before(() => {
  tmp = makeTempDir('agntree-processes-');
});
after(() => {
  removeDir(tmp);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await sleep(50);
  }
  return condition();
}

describe('killProcessTree', () => {
  it("stops a shell command's child processes too, not just the shell", async () => {
    // A quick action like `node parent.js && echo done`: the shell runs node, which starts
    // a long-running child of its own and records that child's PID.
    const pidFile = path.join(tmp, 'grandchild.pid');
    const parent = path.join(tmp, 'parent.js');
    fs.writeFileSync(
      parent,
      `const { spawn } = require('child_process');
       const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       setInterval(() => {}, 1000);`
    );
    const node = process.execPath.replace(/\\/g, '/');
    const action = spawnProcessTree({ command: `"${node}" "${parent.replace(/\\/g, '/')}" && echo done` }, tmp);
    const exited = new Promise((resolve) => action.on('exit', resolve));

    assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8').length > 0, 10_000), 'child never started');
    const grandchild = Number(fs.readFileSync(pidFile, 'utf-8'));
    assert.ok(isAlive(grandchild));

    try {
      killProcessTree(action);
      await exited;
      assert.ok(await waitFor(() => !isAlive(grandchild), 5_000), 'the child of the shell command kept running');
    } finally {
      if (isAlive(grandchild)) {
        process.kill(grandchild, 'SIGKILL');
      }
    }
  });

  it('runs a program with an argument array, without a shell', async () => {
    const child = spawnProcessTree({ file: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', 'a b; c'] }, tmp);
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (output += chunk));
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    assert.equal(output, 'a b; c');
  });
});

describe('stopProcessTree', () => {
  const node = process.execPath.replace(/\\/g, '/');

  /** Start a shell command and track when its output closes, as the quick action code does. */
  function start(script: string) {
    const child = spawnProcessTree({ command: `"${node}" -e "${script}" && echo done` }, tmp);
    const state = { closed: false, gaveUp: false };
    const closed = new Promise<void>((resolve) => child.on('close', () => { state.closed = true; resolve(); }));
    child.stdout?.resume();
    child.stderr?.resume();
    return { child, state, closed };
  }

  it('stops a command that exits on SIGTERM without escalating', async () => {
    const { child, state, closed } = start('setInterval(() => {}, 1000)');
    await sleep(300);
    stopProcessTree(child, { killAfterMs: 1000, giveUpAfterMs: 1000, isDone: () => state.closed, onGiveUp: () => (state.gaveUp = true) });
    await closed;
    await sleep(2200);
    assert.equal(state.gaveUp, false);
  });

  it('gives up waiting if the output never closes, so the action is not stuck as running', async () => {
    const { child, closed } = start('setInterval(() => {}, 1000)');
    let gaveUp = false;
    stopProcessTree(child, { killAfterMs: 200, giveUpAfterMs: 200, isDone: () => false, onGiveUp: () => (gaveUp = true) });
    assert.ok(await waitFor(() => gaveUp, 3000), 'onGiveUp was never called');
    await closed;
  });

  it('kills a command that ignores SIGTERM', { skip: process.platform === 'win32' && 'Windows always force-kills (taskkill /F)' }, async () => {
    const { child, state, closed } = start("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    await sleep(300);
    stopProcessTree(child, { killAfterMs: 500, giveUpAfterMs: 5000, isDone: () => state.closed, onGiveUp: () => (state.gaveUp = true) });
    await sleep(300);
    assert.equal(state.closed, false, 'SIGTERM should have been ignored');
    assert.ok(await waitFor(() => state.closed, 3000), 'SIGKILL did not stop it');
    await closed;
    assert.equal(state.gaveUp, false);
  });
});
