import {deepEqual, match, ok, rejects, strictEqual} from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, rm, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {test} from "node:test";
import {DevtoolsError} from "./errors.ts";
import {MAX_PUSH_ATTEMPTS, MAX_PUSH_ENTRIES, MAX_PUSH_FILE_BYTES, pushSiteSource, reconcile} from "./push.ts";
import {readLedger} from "./pull.ts";
import {SYNC_LEDGER_FORMAT, SYNC_LEDGER_PATH, serializeSyncLedger, type SyncLedger} from "./syncLedger.ts";
import {tempDir} from "./testing/tempDir.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** 서버 대역. 무엇을 받았는지 기록하고, 미리 정한 대로 답하거나 던진다. */
function server(opts: {
    draft?: {changed?: Array<{path: string; sha256: string}>; deleted?: string[]; generation?: string | null; stranded?: boolean} | "unreadable";
    replies?: Array<{generation?: string | null; throw?: DevtoolsError}>;
    /** 지금 켜진 판. 장부 픽스처의 기본 기준 판과 같은 값이 기본이다. */
    activeRevisionNo?: number | "unreadable";
} = {}) {
    const seen: unknown[][] = [];
    let round = 0;
    let draftReads = 0;
    return {
        seen,
        get draftReads() { return draftReads; },
        get rounds() { return round; },
        api: {
            tenantCode: () => "acme",
            listRevisions: async () => {
                if (opts.activeRevisionNo === "unreadable") throw new Error("서버 안 됨");
                return [{revisionNo: opts.activeRevisionNo ?? 7, status: "READY", isActive: true}];
            },
            draftFiles: async () => {
                draftReads += 1;
                if (opts.draft === "unreadable") throw new Error("서버 안 됨");
                return {
                    generation: opts.draft?.generation ?? null,
                    changed: opts.draft?.changed ?? [],
                    deleted: opts.draft?.deleted ?? [],
                    baseRevisionNo: 7,
                    strandedOnOldRevision: opts.draft?.stranded ?? false,
                };
            },
            editDraft: async (edits: unknown[]) => {
                seen.push(edits);
                const reply = opts.replies?.[round] ?? {};
                round += 1;
                if (reply.throw) throw reply.throw;
                return {generation: reply.generation ?? "G-new", files: [], warning: null, previewUrl: null};
            },
        } as never,
    };
}

async function site(files: Record<string, string>, ledgerOver: Partial<SyncLedger> = {}) {
    const dir = await tempDir("zalkera-push-");
    for (const [path, body] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), {recursive: true});
        await writeFile(join(dir, path), body);
    }
    const ledger: SyncLedger = {
        format: SYNC_LEDGER_FORMAT,
        tenant: "acme",
        base: {revisionNo: 7, tarSha256: "a".repeat(64)},
        files: {},
        server: null,
        mine: {},
        pulledAt: "2026-08-01T00:00:00.000Z",
        pushedAt: null,
        ...ledgerOver,
    };
    await mkdir(join(dir, ".zalkera"), {recursive: true});
    await writeFile(join(dir, SYNC_LEDGER_PATH), serializeSyncLedger(ledger));
    return dir;
}

const rejected = (code: string, paths: string[]) =>
    new DevtoolsError("SERVER_REJECTED", "거절", undefined, undefined, code, paths);
/** 백엔드 `SourcePathQuery.RejectedException.PATH_NOT_ACCEPTED` — 「이 경로는 담기지 않는다」. */
const NOT_ACCEPTED = "SOURCE_PATH_NOT_ACCEPTED";
/** 백엔드 `…EDIT_SHAPE_STALE` — 경합이다. 빼면 안 되고 다시 읽어야 한다. */
const SHAPE_STALE = "SOURCE_EDIT_SHAPE_STALE";

test("고친 것을 **한 요청**으로 보낸다 — 나누면 반쪽이 원장에 선다", async () => {
    const s = server();
    const dir = await site({"a.tsx": "새것", "b.tsx": "새것도"}, {
        files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}, "b.tsx": {sha256: sha("옛것도"), bytes: 3}},
    });
    const result = await pushSiteSource({api: s.api, folder: dir});
    strictEqual(s.seen.length, 1, `요청이 ${s.seen.length}번 나갔다`);
    strictEqual(result.sent, 2);
    deepEqual((s.seen[0] as Array<{path: string}>).map((e) => e.path), ["a.tsx", "b.tsx"]);
});

test("🔴 선행조건은 **서버가 준 값**이다 — 장부 값이 아니다", async () => {
    const s = server({draft: {changed: [{path: "a.tsx", sha256: "남이-올린-sha"}], generation: "G1"}});
    const dir = await site({"a.tsx": "내가-고침"}, {files: {"a.tsx": {sha256: sha("판"), bytes: 1}}});
    await pushSiteSource({api: s.api, folder: dir, overwriteUnseen: true});
    const sent = (s.seen[0] as Array<{path: string; baseSha256?: string}>)[0]!;
    strictEqual(sent.baseSha256, "남이-올린-sha", "장부의 판 sha 를 선행조건으로 썼다");
});

test("🔴 서버 상태를 못 읽으면 **아무것도 안 올린다** — 장부로 폴백하지 않는다", async () => {
    const s = server({draft: "unreadable"});
    const dir = await site({"a.tsx": "새것"}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "SERVER_UNREADABLE_DRAFT");
        return true;
    });
    strictEqual(s.seen.length, 0, "못 읽었는데 보냈다");
});

