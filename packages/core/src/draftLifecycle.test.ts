import {deepEqual, match, ok, rejects, strictEqual} from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {test} from "node:test";
import {gzipSync} from "node:zlib";
import {discardDraft, publishDraft, rollbackRevision} from "./draftLifecycle.ts";
import type {StrandedPlan} from "./strandedPlan.ts";
import {DevtoolsError} from "./errors.ts";
import {readLedger} from "./pull.ts";
import {SYNC_LEDGER_FORMAT, SYNC_LEDGER_PATH, serializeSyncLedger, type SyncLedger} from "./syncLedger.ts";
import {tempDir} from "./testing/tempDir.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function header(name: string, size: number): Buffer {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156);
    let s = 0; for (const b of h) s += b;
    h.write(s.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
}
function tarGz(files: Record<string, string>): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, body] of Object.entries(files)) {
        const d = Buffer.from(body, "utf8");
        blocks.push(header(name, d.length), d, Buffer.alloc((512 - (d.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}

interface Fake {
    active?: number;
    /** `activate` 뒤 서버가 실제로 켜 놓는 판. 안 주면 요청한 그 판이 켜진 것으로 본다. */
    landsOn?: number;
    /** `activate` 가 던질 것. 동의 요구를 재현할 때 쓴다. */
    activateThrows?: DevtoolsError;
    /** 활성 행이 없을 때 `GET /draft` 가 답하는 되돌리기 대상. */
    revertTarget?: number;
    /** 사이트 쪽에 편집이 걸려 있는가. 참이면 **비활성 대상 되돌리기를 서버가 거절**한다. */
    hasDraft?: boolean;
    revisions?: Array<{revisionNo: number; status: string; isActive: boolean}>;
    tar?: Buffer;
    draft?: unknown;
    publish?: unknown | Error;
    activate?: {pointerMoved?: boolean; discardedDraft?: boolean; discardedPendingChanges?: number};
    sourceFails?: boolean;
}
function server(opts: Fake = {}) {
    const calls: string[] = [];
    let landed: number | null = null;
    const payload = opts.tar ?? tarGz({"a.tsx": "새 판"});
    return {
        calls,
        api: {
            tenantCode: () => "acme",
            listRevisions: async () =>
                opts.revisions ?? [{revisionNo: landed ?? opts.active ?? 9, status: "READY", isActive: true}],
            draftState: async () => ({revertTargetRevisionNo: opts.revertTarget ?? null}),
            draftFiles: async () => {
                calls.push("draftFiles");
                return (
                    opts.draft ?? {generation: "G1", changed: [], deleted: [], baseRevisionNo: 8, strandedOnOldRevision: true}
                );
            },
            sourceUrl: async (n: number) => {
                if (opts.sourceFails) throw new Error("못 읽음");
                calls.push(`source:${n}`);
                return {url: "http://127.0.0.1:1/s", sha256: createHash("sha256").update(payload).digest("hex")};
            },
            publishDraft: async (label?: string, discard?: boolean) => {
                calls.push(`publish:${label ?? ""}:${discard === true}`);
                if (opts.publish instanceof Error) throw opts.publish;
                return opts.publish ?? {revisionNo: 10, siteType: "NEXT_SOURCE", status: "BUILDING", capabilityNote: ""};
            },
            activateRevision: async (n: number, discard: boolean) => {
                calls.push(`activate:${n}:${discard}`);
                if (opts.activateThrows) throw opts.activateThrows;
                // ⚠ **실물 계약을 흉내낸다**(심의 지적 — 종전 대역은 넷이 달라 결함 둘을 덮었다).
                //   ⑴ 비활성 대상 + 편집이 있으면 서버는 **동의와 무관하게** 거절한다(가드 5층).
                if (n !== (landed ?? opts.active ?? 9) && opts.hasDraft === true) {
                    throw new DevtoolsError(
                        "SERVER_REJECTED", "편집 중인 내용이 있습니다 — 발행하거나 되돌린 뒤 진행해 주세요.",
                        undefined, undefined, "DRAFT_IN_PROGRESS",
                    );
                }
                //   ⑵ `discardedDraft` 는 **활성 대상**(= 버리기) 갈래에서만 참이다.
                const toCurrent = n === (landed ?? opts.active ?? 9);
                landed = opts.landsOn ?? n;
                return (
                    opts.activate ?? {
                        pointerMoved: !toCurrent,
                        discardedDraft: toCurrent && discard,
                        discardedPendingChanges: 0,
                    }
                );
            },
        } as never,
        fetchImpl: (async () => new Response(payload, {status: 200})) as never,
    };
}

async function site(files: Record<string, string>, over: Partial<SyncLedger> = {}) {
    const dir = await tempDir("zalkera-t3-");
    for (const [p, b] of Object.entries(files)) {
        await mkdir(join(dir, p, ".."), {recursive: true});
        await writeFile(join(dir, p), b);
    }
    await mkdir(join(dir, ".zalkera"), {recursive: true});
    await writeFile(
        join(dir, SYNC_LEDGER_PATH),
        serializeSyncLedger({
            format: SYNC_LEDGER_FORMAT, tenant: "acme", base: {revisionNo: 9, tarSha256: "a".repeat(64)},
            files: {}, server: {generation: "G1"}, mine: {},
            pulledAt: "2026-08-01T00:00:00.000Z", pushedAt: null, ...over,
        }),
    );
    return dir;
}

// ── publish ─────────────────────────────────────────────────────────────────────

test("발행은 **새 문을 안 내고** 콘솔이 쓰는 그 문을 쓴다", async () => {
    const s = server();
    const dir = await site({"a.tsx": "새 판"});
    const out = await publishDraft({api: s.api, folder: dir, fetchImpl: s.fetchImpl, label: "봄맞이"});
    strictEqual(out.revisionNo, 10);
    ok(s.calls.includes("publish:봄맞이:false"), `보낸 것: ${s.calls}`);
});

test("🔴 발행 뒤 `files` 를 **새 판에서 다시 읽는다** — 직전 작업본으로 추정하지 않는다", async () => {
    // 서버가 경로 정규화·제외 목록을 적용하므로 추정은 조용히 어긋난다.
    const s = server({tar: tarGz({"a.tsx": "새 판", "b.tsx": "서버가 더한 것"})});
    const dir = await site({"a.tsx": "새 판"});
    const out = await publishDraft({api: s.api, folder: dir, fetchImpl: s.fetchImpl});
    strictEqual(out.files, 2, "추정으로 적었다");
    const ledger = await readLedger(dir);
    strictEqual(ledger?.base.revisionNo, 10);
    deepEqual(Object.keys(ledger?.files ?? {}).sort(), ["a.tsx", "b.tsx"]);
});

test("🔴 발행 뒤 세대와 `mine` 을 비운다 — 드래프트가 소멸했다", async () => {
    const s = server();
    const dir = await site({"a.tsx": "새 판"}, {mine: {"a.tsx": sha("올린것")}, server: {generation: "G1"}});
    await publishDraft({api: s.api, folder: dir, fetchImpl: s.fetchImpl});
    const ledger = await readLedger(dir);
    deepEqual(ledger?.mine, {}, "소멸한 세대의 소유 기록이 남았다");
});

test("🔴 새 매니페스트를 못 읽으면 **장부를 잊는다** — 옛 판을 가리키는 장부는 거짓이다", async () => {
    const s = server({sourceFails: true});
    const dir = await site({"a.tsx": "새 판"});
    const out = await publishDraft({api: s.api, folder: dir, fetchImpl: s.fetchImpl});
    strictEqual(out.ledgerRebuilt, false);
    strictEqual(out.files, null);
    strictEqual(await readLedger(dir), null, "옛 판을 가리키는 장부가 남았다");
});

test("🔴 새 매니페스트를 못 읽어도 **던지지 않는다** — 판은 이미 섰다", async () => {
    const s = server({sourceFails: true});
    const dir = await site({"a.tsx": "새 판"});
    const out = await publishDraft({api: s.api, folder: dir, fetchImpl: s.fetchImpl});
    strictEqual(out.revisionNo, 10, "발행이 성공했는데 실패로 끝냈다");
});

test("🔴 게시 대기 변경 폐기는 **명시 동의가 있을 때만** 참으로 나간다", async () => {
    const s = server();
    const dir = await site({"a.tsx": "새 판"});
    await publishDraft({api: s.api, folder: dir, fetchImpl: s.fetchImpl});
    ok(s.calls.includes("publish::false"), `동의 없이 참으로 보냈다: ${s.calls}`);
    const s2 = server();
    await publishDraft({api: s2.api, folder: await site({"a.tsx": "새 판"}), discardPendingChanges: true, fetchImpl: s2.fetchImpl});
    ok(s2.calls.includes("publish::true"));
});

// ── rollback ────────────────────────────────────────────────────────────────────

test("🔴 되돌리기 대상이 **지금 켜진 판**이면 받지 않는다 — 그것은 버리기다", async () => {
    const s = server({active: 9});
    const dir = await site({"a.tsx": "가"});
    await rejects(() => rollbackRevision({api: s.api, folder: dir, revisionNo: 9}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "ROLLBACK_IS_DISCARD");
        match(e.humanMessage, /zalkera discard/, "다른 동사를 안 알려 준다");
        return true;
    });
    ok(!s.calls.some((c) => c.startsWith("activate:")), "거절인데 원장을 건드렸다");
});

test("🔴 되돌리기는 **서버가 실제로 켠 판**을 장부에 적는다 — 사람이 친 번호가 아니다", async () => {
    // 서버는 대상이 꼬리가 아니면 그 내용으로 **새 판**을 세워 켠다(`activateByPointer`).
    // 친 번호를 적으면 바로 다음 push 가 「기준이 5판에서 10판으로 움직였다」로 죽는다.
    const s = server({active: 9, landsOn: 10, tar: tarGz({"a.tsx": "5판 내용"})});
    const dir = await site({"a.tsx": "내가-고침"});
    const out = await rollbackRevision({api: s.api, folder: dir, fetchImpl: s.fetchImpl, revisionNo: 5});
    strictEqual(out.requested, 5);
    strictEqual(out.revisionNo, 10, "친 번호를 그대로 적었다");
    strictEqual((await readLedger(dir))?.base.revisionNo, 10);
    strictEqual(await readFile(join(dir, "a.tsx"), "utf8"), "내가-고침", "작업본을 건드렸다");
});

test("🔴 되돌린 판과 폴더가 다르면 말한다 — 그 상태로 올리면 전부 나간다", async () => {
    const s = server({active: 9, tar: tarGz({"a.tsx": "5판 내용", "b.tsx": "5판 b"})});
    const dir = await site({"a.tsx": "내가-고침"});
    const out = await rollbackRevision({api: s.api, folder: dir, fetchImpl: s.fetchImpl, revisionNo: 5});
    deepEqual(out.differing, ["a.tsx", "b.tsx"]);
});

test("🔴 편집 폐기는 명시 동의가 있을 때만 참으로 나간다", async () => {
    const s = server({active: 9});
    await rollbackRevision({api: s.api, folder: await site({}), revisionNo: 5, fetchImpl: s.fetchImpl});
    ok(s.calls.includes("activate:5:false"), `동의 없이 버렸다: ${s.calls}`);
});

// ── discard ─────────────────────────────────────────────────────────────────────

test("🔴 버리기는 **판을 안 옮긴다** — 지금 켜진 판을 대상으로 부른다", async () => {
    const s = server({active: 9});
    const dir = await site({"a.tsx": "가"});
    await discardDraft({api: s.api, folder: dir, plan: {verdict: "mine", empty: false, paths: ["a.tsx"], reason: "ledger-matches"}});
    // ⚠ 동의는 **명시가 있을 때만** 참이다 — 그 인자는 게시 대기 AI 변경 폐기다.
    ok(s.calls.includes("activate:9:false"), `엉뚱한 판을 켰거나 동의 없이 참으로 보냈다: ${s.calls}`);
});

test("버린 뒤 세대와 `mine` 을 비운다 · 판 기록은 그대로다", async () => {
    const s = server({active: 9});
    const dir = await site({"a.tsx": "가"}, {mine: {"a.tsx": sha("올린것")}, base: {revisionNo: 9, tarSha256: "a".repeat(64)}});
    await discardDraft({api: s.api, folder: dir, plan: {verdict: "mine", empty: false, paths: ["a.tsx"], reason: "ledger-matches"}});
    const ledger = await readLedger(dir);
    strictEqual(ledger?.server, null);
    deepEqual(ledger?.mine, {});
    strictEqual(ledger?.base.revisionNo, 9, "판 기록을 건드렸다");
});

test("🔴 버리기는 **사람에게 보여 준 그 판정**을 그대로 쓴다 — 다시 조회하면 확인한 것과 갈린다", async () => {
    // 다시 조회하면 그 사이 남의 편집이 끼어들 수 있고, 그러면 동의 없이 그것을 지운다.
    const s = server({active: 9});
    const shown: StrandedPlan = {
        verdict: "elsewhere", empty: false, paths: ["남이-고침.tsx"], reason: "path-not-mine",
    };
    const out = await discardDraft({api: s.api, folder: await site({"a.tsx": "가"}), plan: shown});
    deepEqual(out.plan, shown, "보여 준 판정과 다른 것을 기록했다");
    ok(!s.calls.some((c) => c.startsWith("draftFiles")), "확인 뒤에 다시 조회했다");
});

test("🔴 버리기가 동의를 **무조건 참으로** 안 보낸다 — 그 인자는 게시 대기 AI 변경 폐기다", async () => {
    // 심의 실측: 갈래 A 의 마지막 문장이 「버려도 이 폴더의 내용은 그대로입니다」인데, 그 `y` 한
    // 글자가 **다른 자산군**(쓴 크레딧이 실린 AI 변경)을 지웠다. 우리가 보여 준 목록에는 그 레일이
    // 아예 안 뜬다 — 동의받은 것과 지운 것이 갈렸다.
    const s = server({active: 9});
    const plan: StrandedPlan = {verdict: "mine", empty: false, paths: ["a.tsx"], reason: "ledger-matches"};
    await discardDraft({api: s.api, folder: await site({}), plan});
    ok(s.calls.includes("activate:9:false"), `동의 없이 참으로 보냈다: ${s.calls}`);

    const s2 = server({active: 9});
    await discardDraft({api: s2.api, folder: await site({}), plan, discardPending: true});
    ok(s2.calls.includes("activate:9:true"));
});

test("🔴 서버가 동의를 요구하면 **그 문면 그대로** 올린다 — 우리가 대신 만들지 않는다", async () => {
    const asked = new DevtoolsError(
        "SERVER_REJECTED",
        "되돌리면 저장 안 된 내용이 사라집니다 — 편집 3개 · 게시 대기 변경 2건",
        undefined, undefined, "DRAFT_DISCARD_CONFIRM_REQUIRED",
    );
    const s = server({active: 9, activateThrows: asked});
    const plan: StrandedPlan = {verdict: "mine", empty: false, paths: ["a.tsx"], reason: "ledger-matches"};
    const dir = await site({});
    await rejects(() => discardDraft({api: s.api, folder: dir, plan}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "DISCARD_CONSENT_REQUIRED");
        match(e.message, /편집 3개 · 게시 대기 변경 2건/, "서버 문면을 우리 문장으로 갈았다");
        match(e.humanMessage, /--discard-pending/, "다음 걸음을 안 알려 준다");
        return true;
    });
});

test("🔴 라이브가 움직였으면 싣는다 — 버리기가 배포 사건이 될 수 있다", async () => {
    const s = server({active: 9, activate: {pointerMoved: true, discardedDraft: true, discardedPendingChanges: 0}});
    const plan: StrandedPlan = {verdict: "mine", empty: false, paths: ["a.tsx"], reason: "ledger-matches"};
    const out = await discardDraft({api: s.api, folder: await site({}), plan});
    strictEqual(out.pointerMoved, true);
});

test("🔴 켜진 판이 없으면 **서버가 정한 되돌리기 대상**으로 접는다 — 두 문이 서로를 가리키면 갇힌다", async () => {
    // 백엔드가 그 자리를 알고 `GET /draft` 에 답을 실어 두었다.
    const s = server({revisions: [{revisionNo: 9, status: "FAILED", isActive: false}], revertTarget: 9});
    const plan: StrandedPlan = {verdict: "mine", empty: false, paths: ["a.tsx"], reason: "ledger-matches"};
    await discardDraft({api: s.api, folder: await site({}), plan});
    ok(s.calls.includes("activate:9:false"), `되돌리기 대상으로 안 접었다: ${s.calls}`);
});

test("🔴 편집이 걸려 있으면 되돌리기가 막히고 **실제 출구**를 댄다", async () => {
    // 서버 문면은 「발행하거나 **되돌린** 뒤」인데, CLI 어휘에서 그 「되돌리기」는 방금 실패한
    // 그 명령이다. 그대로 내보내면 사람이 같은 것을 다시 부른다.
    const s = server({active: 9, hasDraft: true});
    const dir = await site({});
    await rejects(
        () => rollbackRevision({api: s.api, folder: dir, fetchImpl: s.fetchImpl, revisionNo: 5}),
        (e: unknown) => {
            ok(e instanceof DevtoolsError);
            strictEqual(e.code, "ROLLBACK_BLOCKED_BY_DRAFT");
            match(e.humanMessage, /zalkera discard/, "실제 출구를 안 댄다");
            match(e.humanMessage, /zalkera publish/, "다른 출구도 있다");
            return true;
        },
    );
});

test("🔴 되돌리기가 편집을 버렸다고 말할 수 있는 갈래는 **없다**", async () => {
    // 실물에서 `discardedDraft` 는 **활성 대상**(= 버리기) 갈래에서만 참이다.
    const s = server({active: 9, landsOn: 10});
    const out = await rollbackRevision({api: s.api, folder: await site({}), fetchImpl: s.fetchImpl, revisionNo: 5});
    strictEqual(out.discardedDraft, false, "되돌리기가 편집을 버렸다고 말한다");
});

test("🔴 발행도 동의 요구를 사람에게 올린다 — 손잡이를 안 대면 나갈 길이 없다", async () => {
    const asked = new DevtoolsError(
        "SERVER_REJECTED", "게시 대기 중인 AI 변경 2건이 취소됩니다 — 계속하려면 확인해 주세요.",
        undefined, undefined, "DRAFT_DISCARD_CONFIRM_REQUIRED",
    );
    const s = server({publish: asked});
    const dir = await site({});
    await rejects(() => publishDraft({api: s.api, folder: dir, fetchImpl: s.fetchImpl}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "DISCARD_CONSENT_REQUIRED");
        match(e.humanMessage, /--discard-pending/);
        return true;
    });
});
