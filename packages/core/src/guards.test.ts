import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { extractTarGz } from "./untar.ts";
import { packProject } from "./zip.ts";
import { isSafeHttpsUrl } from "./payload.ts";
import { protectedPathWarning } from "./diagnostics.ts";
import { DevtoolsError } from "./errors.ts";

/**
 * **가드가 실제로 막는지** 재는 파일.
 *
 * ■ 왜 따로 있나 (심의 실측 · 2026-08-10)
 *   심의가 변이 테스트로 **"지워도 초록인 가드 13건"** 을 셌다. 가장 아픈 것: Zip Slip 루트 검사를
 *   지운 채로 `../victim/secret.txt` 가 해제 루트 **밖** 파일을 실제로 덮어썼는데 테스트 전량이
 *   통과했다. OAuth `state` 검증을 삭제해도 115/115 초록이었다.
 *
 *   가드가 있다는 것과 가드가 지켜진다는 것은 다르다. 여기 있는 시험은 **가드를 지우면 반드시 빨개진다** —
 *   그것이 이 파일의 유일한 존재 이유다. 고치는 사람이 이 파일을 우회하면 안 된다.
 *
 * ■ 쓰는 법
 *   가드를 고칠 때는 여기 대응하는 시험을 **먼저 깨뜨려 보라.** 안 깨지면 그 시험이 가짜다.
 */

const scratch = () => mkdtemp(join(tmpdir(), "zalkera-guard-"));

/**
 * tar 를 **바이트로 짓는다.** 디스크에 만들어 `tar` 로 묶으면 이런 아카이브를 만들 수 없다 —
 * `../` 나 절대경로는 표준 tar 가 스스로 정규화해 버린다. 공격자는 그런 배려를 하지 않는다.
 */
function tarGz(entries: { name: string; body?: string; type?: string; link?: string }[]): Buffer {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
        const body = Buffer.from(entry.body ?? "");
        const h = Buffer.alloc(512);
        h.write(entry.name.slice(0, 100), 0);
        h.write("0000644\0", 100);
        h.write("0000000\0", 108);
        h.write("0000000\0", 116);
        h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
        h.write("00000000000\0", 136);
        h.write("        ", 148);
        h.write(entry.type ?? "0", 156);
        h.write((entry.link ?? "").slice(0, 100), 157);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
        blocks.push(h);
        if (body.length > 0) {
            const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
            body.copy(padded);
            blocks.push(padded);
        }
    }
    blocks.push(Buffer.alloc(1024)); // 종료 표식
    return gzipSync(Buffer.concat(blocks));
}

// ── 경로 이탈 ───────────────────────────────────────────────────────────────
// 이 넷이 같은 가드의 네 얼굴이다. 하나만 잠그면 나머지로 들어온다.

test("가드 — `../` 로 해제 루트를 벗어나지 못한다", async () => {
    const root = await scratch();
    const outside = join(root, "..", `victim-${process.pid}.txt`);
    await writeFile(outside, "원래 내용", "utf8");

    await rejects(
        () => extractTarGz(tarGz([{ name: `../victim-${process.pid}.txt`, body: "OWNED" }]), root),
        (error: unknown) => error instanceof DevtoolsError && error.code === "SERVER_REJECTED",
    );
    strictEqual(await readFile(outside, "utf8"), "원래 내용", "루트 밖 파일이 그대로여야 한다");
});

test("가드 — 절대경로를 거절한다", async () => {
    const root = await scratch();
    await rejects(
        () => extractTarGz(tarGz([{ name: "/etc/zalkera-owned", body: "OWNED" }]), root),
        (error: unknown) => error instanceof DevtoolsError && error.code === "SERVER_REJECTED",
    );
});

test("가드 — 윈도 드라이브 문자 경로를 거절한다", async () => {
    // POSIX 에서 돌려도 의미가 있다. 판정은 문자열이고, 윈도에서만 빨개지는 시험은 아무도 안 돌린다.
    const root = await scratch();
    await rejects(
        () => extractTarGz(tarGz([{ name: "C:/Windows/zalkera-owned", body: "OWNED" }]), root),
        (error: unknown) => error instanceof DevtoolsError && error.code === "SERVER_REJECTED",
    );
});

test("가드 — 여러 겹 `../` 도 막는다", async () => {
    const root = await scratch();
    await rejects(
        () => extractTarGz(tarGz([{ name: "a/b/../../../../../../tmp/zalkera-owned", body: "OWNED" }]), root),
        (error: unknown) => error instanceof DevtoolsError && error.code === "SERVER_REJECTED",
    );
});

// ── 상한 ────────────────────────────────────────────────────────────────────

