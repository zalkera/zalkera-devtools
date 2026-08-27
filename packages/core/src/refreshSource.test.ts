/**
 * **「서버 판으로 교체」 — 갈아 끼운 뒤 표식이 새 판을 말하는가.**
 *
 * ■ 이 시험이 지키는 것은 «멀리서 나는 고장»이다
 *   표식 갱신을 잊어도 기능은 다 되는 것처럼 보인다 — 소스는 새 판이고 미리보기도 뜬다.
 *   증상은 몇 판 뒤 **「발행마다 남이 올린 판이 있습니다 동의」**로 나타난다. 자기가 방금 받아 온
 *   그 판을 두고. 그 거리 때문에 원인을 못 찾으므로 여기서 직접 문다.
 *
 * ■ 두 걸음 우회로로는 원리상 못 되는 일이다
 *   zip 은 표식을 안 싣고(`EXCLUDED_PATHS`) 「zip 으로 교체」는 옛 표식을 되살린다. 판 번호를
 *   아는 자리는 이 문뿐이다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import { ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { test } from "node:test";
import { refreshSiteSource } from "./fetchSource.ts";
import { SOURCE_MARK_PATH } from "./localMark.ts";
import { tempDir } from "./testing/tempDir.ts";

/** ustar 헤더 한 장 — 형제 `fetchSource.test.ts` 와 같은 형상이다. */
function header(name: string, size: number): Buffer {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii");
    h.write("0000000\0", 116, 8, "ascii");
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    h.write("00000000000\0", 136, 12, "ascii");
    h.write("        ", 148, 8, "ascii");
    h.write("0", 156, 1, "ascii");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return h;
}
function tarGz(entries: Array<{ name: string; body: string }>): Buffer {
    const blocks: Buffer[] = [];
    for (const { name, body } of entries) {
        const data = Buffer.from(body, "utf8");
        blocks.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}
function api(payload: Buffer, revisionNo = 9) {
    return {
        listRevisions: async () => [{ revisionNo, status: "READY", isActive: true }],
        sourceUrl: async () => ({
            url: "http://127.0.0.1:1/source.tar.gz",
            sha256: createHash("sha256").update(payload).digest("hex"),
        }),
    } as never;
}
const serve = (payload: Buffer) => (async () => new Response(payload, { status: 200 })) as never;
const LINK = { kind: "absent" } as const;

/** 판 N 에서 받아 작업하던 폴더를 만든다 — 표식·로컬 변경·보존 대상까지. */
async function workedFolder(tenant: string, revisionNo: number): Promise<string> {
    const dir = await tempDir("zalkera-refresh-");
    await mkdir(join(dir, ".zalkera"), { recursive: true });
    await writeFile(
        join(dir, SOURCE_MARK_PATH),
        JSON.stringify({ format: 1, tenant, revisionNo, sha256: "옛sha", fetchedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await writeFile(join(dir, "package.json"), '{"name":"old"}');
    await writeFile(join(dir, "내가-고친-것.txt"), "이건 사라진다");
    await writeFile(join(dir, ".env.local"), "ZALKERA_KEY=oqsk_local");
    return dir;
}
const markOf = async (dir: string) => JSON.parse(await readFile(join(dir, SOURCE_MARK_PATH), "utf8"));

test("갈아 끼운 뒤 표식이 **새 판**을 말한다 — 다음 발행이 낡은 기반을 선언하지 않는다", async () => {
    const dir = await workedFolder("bix", 3);
    const payload = tarGz([{ name: "package.json", body: '{"name":"new"}' }]);

    const result = await refreshSiteSource({
        api: api(payload, 9), targetDir: dir, tenant: "bix", link: LINK, fetchImpl: serve(payload),
    });

    strictEqual(result.revisionNo, 9);
    strictEqual(result.mark.written, true, "표식을 안 썼다 — 발행마다 거짓 409 동의가 뜬다");
    const mark = await markOf(dir);
    strictEqual(mark.revisionNo, 9, `표식이 옛 판을 든 채다: ${JSON.stringify(mark)}`);
    strictEqual(mark.sha256, createHash("sha256").update(payload).digest("hex"), "sha 가 옛 값이다");
    strictEqual(mark.tenant, "bix");
});

test("옛 내용은 사라지고 새 소스가 선다 — 다만 지킬 것은 지킨다", async () => {
    const dir = await workedFolder("bix", 3);
    const payload = tarGz([{ name: "package.json", body: '{"name":"new"}' }]);

    const result = await refreshSiteSource({
        api: api(payload), targetDir: dir, tenant: "bix", link: LINK, fetchImpl: serve(payload),
    });

    const names = await readdir(dir);
    ok(!names.includes("내가-고친-것.txt"), `밀어내야 할 것이 남았다: ${names.join("·")}`);
    strictEqual(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name, "new");
    // ⚠ **자격증명은 자리에 둔다** — 형제 zip 문과 같은 술어(`keepNames`)를 지난다.
    ok(names.includes(".env.local"), "미리보기 열쇠를 지웠다");
    ok(result.kept.includes(".env.local"), `kept 가 그 사실을 안 말한다: ${result.kept.join("·")}`);
});

test("남의 사이트 표식이면 **안 덮는다** — 소스는 갈아 끼우되 소속은 안 건드린다", async () => {
    // ⚠ 게이트 뒤 TOCTOU 벨트다. 「모른다」로 막지는 않되, 모르는 채로 **적지도** 않는다.
    const dir = await workedFolder("other", 3);
    const payload = tarGz([{ name: "package.json", body: '{"name":"new"}' }]);

    const result = await refreshSiteSource({
        api: api(payload), targetDir: dir, tenant: "bix", link: LINK, fetchImpl: serve(payload),
    });

    strictEqual(result.mark.written, false);
    strictEqual((result.mark as { reason: string }).reason, "keep");
    strictEqual((await markOf(dir)).tenant, "other", "남의 소속을 덮었다");
});

test("해제가 깨지면 **폴더가 원래대로 돌아온다** — 표식도 옛 판 그대로다", async () => {
    const dir = await workedFolder("bix", 3);
    // 앞 항목이 먼저 쓰인다 — 되돌리기가 없으면 반쪽이 남는다.
    const payload = tarGz([
        { name: "good.txt", body: "먼저 쓰이는 파일" },
        { name: "../evil.txt", body: "탈출" },
    ]);

    let threw = "";
    try {
        await refreshSiteSource({
            api: api(payload), targetDir: dir, tenant: "bix", link: LINK, fetchImpl: serve(payload),
        });
    } catch (e) {
        threw = (e as Error).message;
    }
    ok(threw, "깨진 tar 를 통과시켰다");
    const names = await readdir(dir);
    ok(names.includes("내가-고친-것.txt"), `되돌리기가 원래 내용을 안 살렸다: ${names.join("·")}`);
    ok(!names.includes("good.txt"), "반쪽 해제가 남았다");
    strictEqual((await markOf(dir)).revisionNo, 3, "실패했는데 표식이 움직였다");
});
