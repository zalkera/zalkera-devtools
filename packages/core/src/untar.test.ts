import { ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevtoolsError } from "./errors.ts";
import { extractTarGz, extractTarGzFile } from "./untar.ts";

/**
 * 페이로드 해제기 확장 3건(memo146 §13.3 · T-D2c) — 심볼릭 링크 실체화 · 실행 비트 · 저메모리 스트리밍.
 *
 * 아카이브는 **실제 tar 로** 만든다. 우리가 만든 바이트로 우리 파서를 재면 둘이 같이 틀려도 통과한다.
 */
async function fixture(): Promise<{ dir: string; gz: string }> {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-untar-"));
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
    const target = await mkdtemp(join(tmpdir(), "zalkera-out-"));

    await extractTarGzFile(gz, target, join(target, ".scratch"));

    // 링크류는 경로 탈출 매개라 소스 경로에선 계속 안 만든다 — 이 기본값이 바뀌면 fetchSource 가 조용히 넓어진다.
    await rejects(() => lstat(join(target, "node_modules", ".bin", "next")));
});

test("materialize 면 상대 심볼릭 링크를 링크 그대로 만든다", async () => {
    const { gz } = await fixture();
    const target = await mkdtemp(join(tmpdir(), "zalkera-out-"));

    await extractTarGzFile(gz, target, join(target, ".scratch"), { symlinks: "materialize" });

    const link = join(target, "node_modules", ".bin", "next");
    ok((await lstat(link)).isSymbolicLink(), "심볼릭 링크여야 한다(복사본이면 캐시를 옮길 때 끊긴다)");
    // **상대 형태를 유지한다** — 절대경로로 심으면 캐시 트리를 옮기는 순간 전부 끊긴다.
    ok(!(await readlink(link)).startsWith("/"), `상대 경로여야 한다: ${await readlink(link)}`);
    strictEqual((await readFile(link, "utf8")).trim(), "#!/usr/bin/env node");
});

test("preserveMode 면 실행 비트가 산다", async () => {
    const { gz } = await fixture();
    const withMode = await mkdtemp(join(tmpdir(), "zalkera-out-"));
    const without = await mkdtemp(join(tmpdir(), "zalkera-out-"));

    await extractTarGzFile(gz, withMode, join(withMode, ".s"), { preserveMode: true });
    await extractTarGzFile(gz, without, join(without, ".s"));

    const bin = join("node_modules", "next", "dist", "bin", "next");
    // 실행 비트가 없으면 그 실패는 **실행 단계에서 EACCES** 로 나타나 원인을 엉뚱한 데서 찾게 된다.
    ok((await lstat(join(withMode, bin))).mode & 0o111, "실행 비트가 있어야 한다");
    strictEqual((await lstat(join(without, bin))).mode & 0o111, 0, "기본값은 보존하지 않는다");
});

test("스트리밍과 버퍼 해제가 같은 결과를 낸다", async () => {
    const { gz } = await fixture();
    const streamed = await mkdtemp(join(tmpdir(), "zalkera-out-"));
    const buffered = await mkdtemp(join(tmpdir(), "zalkera-out-"));

    const a = await extractTarGzFile(gz, streamed, join(streamed, ".s"), { symlinks: "materialize" });
    const b = await extractTarGz(await readFile(gz), buffered, { symlinks: "materialize" });

    // 파서를 하나로 묶은 이유가 이것이다 — 갈리면 한쪽만 고쳐지는 날이 온다.
    strictEqual(a, b);
    strictEqual(await readFile(join(streamed, "node_modules", "next", "package.json"), "utf8"),
        await readFile(join(buffered, "node_modules", "next", "package.json"), "utf8"));
});

test("중간 tar 는 성공해도 남지 않는다", async () => {
    const { gz } = await fixture();
    const target = await mkdtemp(join(tmpdir(), "zalkera-out-"));
    const scratch = join(target, ".scratch");

    await extractTarGzFile(gz, target, scratch);

    // 600MB 짜리가 남으면 사용자 디스크를 조용히 먹는다.
    await rejects(() => lstat(scratch));
});

/** 오염된 아카이브 모사 — 우리 CI 가 굽지만, 굽는 쪽이 뚫린 날 이 검사만이 고객 홈을 지킨다. */
async function poisonedLinkTarGz(linkTarget: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-evil-"));
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await symlink(linkTarget, join(dir, "node_modules", ".bin", "evil"));
    const gz = join(dir, "evil.tar.gz");
    execFileSync("tar", ["-czf", gz, "-C", dir, "node_modules"]);
    return gz;
}

test("뿌리 밖을 가리키는 링크는 거절한다", async () => {
    const gz = await poisonedLinkTarGz("../../../../../../etc/passwd");
    const target = await mkdtemp(join(tmpdir(), "zalkera-out-"));

    // 링크는 **따라가는 시점에** 해석된다 — 해제기가 안 막으면 그 뒤 도구가 고객 홈의 파일을 읽는다.
    await rejects(
        () => extractTarGzFile(gz, target, join(target, ".s"), { symlinks: "materialize" }),
        (e: unknown) => e instanceof DevtoolsError && /폴더 밖/.test((e as DevtoolsError).message),
    );
});

test("절대경로 링크는 거절한다", async () => {
    const gz = await poisonedLinkTarGz("/etc/passwd");
    const target = await mkdtemp(join(tmpdir(), "zalkera-out-"));

    await rejects(
        () => extractTarGzFile(gz, target, join(target, ".s"), { symlinks: "materialize" }),
        (e: unknown) => e instanceof DevtoolsError && /절대경로/.test((e as DevtoolsError).message),
    );
});

test("잘린 아카이브는 성공으로 보고하지 않는다", async () => {
    const { gz } = await fixture();
    const target = await mkdtemp(join(tmpdir(), "zalkera-out-"));
    const truncated = join(target, "cut.tar.gz");
    const whole = await readFile(gz);
    await writeFile(truncated, whole.subarray(0, Math.floor(whole.length / 2)));

    // 조용히 절반만 풀고 "됐다"고 하면, 그 트리로 dev 서버가 서다가 이유 없이 죽는다.
    await rejects(() => extractTarGzFile(truncated, target, join(target, ".s")));
});
