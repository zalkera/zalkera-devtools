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
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { acquireFolderLock } from "./emptyDir.ts";
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
/** 무결성 대조에서 반드시 실패하는 응답 — 롤백 경로를 재는 데 쓴다. */
const badPayload = (ms: number) => (async () => {
    await sleep(ms);
    return new Response("garbage", { status: 200 });
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

test("먼저 잡은 쪽만 이긴다 — 판정이 아니라 **원자 점유**다", async () => {
    // 종전에는 「살아 있는 임시 자리가 있으면 물러난다」는 **판정**이었다. 판정과 점유 사이에 fs
    // 호출이 여럿 있어 두 실행이 **둘 다** 「비어 있다」를 봤다(check-then-act).
    const target = await scratch("lock-");
    const first = await acquireFolderLock(target, 15 * 60 * 1000);
    ok(first !== null, "첫 번째는 잡아야 한다");
    strictEqual(await acquireFolderLock(target, 15 * 60 * 1000), null, "두 번째는 못 잡아야 한다");
    await first!.release();
    const again = await acquireFolderLock(target, 15 * 60 * 1000);
    ok(again !== null, "놓으면 다시 잡힌다");
    await again!.release();
});

test("죽은 주인의 자물쇠는 **즉시** 회수한다 — 15분을 안 기다린다", async () => {
    // mtime 휴리스틱은 크래시 잔해에 최대 15분을 기다리게 했다(그 사이 「이미 받는 중입니다」 —
    // 아무도 안 받는데). 주인의 생사를 물으면 기다릴 이유가 없다.
    const target = await scratch("dead-");
    await mkdir(join(target, ".zalkera-fetch-lock", "work"), { recursive: true });
    await writeFile(join(target, ".zalkera-fetch-lock", "owner.json"), JSON.stringify({ pid: 999_999, startedAt: Date.now() }));
    const lock = await acquireFolderLock(target, 15 * 60 * 1000);
    ok(lock !== null, "죽은 주인의 자물쇠는 회수한다");
    await lock!.release();
});

test("살아 있는 주인의 자물쇠는 안 뺏는다", async () => {
    const target = await scratch("alive-");
    await mkdir(join(target, ".zalkera-fetch-lock", "work"), { recursive: true });
    await writeFile(join(target, ".zalkera-fetch-lock", "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    strictEqual(await acquireFolderLock(target, 15 * 60 * 1000), null);
});

test("자물쇠는 「비어 있는가」 판정에 안 걸린다 — 고객 눈에 안 보이는 것이 폴더를 막으면 안 된다", async () => {
    const { isReceivable } = await import("./emptyDir.ts");
    const target = await scratch("vis-");
    const lock = await acquireFolderLock(target, 15 * 60 * 1000);
    ok(await isReceivable(target), "자물쇠가 폴더를 «비어 있지 않다»로 만들면 안 된다");
    await lock!.release();
});

test("받는 **동안** 생긴 고객 파일을 롤백이 지우지 않는다", async () => {
    // `emptyDir.ts` 가 「이 도구가 낼 수 있는 가장 큰 손해」라고 적어 둔 자리다. 스냅샷 뺄셈은
    // 받기 시작 **전** 한 번만 찍히는데 다운로드는 최대 15분이다 — VS Code 가 폴더를 연 창에서
    // 만드는 `.vscode/settings.json` 도 그 창 안이다(실측으로 고객 메모와 함께 사라졌다).
    const target = await scratch("during-");
    const failing = fetchSiteSource({ api, targetDir: target, fetchImpl: badPayload(300) }).then(
        () => "성공",
        (error: Error) => error.message,
    );
    await sleep(80);
    await writeFile(join(target, "내메모.md"), "받는 동안 쓴 것");
    await mkdir(join(target, ".vscode"), { recursive: true });
    await writeFile(join(target, ".vscode", "settings.json"), "{}");

    ok(String(await failing).includes("원본과 다릅니다"), "이 시험은 실패 경로를 재야 한다");
    const left = (await readdir(target)).sort();
    strictEqual(left.join(","), ".vscode,내메모.md", `고객 파일이 사라졌다: ${left.join(",")}`);
});





test("반쪽 해제는 되감는다 — 고객 것은 두고 **우리 것만**", async () => {
    // 「쓴 것만 되감는다」는 양쪽을 다 재야 한다. 고객 파일 보존만 재면 «아무것도 안 지우는»
    // 롤백으로도 통과하고, 그러면 배송 문서의 «아무것도 풀지 않고 멈춘 것이니 폴더는 그대로입니다»
    // 가 거짓이 된다 — 그리고 같은 폴더로 재시도하면 「비어 있지 않습니다」에 막힌다.
    // 받을 폴더는 **비어 있어야** 시작한다(그 규칙이 먼저 선다). 그러니 여기서 재는 것은
    // 「우리가 쓴 것이 되감기는가」다 — 고객 파일 보존은 위 시험이 따로 잰다.
    const target = await scratch("partial-");

    // 앞 항목은 정상, 뒤 항목이 폴더 밖을 가리킨다 — 앞 것은 이미 디스크에 쓰인 뒤다.
    const escaping = gzipSync(
        Buffer.concat([
            header("site/index.html", 5),
            Buffer.from("hello"),
            Buffer.alloc(507),
            header("../탈출.txt", 5),
            Buffer.from("evil!"),
            Buffer.alloc(507),
            Buffer.alloc(1024),
        ]),
    );
    const sha = createHash("sha256").update(escaping).digest("hex");
    const escapeApi = {
        listRevisions: async () => [{ revisionNo: 7, isActive: true }],
        sourceUrl: async () => ({ url: "https://s3.example/s.tar.gz", sha256: sha }),
    } as never;

    await rejects(
        () =>
            fetchSiteSource({
                api: escapeApi,
                targetDir: target,
                fetchImpl: (async () => new Response(escaping, { status: 200 })) as never,
            }),
        /폴더 밖|이상한 경로/,
    );

    const left = (await readdir(target)).sort();
    strictEqual(left.join(","), "", `되감기가 반쪽이다 — 남은 것: ${left.join(",")}`);
});

test("양성 통제군 — 단독 받기는 그대로 되고 임시물이 안 남는다", async () => {
    // 위 시험들은 「아무것도 안 하는」 스윕으로도 통과한다. 정상 경로가 사는지 따로 못박는다.
    const target = await scratch("solo-");
    const result = await fetchSiteSource({ api, targetDir: target, fetchImpl: slow(5) });
    strictEqual(result.fileCount, 1);
    strictEqual((await readdir(target)).join(","), "index.html");
});
