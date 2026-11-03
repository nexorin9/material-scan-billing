/**
 * test_audit_chain：审计链**哈希链** —— 逐行封印、断点行号可指、库层只增不改护栏。
 *
 * 覆盖：
 *   ① 追加 100 行 → 哈希链校验通过（intact），每行都带 prev_hash / row_hash，
 *      首行锚在创世哈希、后续行逐行接续；
 *   ② 绕开护栏改一行内容 → 校验失败并**指出断链行号**与期望 / 实际哈希；
 *   ③ 绕开护栏删一行 → 校验失败并指出缺口（行号不连续 + 接续对不上）；
 *   ④ 库内直接 UPDATE / DELETE audit_chain → 被触发器拒绝，报错信息含 audit_chain；
 *   ⑤ 审计层**不导出**任何 update / delete 接口（只增不改是接口级约束）；
 *   ⑥ 存量行在 v10 迁移时一次性补算封印（老库升级后照样能自证没被动过）；
 *   ⑦ 核查包导出附带审计链校验结论（链是否完整 / 覆盖行数 / 校验时间 / 断点）。
 *
 * 替身说明：②③ 两条用例要模拟「有人绕过触发器直接改库文件」，
 * 所以测试里**临时摘掉护栏**再动手，验完立刻装回 —— 触发器本身拦得住的用例在 ④。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openLedger, schemaVersion, type LedgerDb } from '../src/ledger/db.js';
import {
  appendAudit,
  auditChainHead,
  countAuditRows,
  verifyChain,
  verifyAuditIntegrity,
} from '../src/ledger/audit.js';
import { GENESIS_HASH, canonicalAuditPayload, computeRowHash } from '../src/ledger/audit-hash.js';
import { AUDIT_IMMUTABILITY_TRIGGER_SQL, MIGRATIONS } from '../src/ledger/migrations.js';
import { runPack } from '../src/cli/commands.js';
import { disableAuditGuards, restoreAuditGuards } from './support/audit-reset.js';

/** 追加一行普通审计事件 */
function appendSample(db: DatabaseSync, index: number): number {
  return appendAudit(db, {
    event_type: 'test_audit_event',
    binding_key: `KEY-${String(index).padStart(4, '0')}`,
    operation_no: `OP-SAMPLE-${String((index % 3) + 1).padStart(3, '0')}`,
    scanner_id: 'SCAN-GUN-07',
    actor: 'test',
    detail: `第 ${index} 条审计记录`,
    request_id: `req-${String(index).padStart(4, '0')}`,
  });
}

/** 建一个带 100 行审计记录的台账 */
function ledgerWithRows(rows: number): LedgerDb {
  const ledger = openLedger(':memory:');
  for (let index = 1; index <= rows; index += 1) appendSample(ledger.db, index);
  return ledger;
}

