import { ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureDependencies } from "./deps.ts";
import { DevtoolsError } from "./errors.ts";
import { extractTarGz } from "./fetchSource.ts";
import { ensureEnvIgnored } from "./project.ts";
import { packProject } from "./zip.ts";

/**
 * 심의(Fable·Opus)가 실제 입력으로 재현한 차단들의 회귀 고정.
 * **각 테스트는 "고쳤다"가 아니라 "그 입력으로 다시 깨지지 않는다"를 증명한다.**
 */

test("차단1 — 100바이트 초과 경로가 잘리지 않는다(GNU 긴 이름)", async () => {
    const src = await mkdtemp(join(tmpdir(), "zalkera-long-"));
    // 백엔드 패커가 LONGFILE_GNU 라 실제로 이 형식이 온다. 102자 경로 두 개 — 잘리면 서로 덮어쓴다.
    const deep = "src/app/(marketing)/products/[category]/[slug]/components/gallery";
    await mkdir(join(src, deep), { recursive: true });
    await writeFile(join(src, deep, "ProductDetailGalleryThumbnailA.tsx"), "export const A = 1;");
    await writeFile(join(src, deep, "ProductDetailGalleryThumbnailB.tsx"), "export const B = 2;");
    execFileSync("tar", ["--format=gnu", "-czf", join(src, "out.tgz"), "-C", src, "src"]);

    const target = await mkdtemp(join(tmpdir(), "zalkera-long-out-"));
    const count = await extractTarGz(await readFile(join(src, "out.tgz")), target);

    const files = await readdir(join(target, deep));
    strictEqual(files.length, 2, `두 파일이 살아야 한다: ${files.join(", ")}`);
    ok(files.includes("ProductDetailGalleryThumbnailA.tsx"), "이름이 잘리지 않는다");
    strictEqual(await readFile(join(target, deep, "ProductDetailGalleryThumbnailB.tsx"), "utf8"), "export const B = 2;");
    strictEqual(count, 2, "보고한 개수와 디스크가 같아야 한다");
});

test("차단1 — pax 형식도 이름이 온전하다", async () => {
    const src = await mkdtemp(join(tmpdir(), "zalkera-pax-"));
    const deep = "src/components/verylongdirectoryname/anotherlongsegment/andonemore";
    await mkdir(join(src, deep), { recursive: true });
    await writeFile(join(src, deep, "ExtremelyLongComponentFileName.module.css"), ".a{}");
    execFileSync("tar", ["--format=pax", "-czf", join(src, "out.tgz"), "-C", src, "src"]);

    const target = await mkdtemp(join(tmpdir(), "zalkera-pax-out-"));
    await extractTarGz(await readFile(join(src, "out.tgz")), target);
    ok(existsSync(join(target, deep, "ExtremelyLongComponentFileName.module.css")));
});

test("차단1 — 다룰 수 없는 항목은 조용히 넘어가지 않고 끊는다", async () => {
    const header = Buffer.alloc(512);
    header.write("weird.dat", 0, "utf8");
    header.write("00000000000\0", 124);
    header.write("7", 156); // contiguous file — 우리가 안 다루는 타입
    const { gzipSync } = await import("node:zlib");
    const target = await mkdtemp(join(tmpdir(), "zalkera-type-"));
    await rejects(
        () => extractTarGz(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])), target),
        (e: unknown) => e instanceof DevtoolsError && /다룰 수 없는/.test(e.message),
    );
});

test("차단2 — 반쯤 남은 node_modules 는 '준비됨'이 아니다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-half-"));
    await writeFile(join(dir, "package.json"), "{}");
    await mkdir(join(dir, "node_modules", "pkg-a"), { recursive: true });

    // 완결 표식이 없으므로 재사용으로 통과하면 안 된다 — 지우고 다시 받으려다 install 이 없어 실패한다.
    await rejects(
        () => ensureDependencies({ projectDir: dir, cacheRoot: join(dir, "cache"), npmCommand: ["false"] }),
        (e: unknown) => e instanceof DevtoolsError && e.code === "DEPENDENCIES_FAILED",
    );
    strictEqual(existsSync(join(dir, "node_modules")), false, "반쪽 트리는 치워져야 한다");
});

test("차단3 — git 레포에 .gitignore 가 없으면 만들어 자격증명을 막는다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-git-"));
    await mkdir(join(dir, ".git"), { recursive: true });

    strictEqual(await ensureEnvIgnored(dir), "created");
    ok((await readFile(join(dir, ".gitignore"), "utf8")).includes(".env.local"));

    // git 을 안 쓰는 폴더에는 만들지 않는다(우리 일이 아니다).
    const plain = await mkdtemp(join(tmpdir(), "zalkera-plain-"));
    strictEqual(await ensureEnvIgnored(plain), "not-git");
    strictEqual(existsSync(join(plain, ".gitignore")), false);
});

test("차단4 — 큰 파일을 조용히 빼지 않고 이름을 대고 끊는다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-big-"));
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "hero.mp4"), Buffer.alloc(101 * 1024 * 1024));

    await rejects(
        () => packProject({ projectDir: dir }),
        (e: unknown) => e instanceof DevtoolsError && e.code === "PACK_FAILED" && /hero\.mp4/.test(e.message),
    );
});

test("자격증명 파일은 형제 이름까지 전부 빠진다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-secrets-"));
    await writeFile(join(dir, "package.json"), "{}");
    for (const name of [
        ".env", ".env.local", ".env.production", ".env.development.local",
        ".env.local.bak", ".Env.Local", "id_rsa", "deploy_key.pem", "credentials.json", ".npmrc",
    ]) {
        await writeFile(join(dir, name), "ZALKERA_STOREFRONT_KEY=oqsk_secret");
    }

    const packed = await packProject({ projectDir: dir });
    strictEqual(packed.fileCount, 1, "package.json 하나만 실려야 한다");
    ok(!packed.buffer.includes(Buffer.from("oqsk_secret")), "아카이브 어디에도 키가 없어야 한다");
});
