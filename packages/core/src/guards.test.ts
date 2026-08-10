import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { extractTarGz } from "./untar.ts";
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
