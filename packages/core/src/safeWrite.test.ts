import { ok, rejects, strictEqual } from "node:assert/strict";
import { link, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { writeOwnFile } from "./safeWrite.ts";
import { tempDir } from "./testing/tempDir.ts";

/**
 * 우리가 소유하는 파일 쓰기의 계약.
 *
 * 종전 판은 `lstat` 로 심링크만 막았고, 막을 자리를 **손으로 열거**했다. 그 방식은 셋을 놓쳤다:
 * 하드링크 · `lstat`↔`write` 사이의 교체 · **열거에서 빠진 자리**(다섯 중 셋만 덮여 `.gitignore`
 * 쓰기가 가드 밖에 있었다). `rename` 은 디렉터리 항목만 바꾸므로 셋이 같이 닫힌다.
 */
async function victimAnd(setup: (proj: string, target: string) => Promise<unknown>) {
    const victim = await tempDir("victim-");
    const proj = await tempDir("proj-");
    const target = join(victim, "t");
    await writeFile(target, "ORIGINAL\n");
    await setup(proj, target);
    return { proj, target, at: join(proj, "owned.txt") };
}

test("자리가 **심링크**면 쓰지 않고 사람에게 말한다", async () => {
    const { target, at } = await victimAnd((p, t) => symlink(t, join(p, "owned.txt")));
    await rejects(() => writeOwnFile(at, "MINE\n"), /링크라 쓰지 않았습니다/);
    strictEqual(await readFile(target, "utf8"), "ORIGINAL\n", "링크 대상이 바뀌었다");
    ok(await readlink(at), "링크를 조용히 지웠다 — 고객이 건 링크는 우리가 말없이 끊지 않는다");
});

test("자리가 **하드링크**여도 링크 대상에 쓰지 않는다 — `lstat` 로는 못 막는 형태", async () => {
    const { target, at } = await victimAnd((p, t) => link(t, join(p, "owned.txt")));
    await writeOwnFile(at, "MINE\n");
    strictEqual(await readFile(target, "utf8"), "ORIGINAL\n", "하드링크 대상이 바뀌었다");
    strictEqual(await readFile(at, "utf8"), "MINE\n");
});

test("통제군 — `lstat` 판정만으로는 하드링크가 통과한다(이 시험이 무엇을 막는지)", async () => {
    const { at } = await victimAnd((p, t) => link(t, join(p, "owned.txt")));
    const { lstat } = await import("node:fs/promises");
    strictEqual((await lstat(at)).isSymbolicLink(), false, "하드링크가 심링크로 보인다 — 전제가 깨졌다");
});

test("끊어진 심링크도 같다 — 대상을 만들지 않는다", async () => {
    const proj = await tempDir("proj-");
    const dangling = join(proj, "nowhere");
    await symlink(dangling, join(proj, "owned.txt"));
    await rejects(() => writeOwnFile(join(proj, "owned.txt"), "MINE\n"), /링크라 쓰지 않았습니다/);
    await rejects(() => readFile(dangling, "utf8"), "링크 대상을 만들었다");
});

test("통제군 — 평범한 갱신·생성은 그대로 된다", async () => {
    const proj = await tempDir("proj-");
    const at = join(proj, "owned.txt");
    await writeOwnFile(at, "FIRST\n");
    strictEqual(await readFile(at, "utf8"), "FIRST\n");
    await writeOwnFile(at, "SECOND\n");
    strictEqual(await readFile(at, "utf8"), "SECOND\n");
});

test("권한을 준 대로 붙인다 — 자격증명 파일은 0600 이다", async () => {
    const proj = await tempDir("proj-");
    const at = join(proj, "owned.txt");
    await writeOwnFile(at, "SECRET\n", 0o600);
    const { stat } = await import("node:fs/promises");
    strictEqual((await stat(at)).mode & 0o777, 0o600);
});

test("임시 파일을 남기지 않는다", async () => {
    const proj = await tempDir("proj-");
    await writeOwnFile(join(proj, "owned.txt"), "MINE\n");
    const { readdir } = await import("node:fs/promises");
    const left = (await readdir(proj)).filter((f) => f.includes(".tmp"));
    ok(left.length === 0, `임시 파일이 남았다: ${left.join(" ")}`);
});


test("NUL 이 든 항목 이름을 거절한다", async () => {
    const { safeSegments } = await import("./safeWrite.ts");
    const proj = await tempDir("proj-");
    // NUL 뒤는 많은 시스템 호출이 잘라 읽는다 — `a\u0000.png` 가 `a` 로 착지하면 남의 파일을 덮는다.
    for (const name of ["a\u0000.txt", "dir/b\u0000", "\u0000"]) {
        let threw = false;
        try {
            safeSegments(proj, name);
        } catch {
            threw = true;
        }
        ok(threw, `${JSON.stringify(name)} 가 통과했다`);
    }
    // 통제군 — 평범한 이름은 그대로 쪼갠다.
    strictEqual(safeSegments(proj, "a/b/c.txt").length, 3);
});
