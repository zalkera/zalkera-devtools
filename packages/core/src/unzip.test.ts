import { ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