test("🔴 안 본 남의 편집을 되돌리게 되면 거절이 기본이다", async () => {
    const s = server({draft: {changed: [{path: "a.tsx", sha256: "남이-고침"}], generation: "G1"}});
    const dir = await site({"a.tsx": "판", "b.tsx": "내것"}, {files: {"a.tsx": {sha256: sha("판"), bytes: 1}}});
    // ⚠ 로컬 `a.tsx` 내용의 sha 가 장부의 판 sha 와 같아야 「안 본 것」이 된다.
    await writeFile(join(dir, "a.tsx"), "판");
    const fixed = await site({"a.tsx": "판", "b.tsx": "내것"}, {files: {"a.tsx": {sha256: sha("판"), bytes: 1}}});
    await rejects(() => pushSiteSource({api: s.api, folder: fixed}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_WOULD_REVERT");
        match(e.message, /a\.tsx/);
        return true;
    });
    strictEqual(s.seen.length, 0, "거절인데 보냈다");
});

test("명시 동의가 있으면 넘어간다", async () => {
    const s = server({draft: {changed: [{path: "a.tsx", sha256: "남이-고침"}], generation: "G1"}});
    const dir = await site({"a.tsx": "판"}, {files: {"a.tsx": {sha256: sha("판"), bytes: 1}}});
    const result = await pushSiteSource({api: s.api, folder: dir, overwriteUnseen: true});
    strictEqual(result.sent, 1);
});

test("보낼 것이 없으면 «이미 반영됨» — 서버 조회 결과와 같을 때만", async () => {
    const s = server({draft: {changed: [{path: "a.tsx", sha256: sha("새것")}], generation: "G1"}});
    const dir = await site({"a.tsx": "새것"}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    const result = await pushSiteSource({api: s.api, folder: dir});
    strictEqual(result.sent, 0);
    strictEqual(s.seen.length, 0);
    strictEqual((await readLedger(dir))?.server?.generation, "G1");
});

test("🔴 응답을 못 받으면 장부에 «모름»을 **적고** 끝낸다 — 안 적으면 화해가 한 번도 안 돈다", async () => {
    // 심의 실측: 종전 시험은 픽스처의 기본값(`server: null`)을 재고 있었고, 구현은 그 경로에서
    // 장부를 **아예 안 썼다.** 그래서 지난 세대가 그대로 남고 다음 실행의 화해가
    // `ledger.server !== null` 에서 곧바로 되돌아갔다 — 문은 있는데 못 부르는 상태였다.
    const lost = new DevtoolsError("SERVER_UNREACHABLE", "서버가 제때 응답하지 않았습니다.");
    const s = server({draft: {generation: "G1"}, replies: [{throw: lost}]});
    const dir = await site({"a.tsx": "새것", "b.tsx": "지울것"}, {
        // ⚠ **지난 실행이 성공해 세대를 알고 있는** 상태에서 출발한다. 그래야 「모름으로 덮는가」를 잰다.
        files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}, "b.tsx": {sha256: sha("지울것"), bytes: 3}},
        server: {generation: "G0"},
    });
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_RESPONSE_LOST");
        ok(!/아마|올라갔을/.test(e.humanMessage), `추측을 말했다: ${e.humanMessage}`);
        return true;
    });
    const ledger = await readLedger(dir);
    strictEqual(ledger?.server, null, "지난 세대가 그대로 남았다 — 다음 화해가 못 돈다");
    strictEqual(ledger?.mine["a.tsx"], sha("새것"), "보내려던 것을 안 적었다 — 화해가 대조할 대상이 없다");
});

test("🔴 응답 유실 뒤 다음 실행이 실제로 화해한다 — 두 걸음을 이어서 잰다", async () => {
    const lost = new DevtoolsError("SERVER_UNREACHABLE", "서버가 제때 응답하지 않았습니다.");
    const dir = await site({"a.tsx": "새것"}, {
        files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}},
        server: {generation: "G0"},
    });
    // 1걸음: 응답 유실.
    const first = server({draft: {generation: "G0"}, replies: [{throw: lost}]});
    await rejects(() => pushSiteSource({api: first.api, folder: dir}), DevtoolsError);
    // 2걸음: 사실은 서버에 들어가 있었다.
    const second = server({draft: {changed: [{path: "a.tsx", sha256: sha("새것")}], generation: "G1"}});
    const result = await pushSiteSource({api: second.api, folder: dir});
    strictEqual(result.reconciled, "applied", "화해가 안 돌았다");
    strictEqual(result.sent, 0, "이미 들어간 것을 또 보냈다");
    strictEqual((await readLedger(dir))?.server?.generation, "G1");
});

test("🔴 응답 유실 뒤 사실은 **안 들어갔으면** 다시 보낸다", async () => {
    const lost = new DevtoolsError("SERVER_UNREACHABLE", "서버가 제때 응답하지 않았습니다.");
    const dir = await site({"a.tsx": "새것"}, {
        files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}},
        server: {generation: "G0"},
    });
    const first = server({draft: {generation: "G0"}, replies: [{throw: lost}]});
    await rejects(() => pushSiteSource({api: first.api, folder: dir}), DevtoolsError);
    const second = server({draft: {generation: null}, replies: [{generation: "G2"}]});
    const result = await pushSiteSource({api: second.api, folder: dir});
    strictEqual(result.reconciled, "not-applied");
    strictEqual(result.sent, 1, "안 들어갔는데 안 보냈다");
});

test("🔴 배제 경로는 **그것만 빼고** 다시 보내고 **말한다**", async () => {
    // `.env` 는 우리 배제망에 걸려 계획에 안 들어온다 — 서버만 아는 경로(생성물)로 재현한다.
    const s = server({replies: [{throw: rejected(NOT_ACCEPTED, ["dist/x.js"])}, {generation: "G2"}]});
    const dir = await site({"dist/x.js": "생성물", "a.tsx": "새것"}, {
        files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}, "dist/x.js": {sha256: sha("옛"), bytes: 3}},
    });
    const result = await pushSiteSource({api: s.api, folder: dir});
    strictEqual(s.seen.length, 2, `요청이 ${s.seen.length}번 나갔다`);
    deepEqual(result.droppedByServer, ["dist/x.js"]);
    deepEqual((s.seen[1] as Array<{path: string}>).map((e) => e.path), ["a.tsx"]);
});

