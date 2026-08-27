import {deepEqual, match, ok, rejects, strictEqual} from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, readdir, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {test} from "node:test";
import {gzipSync} from "node:zlib";
import {DevtoolsError} from "./errors.ts";
import {pullSiteSource, readLedger, SAVED_SUFFIX} from "./pull.ts";
import {rebuildBaseline} from "./baseline.ts";
import {SYNC_LEDGER_FORMAT, SYNC_LEDGER_PATH, serializeSyncLedger, type SyncLedger} from "./syncLedger.ts";
import {tempDir} from "./testing/tempDir.ts";

function header(name: string, size: number): Buffer {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
}
function tarGz(files: Record<string, string>): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, body] of Object.entries(files)) {
        const data = Buffer.from(body, "utf8");
        blocks.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fakeApi(payload: Buffer, draft?: {generation: string | null} | "unreadable") {
    return {
        tenantCode: () => "acme",
        listRevisions: async () => [{revisionNo: 7, status: "READY", isActive: true}],
        sourceUrl: async () => ({url: "http://127.0.0.1:1/s.tar.gz", sha256: createHash("sha256").update(payload).digest("hex")}),
        draftFiles: async () => {
            if (draft === "unreadable") throw new Error("서버 안 됨");
            return {generation: draft?.generation ?? null, changed: [], deleted: [], baseRevisionNo: 7, strandedOnOldRevision: false};
        },
    } as never;
}
const serve = (payload: Buffer) => (async () => new Response(payload, {status: 200})) as never;

/** 폴더를 세우고, 원하면 장부까지 앉힌다. */
async function site(files: Record<string, string>, ledgerFiles?: Record<string, string>) {
    const dir = await tempDir("zalkera-pull-");
    for (const [path, body] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), {recursive: true});
        await writeFile(join(dir, path), body);
    }
    if (ledgerFiles) {
        const ledger: SyncLedger = {
            format: SYNC_LEDGER_FORMAT, tenant: "acme",
            base: {revisionNo: 6, tarSha256: "a".repeat(64)},
            files: Object.fromEntries(Object.entries(ledgerFiles).map(([p, b]) => [p, {sha256: sha(b), bytes: b.length}])),
            server: null, mine: {}, pulledAt: "2026-08-01T00:00:00.000Z", pushedAt: null,
        };
        await mkdir(join(dir, ".zalkera"), {recursive: true});
        await writeFile(join(dir, SYNC_LEDGER_PATH), serializeSyncLedger(ledger));
    }
    return dir;
}
const run = (dir: string, payload: Buffer, extra: Record<string, unknown> = {}) =>
    pullSiteSource({api: fakeApi(payload), folder: dir, fetchImpl: serve(payload), ...extra} as never);

test("🔴 서버가 지운 파일이 로컬에서도 지워진다 — 안 지우면 다음 push 가 되살린다", async () => {
    const dir = await site({"app/page.tsx": "가", "app/gone.tsx": "나"}, {"app/page.tsx": "가", "app/gone.tsx": "나"});
    const result = await run(dir, tarGz({"app/page.tsx": "가"}));
    strictEqual(result.deleted, 1);
    strictEqual(await readFile(join(dir, "app", "gone.tsx"), "utf8").catch(() => null), null, "지워진 파일이 남았다");
    strictEqual(await readFile(join(dir, "app", "page.tsx"), "utf8"), "가");
});

test("🔴 순수 로컬 파일은 무간섭 — 받기가 내 메모를 지우지 않는다", async () => {
    const dir = await site({"app/page.tsx": "가", "내메모.txt": "안 지워야 함"}, {"app/page.tsx": "가"});
    const result = await run(dir, tarGz({"app/page.tsx": "나"}));
    strictEqual(result.untracked, 1);
    strictEqual(await readFile(join(dir, "내메모.txt"), "utf8"), "안 지워야 함");
    strictEqual(await readFile(join(dir, "app", "page.tsx"), "utf8"), "나", "판이 아는 파일이 안 바뀌었다");
});

test("🔴 충돌이면 **아무것도 안 한다** — 폴더가 부르기 전과 같다", async () => {
    const dir = await site({"app/page.tsx": "내가-고침", "app/other.tsx": "나"}, {"app/page.tsx": "가", "app/other.tsx": "나"});
    const before = JSON.stringify(await readdir(dir, {recursive: true}));
    await rejects(() => run(dir, tarGz({"app/page.tsx": "서버것", "app/other.tsx": "새것", "app/new.tsx": "신설"})), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PULL_WOULD_OVERWRITE");
        match(e.message, /1개/);
        return true;
    });
    strictEqual(await readFile(join(dir, "app", "page.tsx"), "utf8"), "내가-고침");
    strictEqual(await readFile(join(dir, "app", "other.tsx"), "utf8"), "나", "거절인데 다른 파일이 바뀌었다");
    strictEqual(await readFile(join(dir, "app", "new.tsx"), "utf8").catch(() => null), null, "거절인데 신설이 써졌다");
    strictEqual(before, JSON.stringify(await readdir(dir, {recursive: true})), "거절인데 폴더 구성이 바뀌었다");
});

