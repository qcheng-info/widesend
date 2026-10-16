import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, loadEnvironment } from '../../scripts/run.mjs';
import { deleteSecret, secretNames } from '../../scripts/secrets.mjs';

const node = (code: string) => capture(process.execPath, ['-e', code], { quiet: true });

describe('running Wrangler from the scripts', () => {
  it('returns only what a command prints to standard output', async () => {
    const output = await node(
      "console.log('{\"ok\":true}'); console.error('▲ [WARNING] a warning')",
    );
    expect(JSON.parse(output)).toEqual({ ok: true });
  });
  it('keeps both streams when a command fails', async () => {
    await expect(
      node("console.log('out'); console.error('what went wrong'); process.exit(3)"),
    ).rejects.toMatchObject({ output: expect.stringContaining('what went wrong') });
  });
});

describe('the .env file', () => {
  const folders: string[] = [];
  afterEach(async () => {
    delete process.env.WIDESEND_TEST_FROM_FILE;
    delete process.env.WIDESEND_TEST_ALREADY_SET;
    for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  it('is read without overriding what is already set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'widesend-env-'));
    folders.push(dir);
    await writeFile(
      join(dir, '.env'),
      'WIDESEND_TEST_FROM_FILE=file\nWIDESEND_TEST_ALREADY_SET=file\n',
    );
    process.env.WIDESEND_TEST_ALREADY_SET = 'shell';
    loadEnvironment(dir);
    expect(process.env.WIDESEND_TEST_FROM_FILE).toBe('file');
    expect(process.env.WIDESEND_TEST_ALREADY_SET).toBe('shell');
  });
  it('is optional', () => {
    expect(() => loadEnvironment(join(tmpdir(), 'widesend-no-such-folder'))).not.toThrow();
  });
});

describe('dashboard secrets', () => {
  const failing = (output: string) => async () => {
    throw Object.assign(new Error('wrangler exited with code 1'), { output });
  };
  it('lists none for a dashboard not deployed yet', async () => {
    expect(
      await secretNames(
        'wrangler.admin.jsonc',
        {},
        failing('This Worker does not exist on your account. [code: 10007]'),
      ),
    ).toEqual([]);
  });
  it('lists the names Wrangler returns', async () => {
    const list = async () => '[{"name":"ADMIN_PASSWORD","type":"secret_text"}]';
    expect(await secretNames('wrangler.admin.jsonc', {}, list)).toEqual(['ADMIN_PASSWORD']);
  });
  it('stops on any other failure instead of guessing', async () => {
    await expect(
      secretNames('wrangler.admin.jsonc', {}, failing('Authentication error [code: 10000]')),
    ).rejects.toThrow();
    await expect(
      deleteSecret('ACCESS_AUD', 'wrangler.admin.jsonc', {}, failing('network down')),
    ).rejects.toThrow();
  });
});