test("🔴 배제 재시도는 **한 번**이다 — 또 거절되면 던진다", async () => {
    const s = server({
        replies: [
            {throw: rejected(NOT_ACCEPTED, ["dist/x.js"])},
            {throw: rejected(NOT_ACCEPTED, ["a.tsx"])},
        ],
    });
    const dir = await site({"dist/x.js": "가", "a.tsx": "나"}, {
        files: {"dist/x.js": {sha256: sha("옛"), bytes: 1}, "a.tsx": {sha256: sha("옛"), bytes: 1}},
    });
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), DevtoolsError);
    strictEqual(s.seen.length, 2, `요청이 ${s.seen.length}번 나갔다`);
});

test("🔴 선행조건이 어긋나면 **다시 읽고** 한 번 더 보낸다", async () => {
    const s = server({
        draft: {changed: [], generation: "G1"},
        replies: [{throw: rejected("DRAFT_PRECONDITION_FAILED", ["a.tsx"])}, {generation: "G2"}],
    });
    const dir = await site({"a.tsx": "내가-고침"}, {files: {"a.tsx": {sha256: sha("판"), bytes: 1}}});
    const result = await pushSiteSource({api: s.api, folder: dir});
    strictEqual(result.retriedAfterConflict, true);
    strictEqual(s.draftReads, 2, "다시 안 읽었다");
    strictEqual(s.seen.length, 2);
});

test("🔴 재계산에도 «안 본 편집» 가드가 그대로 걸린다 — 재시도가 세탁 경로가 되면 안 된다", async () => {
    // 첫 요청은 선행조건으로 거절되고, 다시 읽으니 남이 그 파일을 고쳐 놨다.
    let reads = 0;
    const api = {
        tenantCode: () => "acme",
        listRevisions: async () => [{revisionNo: 7, status: "READY", isActive: true}],
        draftFiles: async () => {
            reads += 1;
            return reads === 1
                ? {generation: "G1", changed: [], deleted: [], baseRevisionNo: 7, strandedOnOldRevision: false}
                : {
                      generation: "G2",
                      changed: [{path: "a.tsx", sha256: "남이-고침"}],
                      deleted: [],
                      baseRevisionNo: 7,
                      strandedOnOldRevision: false,
                  };
        },
        editDraft: async () => { throw rejected("DRAFT_PRECONDITION_FAILED", ["a.tsx"]); },
    } as never;
    // 작업본이 **판 그대로**다 — 즉 남의 편집을 본 적이 없다.
    const dir = await site({"a.tsx": "판", "b.tsx": "내것"}, {files: {"a.tsx": {sha256: sha("판"), bytes: 1}}});
    await rejects(() => pushSiteSource({api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_WOULD_REVERT", `재시도가 가드를 건너뛰었다: ${(e as DevtoolsError).code}`);
        return true;
    });
});

test("장부가 없으면 올리지 않는다 — 복구는 baseline 이다", async () => {
    const s = server();
    const dir = await tempDir("zalkera-push-noledger-");
    await writeFile(join(dir, "a.tsx"), "가");
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "LEDGER_UNKNOWN");
        match(e.humanMessage, /baseline/);
        return true;
    });
});

test("남의 사이트 장부로는 올리지 않는다", async () => {
    const s = server();
    const dir = await site({"a.tsx": "가"}, {tenant: "남의사이트"});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "LEDGER_UNKNOWN");
        match(e.message, /남의사이트/);
        return true;
    });
    strictEqual(s.seen.length, 0);
});

test("좌초된 편집 위에는 안 올린다", async () => {
    const s = server({draft: {stranded: true, generation: "G1"}});
    const dir = await site({"a.tsx": "가"}, {files: {"a.tsx": {sha256: sha("옛"), bytes: 1}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "STRANDED_DRAFT");
        return true;
    });
    strictEqual(s.seen.length, 0);
});

test("올린 뒤 장부에 «내가 올린 것»이 그 세대 기준으로 적힌다", async () => {
    const s = server({replies: [{generation: "G9"}]});
    const dir = await site({"a.tsx": "새것"}, {
        files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}, "b.tsx": {sha256: sha("지운것"), bytes: 3}},
    });
    const result = await pushSiteSource({api: s.api, folder: dir});
    strictEqual(result.removed, 1, "지운 것을 안 셌다");
    const ledger = await readLedger(dir);
    strictEqual(ledger?.server?.generation, "G9");
    strictEqual(ledger?.mine["a.tsx"], sha("새것"));
    strictEqual(ledger?.mine["b.tsx"], null, "내가 올린 삭제가 null 로 안 적혔다");
    ok(ledger?.pushedAt);
});

// ── 응답 유실 화해(§2.3) ─────────────────────────────────────────────────────────

const ledgerWith = (mine: Record<string, string | null>, server: {generation: string} | null = null): SyncLedger => ({
    format: SYNC_LEDGER_FORMAT, tenant: "acme", base: {revisionNo: 7, tarSha256: "a".repeat(64)},
    files: {}, server, mine, pulledAt: "2026-08-01T00:00:00.000Z", pushedAt: null,
});
const draftOf = (changed: Array<{path: string; sha256: string}> = [], deleted: string[] = []) =>
    ({generation: "G", changed, deleted, baseRevisionNo: 7, strandedOnOldRevision: false});

test("🔴 보내려던 것이 서버에 그대로 있으면 «적용됨»이다", async () => {
    const verdict = reconcile(ledgerWith({"a.tsx": "sha1"}), draftOf([{path: "a.tsx", sha256: "sha1"}]));
    strictEqual(verdict, "applied");
});