test("🔴 거절 뒤 장부가 그대로다 — 바뀌면 재실행이 자기 잔해를 순수 로컬로 착각한다", async () => {
    const dir = await site({"a.tsx": "내가-고침"}, {"a.tsx": "가"});
    const before = await readFile(join(dir, SYNC_LEDGER_PATH), "utf8");
    await rejects(() => run(dir, tarGz({"a.tsx": "서버것"})), DevtoolsError);
    strictEqual(await readFile(join(dir, SYNC_LEDGER_PATH), "utf8"), before);
});

test("`--discard-local` 은 버리지 않고 **옆 폴더로 옮긴다**", async () => {
    const dir = await site({"a.tsx": "내가-고침"}, {"a.tsx": "가"});
    const result = await run(dir, tarGz({"a.tsx": "서버것"}), {discardLocal: true});
    ok(result.savedTo?.includes(SAVED_SUFFIX), `치워 둔 자리가 이상하다: ${result.savedTo}`);
    strictEqual(await readFile(join(dir, "a.tsx"), "utf8"), "서버것");
    strictEqual(await readFile(join(result.savedTo!, "a.tsx"), "utf8"), "내가-고침", "고친 내용이 사라졌다");
});

test("🔴 치워 두는 자리는 **형제**다 — 프로젝트 안에 두면 다음 push 에 실린다", async () => {
    const dir = await site({"a.tsx": "내가-고침"}, {"a.tsx": "가"});
    const result = await run(dir, tarGz({"a.tsx": "서버것"}), {discardLocal: true});
    ok(!result.savedTo!.startsWith(dir + "/"), `치워 둔 자리가 프로젝트 안이다: ${result.savedTo}`);
});

test("🔴 장부는 **맨 마지막**에 쓰인다 — 중단된 pull 을 재실행이 이어받는다", async () => {
    const dir = await site({"a.tsx": "가", "b.tsx": "나"}, {"a.tsx": "가", "b.tsx": "나"});
    // 첫 실행이 `a` 만 옮기고 죽은 상태를 손으로 만든다: 장부는 옛것, 작업본은 반쯤.
    await writeFile(join(dir, "a.tsx"), "새것");
    const result = await run(dir, tarGz({"a.tsx": "새것", "b.tsx": "새것도"}));
    strictEqual(result.written, 2, "이미 옮겨 둔 파일이 자기 잔해로 스스로를 막았다");
    strictEqual(await readFile(join(dir, "b.tsx"), "utf8"), "새것도");
});

test("장부가 없어도 받기는 돈다 — 전부 신설로 본다", async () => {
    const dir = await site({});
    const result = await run(dir, tarGz({"app/page.tsx": "가"}));
    strictEqual(result.written, 1);
    const ledger = await readLedger(dir);
    strictEqual(ledger?.base.revisionNo, 7);
    strictEqual(ledger?.tenant, "acme");
    deepEqual(ledger?.mine, {}, "받기가 `mine` 을 안 비웠다");
});

test("🔴 장부를 못 읽는 서버 세대는 `null` 로 남는다 — 옛 세대를 지금 값이라 믿지 않는다", async () => {
    const payload = tarGz({"a.tsx": "가"});
    const dir = await site({});
    await pullSiteSource({api: fakeApi(payload, "unreadable"), folder: dir, fetchImpl: serve(payload)} as never);
    strictEqual((await readLedger(dir))?.server, null);
});

test("서버 세대를 읽었으면 장부가 적는다", async () => {
    const payload = tarGz({"a.tsx": "가"});
    const dir = await site({});
    await pullSiteSource({api: fakeApi(payload, {generation: "G1"}), folder: dir, fetchImpl: serve(payload)} as never);
    strictEqual((await readLedger(dir))?.server?.generation, "G1");
});

test("장부는 `.gitignore` 에 오른다 — 남의 기계 `mine` 이 넘어오면 거짓 상태가 된다", async () => {
    const dir = await site({});
    await run(dir, tarGz({"a.tsx": "가"}));
    match(await readFile(join(dir, ".gitignore"), "utf8"), /^\.zalkera\/sync\.json$/m);
    await run(dir, tarGz({"a.tsx": "가"}));
    strictEqual((await readFile(join(dir, ".gitignore"), "utf8")).match(/sync\.json/g)?.length, 1, "두 번 적혔다");
});

