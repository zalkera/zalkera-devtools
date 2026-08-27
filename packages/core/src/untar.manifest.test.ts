import {deepEqual, rejects, strictEqual} from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {test} from "node:test";
import {gzipSync} from "node:zlib";
import {DevtoolsError} from "./errors.ts";
import {extractTarGz, readTarGzManifest} from "./untar.ts";
import {tempDir} from "./testing/tempDir.ts";

/** 항목 하나를 tar 블록으로. `type` 기본은 일반 파일. */
function entry(name: string, body: string | Buffer = "", type = "0", link = ""): Buffer {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write(type, 156);
    h.write(link.slice(0, 100), 157);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
    return Buffer.concat([h, data, pad]);
}
const tarGz = (...parts: Buffer[]) => gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("매니페스트는 경로별 sha 와 크기를 준다 — 디스크를 안 만진다", async () => {
    const m = await readTarGzManifest(tarGz(entry("app/page.tsx", "가"), entry("README.md", "나")));
    deepEqual(Object.keys(m).sort(), ["README.md", "app/page.tsx"]);
    strictEqual(m["app/page.tsx"]!.sha256, sha("가"));
    strictEqual(m["app/page.tsx"]!.bytes, Buffer.from("가").length);
});

test("🔴 파일이 아닌 것은 목록에 없다 — 폴더를 파일로 세면 pull 이 폴더를 덮으려 든다", async () => {
    const m = await readTarGzManifest(tarGz(
        entry("app/", "", "5"), entry("app/link", "", "2", "page.tsx"),
        entry("app/hard", "", "1", "page.tsx"), entry("app/page.tsx", "가"),
    ));
    deepEqual(Object.keys(m), ["app/page.tsx"]);
});

test("🔴 뿌리를 벗어나는 아카이브는 **파일 하나 쓰기 전에** 거절된다", async () => {
    await rejects(() => readTarGzManifest(tarGz(entry("../탈출.tsx", "가"))), DevtoolsError);
    await rejects(() => readTarGzManifest(tarGz(entry("/etc/passwd", "가"))), DevtoolsError);
});

test("🔴 «가상 뿌리»가 정상 경로를 거절하지 않는다 (`//` 회귀)", async () => {
    // 파일시스템 뿌리(`/`)를 그대로 쓰면 `root + sep` 가 `//` 라 **모든 경로가 밖으로 판정된다.**
    const m = await readTarGzManifest(tarGz(entry("a.tsx", "가"), entry("깊은/곳/b.tsx", "나")));
    deepEqual(Object.keys(m).sort(), ["a.tsx", "깊은/곳/b.tsx"]);
});

test("🔴 긴 이름 헤더를 해제 쪽과 **같게** 읽는다", async () => {
    const long = "아주/" + "긴".repeat(60) + "/page.tsx";
    const pax = Buffer.from(`${`${`path=${long}\n`.length + 4}`.length + 3} path=${long}\n`);
    const m = await readTarGzManifest(tarGz(
        entry("././@LongLink", long + "\0", "L"), entry("무시될이름", "가"),
        entry("PaxHeader", pax, "x"), entry("역시무시", "나"),
    ));
    deepEqual(Object.keys(m).sort(), [long].sort(), "L/x 이름 해석이 해제 쪽과 갈렸다");
    strictEqual(m[long]!.sha256, sha("나"), "뒤엣것이 이겨야 한다(같은 경로 두 번)");
});

test("항목 수 상한이 매니페스트 경로에도 선다", async () => {
    const many = Array.from({length: 5}, (_, i) => entry(`f${i}.tsx`, "가"));
    await rejects(() => readTarGzManifest(tarGz(...many), {maxEntries: 3}), DevtoolsError);
});

test("🔴 `decide` 가 «건드리지 마라»고 한 파일은 안 써진다", async () => {
    const dir = await tempDir("zalkera-decide-");
    await mkdir(join(dir, "app"), {recursive: true});
    await writeFile(join(dir, "app", "page.tsx"), "내가-고침");
    const count = await extractTarGz(tarGz(entry("app/page.tsx", "서버것"), entry("새것.tsx", "가")), dir, {
        decide: (p) => (p === "app/page.tsx" ? "skip" : "create"),
    });
    strictEqual(await readFile(join(dir, "app", "page.tsx"), "utf8"), "내가-고침", "지키라던 파일이 덮였다");
    strictEqual(count, 1);
});

test("🔴 `replace` 만 덮는다 — 기본은 여전히 «있는 파일 위에 안 쓴다»", async () => {
    const dir = await tempDir("zalkera-replace-");
    await writeFile(join(dir, "a.tsx"), "옛것");
    await rejects(() => extractTarGz(tarGz(entry("a.tsx", "새것")), dir), DevtoolsError);
    strictEqual(await readFile(join(dir, "a.tsx"), "utf8"), "옛것", "기본값이 덮었다");
    await extractTarGz(tarGz(entry("a.tsx", "새것")), dir, {decide: () => "replace"});
    strictEqual(await readFile(join(dir, "a.tsx"), "utf8"), "새것");
});

test("🔴 `replace` 라도 한 아카이브가 같은 경로를 두 번 담으면 거절이다", async () => {
    const dir = await tempDir("zalkera-twice-");
    await rejects(
        () => extractTarGz(tarGz(entry("a.tsx", "하나"), entry("a.tsx", "둘")), dir, {decide: () => "replace"}),
        DevtoolsError,
    );
});

test("🔴 `decide` 는 조각 검사를 지난 표기로 묻는다 — `./a` 로 우회 못 한다", async () => {
    const dir = await tempDir("zalkera-normal-");
    await writeFile(join(dir, "a.tsx"), "내가-고침");
    const asked: string[] = [];
    await extractTarGz(tarGz(entry("./a.tsx", "서버것")), dir, {
        decide: (p) => { asked.push(p); return p === "a.tsx" ? "skip" : "create"; },
    });
    deepEqual(asked, ["a.tsx"], "tar 가 신고한 이름 그대로 물었다");
    strictEqual(await readFile(join(dir, "a.tsx"), "utf8"), "내가-고침");
});

test("`decide` 없이는 종전과 같다", async () => {
    const dir = await tempDir("zalkera-default-");
    strictEqual(await extractTarGz(tarGz(entry("a.tsx", "가"), entry("b/c.tsx", "나")), dir), 2);
});