test("🔴 없으면 «안 됨»이다 — 다시 보낸다", async () => {
    strictEqual(reconcile(ledgerWith({"a.tsx": "sha1"}), draftOf()), "not-applied");
});

test("🔴 **일부만** 보이면 «적용됨»이 아니다 — 서버는 부분 적용을 안 만든다", async () => {
    // 일부만 보이면 그 사이 남이 고친 것이다 → 재계산 갈래(=안 됨).
    const verdict = reconcile(
        ledgerWith({"a.tsx": "sha1", "b.tsx": "sha2"}),
        draftOf([{path: "a.tsx", sha256: "sha1"}]),
    );
    strictEqual(verdict, "not-applied");
});

test("내가 올린 **삭제**도 대조한다", async () => {
    strictEqual(reconcile(ledgerWith({"a.tsx": null}), draftOf([], ["a.tsx"])), "applied");
    strictEqual(reconcile(ledgerWith({"a.tsx": null}), draftOf()), "not-applied");
});

test("🔴 세대를 아는 장부는 화해 대상이 아니다 — 응답을 받았다는 뜻이다", async () => {
    strictEqual(reconcile(ledgerWith({"a.tsx": "sha1"}, {generation: "G1"}), draftOf()), null);
});

test("올린 적이 없으면 화해할 것도 없다", async () => {
    strictEqual(reconcile(ledgerWith({}), draftOf()), null);
});

test("🔴 같은 경로인데 sha 가 다르면 «적용됨»이 아니다 — 남이 그 위에 더 얹었다", async () => {
    const verdict = reconcile(ledgerWith({"a.tsx": "내것"}), draftOf([{path: "a.tsx", sha256: "남의것"}]));
    strictEqual(verdict, "not-applied");
});

test("화해 결과가 push 결과에 실린다", async () => {
    // ⚠ 장부를 손으로 쓰지 않는다 — 그러면 **구현이 만들 수 없는 상태**의 행동을 재게 된다(심의 지적).
    //   응답 유실을 실제로 겪게 해서 그 상태를 만든다.
    const lost = new DevtoolsError("SERVER_UNREACHABLE", "끊김");
    const dir = await site({"a.tsx": "새것"}, {
        files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}},
        server: {generation: "G0"},
    });
    await rejects(
        () => pushSiteSource({api: server({draft: {generation: "G0"}, replies: [{throw: lost}]}).api, folder: dir}),
        DevtoolsError,
    );
    const s = server({draft: {changed: [{path: "a.tsx", sha256: sha("새것")}], generation: "G1"}});
    const result = await pushSiteSource({api: s.api, folder: dir});
    strictEqual(result.reconciled, "applied");
    strictEqual(result.sent, 0, "이미 반영된 것을 또 보냈다");
});

test("🔴 이진 파일은 **조용히 망가지는 대신 거절한다**", async () => {
    // 실측: 10바이트 PNG 머리가 `toString("utf8")` 왕복에서 16바이트가 됐다. 망가진 채 올라가면
    // 사이트가 깨진 이미지를 서빙하고 원인은 아무 데도 안 보인다.
    const s = server();
    const dir = await site({}, {});
    await writeFile(join(dir, "그림.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]));
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_NOT_TEXT");
        match(e.message, /그림\.png/);
        match(e.humanMessage, /콘솔에서 소스를 통째로/, "탈출구를 안 알려 준다");
        return true;
    });
    strictEqual(s.seen.length, 0, "망가진 것을 보냈다");
});

test("한글·이모지·CRLF 는 그대로 간다 — 조임 실수로 정상 소스를 세우지 않는다", async () => {
    const s = server();
    const body = "// 한글 주석 🎉\r\nexport const x = \"값\";\r\n";
    const dir = await site({"a.tsx": body}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    const result = await pushSiteSource({api: s.api, folder: dir});
    strictEqual(result.sent, 1);
    strictEqual((s.seen[0] as Array<{content?: string}>)[0]?.content, body, "내용이 달라졌다");
});

test("🔴 UTF-8 이 아닌 «텍스트»도 거절한다 — 널 바이트 어림으로는 못 잡는다", async () => {
    // EUC-KR 로 저장된 옛 소스. 널 바이트가 없어 어림 판정은 통과시키고, 왕복하면 주석이 깨진다.
    const s = server();
    const dir = await site({}, {});
    await writeFile(join(dir, "옛소스.js"), Buffer.from([0x2f, 0x2f, 0x20, 0xc7, 0xd1, 0xb1, 0xdb, 0x0a]));
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_NOT_TEXT");
        return true;
    });
});

test("🔴 작업본의 바로가기는 안 올린다 — 그 내용은 폴더 밖 것이다", async () => {
    const s = server();
    const dir = await site({"a.tsx": "가"}, {files: {"a.tsx": {sha256: sha("가"), bytes: 1}}});
    const outside = join(dir, "..", "바깥비밀.txt");
    await writeFile(outside, "폴더 밖 비밀");
    await symlink(outside, join(dir, "훔친것.tsx"));
    const result = await pushSiteSource({api: s.api, folder: dir});
    strictEqual(result.sent, 0, `바로가기를 올렸다: ${JSON.stringify(s.seen)}`);
});

test("배제 대상은 애초에 안 보낸다 — 서버 거절을 기다리지 않는다", async () => {
    const s = server();
    const dir = await site({".env": "S=1", "node_modules/p/i.js": "벤더", "a.tsx": "가"}, {});
    await pushSiteSource({api: s.api, folder: dir});
    deepEqual((s.seen[0] as Array<{path: string}>).map((e) => e.path), ["a.tsx"]);
});

