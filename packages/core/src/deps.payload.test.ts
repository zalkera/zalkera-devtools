import { ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeCacheKey, ensureDependencies } from "./deps.ts";

/**
 * 페이로드 → 캐시 → 프로젝트 **합류점**(memo146 §13.10.6 · 심의 W5).
 *
 * 여기가 무테스트였다. 단위 테스트는 `payload.ts` 가 트리를 폈다는 것까지만 보고, `deps.ts` 가 그 트리를
 * 프로젝트에 **연결하고 완결 표식을 남기는지**는 아무도 안 봤다. 이 축이 깨지면 사용자는 "준비 완료"를
 * 보고 나서 `Cannot find module` 을 만난다.
 */
async function fakeSite(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-site-"));
    await writeFile(join(dir, "package.json"), '{"name":"site"}');
    await writeFile(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    return dir;
}

/** 서버가 굽는 것과 같은 모양 — 뿌리에 `node_modules/` 가 있는 tar.gz. */
async function bakedPayload(): Promise<{ gz: Buffer; sha: string }> {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-baked-"));
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(dir, "node_modules", "next", "bin"), { recursive: true });
    await writeFile(join(dir, "node_modules", "next", "bin", "next"), "#!/usr/bin/env node\n");
    await writeFile(join(dir, "node_modules", "next", "package.json"), '{"name":"next"}');
    execFileSync("ln", ["-s", "../next/bin/next", join(dir, "node_modules", ".bin", "next")]);
    const gzPath = join(dir, "p.tar.gz");
    execFileSync("tar", ["-czf", gzPath, "-C", dir, "node_modules"]);
    const gz = await readFile(gzPath);
    return { gz, sha: createHash("sha256").update(gz).digest("hex") };
}

function serve(gz: Buffer, sha: string, lockSha: string): typeof fetch {
    return (async (input: URL | string) => {
        if (String(input).includes("/api/devtools/handshake")) {
            return new Response(
                JSON.stringify({
                    status: 200,
                    data: {
                        deps: {
                            lockfileSha256: lockSha,
                            payload: { url: "https://deps.zalkera.com/p.tar.gz", sha256: sha, bytes: gz.length, bakedAt: "2026-08-01T00:00:00Z" },
                        },
                    },
                }),
                { headers: { "content-type": "application/json" } },
            );
        }
        return new Response(gz);
    }) as unknown as typeof fetch;
}

test("페이로드가 있으면 npm 없이 연결까지 끝난다", async () => {
    const projectDir = await fakeSite();
    const cacheRoot = await mkdtemp(join(tmpdir(), "zalkera-croot-"));
    const { gz, sha } = await bakedPayload();
    const lockSha = createHash("sha256").update(await readFile(join(projectDir, "package-lock.json"))).digest("hex");
    const said: string[] = [];

    const result = await ensureDependencies({
        projectDir,
        cacheRoot,
        apiBase: "https://api.zalkera.com",
        onProgress: (m) => said.push(m),
        fetchImpl: serve(gz, sha, lockSha),
        // npm 이 불리면 이 명령이 죽는다 — **불리지 않아야** 이 테스트가 뜻이 있다.
        npmCommand: ["/nonexistent-npm-should-not-run"],
    });

    ok(result.action === "linked" || result.action === "copied", `연결됐어야 한다: ${result.action}`);
    ok(existsSync(join(projectDir, "node_modules", "next", "package.json")));
    // 완결 표식이 없으면 다음 실행이 "반쯤 만들어진 트리"로 보고 지운 뒤 다시 받는다.
    // ⚠ 표식은 **캐시 뿌리 아래**에 남는다 — 프로젝트 안에 두면 받은 zip 이 담아 올 수 있다.
    ok(existsSync(join(cacheRoot, ".complete")), "완결 표식이 캐시 뿌리에 남아야 한다");
    ok(!existsSync(join(projectDir, "node_modules", ".zalkera-deps-complete")), "프로젝트 안에는 남기지 않는다");
    // `.bin` 링크가 살아야 dev 서버가 실행 파일을 찾는다.
    ok((await lstat(join(projectDir, "node_modules", ".bin", "next"))).isSymbolicLink());
    ok(said.some((m) => m.includes("받는 중")), said.join(" / "));
});

test("두 번째 호출은 캐시를 재사용한다", async () => {
    const projectDir = await fakeSite();
    const cacheRoot = await mkdtemp(join(tmpdir(), "zalkera-croot-"));
    const { gz, sha } = await bakedPayload();
    const lockSha = createHash("sha256").update(await readFile(join(projectDir, "package-lock.json"))).digest("hex");

    await ensureDependencies({ projectDir, cacheRoot, apiBase: "https://api.zalkera.com", fetchImpl: serve(gz, sha, lockSha), npmCommand: ["/nonexistent-npm"] });
    const second = await ensureDependencies({ projectDir, cacheRoot, apiBase: "https://api.zalkera.com", fetchImpl: serve(gz, sha, lockSha), npmCommand: ["/nonexistent-npm"] });

    strictEqual(second.action, "reused");
});