describe('test_audit_chain · 审计链哈希链', () => {
  it('① 追加 100 行后校验通过：每行都封印，逐行接续，首行锚在创世哈希', () => {
    const ledger = ledgerWithRows(100);

    const rows = ledger.db
      .prepare('SELECT id, prev_hash, row_hash FROM audit_chain ORDER BY id ASC')
      .all() as unknown as Array<{ id: number; prev_hash: string; row_hash: string }>;

    assert.equal(rows.length, 100);
    assert.equal(countAuditRows(ledger.db), 100);

    // 首行锚在创世哈希
    assert.equal(rows[0]?.prev_hash, GENESIS_HASH);
    assert.ok((rows[0]?.row_hash ?? '').length === 64, '首行应有 64 位十六进制行哈希');

    // 逐行接续：第 N 行的 prev_hash = 第 N-1 行的 row_hash
    for (let index = 1; index < rows.length; index += 1) {
      assert.equal(
        rows[index]?.prev_hash,
        rows[index - 1]?.row_hash,
        `第 ${index + 1} 行的 prev_hash 应等于上一行的 row_hash`,
      );
    }

    // 行哈希是「上一行哈希 + 本行内容」的 sha256
    const first = ledger.db
      .prepare('SELECT * FROM audit_chain ORDER BY id ASC LIMIT 1')
      .get() as {
      event_type: string;
      binding_key: string | null;
      operation_no: string | null;
      scanner_id: string | null;
      actor: string | null;
      detail: string | null;
      request_id: string | null;
      created_at: string;
      prev_hash: string;
      row_hash: string;
    };
    const expected = computeRowHash(GENESIS_HASH, {
      event_type: first.event_type,
      binding_key: first.binding_key,
      operation_no: first.operation_no,
      scanner_id: first.scanner_id,
      actor: first.actor,
      detail: first.detail,
      request_id: first.request_id,
      created_at: first.created_at,
      prev_hash: GENESIS_HASH,
    });
    assert.equal(first.row_hash, expected);

    const chain = verifyChain(ledger.db);
    assert.equal(chain.intact, true);
    assert.equal(chain.rows, 100);
    assert.equal(chain.first_break, null);
    assert.deepEqual(chain.issues, []);
    assert.equal(chain.checked_at.length > 0, true);

    ledger.close();
  });

  it('①-2 校验区间可限定：只校验一段，结论仍成立', () => {
    const ledger = ledgerWithRows(20);

    const whole = verifyChain(ledger.db);
    assert.equal(whole.intact, true);
    assert.equal(whole.rows, 20);

    const ranged = verifyChain(ledger.db, 5, 12);
    assert.equal(ranged.intact, true);
    assert.equal(ranged.rows, 8);
    assert.equal(ranged.from_id, 5);
    assert.equal(ranged.to_id, 12);

    ledger.close();
  });

  it('② 绕开护栏改一行内容 → 校验失败并指出断链行号与期望 / 实际哈希', () => {
    const ledger = ledgerWithRows(30);

    // 护栏在位时改不动
    assert.throws(
      () => ledger.db.exec("UPDATE audit_chain SET detail = '被改过' WHERE id = 17"),
      /audit_chain/,
      '护栏在位时 UPDATE 应被拒绝',
    );

    // 模拟绕过护栏的篡改（直接改库文件那条路）
    disableAuditGuards(ledger.db);
    try {
      ledger.db.exec("UPDATE audit_chain SET detail = '被改过' WHERE id = 17");
    } finally {
      restoreAuditGuards(ledger.db);
    }

    const chain = verifyChain(ledger.db);
    assert.equal(chain.intact, false);
    assert.ok(chain.first_break, '应指出第一个断点');
    assert.equal(chain.first_break?.reason, 'content_mismatch');
    assert.equal(chain.first_break?.row_id, 17);
    assert.equal(chain.first_break?.row_no, 17);
    assert.ok(chain.first_break?.expected, '应给出重算出的期望哈希');
    assert.ok(chain.first_break?.actual, '应给出库里实际存的哈希');
    assert.notEqual(chain.first_break?.expected, chain.first_break?.actual);
    assert.match(chain.first_break?.message ?? '', /内容被改/);

    ledger.close();
  });

  it('③ 绕开护栏删一行 → 校验失败并指出行号缺口', () => {
    const ledger = ledgerWithRows(30);

    // 护栏在位时删不掉
    assert.throws(
      () => ledger.db.exec('DELETE FROM audit_chain WHERE id = 9'),
      /audit_chain/,
      '护栏在位时 DELETE 应被拒绝',
    );

    disableAuditGuards(ledger.db);
    try {
      ledger.db.exec('DELETE FROM audit_chain WHERE id = 9');
    } finally {
      restoreAuditGuards(ledger.db);
    }

    const chain = verifyChain(ledger.db);
    assert.equal(chain.intact, false);
    assert.ok(chain.first_break, '应指出第一个断点');
    assert.equal(chain.first_break?.reason, 'missing_row');
    assert.equal(chain.first_break?.row_id, 10);
    assert.equal(chain.first_break?.expected, '9');
    assert.equal(chain.first_break?.actual, '10');
    assert.match(chain.first_break?.message ?? '', /不连续|被删过/);

    // 删掉的是最后一行时，接续仍然对得上，但行号缺口照样指得出来
    const tail = ledgerWithRows(10);
    disableAuditGuards(tail.db);
    try {
      tail.db.exec('DELETE FROM audit_chain WHERE id = 10');
    } finally {
      restoreAuditGuards(tail.db);
    }
    const tailChain = verifyChain(tail.db);
    assert.equal(tailChain.intact, true, '删掉末行不改变前 9 行的接续');
    assert.equal(tailChain.rows, 9);
    tail.close();

    ledger.close();
  });

  it('④ 库内直接 UPDATE / DELETE audit_chain 被触发器拒绝，报错信息含 audit_chain', () => {
    const ledger = ledgerWithRows(5);

    const triggers = ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_chain'")
      .all() as unknown as Array<{ name: string }>;
    const triggerNames = triggers.map((row) => row.name).sort();
    assert.deepEqual(triggerNames, ['trg_audit_chain_no_delete', 'trg_audit_chain_no_update']);

    assert.throws(
      () => ledger.db.exec("UPDATE audit_chain SET actor = 'someone' WHERE id = 1"),
      (error: unknown) => {
        assert.match(String((error as Error).message), /audit_chain/);
        assert.match(String((error as Error).message), /只增不改/);
        return true;
      },
    );

    assert.throws(
      () => ledger.db.exec('DELETE FROM audit_chain WHERE id = 1'),
      (error: unknown) => {
        assert.match(String((error as Error).message), /audit_chain/);
        assert.match(String((error as Error).message), /只增不改/);
        return true;
      },
    );

    // 拒绝之后一行都没少
    assert.equal(countAuditRows(ledger.db), 5);
    assert.equal(verifyChain(ledger.db).intact, true);

    ledger.close();
  });

  it('⑤ 审计层不导出任何 update / delete 接口（只增不改是接口级约束）', async () => {
    const auditModule = await import('../src/ledger/audit.js');
    const exported = Object.keys(auditModule);
    const forbidden = exported.filter((name) => /^(update|delete|remove|drop|truncate|clear|purge)/i.test(name));
    assert.deepEqual(forbidden, [], `审计层不应导出改写接口：${forbidden.join(', ')}`);
    assert.ok(exported.includes('appendAudit'));
    assert.ok(exported.includes('verifyChain'));
  });

  it('⑥ 存量行在 v10 迁移时补算封印：老库升级后照样能自证没被动过', async () => {
    const ledger = openLedger(':memory:');

    // 把台账拨回「升级前」的样子：版本指针停在 v9、护栏还没装、审计行没有哈希
    ledger.db.exec('DROP TRIGGER IF EXISTS trg_audit_chain_no_update');
    ledger.db.exec('DROP TRIGGER IF EXISTS trg_audit_chain_no_delete');
    ledger.db.exec('DELETE FROM migrations WHERE version = 10');
    ledger.db.exec('PRAGMA user_version = 9');
    ledger.db.exec(
      `INSERT INTO audit_chain (event_type, binding_key, operation_no, scanner_id, actor, detail, created_at)
       VALUES ('legacy_event', 'KEY-LEGACY', 'OP-SAMPLE-001', 'SCAN-GUN-01', 'legacy', '升级前写下的行', '2026-01-01T00:00:00.000Z')`,
    );
    ledger.db.exec(
      `INSERT INTO audit_chain (event_type, binding_key, operation_no, scanner_id, actor, detail, created_at)
       VALUES ('legacy_event', 'KEY-LEGACY-2', 'OP-SAMPLE-001', 'SCAN-GUN-01', 'legacy', '升级前写下的第二行', '2026-01-01T00:00:01.000Z')`,
    );

    const unsealed = ledger.db
      .prepare('SELECT COUNT(*) AS n FROM audit_chain WHERE row_hash IS NULL')
      .get() as { n: number };
    assert.equal(unsealed.n, 2, '升级前的老账没有封印哈希');

    // 重跑迁移链：v10 应当补算封印并把护栏装上
    const { applyMigrations } = await import('../src/ledger/migrations.js');
    const result = applyMigrations(ledger.db);
    assert.equal(result.from, 9);
    assert.equal(result.to, MIGRATIONS.length);
    // v9 → 链尾：v10 封印 + 后续版本（v11 幂等键版本化）依次应用
    assert.equal(result.applied.length, MIGRATIONS.length - 9);
    assert.equal(result.applied[0]?.name, 'audit_chain_hash_chain');
    assert.equal(schemaVersion(ledger.db), MIGRATIONS.length);

    const rows = ledger.db
      .prepare('SELECT id, prev_hash, row_hash FROM audit_chain ORDER BY id ASC')
      .all() as unknown as Array<{ id: number; prev_hash: string; row_hash: string }>;
    assert.ok(rows.every((row) => row.row_hash && row.row_hash.length === 64), '存量行应被补算封印');
    assert.equal(rows[0]?.prev_hash, GENESIS_HASH);
    assert.equal(rows[1]?.prev_hash, rows[0]?.row_hash);

    const chain = verifyChain(ledger.db);
    assert.equal(chain.intact, true, '补算后整条链校验通过');
    assert.equal(chain.rows, 2);

    // 补算之后护栏也装上了
    assert.throws(() => ledger.db.exec('DELETE FROM audit_chain WHERE id = 1'), /audit_chain/);

    ledger.close();
  });

  it('⑥-2 老库（v7、无履历表、缺 request_id 列）升级到 v10 成功并封印', async () => {
    const ledger = openLedger(':memory:');

    // 造出「老库」的样子：版本指针停在 v7、履历表是空的、
    // 审计表还停在 v1 形态（没有 v7 才加的 request_id 列）
    // 索引也一并去掉 —— v7 时代的库里不可能有后来版本建的索引
    ledger.db.exec('DROP TRIGGER IF EXISTS trg_audit_chain_no_update');
    ledger.db.exec('DROP TRIGGER IF EXISTS trg_audit_chain_no_delete');
    ledger.db.exec('DROP INDEX IF EXISTS ix_audit_chain_request');
    ledger.db.exec('ALTER TABLE audit_chain DROP COLUMN request_id');
    ledger.db.exec('DELETE FROM migrations');
    ledger.db.exec('PRAGMA user_version = 7');
    ledger.db.exec(
      `INSERT INTO audit_chain (event_type, binding_key, operation_no, scanner_id, actor, detail, created_at)
       VALUES ('legacy_event', 'KEY-LEGACY', 'OP-SAMPLE-001', 'SCAN-GUN-01', 'legacy', '老库里的行', '2026-01-01T00:00:00.000Z')`,
    );

    const { applyMigrations } = await import('../src/ledger/migrations.js');
    const result = applyMigrations(ledger.db);
    assert.equal(result.from, 7);
    assert.equal(result.to, MIGRATIONS.length);
    assert.equal(result.applied.length, MIGRATIONS.length - 7, 'v8 起依次应用到链尾');

    // 缺的列被补齐（老库补记只记履历、不重跑历史 DDL，列要靠本版自己保证）
    const columns = (ledger.db.prepare('PRAGMA table_info(audit_chain)').all() as unknown as Array<{
      name: string;
    }>).map((row) => row.name);
    assert.ok(columns.includes('request_id'), 'request_id 列应被补齐');
    assert.ok(columns.includes('prev_hash'));
    assert.ok(columns.includes('row_hash'));

    // 老账被补算封印，且整链校验通过
    const sealed = ledger.db
      .prepare('SELECT prev_hash, row_hash FROM audit_chain ORDER BY id ASC')
      .all() as unknown as Array<{ prev_hash: string; row_hash: string }>;
    assert.equal(sealed[0]?.prev_hash, GENESIS_HASH);
    assert.ok((sealed[0]?.row_hash ?? '').length === 64);
    assert.equal(verifyChain(ledger.db).intact, true);

    // 护栏也装上了
    assert.throws(() => ledger.db.exec('DELETE FROM audit_chain WHERE id = 1'), /audit_chain/);

    ledger.close();
  });

  it('⑦ 核查包导出附带审计链校验结论（链是否完整 / 覆盖行数 / 校验时间）', () => {
    const ledger = ledgerWithRows(12);

    const pack = runPack(ledger.db);
    assert.ok(pack.audit_chain, '核查包应附带审计链校验结论');
    assert.equal(pack.audit_chain.intact, true);
    assert.equal(pack.audit_chain.rows, 12);
    assert.ok(pack.audit_chain.checked_at.length > 0);
    assert.equal(pack.audit_chain.first_break, null);

    // 篡改之后，核查包里的结论同步变成「不完整 + 断点行号」
    disableAuditGuards(ledger.db);
    try {
      ledger.db.exec("UPDATE audit_chain SET detail = '被改过' WHERE id = 4");
    } finally {
      restoreAuditGuards(ledger.db);
    }
    const tampered = runPack(ledger.db);
    assert.equal(tampered.audit_chain.intact, false);
    assert.equal(tampered.audit_chain.first_break?.row_id, 4);

    ledger.close();
  });

  it('⑦-2 规范化行内容是纯函数：字段顺序固定、null 与空串可区分', () => {
    const base = {
      event_type: 'x',
      binding_key: null,
      operation_no: 'OP-1',
      scanner_id: null,
      actor: null,
      detail: null,
      request_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
      prev_hash: GENESIS_HASH,
    };
    const emptyString = { ...base, detail: '' };
    assert.notEqual(canonicalAuditPayload(base), canonicalAuditPayload(emptyString));
    assert.equal(canonicalAuditPayload(base), canonicalAuditPayload({ ...base }));
    assert.equal(computeRowHash(GENESIS_HASH, base), computeRowHash(GENESIS_HASH, { ...base }));
    assert.notEqual(computeRowHash(GENESIS_HASH, base), computeRowHash('f'.repeat(64), base));
  });

  it('⑦-3 链头可读：空链返回创世哈希，写入后返回末行行哈希', () => {
    const ledger = openLedger(':memory:');
    assert.equal(auditChainHead(ledger.db), GENESIS_HASH);
    appendSample(ledger.db, 1);
    const head = auditChainHead(ledger.db);
    assert.equal(head.length, 64);
    assert.notEqual(head, GENESIS_HASH);
    ledger.close();
  });

  it('⑦-4 触发器 SQL 可重复执行（幂等）', () => {
    const ledger = openLedger(':memory:');
    ledger.db.exec(AUDIT_IMMUTABILITY_TRIGGER_SQL);
    ledger.db.exec(AUDIT_IMMUTABILITY_TRIGGER_SQL);
    const triggers = ledger.db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_chain'")
      .get() as { n: number };
    assert.equal(triggers.n, 2);
    ledger.close();
  });

  it('⑦-5 基础体检（行号连续 / 时间不倒序）与哈希链校验互不干扰', () => {
    const ledger = ledgerWithRows(6);
    const integrity = verifyAuditIntegrity(ledger.db);
    assert.equal(integrity.intact, true);
    assert.equal(integrity.rows, 6);
    assert.equal(verifyChain(ledger.db).intact, true);
    ledger.close();
  });
});
