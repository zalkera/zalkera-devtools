import assert from "node:assert/strict";
import test from "node:test";
import {parseSyncLedger, serializeSyncLedger, SYNC_LEDGER_PATH} from "./syncLedger.ts";

const good = {
    format: 1,
    tenant: "acme",
    base: {revisionNo: 12, tarSha256: "a".repeat(64)},
    files: {"app/page.tsx": {sha256: "b".repeat(64), bytes: 10}},
    server: {generation: "0123456789abcdef"},
    mine: {"app/page.tsx": "c".repeat(64), "app/gone.tsx": null},
    pulledAt: "2026-08-27T00:00:00.000Z",
    pushedAt: null,
};

test("정상 장부를 읽는다 — 내가 올린 삭제(null)도 보존한다", () => {
    const l = parseSyncLedger(JSON.stringify(good))!;
    assert.equal(l.tenant, "acme");
    assert.equal(l.base.revisionNo, 12);
    assert.equal(l.server?.generation, "0123456789abcdef");
    assert.equal(l.mine["app/gone.tsx"], null, "내가 올린 삭제가 사라졌다");
});

test("🔴 모르는 형식은 읽지 않는다 — 반쯤 읽은 장부가 틀린 선행조건을 만든다", () => {
    assert.equal(parseSyncLedger(JSON.stringify({...good, format: 2})), null);
});

test("깨진 내용은 부분 복구하지 않는다 — 없으면 baseline 이 판에서 다시 세운다", () => {
    assert.equal(parseSyncLedger("{"), null, "깨진 JSON 을 읽었다");
    assert.equal(parseSyncLedger(JSON.stringify({...good, base: {revisionNo: "12"}})), null, "판 번호가 문자열인데 읽었다");
    assert.equal(
        parseSyncLedger(JSON.stringify({...good, files: {"a.tsx": {sha256: "x"}}})), null,
        "bytes 없는 매니페스트를 읽었다",
    );
    assert.equal(parseSyncLedger(JSON.stringify({...good, tenant: ""})), null, "빈 테넌트를 읽었다");
});

test("드래프트가 없던 상태(server=null)는 정상이다", () => {
    const l = parseSyncLedger(JSON.stringify({...good, server: null}))!;
    assert.equal(l.server, null);
});

test("쓰고 다시 읽으면 같다 — 왕복이 값을 안 바꾼다", () => {
    const l = parseSyncLedger(JSON.stringify(good))!;
    assert.deepEqual(parseSyncLedger(serializeSyncLedger(l)), l);
});

test("장부 자리는 상수 하나다 — 배제 목록이 이것을 쓴다", () => {
    assert.equal(SYNC_LEDGER_PATH, ".zalkera/sync.json");
});
