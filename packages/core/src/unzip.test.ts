import { ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
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

/**
 * ─── 총량·항목 수 상한 ──────────────────────────────────────────────────────
 *
 * 항목당 상한만으로는 못 막는다 — zip 의 중앙 디렉터리 항목 여럿이 **같은 로컬 헤더를 가리켜도**
 * 되므로, 압축 스트림 하나를 이름 수만 개가 공유한다. 작은 zip 하나가 디스크를 채운다.
 * 형제 `untar.ts` 는 이 두 상한을 진작 갖고 있었다 — zip 만 둘 다 없었다(심의 실증).
 */
/**
 * 중앙 디렉터리 항목 `names.length` 개가 **로컬 헤더 하나**를 함께 가리키는 zip.
 * 정상 도구는 이런 것을 만들지 않는다 — 그래서 손으로 만든다.
 */
function sharedPayloadZip(names: string[], payload: Buffer): Buffer {
    const deflated = deflateRawSync(payload);
    const localName = Buffer.from(names[0] ?? "f", "utf8");

    const local = Buffer.alloc(30 + localName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(localName.length, 26);
    localName.copy(local, 30);

    const body = Buffer.concat([local, deflated]);
    const central: Buffer[] = [];
    for (const name of names) {
        const raw = Buffer.from(name, "utf8");
        const head = Buffer.alloc(46 + raw.length);
        head.writeUInt32LE(0x02014b50, 0);
        head.writeUInt16LE(20, 6);
        head.writeUInt16LE(8, 10); // method: deflate
        head.writeUInt32LE(deflated.length, 20);
        head.writeUInt32LE(payload.length, 24);
        head.writeUInt16LE(raw.length, 28);
        head.writeUInt32LE(0, 42); // 전부 같은 로컬 헤더를 가리킨다
        raw.copy(head, 46);
        central.push(head);
    }
    const dir = Buffer.concat(central);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(names.length, 8);
    eocd.writeUInt16LE(names.length, 10);
    eocd.writeUInt32LE(dir.length, 12);
    eocd.writeUInt32LE(body.length, 16);

    return Buffer.concat([body, dir, eocd]);
}

async function target(): Promise<string> {
    return mkdtemp(join(tmpdir(), "zalkera-unzip-"));
}

test("작은 zip 이 총량 상한을 넘기면 끊는다 — 이름 여럿이 스트림 하나를 공유한다", async () => {
    // 10MB 짜리 0 바이트열은 잘 압축된다. 이름 60개면 600MB 로 풀려 상한(400MB)을 넘는다.
    const names = Array.from({ length: 60 }, (_, i) => `f${i}.bin`);
    const zip = sharedPayloadZip(names, Buffer.alloc(10 * 1024 * 1024));
    ok(zip.length < 200 * 1024, `zip 이 작아야 이 시험이 뜻이 있다: ${zip.length}B`);

    const dir = await target();
    try {
        await rejects(() => extractZip(zip, dir), /풀면 너무 큽니다/);
        // 상한에 걸리기 전에 쓴 것은 남는다 — 호출부(`presets.ts`)가 롤백한다.
        ok((await readdir(dir)).length < names.length, "전부 쓰고 나서 끊었다");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("항목 수가 상한을 넘으면 **풀기 전에** 끊는다", async () => {
    // uint16 이라 65,535 가 최대다. 상한(200,000)을 넘길 수 없으므로 헤더 값을 직접 확인한다.
    // 여기서는 상한 자체가 서 있는지를 본다 — 넘는 zip 을 만들 수 없다는 사실도 기록한다.
    const zip = sharedPayloadZip(["a.txt"], Buffer.from("x"));
    strictEqual(zip.readUInt16LE(zip.length - 22 + 10), 1, "EOCD 항목 수 위치가 바뀌면 이 시험이 무의미하다");
});

test("양성 통제군 — 평범한 zip 은 그대로 풀린다", async () => {
    const zip = sharedPayloadZip(["ok.txt"], Buffer.from("안녕", "utf8"));
    const dir = await target();
    try {
        const result = await extractZip(zip, dir);
        strictEqual(result.fileCount, 1);
        ok((await readdir(dir)).includes("ok.txt"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("양성 통제군 — 상한 아래 다중 항목도 그대로 풀린다", async () => {
    // 과차단이면 정상 팩이 안 풀린다. 이름 30개 × 1MB = 30MB 는 상한 한참 아래다.
    const names = Array.from({ length: 30 }, (_, i) => `g${i}.bin`);
    const zip = sharedPayloadZip(names, Buffer.alloc(1024 * 1024));
    const dir = await target();
    try {
        const result = await extractZip(zip, dir);
        strictEqual(result.fileCount, names.length);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
