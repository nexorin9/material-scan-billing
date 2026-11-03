/**
 * test_env：凭据位集中解析与 fail closed。
 *
 * 语义来源：源产品服务入口的 requiredVars —— 缺变量即打印变量名并非零退出。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MissingCredentialError,
  allChannelStatus,
  channelStatus,
  parseDotEnv,
  redactSecret,
  requireChannel,
  runStartupCheck,
} from '../src/config/env.js';

const FULL_ENV = {
  OR_SCANNER_BASE_URL: 'https://scanner.example.internal',
  OR_SCANNER_TOKEN: 'scanner-token-value',
  OR_SCANNER_SECRET: 'scanner-secret-value',
  HIS_CHARGING_BASE_URL: 'https://his.example.internal',
  HIS_CHARGING_TOKEN: 'his-token-value',
  WECOM_WEBHOOK_URL: 'https://wecom.example.internal/webhook',
  WECOM_SECRET: 'wecom-secret-value',
};

describe('test_env · 凭据位解析与 fail closed', () => {
  it('三路凭据齐全时各自可取，且不串路', () => {
    const inbound = requireChannel('inbound', FULL_ENV);
    assert.equal(inbound.channel, 'inbound');
    assert.equal(inbound.baseUrl, 'https://scanner.example.internal');

    const outbound = requireChannel('outbound', FULL_ENV);
    assert.equal(outbound.channel, 'outbound');
    assert.equal(outbound.baseUrl, 'https://his.example.internal');

    const notify = requireChannel('notify', FULL_ENV);
    assert.equal(notify.channel, 'notify');
    assert.equal(notify.webhookUrl, 'https://wecom.example.internal/webhook');
  });

  it('缺 HIS_CHARGING_TOKEN 即报错并指名变量名', () => {
    const env = { ...FULL_ENV };
    delete (env as Record<string, string | undefined>).HIS_CHARGING_TOKEN;

    assert.throws(
      () => requireChannel('outbound', env),
      (error: unknown) => {
        assert.ok(error instanceof MissingCredentialError);
        assert.equal(error.code, 'ERR_MISSING_CREDENTIAL');
        assert.deepEqual(error.missingVars, ['HIS_CHARGING_TOKEN']);
        assert.match(error.message, /HIS_CHARGING_TOKEN/);
        return true;
      },
    );
  });

  it('缺一路只让该路不可用，其余两路不受影响', () => {
    const env = { ...FULL_ENV };
    delete (env as Record<string, string | undefined>).WECOM_SECRET;

    assert.throws(() => requireChannel('notify', env), MissingCredentialError);
    assert.equal(requireChannel('inbound', env).channel, 'inbound');
    assert.equal(requireChannel('outbound', env).channel, 'outbound');

    const statuses = allChannelStatus(env);
    const byChannel = new Map(statuses.map((s) => [s.channel, s]));
    assert.equal(byChannel.get('notify')?.ready, false);
    assert.deepEqual(byChannel.get('notify')?.missing, ['WECOM_SECRET']);
    assert.equal(byChannel.get('inbound')?.ready, true);
    assert.equal(byChannel.get('outbound')?.ready, true);
  });

  it('体检输出只报齐否与变量名，不含凭据明文', () => {
    const status = channelStatus('outbound', FULL_ENV);
    assert.equal(status.ready, true);
    assert.deepEqual(status.missing, []);
    assert.doesNotMatch(JSON.stringify(status), /his-token-value/);
  });

  it('启动自检：缺 HIS_CHARGING_TOKEN 时进程非零退出且信息含变量名', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const envModuleUrl = pathToFileURL(resolve(here, '..', 'src', 'config', 'env.js')).href;
    const code = [
      `const m = await import(${JSON.stringify(envModuleUrl)});`,
      `m.runStartupCheck(['outbound'], { HIS_CHARGING_BASE_URL: 'https://his.example.internal' });`,
    ].join('\n');

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, '缺凭据时必须非零退出');
    assert.match(result.stderr, /Missing required environment variable: HIS_CHARGING_TOKEN/);
  });

  it('凭据齐全时启动自检不退出', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const envModuleUrl = pathToFileURL(resolve(here, '..', 'src', 'config', 'env.js')).href;
    const code = [
      `const m = await import(${JSON.stringify(envModuleUrl)});`,
      `m.runStartupCheck(['inbound', 'outbound', 'notify'], ${JSON.stringify(FULL_ENV)});`,
      `console.log('STARTUP_OK');`,
    ].join('\n');

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /STARTUP_OK/);
  });

  it('.env 解析：注释、空行、引号包裹的值', () => {
    const parsed = parseDotEnv(
      ['# 注释', 'A=1', 'B="two words"', "C='three'", 'EMPTY=', 'BAD_LINE'].join('\n'),
    );
    assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'three', EMPTY: '' });
  });

  it('凭据打码不落明文', () => {
    assert.doesNotMatch(redactSecret('his-token-value'), /his-token-value/);
    assert.equal(redactSecret(undefined), '未配置');
  });
});
