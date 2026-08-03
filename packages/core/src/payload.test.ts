import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computePayloadKey, currentPlatform, evictOldCaches, tryFetchPayload } from "./payload.ts";

/**
 * 의존성 페이로드 받기(memo146 §13.10 · T-D2c).
 *
 * 여기서 고정하는 것은 성공 경로가 아니라 **내려가는 경로**다 — 이 모듈은 가속기라, 실패했을 때
 * ⑴ 던지지 않고 ⑵ 반쯤 펼쳐진 트리를 안 남기고 ⑶ **말은 하는지**가 계약이다(§13.5 무언 강등 금지).
 */
async function payloadFixture(): Promise<{ gz: Buffer; sha: string }> {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-pf-"));
    await mkdir(join(dir, "node_modules", "next"), { recursive: true });
    await writeFile(join(dir, "node_modules", "next", "package.json"), '{"name":"next"}');
    const gzPath = join(dir, "p.tar.gz");
    execFileSync("tar", ["-czf", gzPath, "-C", dir, "node_modules"]);
    const gz = await readFile(gzPath);
    return { gz, sha: createHash("sha256").update(gz).digest("hex") };
}

/** 핸드셰이크 + 다운로드 두 요청을 흉내 낸다. */
function stubFetch(deps: unknown, body?: Buffer, opts: { downloadStatus?: number } = {}): typeof fetch {
    return (async (input: URL | string) => {
        const url = String(input);
        if (url.includes("/api/devtools/handshake")) {
            return new Response(JSON.stringify({ status: 200, data: { deps } }), {
                headers: { "content-type": "application/json" },
            });
        }
        if (opts.downloadStatus && opts.downloadStatus !== 200) {
            return new Response(null, { status: opts.downloadStatus });
        }
        return new Response(body ?? Buffer.alloc(0));
    }) as unknown as typeof fetch;
}

async function cacheDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "zalkera-cache-"));
}

test("정상 꾸러미는 캐시에 펼쳐진다", async () => {
    const { gz, sha } = await payloadFixture();
    const dir = await cacheDir();
    const said: string[] = [];

    const result = await tryFetchPayload({
        apiBase: "https://api.zalkera.com",
        lockfileSha256: "a".repeat(64),
        platform: "linux-x64",
        cacheDir: dir,
        onProgress: (m) => said.push(m),
        fetchImpl: stubFetch(
            { lockfileSha256: "a".repeat(64), payload: { url: "https://deps.zalkera.com/p.tar.gz", sha256: sha, bytes: gz.length, bakedAt: "2026-08-01T00:00:00Z" } },
            gz,
        ),
    });

    ok(result, "성공해야 한다");
    strictEqual(result.bakedAt, "2026-08-01T00:00:00Z");
    ok(existsSync(join(dir, "node_modules", "next", "package.json")));
    // 중간 산출물이 남으면 사용자 디스크를 조용히 먹는다.
    ok(!existsSync(join(dir, ".payload.tar.gz")));
    ok(!existsSync(join(dir, ".payload.tar")));
    ok(said.some((m) => m.includes("받는 중")), `진행을 말해야 한다: ${said.join(" / ")}`);
});

test("sha 가 다르면 폐기하고 **다른 문구로** 말한다", async () => {
    const { gz } = await payloadFixture();
    const dir = await cacheDir();
    const said: string[] = [];

    const result = await tryFetchPayload({
        apiBase: "https://api.zalkera.com",
        lockfileSha256: "a".repeat(64),
        platform: "linux-x64",
        cacheDir: dir,
        onProgress: (m) => said.push(m),
        fetchImpl: stubFetch(
            { lockfileSha256: "a".repeat(64), payload: { url: "https://deps.zalkera.com/p.tar.gz", sha256: "b".repeat(64), bytes: gz.length, bakedAt: null } },
            gz,
        ),
    });

    strictEqual(result, null, "던지지 않고 null 로 내려간다");
    ok(!existsSync(join(dir, "node_modules")), "받은 것을 쓰지 않는다");
    // "느린 것"과 "믿을 수 없는 것"을 같은 말로 뭉개면 지원 시 구분이 불가능하다.
    ok(said.some((m) => m.includes("원본과 달라")), `무결성 실패는 문구가 달라야 한다: ${said.join(" / ")}`);
});

test("구서버(deps 필드 없음)는 조용히가 아니라 **말하고** 내려간다", async () => {
    const dir = await cacheDir();
    const said: string[] = [];

    const result = await tryFetchPayload({
        apiBase: "https://api.zalkera.com",
        lockfileSha256: "a".repeat(64),
        platform: "linux-x64",
        cacheDir: dir,
        onProgress: (m) => said.push(m),
        fetchImpl: stubFetch(undefined),
    });

    strictEqual(result, null);
    ok(said.some((m) => m.includes("직접 내려받습니다")), `말은 해야 한다: ${said.join(" / ")}`);
});