test("🔴 파일 하나가 상한을 넘으면 **어느 파일인지** 말하고 멈춘다", async () => {
    const s = server();
    const dir = await site({}, {});
    await writeFile(join(dir, "큰것.tsx"), "가".repeat(MAX_PUSH_FILE_BYTES));
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_TOO_LARGE");
        match(e.message, /큰것\.tsx/, `어느 파일인지 안 말한다: ${e.message}`);
        return true;
    });
    strictEqual(s.seen.length, 0, "상한을 넘겼는데 보냈다");
});

test("🔴 한 번에 보낼 총량 상한이 선다 — 나누지 않는다", async () => {
    const s = server();
    const dir = await site({}, {});
    // 파일당 상한은 넘지 않으면서 총량만 넘긴다.
    const each = 900 * 1024;
    for (let i = 0; i < 20; i += 1) await writeFile(join(dir, `f${i}.tsx`), "가".repeat(each / 3));
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_TOO_LARGE");
        match(e.humanMessage, /나눠 보내면.*반쪽/, "왜 안 나누는지 말하지 않는다");
        return true;
    });
    strictEqual(s.seen.length, 0);
});

test("🔴 개수 상한이 선다 — 서버 거절을 기다리지 않는다", async () => {
    const s = server();
    const dir = await site({}, {});
    for (let i = 0; i <= MAX_PUSH_ENTRIES; i += 1) await writeFile(join(dir, `f${i}.tsx`), "가");
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_TOO_LARGE");
        match(e.message, new RegExp(`${MAX_PUSH_ENTRIES}개`));
        return true;
    });
    strictEqual(s.seen.length, 0, "상한을 넘겼는데 보냈다");
});

test("상한 바로 아래는 통과한다 — 조임 실수로 정상 요청을 세우지 않는다", async () => {
    const s = server();
    const dir = await site({}, {});
    for (let i = 0; i < MAX_PUSH_ENTRIES; i += 1) await writeFile(join(dir, `f${i}.tsx`), "가");
    strictEqual((await pushSiteSource({api: s.api, folder: dir})).sent, MAX_PUSH_ENTRIES);
});

test("🔴 요청 총량이 상한 안이다 — 사유가 겹쳐도 갈래마다 세지 않는다", async () => {
    // 실측으로 잡힌 것: 배제 + 선행조건이 겹치면 갈래마다 한 번씩이라 **세 번**이 나갔는데
    // 주석은 「재시도는 한 번」이라 적고 있었다. 지금은 상한이 반복문 하나에 있다.
    const s = server({
        replies: Array.from({length: 10}, (_, i) =>
            i % 2 === 0
                ? {throw: rejected(NOT_ACCEPTED, ["dist/x.js"])}
                : {throw: rejected("DRAFT_PRECONDITION_FAILED", ["a.tsx"])},
        ),
    });
    const dir = await site({"dist/x.js": "가", "a.tsx": "나", "b.tsx": "다"}, {
        files: {
            "dist/x.js": {sha256: sha("옛"), bytes: 1},
            "a.tsx": {sha256: sha("옛"), bytes: 1},
            "b.tsx": {sha256: sha("옛"), bytes: 1},
        },
    });
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), DevtoolsError);
    ok(s.seen.length <= MAX_PUSH_ATTEMPTS, `요청이 ${s.seen.length}번 나갔다(상한 ${MAX_PUSH_ATTEMPTS})`);
});

test("🔴 서버가 **우리 계획에 없는** 경로를 대면 그것을 보고하지 않는다", async () => {
    // 실측: `../../etc/passwd` 가 「우리가 뺀 경로」 목록에 그대로 떴다. 우리 출력이 남의 글이 된다.
    const s = server({replies: [{throw: rejected(NOT_ACCEPTED, ["../../etc/passwd", "없는것.tsx"])}]});
    const dir = await site({"a.tsx": "새것"}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        // 서버의 원래 거절을 그대로 올린다 — 「우리가 뺐다」로 위장하지 않는다.
        strictEqual(e.serverCode, NOT_ACCEPTED);
        return true;
    });
    strictEqual(s.seen.length, 1, "짚어 준 경로가 하나도 우리 것이 아닌데 다시 보냈다");
});

test("서버가 **일부만** 우리 것을 대면 그것만 빼고 보낸다", async () => {
    const s = server({
        replies: [{throw: rejected(NOT_ACCEPTED, ["dist/x.js", "../남의것"])}, {generation: "G2"}],
    });
    const dir = await site({"dist/x.js": "가", "a.tsx": "나"}, {
        files: {"dist/x.js": {sha256: sha("옛"), bytes: 1}, "a.tsx": {sha256: sha("옛"), bytes: 1}},
    });
    const result = await pushSiteSource({api: s.api, folder: dir});
    deepEqual(result.droppedByServer, ["dist/x.js"], "우리 것이 아닌 경로가 보고에 섞였다");
});

test("🔴 같은 사유가 계속 와도 상한에서 멈춘다 — 상한이 없으면 서버에 무한히 매달린다", async () => {
    const s = server({
        replies: Array.from({length: 20}, () => ({throw: rejected("DRAFT_PRECONDITION_FAILED", ["a.tsx"])})),
    });
    const dir = await site({"a.tsx": "새것"}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.serverCode, "DRAFT_PRECONDITION_FAILED");
        return true;
    });
    strictEqual(s.seen.length, MAX_PUSH_ATTEMPTS, `요청이 ${s.seen.length}번 나갔다(상한 ${MAX_PUSH_ATTEMPTS})`);
});

/**
 * 픽스처용 가짜 자격증명 — **조각으로 조립한다.**
 *
 * ⚠ 통짜로 적으면 자격증명 검사기가 이 파일을 잡는다. 그때 **경로를 면제하면 안 된다** —
 *   면제는 구멍이고, 그 파일에 진짜 키가 들어오는 날 아무도 못 본다(검사기 자신이 적어 둔 처방).
 */
