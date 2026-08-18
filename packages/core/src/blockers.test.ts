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

    // 지키는 성질은 **«재사용으로 통과하지 않는다»** 하나다. 완결 표식이 없으므로 설치를 돌리고,
    // 그 설치가 없어서 실패한다.
    await rejects(
        () => ensureDependencies({ projectDir: dir, cacheRoot: join(dir, "cache"), npmCommand: ["false"] }),
        (e: unknown) => e instanceof DevtoolsError && e.code === "DEPENDENCIES_FAILED",
    );
    // ⚠ 종전에는 여기서 «트리가 치워졌는가»를 함께 요구했다. 그 요구가 **고객이 손수 설치한 트리를
    //   지우는 근거**가 됐다(실측). 지금은 받은 꾸러미가 `node_modules` 를 **담을 수 없으므로**
    //   (`safeSegments`) 치울 이유가 없다 — 남은 트리는 언제나 고객 것이다.
    ok(existsSync(join(dir, "node_modules")), "고객 트리를 지웠다");
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

// ── 경고 회귀 ────────────────────────────────────────────────────────────

test("경고 — .env.local 중복 선언이 남으면 폐기된 키가 이긴다", async () => {
    const { mergeEnv } = await import("./env.ts");
    const existing = [
        "ZALKERA_STOREFRONT_KEY=oqsk_old_first",
        "OTHER=1",
        "ZALKERA_STOREFRONT_KEY=oqsk_old_last",
    ].join("\n");

    const merged = mergeEnv(existing, {
        ZALKERA_API_BASE: "https://api.zalkera.com",
        ZALKERA_TENANT: "acme",
        ZALKERA_STOREFRONT_KEY: "oqsk_new",
        ZALKERA_SITE_URL: "http://localhost:3000",
        NEXT_PUBLIC_ZALKERA_PREVIEW: "1",
    });

    const keyLines = merged.split("\n").filter((l) => l.startsWith("ZALKERA_STOREFRONT_KEY="));
    strictEqual(keyLines.length, 1, `중복이 남으면 dotenv 가 마지막 것을 채택해 영구 401 이 된다: ${keyLines}`);
    strictEqual(keyLines[0], "ZALKERA_STOREFRONT_KEY=oqsk_new");
    ok(merged.includes("OTHER=1"), "남의 값은 그대로");
});

test("경고 — 기존 .env.local 권한을 600 으로 조인다", async () => {
    const { writePreviewEnv } = await import("./env.ts");
    const { chmod, stat, writeFile: wf } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "zalkera-perm-"));
    const path = join(dir, ".env.local");
    await wf(path, "OTHER=1\n");
    await chmod(path, 0o644);

    await writePreviewEnv(dir, {
        ZALKERA_API_BASE: "https://api.zalkera.com",
        ZALKERA_TENANT: "acme",
        ZALKERA_STOREFRONT_KEY: "oqsk_x",
        ZALKERA_SITE_URL: "http://localhost:3000",
        NEXT_PUBLIC_ZALKERA_PREVIEW: "1",
    });

    strictEqual((await stat(path)).mode & 0o777, 0o600, "공용 기계의 다른 사용자가 키를 읽으면 안 된다");
});

test("경고 — 압축 폭탄은 사람 말로 끊는다", async () => {
    const { extractZip } = await import("./unzip.ts");
    const { createZip } = await import("./zip.ts");
    // 200MB 상한을 넘기는 단일 항목(0 바이트는 잘 압축된다).
    const bomb = await createZip([{ path: "bomb.bin", data: Buffer.alloc(210 * 1024 * 1024) }]);
    const target = await mkdtemp(join(tmpdir(), "zalkera-bomb-"));
    await rejects(
        () => extractZip(bomb, target),
        (e: unknown) => e instanceof DevtoolsError && /너무 크거나 손상/.test(e.message),
    );
});

test("경고 — 항목 65535 초과는 raw RangeError 가 아니라 사람 말", async () => {
    const { createZip } = await import("./zip.ts");
    const entries = Array.from({ length: 65_536 }, (_, i) => ({ path: `f${i}.txt`, data: Buffer.alloc(1) }));
    await rejects(
        () => createZip(entries),
        (e: unknown) => e instanceof DevtoolsError && /파일이 너무 많습니다/.test(e.message),
    );
});

