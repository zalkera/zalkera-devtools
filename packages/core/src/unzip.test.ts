import { ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevtoolsError } from "./errors.ts";
import { createZip } from "./zip.ts";
import { extractZip } from "./unzip.ts";

test("남이 만든 zip 을 푼다(우리 작성기가 아니라 파이썬 zipfile 산출물)", async () => {
    // **교차 확인이 핵심이다** — 우리 작성기로 만든 것만 풀면 "우리끼리만 맞는 형식"을 못 잡는다.
    // 서버가 주는 시작 소스 팩은 우리 작성기가 만든 것이 아니다.
    const dir = await mkdtemp(join(tmpdir(), "zalkera-unzip-src-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), '{"name":"시작 소스"}');
    await writeFile(join(dir, "src", "page.tsx"), "export default () => null;");
    execFileSync("python3", [
        "-c",
        `import zipfile,sys,os
d=sys.argv[1]
z=zipfile.ZipFile(os.path.join(d,"out.zip"),"w",zipfile.ZIP_DEFLATED)
z.write(os.path.join(d,"package.json"),"package.json")
z.write(os.path.join(d,"src","page.tsx"),"src/page.tsx")
z.close()`,
        dir,
    ]);

    const target = await mkdtemp(join(tmpdir(), "zalkera-unzip-out-"));
    const result = await extractZip(await readFile(join(dir, "out.zip")), target);

    strictEqual(result.fileCount, 2);
    strictEqual(await readFile(join(target, "package.json"), "utf8"), '{"name":"시작 소스"}');
    ok((await readFile(join(target, "src", "page.tsx"), "utf8")).includes("export default"));
});

test("우리 작성기와 해제기가 서로 맞는다(왕복)", async () => {
    const zip = await createZip([
        { path: "a/b/c.txt", data: Buffer.from("가나다", "utf8") },
        { path: "bin.dat", data: Buffer.from([0, 255, 128]) },
    ]);
    const target = await mkdtemp(join(tmpdir(), "zalkera-roundtrip-"));
    const result = await extractZip(zip, target);

    strictEqual(result.fileCount, 2);
    strictEqual(await readFile(join(target, "a", "b", "c.txt"), "utf8"), "가나다");
    strictEqual((await readFile(join(target, "bin.dat"))).length, 3);
});

test("폴더 밖을 가리키는 항목은 거절한다(Zip Slip)", async () => {
    const zip = await createZip([{ path: "../escaped.txt", data: Buffer.from("탈출") }]);
    const target = await mkdtemp(join(tmpdir(), "zalkera-slip-"));
    await rejects(
        () => extractZip(zip, target),
        (error: unknown) => error instanceof DevtoolsError && /폴더 밖/.test(error.message),
    );
});

test("zip 이 아닌 바이트는 형식 오류로 끊는다", async () => {
    const target = await mkdtemp(join(tmpdir(), "zalkera-notzip-"));
    await rejects(
        () => extractZip(Buffer.from("이건 zip 이 아니다"), target),
        (error: unknown) => error instanceof DevtoolsError && /zip 형식/.test(error.message),
    );
});

/**
 * ─── 심링크를 지난 쓰기 ────────────────────────────────────────────────────────
 *
 * 어휘 판정(`resolve`·`normalize`)만으로는 부족하다 — `resolve` 가 뿌리 안이라 해도 **부모 조각이
 * 심링크면** `writeFile` 은 그 링크를 따라간다. 이 판정은 tar 쪽에서 이미 한 번 뚫려 고쳐졌는데,
 * zip 쪽에는 *"같은 판정이어야 한다"* 는 주석만 있고 뚫린 어휘 판정이 남아 있었다.
 */
test("부모 조각이 심링크면 거부한다 — 문자열로는 뿌리 안이어도", async () => {
    const victim = await mkdtemp(join(tmpdir(), "victim-"));
    const target = await mkdtemp(join(tmpdir(), "target-"));
    try {
        await symlink(victim, join(target, ".vscode"));
        const zip = await createZip([{ path: ".vscode/settings.json", data: Buffer.from("PWNED\n") }]);
        await rejects(
            () => extractZip(zip, target),
            (error: unknown) => error instanceof DevtoolsError && /링크/.test(error.message),
            "심링크를 지나 폴더 밖에 썼다",
        );
        strictEqual(existsSync(join(victim, "settings.json")), false, "링크 대상에 파일이 생겼다");
    } finally {
        await rm(victim, { recursive: true, force: true });
        await rm(target, { recursive: true, force: true });
    }
});

test("파일 자리 자체가 심링크여도 거부한다", async () => {
    const victim = await mkdtemp(join(tmpdir(), "victim-"));
    const target = await mkdtemp(join(tmpdir(), "target-"));
    try {
        await writeFile(join(victim, "keep.txt"), "original\n");
        await symlink(join(victim, "keep.txt"), join(target, "a.txt"));
        const zip = await createZip([{ path: "a.txt", data: Buffer.from("PWNED\n") }]);
        await rejects(() => extractZip(zip, target), (error: unknown) => error instanceof DevtoolsError);
        strictEqual(await readFile(join(victim, "keep.txt"), "utf8"), "original\n");
    } finally {
        await rm(victim, { recursive: true, force: true });
        await rm(target, { recursive: true, force: true });
    }
});

test("통제군 — 심링크가 없으면 중첩 경로도 정상으로 푼다", async () => {
    const target = await mkdtemp(join(tmpdir(), "target-"));
    try {
        const zip = await createZip([
            { path: "a/b/c.txt", data: Buffer.from("ok\n") },
            { path: "top.txt", data: Buffer.from("ok\n") },
        ]);
        const result = await extractZip(zip, target);
        strictEqual(result.fileCount, 2);
        strictEqual(await readFile(join(target, "a", "b", "c.txt"), "utf8"), "ok\n");
    } finally {
        await rm(target, { recursive: true, force: true });
    }
});

test("중앙 디렉터리 오프셋이 깨져도 raw RangeError 가 아니라 우리 오류다", async () => {
    const zip = await createZip([{ path: "a.txt", data: Buffer.from("ok\n") }]);
    // EOCD 의 "중앙 디렉터리 시작 오프셋" 을 파일 밖으로 민다.
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const broken = Buffer.from(zip);
    broken.writeUInt32LE(0xfffffff0, eocd + 16);
    const target = await mkdtemp(join(tmpdir(), "target-"));
    try {
        await rejects(
            () => extractZip(broken, target),
            (error: unknown) => error instanceof DevtoolsError,
            "raw RangeError 가 사용자에게 그대로 갔다",
        );
    } finally {
        await rm(target, { recursive: true, force: true });
    }
});