const fakeAwsKey = ["AKIA", "IOSFODNN", "7EXAMPLE"].join("");
const fakePreviewKey = ["oqsk", "_live_", "AbCdEfGhIjKlMnOpQrStUv"].join("");

test("🔴 `.env.example` 이라는 **폴더**가 서식 예외를 못 받는다", async () => {
    // 심의 실측: 이름 판정이 앞 조각을 전부 파일로 물어, 그 폴더 아래 라이브 열쇠가 그대로 실렸다.
    const s = server();
    const dir = await site({".env.sample/keys.txt": `AWS=${fakeAwsKey}`, "a.tsx": "가"}, {});
    await pushSiteSource({api: s.api, folder: dir});
    deepEqual((s.seen[0] as Array<{path: string}>).map((e) => e.path), ["a.tsx"], "폴더 아래 비밀이 나갔다");
});

test("🔴 값이 채워진 서식은 **거절한다** — 조용히 빼면 「올렸는데 안 바뀐다」가 된다", async () => {
    const s = server();
    const dir = await site({".env.example": `ZALKERA_PREVIEW_KEY=${fakePreviewKey}`}, {});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_SECRET_TEMPLATE");
        match(e.message, /\.env\.example/);
        match(e.humanMessage, /값을 비워 두어야|환경변수 화면/, "무엇을 하면 되는지 안 말한다");
        return true;
    });
    strictEqual(s.seen.length, 0, "비밀이 회선을 지났다");
});

test("값이 없는 서식은 그대로 올라간다 — 조임 실수로 정상 서식을 세우지 않는다", async () => {
    const s = server();
    const dir = await site({".env.example": "ZALKERA_PREVIEW_KEY=\nDATABASE_URL=\n"}, {});
    const result = await pushSiteSource({api: s.api, folder: dir});
    strictEqual(result.sent, 1);
    deepEqual((s.seen[0] as Array<{path: string}>).map((e) => e.path), [".env.example"]);
});

test("🔴 서식치고 큰 파일은 전제가 깨진 것이다 — 앞부분만 보고 전체를 실으면 안 된다", async () => {
    const s = server();
    const dir = await site({}, {});
    // 스캔 상한(256KB)을 넘기되 앞부분에는 비밀이 없다 — 못 본 뒤쪽에 있을 수 있다.
    await writeFile(join(dir, ".env.example"), `${"# 주석\n".repeat(60000)}KEY=\n`);
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_SECRET_TEMPLATE");
        match(e.message, /너무 큽니다/);
        return true;
    });
});

test("🔴 판이 움직였으면 «같습니다»라고 말하지 않고 멈춘다", async () => {
    // 심의 실측: 이 폴더는 7판이고 남이 9판을 발행했는데, 드래프트가 없으니 보낼 것이 없고
    // 「이 폴더의 내용이 사이트 쪽과 같습니다」가 나갔다. 판 쪽에서 난 거짓 동기화다.
    const s = server({activeRevisionNo: 9});
    const dir = await site({"a.tsx": "가"}, {files: {"a.tsx": {sha256: sha("가"), bytes: 1}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_BASE_MOVED");
        match(e.message, /7판에서 9판으로/);
        match(e.humanMessage, /zalkera pull/, "다음 걸음을 안 알려 준다");
        return true;
    });
    strictEqual(s.seen.length, 0);
});

test("🔴 판이 움직였으면 **보낼 것이 있어도** 멈춘다 — 낡은 기준 위에서 계산한 값이다", async () => {
    const s = server({activeRevisionNo: 9});
    const dir = await site({"a.tsx": "내가-고침"}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_BASE_MOVED");
        return true;
    });
    strictEqual(s.seen.length, 0);
});

test("🔴 켜진 판을 못 읽으면 올리지 않는다 — 「모른다」를 「같다」로 바꾸지 않는다", async () => {
    const s = server({activeRevisionNo: "unreadable"});
    const dir = await site({"a.tsx": "내가-고침"}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "SERVER_UNREADABLE_DRAFT");
        return true;
    });
    strictEqual(s.seen.length, 0);
});

