import {deepEqual, match, ok, rejects, strictEqual} from "node:assert/strict";
import {createHash} from "node:crypto";
import {link, mkdir, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {basename, join} from "node:path";
import {test} from "node:test";
import {gzipSync} from "node:zlib";
import {DevtoolsError} from "./errors.ts";
import {pullSiteSource, readLedger, SAVED_SUFFIX} from "./pull.ts";
import {rebuildBaseline} from "./baseline.ts";
import {SYNC_LEDGER_FORMAT, SYNC_LEDGER_PATH, serializeSyncLedger, type SyncLedger} from "./syncLedger.ts";
import {SOURCE_MARK_PATH, parseSourceMark} from "./localMark.ts";
import {tempDir} from "./testing/tempDir.ts";

function header(name: string, size: number, type = "0"): Buffer {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write(type, 156);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
}
/** @param extra `[이름, tar 타입]` — 해제기가 다룰 수 없는 항목을 **뒤에** 달 때 쓴다. */
function tarGz(files: Record<string, string>, extra: ReadonlyArray<readonly [string, string, string]> = []): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, body] of Object.entries(files)) {
        const data = Buffer.from(body, "utf8");
        blocks.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    for (const [name, type] of extra) blocks.push(header(name, 0, type));
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

test("git 이 장부를 안 나르게 한다 — 남의 기계 `mine` 이 넘어오면 거짓 상태가 된다", async () => {
    const dir = await site({});
    await mkdir(join(dir, ".git"), {recursive: true});
    await run(dir, tarGz({"a.tsx": "가"}));
    const exclude = join(dir, ".git", "info", "exclude");
    match(await readFile(exclude, "utf8"), /^\.zalkera\/sync\.json$/m);
    await run(dir, tarGz({"a.tsx": "가"}));
    strictEqual((await readFile(exclude, "utf8")).match(/sync\.json/g)?.length, 1, "두 번 적혔다");
});

test("🔴 `.gitignore` 를 안 건드린다 — 판이 싣고 오는 파일이라 손대면 다음 받기가 영구 충돌한다", async () => {
    // 실측으로 잡힌 결함: 서버가 `.gitignore` 를 실어 오는데 우리가 한 줄 붙여, 두 번째 받기가
    // **고객이 만진 적 없는 파일** 이름을 대며 거절했다.
    const dir = await site({});
    await mkdir(join(dir, ".git"), {recursive: true});
    const payload = tarGz({"a.tsx": "가", ".gitignore": "node_modules\n"});
    await run(dir, payload);
    strictEqual(await readFile(join(dir, ".gitignore"), "utf8"), "node_modules\n", "판의 파일에 손댔다");
    const again = await run(dir, payload);
    strictEqual(again.unchanged, 2, "같은 판을 다시 받는데 뭔가가 달라져 있었다");
});

test("git 폴더가 없으면 아무 파일도 안 만든다 — 없는 자리에 만들면 다음 판에 실려 나간다", async () => {
    const dir = await site({});
    await run(dir, tarGz({"a.tsx": "가"}));
    deepEqual((await readdir(dir)).sort(), [".zalkera", "a.tsx"], "안 만들기로 한 파일이 생겼다");
});

test("🔴 치워 두는 자리는 **실경로**의 형제다 — 링크로 열린 폴더는 부모가 다른 파일시스템일 수 있다", async () => {
    const dir = await site({"a.tsx": "내가-고침"}, {"a.tsx": "가"});
    const link = join(dir, "..", `${basename(dir)}-링크`);
    await symlink(dir, link);
    const result = await run(link, tarGz({"a.tsx": "서버것"}), {discardLocal: true});
    ok(result.savedTo!.startsWith(`${dir}${SAVED_SUFFIX}`), `링크 이름으로 잡았다: ${result.savedTo}`);
    strictEqual(await readFile(join(result.savedTo!, "a.tsx"), "utf8"), "내가-고침");
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

test("🔴 하드링크에 쓰지 않는다 — `lstat` 는 하드링크를 못 보고 맨 쓰기는 대상에 그대로 간다", async () => {
    const dir = await site({}, {"app.ts": "원본"});
    const victim = join(dir, "..", `${basename(dir)}-피해자.txt`);
    await writeFile(victim, "원본");
    await link(victim, join(dir, "app.ts"));
    const result = await run(dir, tarGz({"app.ts": "서버가-덮었다"}));
    strictEqual(await readFile(victim, "utf8"), "원본", "폴더 밖 파일이 서버 내용으로 교체됐다");
    strictEqual(await readFile(join(dir, "app.ts"), "utf8"), "서버가-덮었다");
    strictEqual(result.written, 1);
});

test("🔴 부모 조각이 바로가기여도 **쓰기 전에** 멈춘다 — 잎만 보면 통과한다", async () => {
    const dir = await site({}, {"먼저.ts": "가"});
    await writeFile(join(dir, "먼저.ts"), "가");
    const outside = join(dir, "..", `${basename(dir)}-바깥`);
    await mkdir(outside, {recursive: true});
    await symlink(outside, join(dir, "app"));
    await rejects(() => run(dir, tarGz({"먼저.ts": "나", "app/victim.ts": "덮어썼다"})), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PULL_WOULD_OVERWRITE", `거절 사유가 다르다: ${e.code}`);
        return true;
    });
    strictEqual(await readFile(join(dir, "먼저.ts"), "utf8"), "가", "거절인데 앞 파일이 이미 바뀌었다");
    strictEqual(await readFile(join(outside, "victim.ts"), "utf8").catch(() => null), null);
});

test("🔴 로컬과 이름이 대소문자만 다르면 거절한다 — 이름을 접는 파일시스템에서 한쪽이 사라진다", async () => {
    const dir = await site({"readme.md": "고객이 쓴 것"});
    await rejects(() => run(dir, tarGz({"README.md": "서버 것"})), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        strictEqual(e.code, "PULL_WOULD_OVERWRITE");
        return true;
    });
    strictEqual(await readFile(join(dir, "readme.md"), "utf8"), "고객이 쓴 것");
});

test("🔴 `.zalkera` 가 바로가기면 장부를 폴더 밖에 안 쓴다 — 그런데 성공을 보고했다", async () => {
    const dir = await site({});
    const outside = join(dir, "..", `${basename(dir)}-바깥`);
    await mkdir(outside, {recursive: true});
    await symlink(outside, join(dir, ".zalkera"));
    const result = await run(dir, tarGz({"a.tsx": "가"}));
    strictEqual(result.ledgerWritten, false, "폴더 밖에 쓰고 성공이라 말했다");
    strictEqual(await readFile(join(outside, "sync.json"), "utf8").catch(() => null), null, "폴더 밖에 장부가 생겼다");
});

test("🔴 치워 둔 삭제도 「지운 것」으로 센다 — 안 세면 한 일과 보고가 어긋난다", async () => {
    const dir = await site({"gone.tsx": "내가-고침", "a.tsx": "가"}, {"gone.tsx": "나", "a.tsx": "가"});
    const result = await run(dir, tarGz({"a.tsx": "가"}), {discardLocal: true});
    strictEqual(result.deleted, 1, "치우면서 없어진 경로를 안 셌다");
    strictEqual(await readFile(join(result.savedTo!, "gone.tsx"), "utf8"), "내가-고침");
});

test("🔴 기준 기록 없이 «이미 파일이 있는» 폴더를 받으면 그 사실을 말한다", async () => {
    // 삭제 전파가 통째로 못 돈다 — 「유일한 방어」가 이 회차에 없었다는 사실을 조용히 넘기면
    // 남은 파일이 다음 올리기에서 되살아난다.
    const dir = await site({"옛것.tsx": "판에 있던 것"});
    const withFiles = await run(dir, tarGz({"a.tsx": "가"}));
    strictEqual(withFiles.deletionsUnknown, true);
    const empty = await site({});
    strictEqual((await run(empty, tarGz({"a.tsx": "가"}))).deletionsUnknown, false, "빈 폴더는 지울 것이 없다");
});

test("🔴 거절 문면이 **없는 명령**을 다음 걸음으로 대지 않는다", async () => {
    const dir = await site({"a.tsx": "내가-고침"}, {"a.tsx": "가"});
    await rejects(() => run(dir, tarGz({"a.tsx": "서버것"})), (e: unknown) => {
        ok(e instanceof DevtoolsError);
        // 있는 동사만 댄다. `publish`·`discard`·`rollback` 은 아직 없다(T3).
        ok(!/zalkera (publish|discard|rollback)/.test(e.humanMessage), `없는 명령을 댔다: ${e.humanMessage}`);
        ok(/zalkera push/.test(e.humanMessage), "작업을 지키는 길을 안 알려 준다");
        ok(/--discard-local/.test(e.humanMessage), "탈출구를 안 알려 준다");
        return true;
    });
});

test("`--verbose` 가 거절 목록에도 닿는다 — 사람이 잘림을 가장 자주 만나는 자리다", async () => {
    const many = Object.fromEntries(Array.from({length: 15}, (_, i) => [`f${i}.tsx`, "가"]));
    const dirty = Object.fromEntries(Object.keys(many).map((p) => [p, "내가-고침"]));
    const dir = await site(dirty, many);
    const catchIt = (opts: Record<string, unknown>) =>
        run(dir, tarGz(Object.fromEntries(Object.keys(many).map((p) => [p, "서버것"]))), opts)
            .then(() => "", (e: DevtoolsError) => e.message);
    ok(/외 5개/.test(await catchIt({})), "기본이 안 잘렸다");
    ok(!/외 5개/.test(await catchIt({listAll: true})), "--verbose 인데 잘렸다");
});

test("🔴 쓰기가 도중에 죽어도 장부는 **옛것 그대로**다 — 이 순서가 재실행의 전제다", async () => {
    // 심의 실측: 종전 시험은 관용 1 만 재고 있었고, `writeLedger` 를 앞으로 옮겨도 전부 초록이었다.
    //
    // ⚠ 죽이는 벡터는 **읽기 훑기가 미리 못 잡는 것**이어야 한다. 아카이브 형상(모르는 형식·벤더·
    //   대소문자 접힘)은 이제 전부 쓰기 전에 걸리므로 그것으로는 이 순서를 못 잰다. 남는 것은
    //   **로컬 상태**에 달린 실패다: 판이 폴더로 쓰려는 자리에 «장부가 모르는» 파일이 이미 있는 경우.
    const dir = await site({"먼저.tsx": "가"}, {"먼저.tsx": "가"});
    await writeFile(join(dir, "app"), "장부가 모르는 파일");
    const before = await readFile(join(dir, SYNC_LEDGER_PATH), "utf8");
    await rejects(() => run(dir, tarGz({"먼저.tsx": "새것", "app/page.tsx": "가"})), DevtoolsError);
    strictEqual(await readFile(join(dir, SYNC_LEDGER_PATH), "utf8"), before, "죽었는데 장부가 새 판을 선언했다");
    // 그리고 사람이 그 파일을 치우면 재실행이 이어받는다 — 이미 옮겨진 것이 스스로를 막지 않는다.
    await rm(join(dir, "app"));
    strictEqual((await run(dir, tarGz({"먼저.tsx": "새것", "app/page.tsx": "가"}))).written, 2);
});

test("🔴 모르는 형식은 **뒤에 달려 있어도** 파일 하나 쓰기 전에 거절한다", async () => {
    // 종전에는 읽기 훑기가 조용히 건너뛰고 해제기만 던져, 그런 항목을 뒤에 단 아카이브가
    // 앞부분을 디스크에 내려놓은 뒤에 죽었다(심의 지적).
    const dir = await site({});
    await rejects(() => run(dir, tarGz({"먼저.tsx": "이것이 남으면 안 된다"}, [["나쁜것", "3", ""]])), DevtoolsError);
    deepEqual(await readdir(dir), [], "거절인데 파일이 남았다");
});

test("🔴 `baseline` 이 «이 폴더는 그 판에 있지 않다»를 말한다 — 안 말하면 다음 push 가 남의 판을 덮는다", async () => {
    // 실측: 만진 것은 1개인데 baseline 뒤 push 가 4개를 보내 그 판의 내용을 되돌렸다.
    // 그 선행조건은 새 매니페스트에서 나오므로 CAS 는 정당하게 통과한다.
    const dir = await site({"a.tsx": "내가-고침", "b.tsx": "판7", "c.tsx": "판7"});
    const payload = tarGz({"a.tsx": "판9", "b.tsx": "판9", "c.tsx": "판9"});
    const result = await rebuildBaseline({api: fakeApi(payload), folder: dir, fetchImpl: serve(payload)} as never);
    deepEqual(result.differing, ["a.tsx", "b.tsx", "c.tsx"], "다른 것을 안 셌다");
});

test("그 판에 있는 폴더는 아무것도 신고하지 않는다 — 조임 실수로 정상 복구를 겁주지 않는다", async () => {
    const dir = await site({"a.tsx": "가", "b.tsx": "나"});
    const payload = tarGz({"a.tsx": "가", "b.tsx": "나"});
    const result = await rebuildBaseline({api: fakeApi(payload), folder: dir, fetchImpl: serve(payload)} as never);
    deepEqual(result.differing, []);
});

test("🔴 `baseline` 도 배제 목록을 지난다 — 안 지나면 다음 push 가 그것들을 **삭제로** 내보낸다", async () => {
    // 심의 실측: 만진 것 0개인데 `removed: 2`. 우리가 안 보는 경로가 장부에만 실려, 작업본에
    // 없으니 「내가 지웠다」로 판정됐다. 같은 비대칭을 `pull` 에서 🔴 로 고쳤는데 이 동사에만 남았다.
    const dir = await site({"a.tsx": "가"});
    const payload = tarGz({
        "a.tsx": "가",
        ".env.example/keys.txt": "AWS=x",
        "apps/web/node_modules/left-pad/index.js": "x",
    });
    const result = await rebuildBaseline({api: fakeApi(payload), folder: dir, fetchImpl: serve(payload)} as never);
    strictEqual(result.files, 1, "배제 경로가 장부에 실렸다");
    deepEqual(result.serverExcluded, [".env.example/keys.txt", "apps/web/node_modules/left-pad/index.js"]);
    deepEqual(Object.keys((await readLedger(dir))?.files ?? {}), ["a.tsx"]);
});

test("🔴 받기가 **소속 표식**도 남긴다 — 장부가 유일한 소속 기록이면 잊는 순간 폴더가 막힌다", async () => {
    // 실측: 발행이 새 매니페스트를 못 읽어 장부를 잊자 폴더가 소속까지 잃었고, `--site` 를 손으로
    // 붙이지 않으면 복구 동사(`baseline`)조차 못 돌았다 — 모든 동사가 막혔다.
    const dir = await site({});
    await run(dir, tarGz({"a.tsx": "가"}));
    const mark = parseSourceMark(await readFile(join(dir, SOURCE_MARK_PATH), "utf8").catch(() => null));
    strictEqual(mark?.tenant, "acme");
    strictEqual(mark && "revisionNo" in mark ? mark.revisionNo : null, 7);
});

test("🔴 `baseline` 도 소속 표식을 남긴다 — 복구 동사라 특히 그렇다", async () => {
    const dir = await site({});
    const payload = tarGz({"a.tsx": "가"});
    await rebuildBaseline({api: fakeApi(payload), folder: dir, fetchImpl: serve(payload)} as never);
    const mark = parseSourceMark(await readFile(join(dir, SOURCE_MARK_PATH), "utf8").catch(() => null));
    strictEqual(mark?.tenant, "acme");
});

test("표식을 못 써도 받기는 성공이다 — 파일은 이미 새 판이다", async () => {
    const dir = await site({});
    // `.zalkera` 를 링크로 만들어 표식 쓰기를 막는다(장부 쓰기도 함께 막힌다).
    const outside = join(dir, "..", `${basename(dir)}-바깥`);
    await mkdir(outside, {recursive: true});
    await symlink(outside, join(dir, ".zalkera"));
    const result = await run(dir, tarGz({"a.tsx": "가"}));
    strictEqual(result.revisionNo, 7, "표식을 못 써서 받기가 실패했다");
});
