import {match, ok, strictEqual} from "node:assert/strict";
import {test} from "node:test";
import {SYNC_LEDGER_FORMAT, syncStatus, type PushResult, type SyncLedger} from "@zalkera/devtools-core";
import {describePush, describeStatus, describeStranded, DISCARD_PHRASE} from "./report.ts";

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
    match(stranded, /zalkera discard/);
    // ⚠ **있는 명령만** 댄다. T3 에서 `discard`·`publish` 가 실제로 생겼으므로 그것들은 이제 옳다 —
    //   대신 **아직 없는** 것을 대면 안 된다.
    match(stranded, /zalkera discard/, "실제 출구를 안 댄다");
    ok(!/zalkera (preview|mcp)/.test(stranded), stranded);
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

// ── 올리기 보고 ─────────────────────────────────────────────────────────────────

const pushed = (over: Partial<PushResult> = {}): PushResult => ({
    sent: 0,
    removed: 0,
    generation: null,
    droppedByServer: [],
    retriedAfterConflict: false,
    reconciled: null,
    previewUrl: null,
    warning: null,
    ...over,
});

test("🔴 「같습니다」와 「빼고 보냈습니다」가 함께 찍히지 않는다", () => {
    const out = describePush(pushed({sent: 0, droppedByServer: ["dist/x.js"]})).join("\n");
    ok(!out.includes("사이트 쪽과 같습니다"), `모순된 두 줄이 함께 찍혔다:\n${out}`);
    match(out, /빼고 보냈습니다/);
});

test("🔴 「다시 보냈습니다」라고 **행동으로** 적지 않는다 — 요청이 0번 나가는 갈래가 있다", () => {
    const out = describePush(pushed({reconciled: "not-applied", sent: 0})).join("\n");
    ok(!/다시 보냈습니다/.test(out), `안 보냈는데 보냈다고 적었다:\n${out}`);
    match(out, /사이트 쪽에 없었습니다/);
});

test("🔴 올린 것이 있을 때만 «아직 안 켜졌다»를 말한다", () => {
    match(describePush(pushed({sent: 2, removed: 1})).join("\n"), /켜지지는 않았습니다/);
    ok(!describePush(pushed({sent: 0})).join("\n").includes("켜지지는"), "안 올렸는데 발행하라고 한다");
});

test("🔴 두 번째 요청이 안 나간 갈래에서 「다시 보냈습니다」라고 안 한다", () => {
    // `retriedAfterConflict` 는 **보낸 뒤에만** 참이 된다 — 그 계약을 문면 쪽에서도 못박는다.
    const out = describePush(pushed({sent: 0, retriedAfterConflict: false})).join("\n");
    ok(!out.includes("한 번 더 보냈습니다"), out);
});

test("경로를 전량 나열하지 않는다 · `--verbose` 면 전부", () => {
    const many = Array.from({length: 25}, (_, i) => `f${i}.tsx`);
    match(describePush(pushed({sent: 1, droppedByServer: many})).join("\n"), /외 15개/);
    ok(!describePush(pushed({sent: 1, droppedByServer: many}), true).join("\n").includes("외 "));
});

test("화해 결과를 사실로 적는다", () => {
    match(describePush(pushed({reconciled: "applied"})).join("\n"), /들어가 있었습니다/);
    strictEqual(describePush(pushed({reconciled: null}))[0], "올릴 것이 없습니다 — 이 폴더의 내용이 사이트 쪽과 같습니다.");
});

// ── 좌초 안내(§2.5) ─────────────────────────────────────────────────────────────

test("🔴 「손실이 아니다」는 **내 것일 때만** 쓴다 — 무조건 달면 유일본을 지우게 만든다", () => {
    const mine = describeStranded({verdict: "mine", empty: false, paths: ["a.tsx"], reason: "ledger-matches"}).join("\n");
    match(mine, /이 폴더의 내용은 그대로입니다/);

    const other = describeStranded({verdict: "elsewhere", empty: false, paths: ["a.tsx"], reason: "path-not-mine"}).join("\n");
    ok(!other.includes("그대로입니다"), `유일본에 「손실이 아니다」를 달았다:\n${other}`);
    match(other, /되찾을 방법이 없습니다/);
});

test("🔴 「남의 드래프트」라고 쓰지 않는다 — 같은 사람이 두 표면을 쓰면 거짓이 된다", () => {
    const out = describeStranded({verdict: "elsewhere", empty: false, paths: ["a.tsx"], reason: "sha-differs"}).join("\n");
    ok(!/남의|다른 사람의/.test(out), `누구의 것인지 단정했다:\n${out}`);
    match(out, /이 폴더에 없는 편집/, "폴더 기준으로 말하지 않는다");
});

test("무엇이 걸려 있는지 보여 주고, 못 읽었으면 그 사실도 말한다", () => {
    match(describeStranded({verdict: "elsewhere", empty: false, paths: ["a.tsx", "b.tsx"], reason: "no-ledger"}).join("\n"), /· a\.tsx/);
    // 목록이 비었으면 **「걸려 있습니다」를 단정하지 않는다** — 못 읽은 것과 없는 것을 안 뭉친다.
    const unknown = describeStranded({verdict: "elsewhere", empty: false, paths: [], reason: "server-unreadable"}).join("\n");
    match(unknown, /확인하지 못했습니다/);
    ok(!unknown.includes("걸려 있습니다."), `목록도 없이 단정했다:\n${unknown}`);
});

test("경로를 전량 나열하지 않는다", () => {
    const many = Array.from({length: 25}, (_, i) => `f${i}.tsx`);
    match(describeStranded({verdict: "mine", empty: false, paths: many, reason: "ledger-matches"}).join("\n"), /외 15개/);
});

test("🔴 버리기 문구는 **한 글자가 아니다**", () => {
    ok(DISCARD_PHRASE.length > 1, `한 글자 동의를 받는다: ${DISCARD_PHRASE}`);
});
