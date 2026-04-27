import { describe, test, expect, beforeEach } from 'bun:test';
import { runBuiltin } from './builtins.js';
import { env } from './env.js';
import { history } from './history.js';

describe('Builtins', () => {
  beforeEach(() => {
    // Reset environment for tests
    process.chdir('/tmp');
  });

  test('cd changes directory', () => {
    const original = process.cwd();
    runBuiltin('cd', ['/']);
    expect(process.cwd()).not.toBe(original);
  });

  test('pwd prints current directory', () => {
    // This test is limited since we can't capture stdout easily
    const result = runBuiltin('pwd', []);
    expect(result).toBe(true);
  });

  test('env expansion works', () => {
    env.set('TEST_VAR', 'hello_kulsh');
    expect(env.expand('echo $TEST_VAR')).toContain('hello_kulsh');
  });

  test('history records commands', () => {
    history.add('echo hello');
    const entries = history.getAll();
    expect(entries).toContain('echo hello');
  });
});