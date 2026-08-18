/**
 * **같은 폴더로 두 번 받기 — 이 폴더가 자물쇠다.**
 *
 * ## 왜 이 파일이 생겼나
 *
 * 임시 스크래치 폴더(`.zalkera-fetch-*`)는 **사실상 뮤텍스였다** — 두 번째 실행이 「비어 있지
 * 않습니다」에 막혔기 때문이다. 잔해가 폴더를 눈에 안 보이게 폐색하는 문제를 고치면서 그 자물쇠를
 * 이름 접두만 보고 걷어냈고, 아무것도 대신 놓지 않았다. 결과(실측):
 *
 *     A(먼저·느린 회선)  실패: ENOENT       ← B 의 스윕이 A 의 임시 파일을 지웠다
 *     B(나중)            성공 1개           ← 「1개 파일을 받았습니다」
 *     폴더 최종 내용      []                ← A 의 롤백이 B 가 푼 파일까지 걷어 갔다
 *
 * **거짓 성공 + 전량 유실**이다. 다운로드는 최대 15분이고 취소 단추가 없어, 「멈춘 것 같다」며
 * 같은 폴더로 다시 누르는 것이 유일한 대응 수단이다 — 즉 정상 사용 경로가 방아쇠다.
 */
import { ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { sweepOurScratch } from "./emptyDir.ts";
import { fetchSiteSource } from "./fetchSource.ts";

const made: string[] = [];
after(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function scratch(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
}

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

const BODY = "hello";
const PAYLOAD = gzipSync(
    Buffer.concat([
        header("index.html", BODY.length),
        Buffer.from(BODY),
        Buffer.alloc(512 - BODY.length),
        Buffer.alloc(1024),
    ]),
);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const api = {
    listRevisions: async () => [{ revisionNo: 7, isActive: true }],
    sourceUrl: async () => ({ url: "https://s3.example/s.tar.gz", sha256: SHA }),
} as never;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 느린 회선. **유한**하다 — 가드를 재는 시험이 매달려 있으면 안 된다. */
const slow = (ms: number) => (async () => {
    await sleep(ms);
    return new Response(PAYLOAD, { status: 200 });
}) as never;

test("먼저 시작한 받기가 이긴다 — 나중 것은 「이미 받는 중」으로 끊는다", async () => {
    const target = await scratch("race-");
    const first = fetchSiteSource({ api, targetDir: target, fetchImpl: slow(400) });
    await sleep(80);
    // 「비어 있지 않습니다」로 답하면 **거짓**이다 — 스크래치는 점 파일이라 폴더는 비어 보인다.
    await rejects(
        () => fetchSiteSource({ api, targetDir: target, fetchImpl: slow(10) }),
        /이미 소스를 받는 중/,
    );
    strictEqual((await first).fileCount, 1, "먼저 시작한 쪽이 죽으면 안 된다");
    // 유실 없음이 이 시험의 본체다 — 한때 여기가 `[]` 였다.
    strictEqual((await readdir(target)).join(","), "index.html");
});

test("죽은 잔해는 걷는다 — 그것이 폴더를 눈에 안 보이게 막던 것이다", async () => {
    const target = await scratch("stale-");
    const dead = join(target, ".zalkera-fetch-abc123");
    await mkdir(dead, { recursive: true });
    await writeFile(join(dead, "source.tar.gz"), "x");
    const old = new Date(Date.now() - 30 * 60 * 1000);
    await utimes(join(dead, "source.tar.gz"), old, old);
    await utimes(dead, old, old);

    const result = await sweepOurScratch(target, 15 * 60 * 1000);
    strictEqual(result.swept, 1);
    strictEqual(result.active, 0);
    strictEqual((await readdir(target)).length, 0);
});

test("갓 만든 것은 안 걷는다 — 살아 있는 받기다", async () => {
    const target = await scratch("live-");
    await mkdir(join(target, ".zalkera-fetch-xyz789"), { recursive: true });
    const result = await sweepOurScratch(target, 15 * 60 * 1000);
    strictEqual(result.swept, 0);
    strictEqual(result.active, 1);
});

test("고객 파일은 접두가 같아도 안 지운다 — 이름 접두만 보면 남의 것을 지운다", async () => {
    const target = await scratch("cust-");
    await writeFile(join(target, ".zalkera-fetch-메모.txt"), "고객 것");
    await mkdir(join(target, ".zalkera-fetch-내작업"), { recursive: true });
    await writeFile(join(target, ".zalkera-fetch-내작업", "중요.txt"), "고객 것");

    const result = await sweepOurScratch(target, 0); // 상한 0 — 「전부 오래됐다」로 가장 공격적으로
    strictEqual(result.swept, 0, "우리 것이 아니면 하나도 안 지운다");
    strictEqual((await readdir(target)).length, 2);
});

test("이름만 흉내 낸 심링크를 따라가 폴더 밖을 지우지 않는다", async () => {
    const target = await scratch("link-");
    const outside = await scratch("outside-");
    await writeFile(join(outside, "카나리.txt"), "밖의 것");
    await symlink(outside, join(target, ".zalkera-fetch-abcdef"));

    const result = await sweepOurScratch(target, 0);
    strictEqual(result.swept, 0);
    ok((await readdir(outside)).includes("카나리.txt"), "레포 밖 파일이 사라졌다");
});

test("양성 통제군 — 단독 받기는 그대로 되고 임시물이 안 남는다", async () => {
    // 위 시험들은 「아무것도 안 하는」 스윕으로도 통과한다. 정상 경로가 사는지 따로 못박는다.
    const target = await scratch("solo-");
    const result = await fetchSiteSource({ api, targetDir: target, fetchImpl: slow(5) });
    strictEqual(result.fileCount, 1);
    strictEqual((await readdir(target)).join(","), "index.html");
});