test("payload 가 null 이면(안 구운 세대) 내려간다", async () => {
    const dir = await cacheDir();
    const said: string[] = [];

    const result = await tryFetchPayload({
        apiBase: "https://api.zalkera.com",
        lockfileSha256: "a".repeat(64),
        platform: "linux-x64",
        cacheDir: dir,
        onProgress: (m) => said.push(m),
        fetchImpl: stubFetch({ lockfileSha256: "a".repeat(64), payload: null }),
    });

    strictEqual(result, null);
    ok(said.some((m) => m.includes("아직 없어")), said.join(" / "));
});

test("조회가 늦으면 기다리지 않는다", async () => {
    const dir = await cacheDir();
    // ⚠ 스텁이 `signal` 을 무시하면 **우리 코드가 아니라 스텁을 시험**하게 된다(첫 판이 그래서 매달렸다).
    // 실제 fetch 는 중단 신호에 거절로 답한다 — 그 계약을 그대로 흉내 낸다.
    const slow = ((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch;

    const started = Date.now();
    const result = await tryFetchPayload({
        apiBase: "https://api.zalkera.com",
        lockfileSha256: "a".repeat(64),
        platform: "linux-x64",
        cacheDir: dir,
        fetchImpl: slow,
        lookupTimeoutMs: 150,
    });

    // 가속기 하나 때문에 사용자를 세워 두지 않는다.
    strictEqual(result, null);
    ok(Date.now() - started < 2_000, "타임아웃이 먹어야 한다");
});

test("다운로드가 실패해도 반쯤 펼쳐진 트리를 남기지 않는다", async () => {
    const dir = await cacheDir();
    const said: string[] = [];

    const result = await tryFetchPayload({
        apiBase: "https://api.zalkera.com",
        lockfileSha256: "a".repeat(64),
        platform: "linux-x64",
        cacheDir: dir,
        onProgress: (m) => said.push(m),
        fetchImpl: stubFetch(
            { lockfileSha256: "a".repeat(64), payload: { url: "https://deps.zalkera.com/p.tar.gz", sha256: "c".repeat(64), bytes: 10, bakedAt: null } },
            undefined,
            { downloadStatus: 502 },
        ),
    });

    strictEqual(result, null);
    // 남기면 `deps.ts` 의 캐시 판정이 그것을 "준비됨"으로 통과시킨다(같은 종류의 결함을 한 번 겪었다).
    ok(!existsSync(join(dir, "node_modules")));
    ok(said.some((m) => m.includes("직접 내려받습니다")), said.join(" / "));
});

test("질의 키는 lockfile 원본 바이트의 sha256 이다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-proj-"));
    const content = '{"lockfileVersion":3}';
    await writeFile(join(dir, "package-lock.json"), content);

    // ⚠ `computeCacheKey`(로컬 캐시 키)와 **다른 값**이어야 한다 — 섞으면 적중률이 0 이 되고,
    // 그 실패는 "그냥 좀 느리다"로만 보여 아무도 못 찾는다.
    strictEqual(await computePayloadKey(dir), createHash("sha256").update(content).digest("hex"));
});

test("npm 계열이 아니면 조회조차 하지 않는다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-proj-"));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");

    // 굽지 않는 매니저는 물어봐야 항상 "없다"이고, 그 왕복이 곧 낭비다.
    strictEqual(await computePayloadKey(dir), null);
});

test("플랫폼 표기는 서버가 쓰는 것과 같다", () => {
    ok(/^(linux|darwin|win32)-(x64|arm64)$/.test(currentPlatform()), currentPlatform());
});

test("캐시는 최근 3개만 남긴다", async () => {
    const root = await mkdtemp(join(tmpdir(), "zalkera-root-"));
    for (let i = 0; i < 5; i += 1) {
        const dir = join(root, `key${i}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "mark"), String(i));
        // mtime 을 벌려 최근 판정을 결정론으로 만든다.
        const when = new Date(Date.now() - (5 - i) * 60_000);
        await utimes(dir, when, when);
    }

    const removed = await evictOldCaches(root, 3);

    strictEqual(removed, 2);
    const left = (await readdir(root)).sort();
    strictEqual(left.join(","), "key2,key3,key4", "오래된 둘이 지워져야 한다");
});

test("캐시 폐기 실패는 작업을 막지 않는다", async () => {
    // 없는 경로 — 청소가 안 됐다고 사용자의 작업을 막을 이유가 없다.
    strictEqual(await evictOldCaches(join(tmpdir(), "zalkera-none-does-not-exist"), 3), 0);
});