test("`baseline` 은 장부만 고치고 **작업본을 안 건드린다**", async () => {
    const dir = await site({"a.tsx": "내가-고침", "내메모.txt": "그대로"});
    const payload = tarGz({"a.tsx": "서버것"});
    const result = await rebuildBaseline({api: fakeApi(payload), folder: dir, fetchImpl: serve(payload)} as never);
    strictEqual(result.files, 1);
    strictEqual(result.replaced, false);
    strictEqual(await readFile(join(dir, "a.tsx"), "utf8"), "내가-고침", "baseline 이 작업본을 덮었다");
    strictEqual(await readFile(join(dir, "내메모.txt"), "utf8"), "그대로");
    strictEqual((await readLedger(dir))?.files["a.tsx"]?.sha256, sha("서버것"));
});

test("🔴 `baseline` 은 옛 `mine` 을 안 물려받는다", async () => {
    const dir = await site({"a.tsx": "가"}, {"a.tsx": "가"});
    const stale: SyncLedger = {
        ...(await readLedger(dir))!, mine: {"a.tsx": sha("옛것")}, server: {generation: "옛세대"},
    };
    await writeFile(join(dir, SYNC_LEDGER_PATH), serializeSyncLedger(stale));
    const payload = tarGz({"a.tsx": "가"});
    await rebuildBaseline({api: fakeApi(payload), folder: dir, fetchImpl: serve(payload)} as never);
    const after = await readLedger(dir);
    deepEqual(after?.mine, {}, "근거 없는 「내가 올렸다」가 되살아났다");
    strictEqual(after?.server, null, "지난 세대를 지금 값이라 믿었다");
});

test("🔴 치운 자리에 **서버 내용이 들어온다** — 치우기만 하면 그 파일이 통째로 사라진다", async () => {
    const dir = await site({"a.tsx": "내가-고침", "b.tsx": "내가-만듦"}, {"a.tsx": "가"});
    const result = await run(dir, tarGz({"a.tsx": "서버것", "b.tsx": "서버것도"}), {discardLocal: true});
    strictEqual(await readFile(join(dir, "a.tsx"), "utf8"), "서버것", "고친 파일 자리가 비었다");
    strictEqual(await readFile(join(dir, "b.tsx"), "utf8"), "서버것도", "신설 충돌 자리가 비었다");
    strictEqual(result.written, 2);
});

test("🔴 서버가 지운 파일을 내가 고쳐 뒀으면, 치운 뒤 **되살아나지 않는다**", async () => {
    const dir = await site({"a.tsx": "가", "gone.tsx": "내가-고침"}, {"a.tsx": "가", "gone.tsx": "나"});
    const result = await run(dir, tarGz({"a.tsx": "가"}), {discardLocal: true});
    strictEqual(await readFile(join(dir, "gone.tsx"), "utf8").catch(() => null), null, "서버가 지운 파일이 남았다");
    strictEqual(await readFile(join(result.savedTo!, "gone.tsx"), "utf8"), "내가-고침", "고친 내용이 사라졌다");
});

test("🔴 받기는 옛 `mine` 을 **비운다** — 안 비우면 근거 없는 「내가 올렸다」가 남는다", async () => {
    const dir = await site({"a.tsx": "가"}, {"a.tsx": "가"});
    const stale: SyncLedger = {...(await readLedger(dir))!, mine: {"a.tsx": sha("옛것"), "b.tsx": null}};
    await writeFile(join(dir, SYNC_LEDGER_PATH), serializeSyncLedger(stale));
    await run(dir, tarGz({"a.tsx": "가"}));
    deepEqual((await readLedger(dir))?.mine, {});
});

test("🔴 심볼릭 링크는 작업본 파일로 안 센다 — 링크의 sha 는 폴더 밖 내용이다", async () => {
    const dir = await site({"a.tsx": "가"}, {"a.tsx": "가"});
    const outside = join(dir, "..", "바깥.txt");
    await writeFile(outside, "폴더 밖 내용");
    await symlink(outside, join(dir, "링크.tsx"));
    const result = await run(dir, tarGz({"a.tsx": "가"}));
    strictEqual(result.untracked, 0, "링크를 순수 로컬 파일로 셌다");
    strictEqual(await readFile(outside, "utf8"), "폴더 밖 내용");
});

test("🔴 서버가 보낸 `.env` 가 고객의 `.env` 를 **안 덮는다**", async () => {
    // 실측으로 잡힌 결함: 받을 목록에는 있고(배제 안 함) 작업본 목록에는 없어(배제함) **신설**로
    // 판정됐고, `replace` 갈래는 「있는 파일 위에 안 쓴다」를 안 지나 조용히 덮었다.
    const dir = await site({".env": "고객의-진짜-비밀=1", "a.tsx": "가"});
    const result = await run(dir, tarGz({"a.tsx": "가", ".env": "서버가-보낸-것"}));
    strictEqual(await readFile(join(dir, ".env"), "utf8"), "고객의-진짜-비밀=1", "고객 비밀이 교체됐다");
    deepEqual(result.serverExcluded, [".env"], "조용히 빼고 말을 안 했다");
});

