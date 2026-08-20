import { ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { DevtoolsError } from "./errors.ts";
import { extractTarGz, extractTarGzFile } from "./untar.ts";
import { tempDir } from "./testing/tempDir.ts";

/**
 * 링크 **사다리** 픽스처 — 심의가 이걸로 뚫었다(2026-08-03 · 실측).
 *
 * 각 홉은 "어휘상 뿌리 안"이면서 물리적으로는 한 단계씩 올라간다. 표준 `tar` 로는 이런 아카이브를
 * 만들 수 없어(디스크에 만들면 그 링크를 따라가 버린다) **바이트로 직접 짓는다.**
 */
function ladderTarGz(hops: number, finalFile: string): Buffer {
    const blocks: Buffer[] = [];
    const header = (name: string, type: string, size: number, link: string): Buffer => {
        const h = Buffer.alloc(512);
        h.write(name.slice(0, 100), 0);
        h.write("0000644\0", 100);
        h.write("0000000\0", 108);
        h.write("0000000\0", 116);
        h.write(size.toString(8).padStart(11, "0") + "\0", 124);
        h.write("00000000000\0", 136);
        h.write("        ", 148);
        h.write(type, 156);
        h.write(link.slice(0, 100), 157);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
        return h;
    };
    let prefix = "node_modules";
    blocks.push(header(`${prefix}/`, "5", 0, ""));
    for (let i = 0; i < hops; i += 1) {
        blocks.push(header(`${prefix}/up`, "2", 0, ".."));
        prefix = `${prefix}/up`;
    }
    const body = Buffer.from("OWNED\n");
    blocks.push(header(`${prefix}/${finalFile}`, "0", body.length, ""));
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    blocks.push(padded);
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}

/**
 * 페이로드 해제기 확장 3건(memo146 §13.3 · T-D2c) — 심볼릭 링크 실체화 · 실행 비트 · 저메모리 스트리밍.
 *
 * 아카이브는 **실제 tar 로** 만든다. 우리가 만든 바이트로 우리 파서를 재면 둘이 같이 틀려도 통과한다.
 */
async function fixture(): Promise<{ dir: string; gz: string }> {
    const dir = await tempDir("zalkera-untar-");
    const src = join(dir, "node_modules");
    await mkdir(join(src, ".bin"), { recursive: true });
    await mkdir(join(src, "next", "dist", "bin"), { recursive: true });
    await writeFile(join(src, "next", "dist", "bin", "next"), "#!/usr/bin/env node\n");
    await chmod(join(src, "next", "dist", "bin", "next"), 0o755);
    await writeFile(join(src, "next", "package.json"), '{"name":"next"}');
    // 실제 `.bin` 과 같은 형태 — **상대** 심볼릭 링크
    await symlink("../next/dist/bin/next", join(src, ".bin", "next"));
    const gz = join(dir, "payload.tar.gz");
    execFileSync("tar", ["--owner=0", "--group=0", "--numeric-owner", "-czf", gz, "-C", dir, "node_modules"]);
    return { dir, gz };
}

test("기본값은 심볼릭 링크를 만들지 않는다(사이트 소스 경로 회귀)", async () => {
    const { gz } = await fixture();
    const target = await tempDir("zalkera-out-");

    await extractTarGzFile(gz, target, join(target, ".scratch"));

    // 링크류는 경로 탈출 매개라 소스 경로에선 계속 안 만든다 — 이 기본값이 바뀌면 fetchSource 가 조용히 넓어진다.
    await rejects(() => lstat(join(target, "node_modules", ".bin", "next")));
});

test("materialize 면 상대 심볼릭 링크를 링크 그대로 만든다", async () => {
    const { gz } = await fixture();
    const target = await tempDir("zalkera-out-");

    await extractTarGzFile(gz, target, join(target, ".scratch"), { symlinks: "materialize" });

    const link = join(target, "node_modules", ".bin", "next");
    ok((await lstat(link)).isSymbolicLink(), "심볼릭 링크여야 한다(복사본이면 캐시를 옮길 때 끊긴다)");
    // **상대 형태를 유지한다** — 절대경로로 심으면 캐시 트리를 옮기는 순간 전부 끊긴다.
    ok(!(await readlink(link)).startsWith("/"), `상대 경로여야 한다: ${await readlink(link)}`);
    strictEqual((await readFile(link, "utf8")).trim(), "#!/usr/bin/env node");
});

test("preserveMode 면 실행 비트가 산다", async () => {
    const { gz } = await fixture();
    const withMode = await tempDir("zalkera-out-");
    const without = await tempDir("zalkera-out-");

    await extractTarGzFile(gz, withMode, join(withMode, ".s"), { preserveMode: true });
    await extractTarGzFile(gz, without, join(without, ".s"));

    const bin = join("node_modules", "next", "dist", "bin", "next");
    // 실행 비트가 없으면 그 실패는 **실행 단계에서 EACCES** 로 나타나 원인을 엉뚱한 데서 찾게 된다.
    ok((await lstat(join(withMode, bin))).mode & 0o111, "실행 비트가 있어야 한다");
    strictEqual((await lstat(join(without, bin))).mode & 0o111, 0, "기본값은 보존하지 않는다");
});

test("스트리밍과 버퍼 해제가 같은 결과를 낸다", async () => {
    const { gz } = await fixture();
    const streamed = await tempDir("zalkera-out-");
    const buffered = await tempDir("zalkera-out-");

    const a = await extractTarGzFile(gz, streamed, join(streamed, ".s"), { symlinks: "materialize" });
    const b = await extractTarGz(await readFile(gz), buffered, { symlinks: "materialize" });

    // 파서를 하나로 묶은 이유가 이것이다 — 갈리면 한쪽만 고쳐지는 날이 온다.
    strictEqual(a, b);
    strictEqual(await readFile(join(streamed, "node_modules", "next", "package.json"), "utf8"),
        await readFile(join(buffered, "node_modules", "next", "package.json"), "utf8"));
});

test("중간 tar 는 성공해도 남지 않는다", async () => {
    const { gz } = await fixture();
    const target = await tempDir("zalkera-out-");
    const scratch = join(target, ".scratch");

    await extractTarGzFile(gz, target, scratch);

    // 600MB 짜리가 남으면 사용자 디스크를 조용히 먹는다.
    await rejects(() => lstat(scratch));
});

/** 오염된 아카이브 모사 — 우리 CI 가 굽지만, 굽는 쪽이 뚫린 날 이 검사만이 고객 홈을 지킨다. */
async function poisonedLinkTarGz(linkTarget: string): Promise<string> {
    const dir = await tempDir("zalkera-evil-");
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await symlink(linkTarget, join(dir, "node_modules", ".bin", "evil"));
    const gz = join(dir, "evil.tar.gz");
    execFileSync("tar", ["-czf", gz, "-C", dir, "node_modules"]);
    return gz;
}

test("뿌리 밖을 가리키는 링크는 거절한다", async () => {
    const gz = await poisonedLinkTarGz("../../../../../../etc/passwd");
    const target = await tempDir("zalkera-out-");

    // 링크는 **따라가는 시점에** 해석된다 — 해제기가 안 막으면 그 뒤 도구가 고객 홈의 파일을 읽는다.
    await rejects(
        () => extractTarGzFile(gz, target, join(target, ".s"), { symlinks: "materialize" }),
        (e: unknown) => e instanceof DevtoolsError && /폴더 밖/.test((e as DevtoolsError).message),
    );
});

test("절대경로 링크는 거절한다", async () => {
    const gz = await poisonedLinkTarGz("/etc/passwd");
    const target = await tempDir("zalkera-out-");

    await rejects(
        () => extractTarGzFile(gz, target, join(target, ".s"), { symlinks: "materialize" }),
        (e: unknown) => e instanceof DevtoolsError && /절대경로/.test((e as DevtoolsError).message),
    );
});

test("잘린 아카이브는 성공으로 보고하지 않는다", async () => {
    const { gz } = await fixture();
    const target = await tempDir("zalkera-out-");
    const truncated = join(target, "cut.tar.gz");
    const whole = await readFile(gz);
    await writeFile(truncated, whole.subarray(0, Math.floor(whole.length / 2)));

    // 조용히 절반만 풀고 "됐다"고 하면, 그 트리로 dev 서버가 서다가 이유 없이 죽는다.
    await rejects(() => extractTarGzFile(truncated, target, join(target, ".s")));
});

test("링크 사다리로 뿌리 밖에 쓰지 못한다 (심의 차단 회귀)", async () => {
    const base = await tempDir("zalkera-ladder-");
    const root = join(base, "sandbox", "cache");
    await mkdir(root, { recursive: true });
    await mkdir(join(base, "victim"), { recursive: true });
    await writeFile(join(base, "victim", "secret.txt"), "원본");
    const gz = join(base, "evil.tar.gz");
    // 3홉이면 base 밖까지 나간다 — 초판은 여기서 "성공, 1개 씀"이라고 보고했다.
    await writeFile(gz, ladderTarGz(3, "victim/secret.txt"));

    await rejects(
        () => extractTarGzFile(gz, root, join(root, ".s"), { symlinks: "materialize" }),
        (e: unknown) => e instanceof DevtoolsError,
    );

    // 거절만으로는 부족하다 — **부작용이 남지 않았는지**까지 본다.
    strictEqual(await readFile(join(base, "victim", "secret.txt"), "utf8"), "원본");
    const strays = (await readdir(join(base, "sandbox"))).filter((n) => n !== "cache");
    strictEqual(strays.length, 0, `뿌리 밖 잔해: ${strays.join(",")}`);
});

test("한 홉짜리 링크(뿌리 자신을 가리킴)도 그 위로 못 올라간다", async () => {
    const base = await tempDir("zalkera-ladder1-");
    const root = join(base, "cache");
    await mkdir(root, { recursive: true });
    const gz = join(base, "evil.tar.gz");
    // 초판이 통과시킨 첫 칸: 대상이 정확히 뿌리로 떨어지면 `resolved === root` 라 허용됐다.
    await writeFile(gz, ladderTarGz(2, "escaped.txt"));

    await rejects(() => extractTarGzFile(gz, root, join(root, ".s"), { symlinks: "materialize" }));
    strictEqual((await readdir(base)).includes("escaped.txt"), false);
});

test("기본값(reject)에서도 사다리는 뿌리 안에 갇힌다", async () => {
    const base = await tempDir("zalkera-ladder2-");
    const root = join(base, "cache");
    await mkdir(root, { recursive: true });
    await mkdir(join(base, "victim"), { recursive: true });
    await writeFile(join(base, "victim", "secret.txt"), "원본");
    const gz = join(base, "evil.tar.gz");
    await writeFile(gz, ladderTarGz(3, "victim/secret.txt"));

    // 링크를 안 만드는 경로라도 **파일 쓰기가 기존 링크를 타고 나가면** 같은 사고다.
    await extractTarGzFile(gz, root, join(root, ".s")).catch(() => {});
    strictEqual(await readFile(join(base, "victim", "secret.txt"), "utf8"), "원본");
});

/** 링크 대상을 **받은 문자열 그대로** 담는 아카이브 — 정규화 심기가 없으면 여기서 탈출한다. */
function indirectLinkTarGz(): Buffer {
    const blocks: Buffer[] = [];
    const header = (name: string, type: string, size: number, link: string): Buffer => {
        const h = Buffer.alloc(512);
        h.write(name.slice(0, 100), 0);
        h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
        h.write(size.toString(8).padStart(11, "0") + "\0", 124);
        h.write("00000000000\0", 136); h.write("        ", 148); h.write(type, 156);
        h.write(link.slice(0, 100), 157);
        let sum = 0; for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
        return h;
    };
    blocks.push(header("node_modules/", "5", 0, ""));
    // `self` 는 뿌리 안을 가리키는 **합법** 링크다. 그 뒤 대상을 `self/../..` 로 적으면 어휘 계산과
    // 물리 도달지가 갈린다 — 받은 문자열을 그대로 심으면 그 차이가 그대로 디스크에 남는다.
    blocks.push(header("node_modules/self", "2", 0, "."));
    blocks.push(header("node_modules/pwn", "2", 0, "self/../../victim/secret.txt"));
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}

test("심은 링크의 **물리 도달지**가 뿌리 안이다 (정규화 심기 회귀)", async () => {
    const base = await tempDir("zalkera-indirect-");
    const root = join(base, "cache");
    await mkdir(root, { recursive: true });
    await mkdir(join(base, "victim"), { recursive: true });
    await writeFile(join(base, "victim", "secret.txt"), "원본");
    const gz = join(base, "evil.tar.gz");
    await writeFile(gz, indirectLinkTarGz());

    await extractTarGzFile(gz, root, join(root, ".s"), { symlinks: "materialize" }).catch(() => {});

    // ⚠ 이 축을 실제로 지키는 것은 `descend` 가 아니라 **받은 대상을 정규화해 심는 한 줄**이다
    // (재심의 경고 4 — 그 줄을 되돌리면 86/86 을 유지한 채 탈출이 되살아났다).
    // 그래서 "거절했는가"가 아니라 **"심긴 링크가 어디에 닿는가"**를 잰다.
    const link = join(root, "node_modules", "pwn");
    const info = await lstat(link).catch(() => null);
    if (info?.isSymbolicLink()) {
        const reached = await realpath(link).catch(async () => resolveManually(link));
        const realRoot = await realpath(root);
        ok(
            reached === realRoot || reached.startsWith(realRoot + "/"),
            `물리 도달지가 뿌리 밖이다: ${reached}`,
        );
    }
    strictEqual(await readFile(join(base, "victim", "secret.txt"), "utf8"), "원본");
});

async function resolveManually(link: string): Promise<string> {
    const { dirname, resolve } = await import("node:path");
    return resolve(dirname(link), await readlink(link));
}

test("사다리는 버퍼 경로에서도 막힌다", async () => {
    const base = await tempDir("zalkera-bufladder-");
    const root = join(base, "cache");
    await mkdir(root, { recursive: true });
    await mkdir(join(base, "victim"), { recursive: true });
    await writeFile(join(base, "victim", "secret.txt"), "원본");

    // 신규 픽스처가 전부 스트리밍 경로만 탔다(재심의 경고 6). 두 경로가 `createSink` 를 공유하지만,
    // **공유가 깨지는 날**을 잡는 것이 회귀의 일이다.
    await rejects(() => extractTarGz(ladderTarGz(3, "victim/secret.txt"), root, { symlinks: "materialize" }));
    strictEqual(await readFile(join(base, "victim", "secret.txt"), "utf8"), "원본");
});

test("항목 크기를 과대 신고하면 거절한다 (프로세스 abort 회귀)", async () => {
    const base = await tempDir("zalkera-huge-");
    const gz = join(base, "huge.tar.gz");
    const h = Buffer.alloc(512);
    h.write("big", 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write((4 * 1024 * 1024 * 1024).toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    await writeFile(gz, gzipSync(Buffer.concat([h, Buffer.alloc(1024)])));

    // 65바이트 아카이브가 **exit 134(SIGABRT)** 를 냈다 — JS 로 못 잡는 죽음이라 확장 호스트가 통째로 갔다.
    await rejects(
        () => extractTarGzFile(gz, base, join(base, ".s")),
        (e: unknown) => e instanceof DevtoolsError && /비정상적으로 큰/.test((e as DevtoolsError).message),
    );
});

test("버퍼 경로도 잘린 아카이브를 성공으로 보고하지 않는다", async () => {
    const target = await tempDir("zalkera-out-");
    // 파일 항목 헤더가 999,999바이트를 신고하는데 데이터는 100바이트만 있는 아카이브.
    // 잘린 지점이 **파일 항목의 데이터**여야 이 축을 잰다(디렉터리 항목에 떨어지면 크기가 0 이라 안 걸린다).
    const h = Buffer.alloc(512);
    h.write("cut.txt", 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write((999999).toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);

    // 스트리밍은 거절하는데 **버퍼만 조용히 잘린 데이터를 썼다**(재심의 경고 1 · 파서 드리프트).
    await rejects(
        () => extractTarGz(gzipSync(Buffer.concat([h, Buffer.alloc(100)])), target),
        (e: unknown) => e instanceof DevtoolsError && /중간에 끊/.test((e as DevtoolsError).message),
    );
});

test("대상 폴더에 심링크가 미리 놓여 있으면 그 위로 쓰지 않는다", async () => {
    const base = await tempDir("zalkera-pre-");
    const root = join(base, "cache");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(base, "outside"), { recursive: true });
    await writeFile(join(base, "outside", "hit.txt"), "원본");
    // 캐시 자리가 깨끗하다는 보장은 없다(이전 실행 잔해·사용자 조작·다른 도구).
    await symlink(join(base, "outside", "hit.txt"), join(root, "node_modules", "hit.txt"));

    const { gz } = await fixture();
    // 같은 이름의 **파일**이 든 아카이브를 먹인다. 쓰기가 기존 링크를 따라가면 뿌리 밖이 덮어써진다.
    const evil = join(base, "evil.tar.gz");
    const h = Buffer.alloc(512);
    h.write("node_modules/hit.txt", 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write((6).toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const body = Buffer.alloc(512); Buffer.from("덮어씀").copy(body);
    await writeFile(evil, gzipSync(Buffer.concat([h, body, Buffer.alloc(1024)])));

    // ⚠ 이 축을 지키는 것은 `assertNotSymlink` 한 줄이다 — 지우면 **뿌리 밖 파일이 실제로 덮어써지는데**
    // 그 전까지 어느 테스트도 안 걸려 있었다(3회차 심의 경고 1).
    await rejects(() => extractTarGzFile(evil, root, join(root, ".s")));
    strictEqual(await readFile(join(base, "outside", "hit.txt"), "utf8"), "원본");
    void gz;
});

test("링크 자리를 일반 파일이 선점했으면 조용히 넘어가지 않는다", async () => {
    const { gz } = await fixture();
    const target = await tempDir("zalkera-occupied-");
    await mkdir(join(target, "node_modules", ".bin"), { recursive: true });
    // 링크가 안 생긴 채 "성공"으로 보고되면, 결과가 하필 이 기능이 막으려던 증상이다
    // (`next dev` 가 실행 파일을 못 찾는다). EEXIST 를 삼키면 그 일이 난다(3회차 심의 경고 1).
    await writeFile(join(target, "node_modules", ".bin", "next"), "선점");

    await rejects(
        () => extractTarGzFile(gz, target, join(target, ".s"), { symlinks: "materialize" }),
        (e: unknown) => e instanceof DevtoolsError,
    );
});
