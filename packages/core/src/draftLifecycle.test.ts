import {deepEqual, match, ok, rejects, strictEqual} from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {test} from "node:test";
import {gzipSync} from "node:zlib";
import {discardDraft, publishDraft, rollbackRevision} from "./draftLifecycle.ts";
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
    revisions?: Array<{revisionNo: number; status: string; isActive: boolean}>;
    tar?: Buffer;
    draft?: unknown;
    publish?: unknown | Error;
    activate?: {pointerMoved?: boolean; discardedDraft?: boolean; discardedPendingChanges?: number};
    sourceFails?: boolean;
}
function server(opts: Fake = {}) {
    const calls: string[] = [];
    const payload = opts.tar ?? tarGz({"a.tsx": "새 판"});
    return {
        calls,
        api: {
            tenantCode: () => "acme",
            listRevisions: async () =>
                opts.revisions ?? [{revisionNo: opts.active ?? 9, status: "READY", isActive: true}],
            draftFiles: async () =>
                opts.draft ?? {generation: "G1", changed: [], deleted: [], baseRevisionNo: 8, strandedOnOldRevision: true},
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
                return opts.activate ?? {pointerMoved: true, discardedDraft: discard, discardedPendingChanges: 0};
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

test("되돌리기는 대상 판으로 장부를 **교체**하고 작업본은 안 건드린다", async () => {
    const s = server({active: 9, tar: tarGz({"a.tsx": "5판 내용"})});
    const dir = await site({"a.tsx": "내가-고침"});
    const out = await rollbackRevision({api: s.api, folder: dir, fetchImpl: s.fetchImpl, revisionNo: 5});
    ok(s.calls.includes("activate:5:false"));
    strictEqual((await readLedger(dir))?.base.revisionNo, 5);
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
    await discardDraft({api: s.api, folder: dir});
    ok(s.calls.includes("activate:9:true"), `엉뚱한 판을 켰다: ${s.calls}`);
});

test("버린 뒤 세대와 `mine` 을 비운다 · 판 기록은 그대로다", async () => {
    const s = server({active: 9});
    const dir = await site({"a.tsx": "가"}, {mine: {"a.tsx": sha("올린것")}, base: {revisionNo: 9, tarSha256: "a".repeat(64)}});
    await discardDraft({api: s.api, folder: dir});
    const ledger = await readLedger(dir);
    strictEqual(ledger?.server, null);
    deepEqual(ledger?.mine, {});
    strictEqual(ledger?.base.revisionNo, 9, "판 기록을 건드렸다");
});

test("🔴 버리기가 **무엇을 버리는지** 판정을 함께 돌려준다 — 부르는 쪽이 그것으로 확인을 가른다", async () => {
    const s = server({
        active: 9,
        draft: {generation: "G1", changed: [{path: "남이-고침.tsx", sha256: "x"}], deleted: [], baseRevisionNo: 8, strandedOnOldRevision: true},
    });
    const dir = await site({"a.tsx": "가"}, {mine: {}});
    const out = await discardDraft({api: s.api, folder: dir});
    strictEqual(out.plan.verdict, "elsewhere");
    deepEqual(out.plan.paths, ["남이-고침.tsx"]);
});