test("서버가 안 주면 npm 으로 내려간다 — 그리고 말한다", async () => {
    const projectDir = await fakeSite();
    const cacheRoot = await mkdtemp(join(tmpdir(), "zalkera-croot-"));
    const said: string[] = [];

    // npm 을 일부러 없는 명령으로 두고, **거기까지 내려갔는지**를 실패로 확인한다.
    await ensureDependencies({
        projectDir,
        cacheRoot,
        apiBase: "https://api.zalkera.com",
        onProgress: (m) => said.push(m),
        fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
        npmCommand: ["/nonexistent-npm-should-run-and-fail"],
    }).catch(() => {});

    ok(said.some((m) => m.includes("직접 내려받습니다")), `무언 강등 금지: ${said.join(" / ")}`);
    ok(said.some((m) => m.includes("처음 한 번")), "npm 경로로 실제로 내려가야 한다");
});

test("apiBase 가 없으면 조회 자체를 안 한다", async () => {
    const projectDir = await fakeSite();
    const cacheRoot = await mkdtemp(join(tmpdir(), "zalkera-croot-"));
    let called = 0;

    await ensureDependencies({
        projectDir,
        cacheRoot,
        fetchImpl: (async () => {
            called += 1;
            return new Response("{}");
        }) as unknown as typeof fetch,
        npmCommand: ["/nonexistent-npm"],
    }).catch(() => {});

    strictEqual(called, 0, "서버 주소가 없으면 네트워크를 건드리지 않는다");
});

test("lockfile 이 npm 계열이 아니면 말하고 내려간다", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "zalkera-site-"));
    await writeFile(join(projectDir, "package.json"), '{"name":"site"}');
    await writeFile(join(projectDir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    const cacheRoot = await mkdtemp(join(tmpdir(), "zalkera-croot-"));
    const said: string[] = [];

    await ensureDependencies({
        projectDir,
        cacheRoot,
        apiBase: "https://api.zalkera.com",
        onProgress: (m) => said.push(m),
        npmCommand: ["/nonexistent-npm"],
    }).catch(() => {});

    // 침묵하면 "왜 나만 느린가"를 사용자도 우리도 설명할 수 없다(심의 W6).
    ok(said.some((m) => m.includes("package-lock.json 이 필요합니다")), said.join(" / "));
});

test("캐시가 3세대를 넘으면 정리된다", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "zalkera-croot-"));
    for (const name of ["old1", "old2", "old3", "old4"]) {
        await mkdir(join(cacheRoot, name), { recursive: true });
    }
    const projectDir = await fakeSite();
    const { gz, sha } = await bakedPayload();
    const lockSha = createHash("sha256").update(await readFile(join(projectDir, "package-lock.json"))).digest("hex");

    await ensureDependencies({ projectDir, cacheRoot, apiBase: "https://api.zalkera.com", fetchImpl: serve(gz, sha, lockSha), npmCommand: ["/nonexistent-npm"] });

    // 세대당 586MB 라 무한 증식은 그 자체로 결함이다. 방금 만든 세대는 반드시 살아 있어야 한다.
    const left = await readdir(cacheRoot);
    strictEqual(left.length, 3, `3세대만 남아야 한다: ${left.join(",")}`);
    ok(existsSync(join(projectDir, "node_modules", "next", "package.json")), "방금 쓴 캐시가 지워지면 안 된다");
});

test("받은 폴더가 완결 표식을 담아 와도 준비를 건너뛰지 않는다", async () => {
    // ⚠ 이것이 F6 이다. 종전에는 `node_modules/.zalkera-deps-complete` 하나로 준비가 통째로 건너뛰어졌고,
    //   그러면 **zip 이 담아 온 `node_modules` 가 그대로 실행**된다 — 어느 npm 을 쓸지 고르는 장치가
    //   한 번도 안 돈다.
    const projectDir = await fakeSite();
    const cacheRoot = await mkdtemp(join(tmpdir(), "zalkera-croot-"));
    await mkdir(join(projectDir, "node_modules"), { recursive: true });
    await writeFile(join(projectDir, "node_modules", ".zalkera-deps-complete"), "받은 zip 이 담아 온 것\n");
    await writeFile(join(projectDir, "node_modules", "PWNED.txt"), "여기 있으면 안 된다\n");

    await rejects(
        () => ensureDependencies({ projectDir, cacheRoot, npmCommand: ["/nonexistent-npm-should-run-and-fail"] }),
        (error: unknown) => error instanceof Error,
        "준비를 건너뛰고 reused 로 돌아왔다 — 담아 온 트리를 그대로 쓴다",
    );
    ok(!existsSync(join(projectDir, "node_modules", "PWNED.txt")), "담아 온 트리를 지우지 않았다");
});

test("`.npmrc` 가 다르면 캐시 키가 갈린다 — 같은 lockfile 이라도", async () => {
    // ⚠ 이것이 F5 다. `.npmrc` 의 `registry=` 한 줄이면 같은 lockfile 에서 **다른 꾸러미**가 온다.
    //   키가 그것을 안 세면 조작된 트리가 정상 lockfile 의 키로 적재되고, 남의 사이트가 이어받는다.
    const dir = await fakeSite();
    const clean = await computeCacheKey(dir);
    await writeFile(join(dir, ".npmrc"), "registry=http://127.0.0.1:9/\n");
    const tainted = await computeCacheKey(dir);
    ok(clean !== tainted, `같은 키가 나왔다: ${clean}`);
    await rm(join(dir, ".npmrc"));
    strictEqual(await computeCacheKey(dir), clean, "지우면 원래 키로 돌아와야 한다");
});
