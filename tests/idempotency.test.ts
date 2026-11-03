/**
 * test_idempotency：幂等键派生与租约语义。
 *
 * 核心不变量：键 = sha256("<档位>|material_code|operation_no")（默认档位 v1），
 * 与时间戳 / 重试次数 / 扫码枪编号 无关 —— 否则同一笔消费会被算成多笔，产生重复计费。
 *
 * v1 档位下批号也不参与（同一耗材同一台次只算一次）；
 * 批号维度与键版本化在 `test_idempotency_profile` 里单独覆盖。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  DEFAULT_LEASE_MS,
  deriveIdempotencyKey,
  deriveIdempotencyKeyFromEvent,
  deriveLegacyIdempotencyKey,
  isLeaseActive,
  isLeaseExpired,
  leaseExpiry,
} from '../src/domain/idempotency.js';

describe('test_idempotency · 幂等键与租约', () => {
  it('默认档位 v1：键就是 sha256("v1|material_code|operation_no")', () => {
    const expected = createHash('sha256').update('v1|MAT-SAMPLE-01|OP-SAMPLE-001', 'utf8').digest('hex');
    assert.equal(deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001'), expected);
    assert.equal(deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001').length, 64);
    assert.match(deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001'), /^[0-9a-f]{64}$/);
  });

  it('历史档位 legacy：键是 sha256(material_code|operation_no)（升级前写下的老行）', () => {
    const expected = createHash('sha256').update('MAT-SAMPLE-01|OP-SAMPLE-001', 'utf8').digest('hex');
    assert.equal(deriveLegacyIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001'), expected);
    assert.notEqual(deriveLegacyIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001'), deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001'));
  });

  it('同一 (耗材, 台次) 恒得同一把键', () => {
    assert.equal(
      deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001'),
      deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001'),
    );
  });

  it('键与时间戳、重试次数、扫码枪编号、批号无关', () => {
    const base = deriveIdempotencyKeyFromEvent({ material_code: 'MAT-SAMPLE-01', operation_no: 'OP-SAMPLE-001' });

    const firstAttempt = {
      material_code: 'MAT-SAMPLE-01',
      operation_no: 'OP-SAMPLE-001',
      scan_time: '2026-01-15T09:00:00+08:00',
      batch_no: 'LOT-SAMPLE-A',
      scanner_id: 'SCAN-01',
      attempt: 1,
    };
    const retryAttempt = {
      material_code: 'MAT-SAMPLE-01',
      operation_no: 'OP-SAMPLE-001',
      scan_time: '2026-01-15T09:05:31+08:00',
      batch_no: 'LOT-SAMPLE-A',
      scanner_id: 'SCAN-07',
      attempt: 3,
    };

    assert.equal(deriveIdempotencyKeyFromEvent(firstAttempt), base);
    assert.equal(deriveIdempotencyKeyFromEvent(retryAttempt), base);
  });

  it('耗材或台次任一变化 → 键不同', () => {
    const base = deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    assert.notEqual(deriveIdempotencyKey('MAT-SAMPLE-02', 'OP-SAMPLE-001'), base);
    assert.notEqual(deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-002'), base);
  });

  it('租约：到期即失效，未确认的占位可被接管', () => {
    const now = 1_800_000_000_000;
    const expiry = leaseExpiry(now, DEFAULT_LEASE_MS);
    assert.equal(expiry, now + DEFAULT_LEASE_MS);

    const lease = { key: 'k', token: 't', acquiredAt: now, expiresAt: expiry, state: 'claimed' as const };
    assert.equal(isLeaseExpired(lease, now), false);
    assert.equal(isLeaseActive(lease, now), true);
    assert.equal(isLeaseExpired(lease, expiry), true);
    assert.equal(isLeaseActive(lease, expiry), false);

    const released = { ...lease, state: 'released' as const };
    assert.equal(isLeaseActive(released, now), false);
  });
});
