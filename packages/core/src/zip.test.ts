import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createZip, packProject, writeZip } from "./zip.ts";
import { tempDir } from "./testing/tempDir.ts";

async function fixture(): Promise<string> {
    const dir = await tempDir("zalkera-pack-");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "site" }));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "page.tsx"), "export default function Page() { return null; }");
    // 나가면 안 되는 것들.
    await mkdir(join(dir, "node_modules", "next"), { recursive: true });
    await writeFile(join(dir, "node_modules", "next", "index.js"), "// 거대 의존성");
    await mkdir(join(dir, ".next"), { recursive: true });
    await writeFile(join(dir, ".next", "build"), "산출물");
    await writeFile(join(dir, ".env.local"), "ZALKERA_STOREFRONT_KEY=oqsk_secret");
    // 출처 표식(`localMark.ts`). 이것이 정본에 실리면 다음 판을 받은 폴더가 낡은 거짓을 품는다.
    await mkdir(join(dir, ".zalkera"), { recursive: true });
    await writeFile(join(dir, ".zalkera", "source.json"), '{"format":1,"tenant":"a","revisionNo":13}');
    // 라이선스 대장·판 출처는 **남아야 한다** — 백엔드가 canonical tar 에서 일부러 남기고,
    // 배송 문서(CUSTOMIZE.md)가 그 실물을 가리킨다.
    await writeFile(join(dir, ".zalkera", "ASSETS-LICENSE.md"), "# 라이선스");
    await writeFile(join(dir, ".zalkera", "pack.json"), '{"rev":1,"code":"skeleton","version":"3.0.48"}');
    return dir;
}

test("zip 은 표준 해제기로 열린다(파이썬 zipfile 로 교차 확인)", async () => {
    const buffer = await createZip([
        { path: "a.txt", data: Buffer.from("가나다 hello", "utf8") },
        { path: "nested/b.bin", data: Buffer.from([0, 1, 2, 3, 255]) },
    ]);
    const dir = await tempDir("zalkera-zip-");
    const path = join(dir, "out.zip");
    await writeZip(path, buffer);

    const listed = execFileSync("python3", [
        "-c",
        `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None, "CRC 불일치"
print(z.read("a.txt").decode("utf-8"))
print(len(z.read("nested/b.bin")))`,
        path,
    ]).toString();

    ok(listed.includes("가나다 hello"), "UTF-8 내용 왕복");
    ok(listed.includes("5"), "이진 파일 길이 보존");
});

test("패킹은 node_modules·빌드 산출물·자격증명을 담지 않는다", async () => {
    const dir = await fixture();
    const result = await packProject({ projectDir: dir });
    // 픽스처 **밖**에 쓰면 `TMPDIR` 에 남는다. 안에 써도 이 시험이 재는 것은 이미 만들어진
    // 버퍼의 내용물이라 판정이 안 바뀐다.
    const path = join(await tempDir("zalkera-zipout-"), "packed.zip");
    await writeZip(path, result.buffer);

    const names = execFileSync("python3", [
        "-c",
        `import zipfile,sys
print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))`,
        path,
    ])
        .toString()
        .trim()
        .split("\n");

    ok(names.includes("package.json"), "소스는 담긴다");
    ok(names.includes("src/page.tsx"), "중첩 소스도 담긴다");
    ok(!names.some((n) => n.startsWith("node_modules/")), "의존성 제외");
    ok(!names.some((n) => n.startsWith(".next/")), "빌드 산출물 제외");
    ok(!names.includes(".env.local"), "자격증명 제외 — 여기서 새면 미리보기 키가 서버로 올라간다");
    // ⚠ **소문자로 조회한다**(`ALWAYS_EXCLUDED` 주석) — 대문자 항목은 안 걸린다.
    ok(
        !names.some((n) => n.toLowerCase() === ".zalkera/source.json"),
        "출처 표식 제외 — 실리면 「나는 그 판에서 왔다」는 낡은 거짓이 그 판을 받는 모두에게 복제된다",
    );
    // ⚠ **폴더째 빼면 안 된다.** 배송 문서가 가리키는 라이선스 대장이 매달린 참조가 된다.
    ok(names.includes(".zalkera/ASSETS-LICENSE.md"), "라이선스 대장이 빠졌다");
    ok(names.includes(".zalkera/pack.json"), "판 출처가 빠졌다");
    strictEqual(result.fileCount, names.length);
});

test("같은 소스는 같은 바이트를 낸다(재현 가능)", async () => {
    const dir = await fixture();
    const first = await packProject({ projectDir: dir });
    const second = await packProject({ projectDir: dir });
    strictEqual(first.sha256, second.sha256, "타임스탬프가 섞이면 매번 다른 zip 이 된다");
});

test("🔴 치워 둔 자리는 **정본 zip 에도** 안 실린다 — 접두 배제가 포장기에 안 닿았다", async () => {
    // 심의 실측: `packProject` 의 훑기가 `EXCLUDED_PATHS` 만 인라인으로 보고 접두는 안 봤다.
    // 「둘째 겹」이라 적혀 있었는데 정작 정본을 만드는 경로에는 안 닿았다.
    const dir = await tempDir("zalkera-pack-saved-");
    await mkdir(join(dir, ".zalkera", "saved", "2026-08-27"), {recursive: true});
    await writeFile(join(dir, ".zalkera", "saved", "2026-08-27", "옛작업.tsx"), "치워 둔 것");
    await writeFile(join(dir, ".zalkera", "ASSETS-LICENSE.md"), "배송 문서");
    await writeFile(join(dir, "app.tsx"), "가");
    const result = await packProject({projectDir: dir});
    const path = join(await tempDir("zalkera-zipout-saved-"), "packed.zip");
    await writeZip(path, result.buffer);
    const names = execFileSync("python3", [
        "-c",
        `import zipfile,sys
print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))`,
        path,
    ]).toString().trim().split("\n");
    ok(!names.some((n) => n.startsWith(".zalkera/saved/")), `치워 둔 것이 실렸다: ${names}`);
    ok(names.includes(".zalkera/ASSETS-LICENSE.md"), `배송 문서가 빠졌다: ${names}`);
    ok(names.includes("app.tsx"));
});