test("판이 그대로면 그냥 돈다 — 조임 실수로 정상 올리기를 세우지 않는다", async () => {
    const s = server({activeRevisionNo: 7});
    const dir = await site({"a.tsx": "내가-고침"}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    strictEqual((await pushSiteSource({api: s.api, folder: dir})).sent, 1);
});

test("🔴 서버가 준 안내·주소가 터미널을 조종하지 못한다", async () => {
    // 심의 실측: 제어문자가 살아 있어 서버가 커서를 올려 방금 찍은 줄을 지우고 다른 문장을
    // 앉힐 수 있었다 — 사용자가 보는 결과가 서버가 고른 문장이 된다.
    const ESC = String.fromCharCode(27);
    const s = server();
    const dir = await site({"a.tsx": "새것"}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    const api = {
        ...(s.api as unknown as Record<string, unknown>),
        editDraft: async () => ({
            generation: "G",
            files: [],
            warning: `${ESC}[2K${ESC}[1A${ESC}[2K올릴 것이 없습니다.`,
            previewUrl: `https://x/${ESC}]0;가짜${String.fromCharCode(7)}`,
        }),
    } as never;
    const result = await pushSiteSource({api, folder: dir});
    const control = /[\u0000-\u001f\u007f]/;
    ok(!control.test(result.warning ?? ""), `제어문자가 살아 있다: ${JSON.stringify(result.warning)}`);
    ok(!control.test(result.previewUrl ?? ""), `제어문자가 살아 있다: ${JSON.stringify(result.previewUrl)}`);
    ok((result.warning ?? "").includes("올릴 것이 없습니다"), "내용까지 지웠다");
});

test("🔴 두 번째 요청이 **안 나갔으면** 「다시 보냈습니다」라고 하지 않는다", async () => {
    // 선행조건 거절 뒤 다시 읽으니 남이 이미 같은 내용을 올려 놓아 보낼 것이 없어진 갈래.
    let reads = 0;
    const seen: unknown[] = [];
    const api = {
        tenantCode: () => "acme",
        listRevisions: async () => [{revisionNo: 7, status: "READY", isActive: true}],
        draftFiles: async () => {
            reads += 1;
            return reads === 1
                ? {generation: "G1", changed: [], deleted: [], baseRevisionNo: 7, strandedOnOldRevision: false}
                : {
                      generation: "G2",
                      changed: [{path: "a.tsx", sha256: sha("새것")}],
                      deleted: [],
                      baseRevisionNo: 7,
                      strandedOnOldRevision: false,
                  };
        },
        editDraft: async (e: unknown) => {
            seen.push(e);
            throw rejected("DRAFT_PRECONDITION_FAILED", ["a.tsx"]);
        },
    } as never;
    const dir = await site({"a.tsx": "새것"}, {files: {"a.tsx": {sha256: sha("옛것"), bytes: 3}}});
    const result = await pushSiteSource({api, folder: dir});
    strictEqual(seen.length, 1, "두 번 보냈다");
    strictEqual(result.retriedAfterConflict, false, "안 보냈는데 「다시 보냈습니다」라고 말한다");
    strictEqual(result.sent, 0);
});

test("🔴 판 이동 거절이 **실제 출구**를 댄다 — 두 문이 서로를 가리키면 사람이 갇힌다", async () => {
    // 실측: push 는 「pull 먼저」, pull 은 「push 먼저」라고 서로를 가리켰다. 유일한 출구인
    // `--discard-local` 은 어느 쪽도 그 상황에서 대 주지 않았다.
    const s = server({activeRevisionNo: 9});
    const dir = await site({"a.tsx": "내가-고침"}, {files: {"a.tsx": {sha256: sha("판7"), bytes: 3}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_BASE_MOVED");
        match(e.humanMessage, /--discard-local/, `갇히는 안내다: ${e.humanMessage}`);
        // ⚠ `baseline` 을 대면 안 된다 — 그것은 장부만 새 판으로 바꿔 놓고, 그 뒤 push 가
        //   내가 만진 적 없는 파일까지 전부 보낸다.
        ok(!/zalkera baseline/.test(e.humanMessage), `위험한 길을 댔다: ${e.humanMessage}`);
        return true;
    });
});

test("고친 것이 없으면 그냥 «받으세요»라고 한다 — 필요 없는 경고를 안 붙인다", async () => {
    const s = server({activeRevisionNo: 9});
    const dir = await site({"a.tsx": "판7"}, {files: {"a.tsx": {sha256: sha("판7"), bytes: 3}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        match(e.humanMessage, /zalkera pull/);
        ok(!/--discard-local/.test(e.humanMessage), "버리라는 말을 필요 없이 붙였다");
        return true;
    });
});

test("🔴 상한은 **실제 요청 본문**으로 잰다 — 원본 바이트로 재면 이스케이프 몫을 못 본다", async () => {
    // 심의 실측: 따옴표가 잦은 파일은 원본 3MiB 가 본문 4.65MiB 가 되어 4MiB 필터에 걸린다.
    // 그러면 우리 문면 대신 **본문 없는 413** 이 나가고 사람은 「HTTP 413」만 본다.
    const s = server();
    const dir = await site({}, {});
    // 원본으로는 상한 아래(3.0MiB)지만 JSON 이스케이프로 본문이 배가 된다.
    const quoted = '"'.repeat(3.0 * 1024 * 1024);
    await writeFile(join(dir, "따옴표.csv"), quoted);
    // 파일 하나 상한(1MiB)에 먼저 걸리지 않게 여러 개로 쪼갠다.
    await rm(join(dir, "따옴표.csv"));
    for (let i = 0; i < 4; i += 1) await writeFile(join(dir, `q${i}.csv`), '"'.repeat(750 * 1024));
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_TOO_LARGE", `실제 본문을 안 쟀다: ${(e as DevtoolsError).code}`);
        return true;
    });
    strictEqual(s.seen.length, 0, "413 이 될 것을 보냈다");
});

test("상한 아래는 통과한다 — 조임 실수로 정상 올리기를 세우지 않는다", async () => {
    const s = server();
    const dir = await site({}, {});
    // 이스케이프가 없는 평범한 소스 3MiB — 본문도 그만큼이라 통과해야 한다.
    for (let i = 0; i < 4; i += 1) await writeFile(join(dir, `f${i}.tsx`), "가".repeat(250 * 1024));
    strictEqual((await pushSiteSource({api: s.api, folder: dir})).sent, 4);
});

test("🔴 고치고 → 올리고 → 또 고치고 → 올리는 루프가 돈다 — 두 회차를 실제로 잰다", async () => {
    // 심의 실측: 두 번째에서 `PUSH_WOULD_REVERT` 로 막혔다. 계획 시험만으로는 못 잡는 자리다 —
    // 장부의 `mine` 과 세대가 회차 사이에 옳게 이어져야 참이 된다.
    const dir = await site({"a.tsx": "내용1"}, {files: {"a.tsx": {sha256: sha("판7"), bytes: 3}}});
    let changed: Array<{path: string; sha256: string}> = [];
    let gen: string | null = null;
    let round = 0;
    const api = {
        tenantCode: () => "acme",
        listRevisions: async () => [{revisionNo: 7, status: "READY", isActive: true}],
        draftFiles: async () => ({
            generation: gen, changed, deleted: [], baseRevisionNo: gen ? 7 : null, strandedOnOldRevision: false,
        }),
        editDraft: async (edits: Array<{path: string; content?: string; remove?: boolean}>) => {
            round += 1;
            gen = `G${round}`;
            for (const e of edits) {
                changed = changed.filter((r) => r.path !== e.path);
                if (!e.remove) changed.push({path: e.path, sha256: sha(e.content!)});
            }
            return {generation: gen, files: [], warning: null, previewUrl: null};
        },
    } as never;
    strictEqual((await pushSiteSource({api, folder: dir})).sent, 1);
    await writeFile(join(dir, "a.tsx"), "내용2");
    strictEqual((await pushSiteSource({api, folder: dir})).sent, 1, "내가 올린 것을 내가 못 고쳤다");
    await writeFile(join(dir, "a.tsx"), "내용3");
    strictEqual((await pushSiteSource({api, folder: dir})).sent, 1, "세 번째도 막히면 안 된다");
});

test("🔴 세대가 갈렸으면 `mine` 이 소유를 증언 못 한다 — 지난 세계의 기록이다", async () => {
    // 남이 되돌리고 새로 편집하면 세대가 갈린다. 그때 내 장부의 `mine` 은 아무것도 못 말하는데,
    // 그대로 믿으면 남의 새 편집을 「내가 올린 것」이라 여겨 조용히 덮는다.
    const s = server({
        draft: {changed: [{path: "a.tsx", sha256: "남이-새로-올린것"}], generation: "G-남의것"},
    });
    const dir = await site({"a.tsx": "내가-고침"}, {
        files: {"a.tsx": {sha256: sha("판7"), bytes: 3}},
        // 내 장부는 옛 세대에서 그 경로를 올렸다고 적고 있다.
        server: {generation: "G-내것"},
        mine: {"a.tsx": "남이-새로-올린것"},
    });
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_WOULD_REVERT", "지난 세대의 소유 기록을 믿었다");
        return true;
    });
    strictEqual(s.seen.length, 0);
});

