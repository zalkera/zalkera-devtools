/**
 * **받는 것은 우리 마당, 놓는 것만 고객 마당.**
 *
 * ## 왜 이 파일이 생겼나
 *
 * 한때 임시 파일(받는 중인 tar.gz · 중간 tar)을 **고객이 고른 폴더 안**에 뒀다. 같은 파일시스템이라
 * 공간이 보장되고 `os.tmpdir()` 이 tmpfs(=메모리)인 환경이 많다는 것이 이유였다. 그 결정 하나에서
 * 심의 차단이 연달아 나왔다:
 *
 *   · 크래시 잔해가 남으면 「비어 있지 않습니다」인데, 그것은 점 파일이라 **고객 눈엔 빈 폴더**다
 *   · 그 잔해를 걷으려면 「버려진 것」과 「지금 받는 중인 것」을 **추측**해야 한다 → 그 추측이
 *     진행 중 받기를 죽여 **「받았습니다」가 뜨고 폴더는 비었다**
 *   · 고정 이름이 아카이브 안의 경로와 부딪혀 **파일이 조용히 사라졌다**(3개 보고 · 2개 실재)
 *   · 「비어 있는가」 판정을 여러 명령이 공유하는데 거기 우리 것이 끼었다
 *
 * 전부 «남의 마당에서 작업한다»는 하나에서 나왔다. 여기서 잠그는 것은 그 하나다.
 */
import { ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
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

/** 링크 항목 한 장. 데이터는 없고 헤더만 있다(`linkname` 자리에 대상). */
function linkEntry(name: string, target: string, type: "1" | "2"): Buffer {
    const h = header(name, 0);
    h.write(type, 156, 1, "ascii");
    h.write(target, 157, 100, "utf8");
    h.write("        ", 148, 8, "ascii");
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return h;
}

function entry(name: string, body: string): Buffer[] {
    const data = Buffer.from(body, "utf8");
    return [header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

function archive(items: Array<[string, string]>): Buffer {
    return gzipSync(Buffer.concat([...items.flatMap(([n, b]) => entry(n, b)), Buffer.alloc(1024)]));
}

function apiFor(payload: Buffer) {
    return {
        listRevisions: async () => [{ revisionNo: 7, isActive: true }],
        sourceUrl: async () => ({
            url: "https://s3.example/s.tar.gz",
            sha256: createHash("sha256").update(payload).digest("hex"),
        }),
    } as never;
}

const serve = (payload: Buffer) => (async () => new Response(payload, { status: 200 })) as never;

/** 무결성 대조에서 반드시 실패하는 응답 — 롤백 경로를 재는 데 쓴다. */
const serveBad = (async () => new Response("garbage", { status: 200 })) as never;

const ONE = archive([["index.html", "hello"]]);

test("성공해도 고객 폴더에 우리 것이 남지 않는다", async () => {
    const target = await scratch("t-");
    const mine = await scratch("mine-");
    const result = await fetchSiteSource({
        api: apiFor(ONE),
        targetDir: target,
        scratchRoot: mine,
        fetchImpl: serve(ONE),
    });
    strictEqual(result.fileCount, 1);
    // **숨은 것까지** 센다 — 종전 잔해는 점 파일이라 `ls` 에 안 보였다.
    strictEqual((await readdir(target)).sort().join(","), "index.html");
});

test("받는 **동안에도** 고객 폴더에 우리 것이 없다 — 이것이 본체다", async () => {
    // 끝난 뒤만 재면 「고객 폴더에 두고 나중에 치우는」 형상으로도 통과한다. 그런데 차단이 난 자리는
    // 전부 **중간에 죽었을 때**였다 — 크래시 잔해가 폴더를 눈에 안 보이게 막고, 그것을 걷으려는
    // 추측이 진행 중 받기를 죽였다. 그러니 재야 하는 것은 **받는 도중의 폴더 상태**다.
    const target = await scratch("t-");
    const mine = await scratch("mine-");
    let seen: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const watched = (async () => {
        // 다운로드가 시작된 시점 — 임시 파일이 있다면 바로 지금 있다.
        seen = await readdir(target);
        await gate;
        return new Response(ONE, { status: 200 });
    }) as never;

    const run = fetchSiteSource({ api: apiFor(ONE), targetDir: target, scratchRoot: mine, fetchImpl: watched });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await run;

    strictEqual(seen.join(","), "", `받는 도중 고객 폴더에 우리 것이 있었다: ${seen.join(",")}`);
    // 반대편도 못박는다 — 우리 마당에는 그때 실제로 있어야 한다(«아무 데도 안 쓴다» 가 아니다).
    ok(mine.length > 0);
});

test("실패해도 고객 폴더에 우리 것이 남지 않는다", async () => {
    // 잔해가 남으면 그 폴더는 그 뒤 **모든** 받기에서 막힌다 — 고객 눈엔 빈 폴더인데.
    const target = await scratch("t-");
    const mine = await scratch("mine-");
    await rejects(
        () => fetchSiteSource({ api: apiFor(ONE), targetDir: target, scratchRoot: mine, fetchImpl: serveBad }),
        /원본과 다릅니다/,
    );
    strictEqual((await readdir(target)).join(","), "", "잔해가 남으면 폴더가 영영 막힌다");
});

test("우리 마당에도 남기지 않는다 — 성공·실패 양쪽", async () => {
    for (const [label, impl, expectFail] of [
        ["성공", serve(ONE), false],
        ["실패", serveBad, true],
    ] as const) {
        const target = await scratch("t-");
        const mine = await scratch("mine-");
        const run = fetchSiteSource({ api: apiFor(ONE), targetDir: target, scratchRoot: mine, fetchImpl: impl });
        if (expectFail) await rejects(() => run);
        else await run;
        strictEqual((await readdir(mine)).join(","), "", `${label}: 우리 마당에 잔여`);
    }
});

test("아카이브가 우리 임시 이름을 담아도 파일이 사라지지 않는다", async () => {
    // 임시물이 고객 폴더 안에 있던 시절, 아카이브가 그 이름을 담으면 겹쳐 써서 **「3개 받았습니다」**
    // 인데 디스크엔 2개였다(실측). 밖으로 나가면 부딪힐 이름 자체가 없다.
    const payload = archive([
        ["a.html", "AAA"],
        [".zalkera-fetch-lock/설정.json", "{}"],
        ["page.tsx", "PPP"],
    ]);
    const target = await scratch("t-");
    const mine = await scratch("mine-");
    const result = await fetchSiteSource({
        api: apiFor(payload),
        targetDir: target,
        scratchRoot: mine,
        fetchImpl: serve(payload),
    });

    const found: string[] = [];
    const walk = async (dir: string, prefix = ""): Promise<void> => {
        for (const item of await readdir(dir, { withFileTypes: true })) {
            const name = prefix + item.name;
            if (item.isDirectory()) await walk(join(dir, item.name), `${name}/`);
            else found.push(name);
        }
    };
    await walk(target);
    // **말한 수와 디스크의 수가 같아야 한다.** 이 레포가 「사용자에게는 4개라고 말하고 디스크엔
    // 3개다」를 금지 사유로 적어 둔 자리다.
    strictEqual(found.length, result.fileCount, `말한 것 ${result.fileCount} · 실재 ${found.length}`);
});

test("받는 **동안** 생긴 고객 파일을 롤백이 지우지 않는다", async () => {
    // `emptyDir.ts` 가 「이 도구가 낼 수 있는 가장 큰 손해」라고 적어 둔 자리다.
    const target = await scratch("t-");
    const mine = await scratch("mine-");
    let released: () => void = () => {};
    const gate = new Promise<void>((resolve) => (released = resolve));
    const slowBad = (async () => {
        await gate;
        return new Response("garbage", { status: 200 });
    }) as never;

    const run = fetchSiteSource({ api: apiFor(ONE), targetDir: target, scratchRoot: mine, fetchImpl: slowBad });
    // 「빈 폴더인가」 판정이 **먼저** 지나가야 이 시험이 뜻이 있다 — 그 전에 쓰면 그 판정에 걸린다.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(join(target, "내메모.md"), "받는 동안 쓴 것");
    await mkdir(join(target, ".vscode"), { recursive: true });
    await writeFile(join(target, ".vscode", "settings.json"), "{}");
    released();

    await rejects(() => run, /원본과 다릅니다/);
    strictEqual((await readdir(target)).sort().join(","), ".vscode,내메모.md");
});

test("반쪽 해제는 되감는다 — 우리가 쓴 것만", async () => {
    // 「고객 것 보존」만 재면 «아무것도 안 지우는» 롤백으로도 통과한다. 양쪽을 다 못박는다.
    const payload = archive([
        ["site/index.html", "hello"],
        ["../탈출.txt", "evil!"],
    ]);
    const target = await scratch("t-");
    const mine = await scratch("mine-");
    await rejects(
        () =>
            fetchSiteSource({
                api: apiFor(payload),
                targetDir: target,
                scratchRoot: mine,
                fetchImpl: serve(payload),
            }),
        /폴더 밖|이상한 경로/,
    );
    strictEqual((await readdir(target)).join(","), "", "되감기가 반쪽이다");
});

test("크래시 잔해를 다음 켜기에 걷는다 — 우리 마당은 무한히 쌓이면 안 된다", async () => {
    // 크래시(창 닫기·SIGKILL·절전)면 `finally` 가 안 돈다. 우리 마당은 VS Code 가 **절대 안 지우므로**
    // 그대로 두면 크래시 1회당 최대 600MB 가 사용자 프로필에 영구히·보이지 않게 쌓인다.
    // 종전(고객 폴더)에는 잔해가 폴더를 막아 최소한 **보이기라도** 했다.
    const { sweepScratch } = await import("./fetchSource.ts");
    const mine = await scratch("mine-");
    await mkdir(join(mine, "fetch-abc123"), { recursive: true });
    await writeFile(join(mine, "fetch-abc123", "source.tar.gz"), "찌꺼기");
    await mkdir(join(mine, "fetch-def456"), { recursive: true });
    // 우리 것이 아닌 이름은 안 건드린다 — 이 자리를 다른 용도로 쓰게 될 수 있다.
    await writeFile(join(mine, "keep.json"), "{}");

    strictEqual(await sweepScratch(mine), 2);
    strictEqual((await readdir(mine)).join(","), "keep.json");
});

test("걷을 것이 없거나 마당이 아직 없어도 조용히 넘어간다", async () => {
    const { sweepScratch } = await import("./fetchSource.ts");
    strictEqual(await sweepScratch(join(await scratch("mine-"), "아직없음")), 0);
});

test("과대보고 없음 — 안 쓴 이름은 되감기 대상이 아니다", async () => {
    // 해제기가 항목을 **보자마자** 알리던 시절, 만들지도 않은 하드링크·거부된 심링크의 이름이
    // 되감기 목록에 들어갔다. 받는 15분 사이에 고객이 같은 이름의 파일을 만들면 **그것이 지워진다**.
    const { extractTarGzFile } = await import("./untar.ts");
    const payload = gzipSync(
        Buffer.concat([
            ...entry("진짜.txt", "ok"),
            linkEntry("하드링크.txt", "진짜.txt", "1"),
            linkEntry("심링크.txt", "진짜.txt", "2"),
            Buffer.alloc(1024),
        ]),
    );
    const target = await scratch("t-");
    const mine = await scratch("mine-");
    const gzPath = join(mine, "in.tar.gz");
    await writeFile(gzPath, payload);
    const wrote: string[] = [];
    await extractTarGzFile(gzPath, target, join(mine, "s.tar"), { onWroteRoot: (n) => wrote.push(n) });

    // 디스크에 실제로 있는 것과 알린 것이 **같아야** 한다.
    strictEqual([...new Set(wrote)].sort().join(","), (await readdir(target)).sort().join(","));
});

test("`scratchRoot` 를 안 주면 OS 임시 디렉터리로 물러난다 — 못 받는 것보다 낫다", async () => {
    const target = await scratch("t-");
    const result = await fetchSiteSource({ api: apiFor(ONE), targetDir: target, fetchImpl: serve(ONE) });
    strictEqual(result.fileCount, 1);
    ok((await readdir(target)).includes("index.html"));
});
