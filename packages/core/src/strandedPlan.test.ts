import {deepEqual, strictEqual} from "node:assert/strict";
import test from "node:test";
import {planStranded} from "./strandedPlan.ts";
import {SYNC_LEDGER_FORMAT, type SyncLedger} from "./syncLedger.ts";

const ledger = (over: Partial<SyncLedger> = {}): SyncLedger => ({
    format: SYNC_LEDGER_FORMAT,
    tenant: "acme",
    base: {revisionNo: 7, tarSha256: "a".repeat(64)},
    files: {},
    server: {generation: "G1"},
    mine: {},
    pulledAt: "2026-08-01T00:00:00.000Z",
    pushedAt: null,
    ...over,
});
const draft = (over: Record<string, unknown> = {}) =>
    ({generation: "G1", changed: [], deleted: [], baseRevisionNo: 6, strandedOnOldRevision: true, ...over}) as never;

test("내가 올린 것과 같으면 A — 버려도 원본이 여기 있다", () => {
    const plan = planStranded({
        ledger: ledger({mine: {"a.tsx": "sha-a", "b.tsx": null}}),
        draft: draft({changed: [{path: "a.tsx", sha256: "sha-a"}], deleted: ["b.tsx"]}),
    });
    strictEqual(plan.verdict, "mine");
    deepEqual(plan.paths, ["a.tsx", "b.tsx"]);
});

test("🔴 내 장부에 없는 경로가 섞이면 B — 그것이 유일본일 수 있다", () => {
    const plan = planStranded({
        ledger: ledger({mine: {"a.tsx": "sha-a"}}),
        draft: draft({changed: [{path: "a.tsx", sha256: "sha-a"}, {path: "남이-고침.tsx", sha256: "x"}]}),
    });
    strictEqual(plan.verdict, "elsewhere");
    strictEqual(plan.reason, "path-not-mine");
});

test("🔴 같은 경로인데 sha 가 다르면 B — 내가 올린 뒤 남이 더 얹었다", () => {
    const plan = planStranded({
        ledger: ledger({mine: {"a.tsx": "내것"}}),
        draft: draft({changed: [{path: "a.tsx", sha256: "남의것"}]}),
    });
    strictEqual(plan.verdict, "elsewhere");
    strictEqual(plan.reason, "sha-differs");
});

test("🔴 세대가 다르면 B — 그 조건이 빠지면 「내가 올린 뒤 남이 더 얹은」 경우가 A 로 접힌다", () => {
    const plan = planStranded({
        ledger: ledger({server: {generation: "G1"}, mine: {"a.tsx": "sha-a"}}),
        draft: draft({generation: "G2", changed: [{path: "a.tsx", sha256: "sha-a"}]}),
    });
    strictEqual(plan.verdict, "elsewhere");
    strictEqual(plan.reason, "generation-differs");
});

test("🔴 세대를 모르면 B — 「모른다」를 「내 것」으로 바꾸지 않는다", () => {
    const plan = planStranded({
        ledger: ledger({server: null, mine: {"a.tsx": "sha-a"}}),
        draft: draft({changed: [{path: "a.tsx", sha256: "sha-a"}]}),
    });
    strictEqual(plan.verdict, "elsewhere");
    strictEqual(plan.reason, "generation-differs");
});

test("🔴 장부가 없으면 B", () => {
    strictEqual(planStranded({ledger: null, draft: draft()}).verdict, "elsewhere");
    strictEqual(planStranded({ledger: null, draft: draft()}).reason, "no-ledger");
});

test("🔴 서버를 못 읽으면 B — 그리고 보여 줄 목록도 없다", () => {
    const plan = planStranded({ledger: ledger({mine: {"a.tsx": "sha-a"}}), draft: null});
    strictEqual(plan.verdict, "elsewhere");
    strictEqual(plan.reason, "server-unreadable");
    deepEqual(plan.paths, []);
});

test("🔴 내가 올린 것은 «쓰기»였는데 사이트에는 «삭제»로 있으면 B", () => {
    const plan = planStranded({
        ledger: ledger({mine: {"a.tsx": "sha-a"}}),
        draft: draft({deleted: ["a.tsx"]}),
    });
    strictEqual(plan.verdict, "elsewhere");
    strictEqual(plan.reason, "sha-differs");
});

test("내가 올린 삭제가 사이트의 삭제와 맞으면 A", () => {
    const plan = planStranded({
        ledger: ledger({mine: {"a.tsx": null}}),
        draft: draft({deleted: ["a.tsx"]}),
    });
    strictEqual(plan.verdict, "mine");
});

test("보여 줄 목록은 바뀐 것과 지운 것을 **둘 다** 담는다", () => {
    const plan = planStranded({
        ledger: null,
        draft: draft({changed: [{path: "b.tsx", sha256: "x"}], deleted: ["a.tsx"]}),
    });
    deepEqual(plan.paths, ["a.tsx", "b.tsx"]);
});
