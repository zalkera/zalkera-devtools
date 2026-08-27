import {ok, strictEqual} from "node:assert/strict";
import {mkdir, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {test} from "node:test";
import {hashWorkdir, resolveExisting} from "./workdir.ts";
import {tempDir} from "./testing/tempDir.ts";

test("파일별 sha 를 낸다 · 배제 폴더에는 들어가지 않는다", async () => {
    const dir = await tempDir("zalkera-wd-");
    await mkdir(join(dir, "app"), {recursive: true});
    await mkdir(join(dir, "node_modules", "깊이"), {recursive: true});
    await writeFile(join(dir, "app", "page.tsx"), "가");
    await writeFile(join(dir, "node_modules", "깊이", "x.js"), "안 세야 함");
    await writeFile(join(dir, ".env"), "SECRET=1");
    const m = await hashWorkdir(dir);
    strictEqual(Object.keys(m).length, 1, `배제가 샜다: ${Object.keys(m)}`);
    ok(m["app/page.tsx"]);
});

test("🔴 장부 자신은 작업본 목록에 없다 — 있으면 매번 「새 파일」로 뜬다", async () => {
    const dir = await tempDir("zalkera-wd-ledger-");
    await mkdir(join(dir, ".zalkera", "saved", "2026"), {recursive: true});
    await writeFile(join(dir, ".zalkera", "sync.json"), "{}");
    await writeFile(join(dir, ".zalkera", "saved", "2026", "옛것.tsx"), "가");
    await writeFile(join(dir, ".zalkera", "ASSETS-LICENSE.md"), "배송 문서");
    const m = await hashWorkdir(dir);
    strictEqual(m[".zalkera/sync.json"], undefined, "장부가 목록에 들어왔다");
    strictEqual(m[".zalkera/saved/2026/옛것.tsx"], undefined, "치워 둔 것이 목록에 들어왔다");
    ok(m[".zalkera/ASSETS-LICENSE.md"], "배송 문서가 빠졌다 — `.zalkera` 를 통째로 뺐다");
});

test("파일 수 상한이 선다", async () => {
    const dir = await tempDir("zalkera-wd-cap-");
    for (let i = 0; i < 5; i += 1) await writeFile(join(dir, `f${i}.tsx`), "가");
    await hashWorkdir(dir, {maxEntries: 5});
    await hashWorkdir(dir, {maxEntries: 4}).then(
        () => { throw new Error("상한을 넘겼는데 통과했다"); },
        () => {},
    );
});

test("🔴 `resolveExisting` 은 폴더 밖으로 못 나간다", async () => {
    const dir = await tempDir("zalkera-resolve-");
    await writeFile(join(dir, "..", "피해자.txt"), "원본");
    await writeFile(join(dir, "a.tsx"), "가");
    strictEqual(await resolveExisting(dir, "../피해자.txt"), null, "`..` 로 나갔다");
    strictEqual(await resolveExisting(dir, "깊이/../../피해자.txt"), null, "중간 `..` 로 나갔다");
    strictEqual(await resolveExisting(dir, "/etc/passwd"), null, "절대경로가 통과했다");
    strictEqual(await resolveExisting(dir, ""), null);
    strictEqual(await resolveExisting(dir, "a.tsx\0b"), null, "널 바이트가 통과했다");
    ok(await resolveExisting(dir, "a.tsx"), "정상 경로가 막혔다");
});

test("🔴 `resolveExisting` 은 링크를 **안 따라간다** — 부모가 링크여도", async () => {
    const dir = await tempDir("zalkera-resolve-link-");
    const outside = join(dir, "..", "바깥");
    await mkdir(outside, {recursive: true});
    await writeFile(join(outside, "비밀.txt"), "원본");
    await symlink(outside, join(dir, "문"));
    await symlink(join(outside, "비밀.txt"), join(dir, "곧장.txt"));
    strictEqual(await resolveExisting(dir, "문/비밀.txt"), null, "링크 폴더를 지나 밖에 닿았다");
    strictEqual(await resolveExisting(dir, "곧장.txt"), null, "링크 파일 자체를 실물로 봤다");
});

test("없는 경로는 `null` 이다 — 지우기가 관용한다", async () => {
    const dir = await tempDir("zalkera-resolve-absent-");
    strictEqual(await resolveExisting(dir, "없음.tsx"), null);
});
