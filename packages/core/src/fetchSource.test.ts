import { ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { DevtoolsError } from "./errors.ts";
import { extractTarGz, findProjectRoot } from "./fetchSource.ts";

/** 실제 tar 로 만든 아카이브 — 우리 해제기가 **표준 tar** 를 읽는지 보려면 표준 도구로 만들어야 한다. */
async function realTarGz(): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-tar-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), '{"name":"내 사이트"}');
    await writeFile(join(dir, "src", "page.tsx"), "export default () => null;");
    execFileSync("tar", ["-czf", join(dir, "out.tgz"), "-C", dir, "package.json", "src"]);
    return readFile(join(dir, "out.tgz"));
}

test("표준 tar.gz 를 해제한다(중첩 폴더·UTF-8 내용 포함)", async () => {
    const target = await mkdtemp(join(tmpdir(), "zalkera-out-"));
    const count = await extractTarGz(await realTarGz(), target);

    strictEqual(count, 2);
    strictEqual(await readFile(join(target, "package.json"), "utf8"), '{"name":"내 사이트"}');
    ok((await readdir(join(target, "src"))).includes("page.tsx"));
});

test("폴더 밖을 가리키는 경로는 거절한다(경로 탈출)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zalkera-evil-"));
    await writeFile(join(dir, "evil.txt"), "탈출 시도");
    // `-P` 로 `../` 를 그대로 담는다 — 우리 해제기가 이것을 막아야 한다.
    execFileSync("bash", ["-c", `cd ${dir} && tar -czf evil.tgz -P --transform 's|evil.txt|../escaped.txt|' evil.txt`]);

    const target = await mkdtemp(join(tmpdir(), "zalkera-out-"));
    const archive = await readFile(join(dir, "evil.tgz"));
    await rejects(
        () => extractTarGz(archive, target),
        (error: unknown) => error instanceof DevtoolsError && /폴더 밖|이상한 경로/.test(error.message),
    );
});

test("절대 경로 항목은 거절한다", async () => {
    // 표준 tar 로는 절대 경로를 담기 어렵고(도구가 앞의 `/` 를 떼어 낸다), 실수로 `/tmp` 전체를 담는 사고가
    // 나기 쉽다. 그래서 **헤더를 손으로 만든다** — 겨냥한 한 가지만 재현하고 즉시 끝난다.
    const header = Buffer.alloc(512);
    header.write("/etc/passwd", 0, "utf8"); // name
    header.write("0000644\0", 100);
    header.write("00000000000\0", 124); // size 0
    header.write("0", 156); // type = 일반 파일
    header.write("        ", 148); // checksum 자리(우리 해제기는 검사하지 않는다)
    const tar = Buffer.concat([header, Buffer.alloc(1024)]);

    const target = await mkdtemp(join(tmpdir(), "zalkera-out-"));
    await rejects(
        () => extractTarGz(gzipSync(tar), target),
        (error: unknown) => error instanceof DevtoolsError && /이상한 경로/.test(error.message),
    );
});

test("한 겹 감싼 아카이브에서도 프로젝트 뿌리를 찾는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "zalkera-root-"));
    const inner = join(root, "site-v3");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "package.json"), "{}");

    strictEqual(await findProjectRoot(root), inner);
    strictEqual(await findProjectRoot(inner), inner, "이미 뿌리면 그대로");
});