test("경고 — 손상된 zip 목록은 raw RangeError 가 아니라 사람 말", async () => {
    const { extractZip } = await import("./unzip.ts");
    const { createZip } = await import("./zip.ts");
    const zip = await createZip([{ path: "a.txt", data: Buffer.from("x") }]);
    // 중앙 디렉터리의 로컬 헤더 오프셋을 파일 밖으로 밀어 버린다.
    const eocd = zip.length - 22;
    const centralStart = zip.readUInt32LE(eocd + 16);
    zip.writeUInt32LE(0xff_ff_ff_00, centralStart + 42);

    const target = await mkdtemp(join(tmpdir(), "zalkera-broken-"));
    await rejects(
        () => extractZip(zip, target),
        (e: unknown) => e instanceof DevtoolsError && /손상/.test(e.message),
    );
});

test("경고 — 프록시 자격증명은 리포트에 찍히지 않는다", async () => {
    const { runDoctor } = await import("./doctor.ts");
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://alice:s3cret@proxy.corp:8080";
    try {
        const checks = await runDoctor({
            apiBase: "http://127.0.0.1:1",
            extensionVersion: "0.1.0",
            fetchImpl: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
        });
        const proxy = checks.find((c) => c.name === "네트워크 프록시");
        ok(proxy && !proxy.detail.includes("s3cret"), `비밀번호가 새면 안 된다: ${proxy?.detail}`);
        ok(proxy!.detail.includes("proxy.corp:8080"), "호스트는 보여야 쓸모가 있다");
    } finally {
        if (previous === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = previous;
    }
});

test("경고 — 핸드셰이크 응답이 우리 형식이 아니면 사람 말로 끊는다", async () => {
    const { fetchHandshake } = await import("./handshake.ts");
    const html = (async () => new Response("<html>502</html>", { status: 200 })) as unknown as typeof fetch;
    await rejects(
        () => fetchHandshake("https://api.zalkera.com", "0.1.0", html),
        (e: unknown) => e instanceof DevtoolsError && /이해하지 못했습니다/.test(e.message),
    );

    const empty = (async () => Response.json({ status: 200, data: null })) as unknown as typeof fetch;
    await rejects(
        () => fetchHandshake("https://api.zalkera.com", "0.1.0", empty),
        (e: unknown) => e instanceof DevtoolsError && /필요한 정보가 없습니다/.test(e.message),
    );
});

test("경고 — 서버 메시지를 무제한으로 사용자에게 넘기지 않는다", async () => {
    const { ZalkeraApi } = await import("./api.ts");
    const huge = "가".repeat(40_000);
    const api = new ZalkeraApi({
        apiBase: "https://api.zalkera.com",
        accessToken: async () => "t",
        tenantCode: () => "acme",
        fetchImpl: (async () => Response.json({ message: huge }, { status: 400 })) as unknown as typeof fetch,
    });
    await rejects(
        () => api.listRevisions(),
        (e: unknown) => e instanceof DevtoolsError && e.message.length < 400,
    );
});

test("무결성 — 받은 소스가 원장과 다르면 풀지 않는다(B2)", async () => {
    const { fetchSiteSource } = await import("./fetchSource.ts");
    const dir = await mkdtemp(join(tmpdir(), "zalkera-integrity-"));
    const payload = Buffer.from("이건 진짜 tar 가 아니어도 된다 — 해시에서 먼저 걸린다");

    const api = {
        listRevisions: async () => [{ revisionNo: 9, status: "READY", isActive: true, createdAt: "2026-08-03" }],
        sourceUrl: async () => ({ url: "https://s3/x", revisionNo: 9, sha256: "0".repeat(64), expiresAt: "" }),
    } as never;

    await rejects(
        () =>
            fetchSiteSource({
                api,
                targetDir: dir,
                fetchImpl: (async () => new Response(payload)) as unknown as typeof fetch,
            }),
        (e: unknown) => e instanceof DevtoolsError && /원본과 다릅니다/.test(e.message),
    );
    // 풀지 않았다는 것이 이 테스트의 본체다 — 풀고 나면 무엇이 깨졌는지 모른 채 소스가 남는다.
    strictEqual((await readdir(dir)).length, 0);
});

test("무결성 — 서버가 해시를 안 주면 시작 소스는 진행하지 않는다(fail-open 제거)", async () => {
    const { startFromPreset } = await import("./presets.ts");
    const dir = await mkdtemp(join(tmpdir(), "zalkera-preset-open-"));
    const api = {
        presetSourceUrl: async () => ({ url: "https://s3/p", version: "1.0.0", sha256: "", sizeBytes: 0, filename: "p.zip" }),
    } as never;

    await rejects(
        () =>
            startFromPreset({
                api,
                presetCode: "skeleton",
                targetDir: dir,
                fetchImpl: (async () => new Response(Buffer.from("x"))) as unknown as typeof fetch,
            }),
        (e: unknown) => e instanceof DevtoolsError && /검증할 수 없습니다/.test(e.message),
    );
});