test("세대가 같으면 증언이 선다", async () => {
    const s = server({draft: {changed: [{path: "a.tsx", sha256: "내가-올린것"}], generation: "G1"}});
    const dir = await site({"a.tsx": "또-고침"}, {
        files: {"a.tsx": {sha256: sha("판7"), bytes: 3}},
        server: {generation: "G1"},
        mine: {"a.tsx": "내가-올린것"},
    });
    strictEqual((await pushSiteSource({api: s.api, folder: dir})).sent, 1);
});

test("🔴 «모양이 안 맞는다」는 배제가 아니다 — 빼면 그 파일이 조용히 안 올라간다", async () => {
    // 심의 실측: 경합(「기준 해시를 안 줬다」)도 경로를 싣는데, 그것을 「배제」로 읽어
    // 그 파일을 빼고 「올렸습니다」를 찍었다. 사유가 다르면 처분도 다르다.
    let reads = 0;
    const seen: unknown[] = [];
    const api = {
        tenantCode: () => "acme",
        listRevisions: async () => [{revisionNo: 7, status: "READY", isActive: true}],
        draftFiles: async () => {
            reads += 1;
            return reads === 1
                ? {generation: null, changed: [], deleted: [], baseRevisionNo: null, strandedOnOldRevision: false}
                : {
                      generation: "G2",
                      changed: [{path: "새것.tsx", sha256: "남이-만듦"}],
                      deleted: [],
                      baseRevisionNo: 7,
                      strandedOnOldRevision: false,
                  };
        },
        editDraft: async (e: unknown) => {
            seen.push(e);
            if (seen.length === 1) throw rejected(SHAPE_STALE, ["새것.tsx"]);
            return {generation: "G3", files: [], warning: null, previewUrl: null};
        },
    } as never;
    const dir = await site({"새것.tsx": "내가-만듦"}, {});
    // 재계산하니 남이 그 경로를 만들어 뒀다 → 안 본 편집이므로 거절이 옳다.
    await rejects(() => pushSiteSource({api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_WOULD_REVERT", `경합을 배제로 읽었다: ${(e as DevtoolsError).code}`);
        return true;
    });
    strictEqual(seen.length, 1, "경합인데 빼고 다시 보냈다");
});

test("🔴 판이 **되돌아가도** 멈춘다 — 되돌리기도 움직임이다", async () => {
    // 심의 실측: 가드가 `>` 라 7판 폴더 + 5판 활성이 그대로 통과하고
    // 「이 폴더의 내용이 사이트 쪽과 같습니다」가 나갔다.
    const s = server({activeRevisionNo: 5});
    const dir = await site({"a.tsx": "판7"}, {files: {"a.tsx": {sha256: sha("판7"), bytes: 3}}});
    await rejects(() => pushSiteSource({api: s.api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PUSH_BASE_MOVED");
        return true;
    });
    strictEqual(s.seen.length, 0);
});

test("🔴 켜진 판이 하나도 없으면 「잠시 뒤 다시」라고 하지 않는다 — 그 말이 거짓인 상태다", async () => {
    const s = server({activeRevisionNo: -1});
    const api = {...(s.api as unknown as Record<string, unknown>),
        listRevisions: async () => [{revisionNo: 9, status: "FAILED", isActive: false}]} as never;
    const dir = await site({"a.tsx": "가"}, {files: {"a.tsx": {sha256: sha("옛"), bytes: 1}}});
    await rejects(() => pushSiteSource({api, folder: dir}), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        match(e.message, /켜져 있는 버전이 없습니다/);
        match(e.humanMessage, /콘솔에서 어떤 버전을 켤지/, "다음 걸음을 안 알려 준다");
        return true;
    });
});
