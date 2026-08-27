import {deepEqual, ok, strictEqual} from "node:assert/strict";
import test from "node:test";
import {ledgerCorrection, syncStatus} from "./syncStatus.ts";
import {SYNC_LEDGER_FORMAT, type SyncLedger} from "./syncLedger.ts";

const ledger = (over: Partial<SyncLedger> = {}): SyncLedger => ({
    format: SYNC_LEDGER_FORMAT, tenant: "acme", base: {revisionNo: 12, tarSha256: "a".repeat(64)},
    files: {"app/page.tsx": {sha256: "가", bytes: 1}}, server: null, mine: {},
    pulledAt: "2026-08-01T00:00:00.000Z", pushedAt: null, ...over,
});
const draft = (over: Record<string, unknown> = {}) => ({
    generation: "G1", changed: [], deleted: [], baseRevisionNo: 12, strandedOnOldRevision: false, ...over,
}) as never;

test("고친 것·지운 것·새로 생긴 것을 가른다", () => {
    const s = syncStatus({
        ledger: ledger({files: {"a.tsx": {sha256: "가", bytes: 1}, "b.tsx": {sha256: "나", bytes: 1}}}),
        local: {"a.tsx": {sha256: "고침"}, "c.tsx": {sha256: "새것"}},
        draft: draft(), activeRevisionNo: 12,
    });
    deepEqual(s.changed, ["a.tsx"]);
    deepEqual(s.removed, ["b.tsx"]);
    deepEqual(s.added, ["c.tsx"]);
});

test("🔴 세대가 갈리면 `mine` 은 아무 말도 못 한다 — 「이미 반영됨」의 뿌리", () => {
    const s = syncStatus({
        ledger: ledger({server: {generation: "G1"}, mine: {"app/page.tsx": "가"}}),
        local: {}, draft: draft({generation: "G2"}), activeRevisionNo: 12,
    });
    strictEqual(s.mineValid, false);
});

test("세대가 같아야 `mine` 이 유효하다", () => {
    const s = syncStatus({
        ledger: ledger({server: {generation: "G1"}}), local: {}, draft: draft({generation: "G1"}), activeRevisionNo: 12,
    });
    strictEqual(s.mineValid, true);
});

test("🔴 서버를 못 읽었으면 `mine` 은 무효다 — 장부로 폴백하면 🔴1 이 되살아난다", () => {
    const s = syncStatus({
        ledger: ledger({server: {generation: "G1"}, mine: {"a.tsx": "가"}}),
        local: {}, draft: null, activeRevisionNo: 12,
    });
    strictEqual(s.mineValid, false);
    ok(s.blockers.includes("SERVER_UNREADABLE"));
});

test("🔴 편집이 없어진 뒤(세대 null)에도 `mine` 은 무효다", () => {
    // 남이 콘솔에서 되돌린 형상. 장부는 G1 을 봤다고 적혀 있고 서버는 아무것도 없다고 답한다.
    const s = syncStatus({
        ledger: ledger({server: {generation: "G1"}, mine: {"a.tsx": "가"}}),
        local: {}, draft: draft({generation: null}), activeRevisionNo: 12,
    });
    strictEqual(s.mineValid, false);
});

test("장부가 없으면 막는다 — 복구는 baseline 이다", () => {
    const s = syncStatus({ledger: null, local: {"a.tsx": {sha256: "가"}}, draft: draft(), activeRevisionNo: 12});
    ok(s.blockers.includes("LEDGER_UNKNOWN"));
    deepEqual(s.added, ["a.tsx"], "장부가 없으면 전부 새것이다");
    strictEqual(s.baseRevisionNo, null);
});

test("좌초는 막는다", () => {
    const s = syncStatus({ledger: ledger(), local: {}, draft: draft({strandedOnOldRevision: true}), activeRevisionNo: 12});
    ok(s.blockers.includes("STRANDED"));
});

test("서버가 앞서 있으면 말한다 — 그리고 판 번호를 모르면 말하지 않는다", () => {
    strictEqual(syncStatus({ledger: ledger(), local: {}, draft: draft(), activeRevisionNo: 14}).behind, true);
    strictEqual(syncStatus({ledger: ledger(), local: {}, draft: draft(), activeRevisionNo: 12}).behind, false);
    strictEqual(syncStatus({ledger: ledger(), local: {}, draft: draft(), activeRevisionNo: null}).behind, false);
    strictEqual(syncStatus({ledger: null, local: {}, draft: draft(), activeRevisionNo: 14}).behind, false);
});

test("편집이 담은 경로 수는 쓴 것과 지운 것을 **둘 다** 센다", () => {
    const s = syncStatus({
        ledger: ledger(), local: {},
        draft: draft({changed: [{path: "a.tsx", sha256: "가"}], deleted: ["b.tsx"]}), activeRevisionNo: 12,
    });
    strictEqual(s.draftPaths, 2);
});

test("🔴 세대가 갈리면 장부를 정정한다 — 지난 세계의 소유 기록이 남으면 안 된다", () => {
    const before = ledger({server: {generation: "G1"}, mine: {"a.tsx": "가"}});
    const after = ledgerCorrection(before, draft({generation: "G2"}));
    strictEqual(after?.server, null, "세대를 지금 값으로 갈아 적었다 — 「확인했다」가 거짓이 된다");
    deepEqual(after?.mine, {});
    strictEqual(after?.base.revisionNo, 12, "판 기록까지 건드렸다");
    deepEqual(after?.files, before.files, "판 매니페스트를 건드렸다");
});

test("🔴 서버를 못 읽었으면 **아무것도 안 고친다** — 「못 물어봤다」는 「갈렸다」가 아니다", () => {
    strictEqual(ledgerCorrection(ledger({server: {generation: "G1"}, mine: {"a.tsx": "가"}}), null), null);
});

test("세대가 같으면 안 고친다", () => {
    strictEqual(ledgerCorrection(ledger({server: {generation: "G1"}}), draft({generation: "G1"})), null);
});

test("편집이 사라졌으면(둘 다 null) 안 고친다 — 쓸 것이 없는데 쓰지 않는다", () => {
    strictEqual(ledgerCorrection(ledger({server: null, mine: {}}), draft({generation: null})), null);
});

test("🔴 세대를 몰랐는데 내 소유 기록만 남아 있으면 비운다", () => {
    // 응답 유실 뒤의 형상: 세대는 「모름」인데 `mine` 이 남았다. 그 소유는 근거가 없다.
    const after = ledgerCorrection(ledger({server: null, mine: {"a.tsx": "가"}}), draft({generation: "G1"}));
    deepEqual(after?.mine, {});
    strictEqual(after?.server, null);
});

test("장부가 없으면 고칠 것도 없다", () => {
    strictEqual(ledgerCorrection(null, draft()), null);
});