test("🔴 배제 경로는 장부에도 안 들어간다 — 들어가면 매 pull 이 그 파일을 다시 쓴다", async () => {
    const dir = await site({});
    await run(dir, tarGz({"a.tsx": "가", ".env": "x", ".git/config": "y"}));
    const files = Object.keys((await readLedger(dir))?.files ?? {});
    deepEqual(files, ["a.tsx"], `배제 경로가 장부에 들어왔다: ${files}`);
});

test("🔴 배제된 것이 「그대로 둔 것」으로도 안 샌다 — 재실행이 멱등이다", async () => {
    const dir = await site({});
    const payload = tarGz({"a.tsx": "가", ".env": "x"});
    await run(dir, payload);
    const again = await run(dir, payload);
    strictEqual(again.written, 0, "같은 판을 또 받았는데 뭔가를 다시 썼다");
    strictEqual(again.unchanged, 1);
});

test("🔴 벤더 트리를 담은 아카이브는 **파일 하나 쓰기 전에** 거절된다", async () => {
    // 종전에는 앞 항목을 디스크에 내려놓은 **뒤** `node_modules` 에서 던졌다(실측).
    const dir = await site({});
    await rejects(
        () => run(dir, tarGz({"먼저.tsx": "이것이 남으면 안 된다", "node_modules/p/i.js": "벤더"})),
        DevtoolsError,
    );
    strictEqual(await readFile(join(dir, "먼저.tsx"), "utf8").catch(() => null), null, "거절인데 파일이 남았다");
    strictEqual(await readLedger(dir), null, "거절인데 장부가 섰다");
});

test("🔴 쓸 자리가 바로가기면 **아무것도 안 하고** 멈춘다 — 재실행해도 안 풀리는 자리다", async () => {
    // ⚠ 계획 단계에서 먼저 끊기면 이 시험은 **아무것도 안 재게 된다.** 그래서 장부를 세워
    //   `정상.tsx` 를 깨끗하게 만들고(=충돌 없음), tar 도 그것을 **먼저** 담는다. 사전검사가 없으면
    //   `정상.tsx` 가 이미 내려앉은 뒤에 링크에서 던진다 — 그 반쯤 적용을 이 시험이 잡는다.
    const dir = await site({"정상.tsx": "가"}, {"정상.tsx": "가"});
    const outside = join(dir, "..", "피해자.txt");
    await writeFile(outside, "원본");
    await symlink(outside, join(dir, "a.tsx"));
    await rejects(() => run(dir, tarGz({"정상.tsx": "나", "a.tsx": "덮어썼다"})), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PULL_WOULD_OVERWRITE", `거절 사유가 다르다: ${e.code}`);
        return true;
    });
    strictEqual(await readFile(outside, "utf8"), "원본", "링크를 타고 폴더 밖을 덮었다");
    strictEqual(await readFile(join(dir, "정상.tsx"), "utf8"), "가", "거절인데 앞 파일이 이미 바뀌었다");
});

test("🔴 대소문자만 다른 짝은 **쓰기 전에** 거절한다 — 다른 기계에서 한쪽이 사라진다", async () => {
    const dir = await site({});
    await rejects(() => run(dir, tarGz({"App.tsx": "하나", "app.tsx": "둘"})), DevtoolsError);
    deepEqual(await readdir(dir), [], "거절인데 파일이 남았다");
});

test("🔴 남의 사이트 장부는 판정에 안 쓴다 — 엉뚱한 이유로 거절하게 된다", async () => {
    const dir = await site({"기밀.tsx": "남의 사이트 파일"}, {"기밀.tsx": "남의 사이트 파일"});
    const stale: SyncLedger = {...(await readLedger(dir))!, tenant: "남의사이트"};
    await writeFile(join(dir, SYNC_LEDGER_PATH), serializeSyncLedger(stale));
    const result = await run(dir, tarGz({"a.tsx": "가"}));
    strictEqual(result.foreignLedger, true, "남의 장부인 것을 못 알아봤다");
    strictEqual(result.untracked, 1, "남의 장부의 파일을 이 판이 아는 것으로 셌다");
    strictEqual(await readFile(join(dir, "기밀.tsx"), "utf8"), "남의 사이트 파일", "남의 파일을 지웠다");
    strictEqual((await readLedger(dir))?.tenant, "acme");
});
