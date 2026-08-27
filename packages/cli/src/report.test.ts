import {match, ok, strictEqual} from "node:assert/strict";
import {test} from "node:test";
import {SYNC_LEDGER_FORMAT, syncStatus, type SyncLedger} from "@zalkera/devtools-core";
import {describeStatus} from "./report.ts";

const ledger = (over: Partial<SyncLedger> = {}): SyncLedger => ({
    format: SYNC_LEDGER_FORMAT,
    tenant: "acme",
    base: {revisionNo: 7, tarSha256: "a".repeat(64)},
    files: {"a.tsx": {sha256: "판7", bytes: 3}},
    server: null,
    mine: {},
    pulledAt: "2026-08-01T00:00:00.000Z",
    pushedAt: null,
    ...over,
});
const draft = (over: Record<string, unknown> = {}) =>
    ({generation: null, changed: [], deleted: [], baseRevisionNo: null, strandedOnOldRevision: false, ...over}) as never;

test("🔴 판이 움직였고 고친 것이 있으면 **실제 출구**를 댄다 — 두 문이 서로를 가리키면 갇힌다", () => {
    // 실측: 「pull 하세요」로 끝내면 그 pull 이 거절하고, 그 거절은 「push 하세요」라고 답한다.
    const out = describeStatus(
        syncStatus({ledger: ledger(), local: {"a.tsx": {sha256: "내가-고침"}}, draft: draft(), activeRevisionNo: 9}),
    );
    match(out, /7판에서 9판으로 움직였습니다/);
    match(out, /--discard-local/, `갇히는 안내다:\n${out}`);
});

test("고친 것이 없으면 그냥 «받으세요»라고 한다 — 필요 없는 경고를 안 붙인다", () => {
    const out = describeStatus(
        syncStatus({ledger: ledger(), local: {"a.tsx": {sha256: "판7"}}, draft: draft(), activeRevisionNo: 9}),
    );
    match(out, /zalkera pull/);
    ok(!out.includes("--discard-local"), `버리라는 말을 필요 없이 붙였다:\n${out}`);
});

test("판이 그대로면 그 문단이 아예 없다", () => {
    const out = describeStatus(
        syncStatus({ledger: ledger(), local: {"a.tsx": {sha256: "판7"}}, draft: draft(), activeRevisionNo: 7}),
    );
    ok(!out.includes("움직였습니다"), out);
});

test("🔴 막힌 이유마다 **다음에 할 일**이 문장 안에 있다", () => {
    const noLedger = describeStatus(syncStatus({ledger: null, local: {}, draft: draft(), activeRevisionNo: 7}));
    match(noLedger, /zalkera baseline/);
    const unreadable = describeStatus(syncStatus({ledger: ledger(), local: {}, draft: null, activeRevisionNo: 7}));
    match(unreadable, /다시 시도/);
    const stranded = describeStatus(
        syncStatus({ledger: ledger(), local: {}, draft: draft({strandedOnOldRevision: true}), activeRevisionNo: 7}),
    );
    match(stranded, /콘솔에서/);
    // ⚠ 없는 명령을 대면 안 된다 — 좌초는 사람이 막혀서 다음 걸음을 찾는 자리다.
    ok(!/zalkera (discard|publish|rollback)/.test(stranded), stranded);
});

test("경로를 전량 나열하지 않는다 — 건수 + 최대 10 + 「외 N개」", () => {
    // 장부를 비워 「새로 만든 것」 한 덩어리만 나오게 한다 — 안 그러면 「지운 것」이 섞여 산수가 흐려진다.
    const many = Object.fromEntries(Array.from({length: 25}, (_, i) => [`f${i}.tsx`, {sha256: "새것"}]));
    const out = describeStatus(syncStatus({ledger: ledger({files: {}}), local: many, draft: draft(), activeRevisionNo: 7}));
    match(out, /새로 만든 것 25개/);
    match(out, /외 15개/);
    strictEqual(out.split("\n").filter((line) => line.startsWith("  · ")).length, 11, out);
});

test("`--verbose` 면 전부 보여 준다", () => {
    const many = Object.fromEntries(Array.from({length: 25}, (_, i) => [`f${i}.tsx`, {sha256: "새것"}]));
    const out = describeStatus(
        syncStatus({ledger: ledger({files: {}}), local: many, draft: draft(), activeRevisionNo: 7}),
        true,
    );
    ok(!out.includes("외 "), out);
    strictEqual(out.split("\n").filter((line) => line.startsWith("  · ")).length, 25);
});
