import { describe, it, expect } from 'vitest';
import { commandEnv } from './commandEnv';

/** A fake host: shell essentials plus planted fake secrets (never real ones). */
const POSIX_HOST = {
  platform: 'linux',
  env: {
    PATH: '/usr/bin',
    HOME: '/home/me',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm',
    CI: '1',
    FAKE_SECRET_FOR_TEST: 'fake-secret-value',
    OPENAI_API_KEY: 'fake-openai-key-for-test',
    UNSET: undefined,
  },
};

const WINDOWS_HOST = {
  platform: 'win32',
  env: {
    Path: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\me',
    TEMP: 'C:\\Temp',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATHEXT: '.COM;.EXE',
    windir: 'C:\\Windows',
    ci: '1',
    FAKE_SECRET_FOR_TEST: 'fake-secret-value',
    ANTHROPIC_API_KEY: 'fake-anthropic-key-for-test',
  },
};

describe('commandEnv', () => {

  it('passes the Windows base by default, matching names case-insensitively', () => {
    expect(commandEnv({}, { host: WINDOWS_HOST })).toEqual({
      Path: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\me',
      TEMP: 'C:\\Temp',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE',
      windir: 'C:\\Windows',
    });
    expect(commandEnv({ inheritEnv: ['CI'] }, { host: WINDOWS_HOST }).ci).toBe('1');
    expect(commandEnv({ inheritEnv: ['ci'] }, { host: POSIX_HOST }).CI).toBeUndefined();
  });
});