test("가드 — 항목 수 상한이 tar 에도 있다", async () => {
    // 실측(심의): 141KB gz 가 20,000 항목으로 풀렸다. 바이트 상한은 **작은 파일 수백만 개**를 못 막는다 —
    // inode 고갈과 몇 시간짜리 해제가 그 모습이다.
    //
    // ⚠ 초판은 기본 상한(20만)을 실제로 넘겨 재려 했고 **/tmp 를 채웠다**(실측). 가드를 재는 시험이
    // 가드가 막으려는 바로 그 손해를 내면 안 된다. 주입한 상한으로 **같은 코드 경로**를 잰다.
    const root = await scratch();
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt` }));
    await rejects(
        () => extractTarGz(tarGz(many), root, { maxEntries: 3 }),
        (error: unknown) => error instanceof DevtoolsError && /항목이 너무 많습니다/.test(error.message),
    );

    // 상한 안이면 통과해야 한다 — "항상 던진다"로 통과하는 가짜 가드를 배제한다.
    strictEqual(await extractTarGz(tarGz(many), await scratch(), { maxEntries: 10 }), 5);
});

test("가드 — maxBytes 가 **버퍼 경로에서도** 듣는다", async () => {
    // 종전에는 스트리밍 경로만 이 값을 봤다(심의 실측: maxBytes 1024 인데 20,000 파일 기록).
    // 호출부가 건 상한이 경로에 따라 있다 없다 하면 그건 상한이 아니다.
    const root = await scratch();
    const big = tarGz([{ name: "big.txt", body: "x".repeat(100_000) }]);
    await rejects(
        () => extractTarGz(big, root, { maxBytes: 1024 }),
        (error: unknown) => error instanceof DevtoolsError,
    );
});

test("가드 — 중간에 끊긴 아카이브를 조용히 쓰지 않는다", async () => {
    const root = await scratch();
    const full = tarGz([{ name: "a.txt", body: "x".repeat(2000) }]);
    // gz 를 풀어 뒤를 자른 뒤 다시 압축한다 — "받다 만" 상태를 흉내 낸다.
    const { gunzipSync } = await import("node:zlib");
    const raw = gunzipSync(full);
    const truncated = gzipSync(raw.subarray(0, 512 + 512));

    await rejects(
        () => extractTarGz(truncated, root),
        (error: unknown) => error instanceof DevtoolsError && /끊겼습니다/.test(error.message),
    );
});

// ── URL 스킴 ────────────────────────────────────────────────────────────────

test("가드 — 서버가 준 주소는 https 만 받는다", () => {
    // 실측(재심의): Node 의 fetch 는 `data:` 를 받는다. 스킴 검사를 지우면 서버 오염 하나가
    // **로컬 파일 읽기·인라인 페이로드 주입**으로 번진다.
    ok(isSafeHttpsUrl("https://deps.zalkera.com/v1/x.tar.gz"));
    for (const bad of [
        "http://deps.zalkera.com/x.tar.gz",
        "data:application/gzip;base64,H4sIAAAAAAAA",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "ftp://example.com/x",
        "",
        "그냥 문자열",
    ]) {
        strictEqual(isSafeHttpsUrl(bad), false, `막아야 한다: ${bad}`);
    }
});

// ── 발행 zip 에 실리면 안 되는 것 ───────────────────────────────────────────

test("가드 — 우리가 만든 설정 파일이 발행 zip 에 실리지 않는다", async () => {
    // 심의 실측(2026-08-10): `.mcp.json` 과 `.vscode/settings.json` 이 **실제로 실렸다.**
    // 제외 목록이 옛 기준으로 쓰인 뒤 우리가 파일을 늘렸는데 목록을 안 늘린 것이다.
    //
    // 왜 무거운가: 둘 다 **우리가 만든다.** `.vscode/settings.json` 에는 우리가 적은 `zalkera.tenant`
    // 가 있고, 그것이 정본 소스로 유통되면 그 소스를 받아 연 사람의 확장이 조용히 그 테넌트를 가리킨다.
    // `.mcp.json` 은 남의 MCP 서버 항목을 일부러 보존하는데, 그 항목이 토큰을 들고 다닐 수 있다.
    const dir = await scratch();
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, ".mcp.json"), '{"mcpServers":{"github":{"env":{"GITHUB_TOKEN":"ghp_leaked"}}}}');
    await mkdir(join(dir, ".vscode"), { recursive: true });
    await writeFile(join(dir, ".vscode", "settings.json"), '{"zalkera.tenant":"other-tenant"}');
    await mkdir(join(dir, ".idea"), { recursive: true });
    await writeFile(join(dir, ".idea", "workspace.xml"), "<x/>");

    const packed = await packProject({ projectDir: dir });

    strictEqual(packed.fileCount, 1, "package.json 하나만 실려야 한다");
    ok(!packed.buffer.includes(Buffer.from("ghp_leaked")), "남의 토큰이 아카이브에 없어야 한다");
    ok(!packed.buffer.includes(Buffer.from("other-tenant")), "테넌트 코드가 아카이브에 없어야 한다");
});

test("가드 — 확장자·이름으로 거르는 자격증명이 발행 zip 에 실리지 않는다", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "package.json"), "{}");
    for (const name of [
        "deploy.pem", "server.key", "cert.p12", "cert.pfx",
        ".netrc", ".git-credentials", ".yarnrc.yml",
        "service-account.json", "service-account-prod.json",
        // 대소문자가 달라도 같은 파일이다 — 이름으로 거르는 가드의 고전적 구멍.
        "Deploy.PEM", ".NETRC",
    ]) {
        await writeFile(join(dir, name), "SECRET_MARKER_9f2a");
    }

    const packed = await packProject({ projectDir: dir });

    strictEqual(packed.fileCount, 1, "package.json 하나만 실려야 한다");
    ok(!packed.buffer.includes(Buffer.from("SECRET_MARKER_9f2a")), "아카이브 어디에도 비밀이 없어야 한다");
});

test("가드 — 심의가 실측으로 찾아낸 새던 이름 넷", async () => {
    // 전부 **관례가 굳은 표준 이름**이라 블록리스트가 전수일 수 없다는 변명이 안 통하는 자리다.
    const dir = await scratch();
    await writeFile(join(dir, "package.json"), "{}");
    for (const name of [
        "production.env", // docker compose env_file 관례 — `.env` 로 시작하지 않는다
        "AuthKey_ABC123.p8", // 애플 푸시 키
        "myproj-firebase-adminsdk-x1y2.json", // GCP 콘솔이 주는 **기본** 파일명
        "_netrc", // 윈도 변형
        ".VSCode", // 대소문자 — 디렉터리 판정이 타면 안 된다
    ]) {
        if (name === ".VSCode") continue;
        await writeFile(join(dir, name), "SECRET_MARKER_7c3e");
    }
    await mkdir(join(dir, ".VSCode"), { recursive: true });
    await writeFile(join(dir, ".VSCode", "settings.json"), '{"zalkera.tenant":"leaked-tenant"}');
    // ⚠ 이 줄이 없어서 회귀를 놓쳤다(재심의 실측). 제외 목록에서 **유일하게 혼합 대소문자**였던
    // 항목이라, 조회를 소문자로 바꾸자 조용히 안 걸리게 됐는데 시험 129건이 전부 초록이었다.
    // `.DS_Store` 는 형제 파일명(제외된 비밀 파일 이름까지)을 담는다.
    await writeFile(join(dir, ".DS_Store"), "SECRET_MARKER_7c3e");

    const packed = await packProject({ projectDir: dir });

    strictEqual(packed.fileCount, 1, "package.json 하나만 실려야 한다");
    ok(!packed.buffer.includes(Buffer.from("SECRET_MARKER_7c3e")));
    ok(!packed.buffer.includes(Buffer.from("leaked-tenant")));
});

test("가드 — 비밀로 판단해 뺀 것은 이름을 대고 말한다", async () => {
    // 이 코드베이스가 스스로 세운 원칙("조용히 빼지 않는다")이 이 경로에만 없었다.
    const dir = await scratch();
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "turkey.key"), "이건 사실 비밀이 아니다");

    const said: string[] = [];
    await packProject({ projectDir: dir, onProgress: (m) => said.push(m) });

    ok(said.some((m) => m.includes("turkey.key")), `이름을 대야 한다 — 실제 출력: ${said.join(" | ")}`);
});

test("가드 — `.env` 로 **시작**하는 것은 전부 뺀다", async () => {
    // 클로징 심의(Fable·Opus 공통 차단 · 실측 유출). 주석과 도움말은 처음부터 "시작"이라고 적었는데
    // 코드만 `.env.` 로 점을 하나 더 요구했다. 그 한 글자 틈으로 나가던 것들이다.
    const dir = await scratch();
    await writeFile(join(dir, "package.json"), "{}");
    for (const name of [
        ".envrc", // direnv — `export AWS_SECRET_ACCESS_KEY=…` 가 관례
        ".env~", // 편집기 백업 — **`.env` 의 바이트 사본**이다
        ".env.local.swp",
        ".env.production",
    ]) {
        await writeFile(join(dir, name), "SECRET_MARKER_env1");
    }

    const packed = await packProject({ projectDir: dir });

    strictEqual(packed.fileCount, 1);
    ok(!packed.buffer.includes(Buffer.from("SECRET_MARKER_env1")));
});

test("가드 — 제외 목록의 **모든** 항목이 실제로 걸린다", async () => {
    // 심의가 변이로 셌다: 새 시험 5개가 `.mcp.json`·`.vscode`·`.idea` 는 잠갔는데 **같은 커밋에서
    // 넣은 `.ssh`·`.aws` 는 안 잠갔다** — 목록 안에서 또 일부만 지킨 것이다. 전량을 돈다.
    for (const name of [
        ".git", ".claude", ".ssh", ".aws", ".turbo", ".vercel", "dist", "out",
        ".next", "node_modules", ".ds_store", ".vscode", ".idea", ".mcp.json",
    ]) {
        const dir = await scratch();
        await writeFile(join(dir, "package.json"), "{}");
        if (name.includes(".json") || name === ".ds_store") {
            await writeFile(join(dir, name === ".ds_store" ? ".DS_Store" : name), "DROP_ME");
        } else {
            await mkdir(join(dir, name), { recursive: true });
            await writeFile(join(dir, name, "x.txt"), "DROP_ME");
        }
        const packed = await packProject({ projectDir: dir });
        strictEqual(packed.fileCount, 1, `${name} 이 걸려야 한다`);
    }
});

test("가드 — SSH 키 이름 네 형제가 모두 걸린다", async () => {
    // `id_rsa` 만 시험에 있었다(심의 실측). 형제 중 하나만 지키는 가드는 가드가 아니다.
    const dir = await scratch();
    await writeFile(join(dir, "package.json"), "{}");
    for (const name of ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]) {
        await writeFile(join(dir, name), "SECRET_MARKER_ssh1");
    }

    const packed = await packProject({ projectDir: dir });

    strictEqual(packed.fileCount, 1);
    ok(!packed.buffer.includes(Buffer.from("SECRET_MARKER_ssh1")));
});

test("가드 — 제외가 과하지 않다(평범한 소스는 실린다)", async () => {
    // **"전부 빼면 통과"하는 가짜 가드를 배제한다.** 위 두 시험만 있으면 제외 목록에 모든 것을 넣어도
    // 초록이다 — 그러면 아무것도 못 올리는 도구가 된다.
    const dir = await scratch();
    await writeFile(join(dir, "package.json"), '{"name":"site"}');
    await mkdir(join(dir, "src", "app"), { recursive: true });
    await writeFile(join(dir, "src", "app", "page.tsx"), "export default function Page() {}");
    await writeFile(join(dir, "README.md"), "# 사이트");
    // 이름이 비슷하지만 비밀이 아닌 것들 — 과잉 제외의 단골이다.
    await writeFile(join(dir, "environment.ts"), "export const x = 1;");
    await writeFile(join(dir, "keyboard.ts"), "export const y = 2;");
    await writeFile(join(dir, "service-accounts.tsx"), "export default function A() {}");

    const packed = await packProject({ projectDir: dir });

    strictEqual(packed.fileCount, 6, "여섯 개가 전부 실려야 한다");
    ok(packed.buffer.includes(Buffer.from("export default function Page")), "소스 내용이 들어 있어야 한다");
});

// ── 되돌리기 어려운 자리 ────────────────────────────────────────────────────

test("가드 — 보호 경로 경고가 실제로 그 세 갈래를 짚는다", () => {
    // 세 갈래다: 자격증명 · 의존성 트리(하드링크로 다른 프로젝트까지 번진다) · 빌드 산출물.
    for (const path of [".env", ".env.local", ".env.production", "node_modules/next/index.js", "dist/app.js", ".next/x", "out/y"]) {
        ok(protectedPathWarning(path), `경고가 있어야 한다: ${path}`);
    }
    // 윈도 구분자로 와도 같은 판정이어야 한다 — 경고가 OS 따라 있다 없다 하면 그건 경고가 아니다.
    ok(protectedPathWarning("node_modules\\next\\index.js"));

    // ⚠ `package-lock.json` 은 **보호 대상이 아니다**(구현자가 처음에 그렇다고 착각했다).
    // 여기 적어 두는 이유는, 나중에 넣기로 정하면 이 줄이 먼저 빨개져야 하기 때문이다.
    for (const path of ["src/app/page.tsx", "README.md", "package-lock.json", "envelope.ts"]) {
        strictEqual(protectedPathWarning(path), null, `평범한 파일은 조용해야 한다: ${path}`);
    }
});
