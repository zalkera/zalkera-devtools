import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { snapshotEntries } from "./emptyDir.ts";
import { declaredBaseRevisionNo, parseSourceMark } from "./localMark.ts";
import { clearStaleOwnState, occupiedLine } from "./ownState.ts";
import { tempDir } from "./testing/tempDir.ts";

/**
 * **받기·zip 풀기 뒤 옛 자기 상태 파일 정리** — 「빈 폴더」 판정이 우리 표식·장부만 든 폴더를 통과시키므로,
 * 성공한 뒤 그 파일이 새 내용에 대해 거짓(옛 판 · 옛 소속)을 말하지 않게 한다.
 */

const FETCHED = JSON.stringify({ format: 1, tenant: "a", revisionNo: 3, sha256: "x".repeat(64), fetchedAt: "t" });
const LINKED_B = JSON.stringify({ format: 2, origin: "linked", tenant: "b", linkedAt: "t" });

async function folderWith(mark: string | null, ledger: boolean): Promise<string> {
    const dir = await tempDir("zalkera-own-");
    await mkdir(join(dir, ".zalkera"));
    if (mark !== null) await writeFile(join(dir, ".zalkera", "source.json"), mark);
    if (ledger) await writeFile(join(dir, ".zalkera", "sync.json"), "{}");
    return dir;
}

const markAt = async (dir: string) =>
    parseSourceMark(await readFile(join(dir, ".zalkera", "source.json"), "utf8").catch(() => null));

test("zip 풀기: 판을 주장하던 표식은 «같은 사이트의 연결 표식»으로 낮춘다 — 소속은 그대로, 판 주장만 뺀다", async () => {
    const dir = await folderWith(FETCHED, false);
    const before = await snapshotEntries(dir);
    deepStrictEqual(await clearStaleOwnState(dir, before, "imported"), [".zalkera/source.json"]);
    const mark = await markAt(dir);
    strictEqual(mark?.tenant, "a", "소속이 바뀌었다 — 지우기만 하면 표식이 말하던 사이트가 사라진다");
    strictEqual(declaredBaseRevisionNo(mark, "a"), null, "zip 을 푼 폴더가 여전히 판 3 을 주장한다 — 다음 발행이 거짓 동의를 띄운다");
});

test("zip 풀기: 연결 표식·못 읽는 표식은 건드리지 않는다", async () => {
    const linked = await folderWith(LINKED_B, false);
    deepStrictEqual(await clearStaleOwnState(linked, await snapshotEntries(linked), "imported"), []);
    strictEqual((await markAt(linked))?.tenant, "b");
    const garbled = await folderWith("{broken", false);
    deepStrictEqual(await clearStaleOwnState(garbled, await snapshotEntries(garbled), "imported"), []);
    strictEqual(await readFile(join(garbled, ".zalkera", "source.json"), "utf8"), "{broken", "모르는 것을 덮었다");
});

test("받기: 옛 표식은 어느 형상이든 지운다 — 부르는 쪽이 받은 판으로 새로 쓴다", async () => {
    for (const mark of [FETCHED, LINKED_B, "{broken"]) {
        const dir = await folderWith(mark, false);
        deepStrictEqual(await clearStaleOwnState(dir, await snapshotEntries(dir), "fetched"), [".zalkera/source.json"]);
        deepStrictEqual(await readdir(join(dir, ".zalkera")), [], `옛 표식이 남았다: ${mark}`);
    }
});

test("CLI 장부는 두 갈래 모두 지운다 · 기준선에 없던 것은 건드리지 않는다", async () => {
    for (const kind of ["fetched", "imported"] as const) {
        const dir = await folderWith(null, true);
        const before = await snapshotEntries(dir);
        deepStrictEqual(await clearStaleOwnState(dir, before, kind), [".zalkera/sync.json"]);
    }
    // 양성 짝 — 기준선 뒤에 생긴 표식(해제가 쓴 것)은 새 내용의 것이다
    const fresh = await tempDir("zalkera-own-fresh-");
    const before = await snapshotEntries(fresh);
    await mkdir(join(fresh, ".zalkera"));
    await writeFile(join(fresh, ".zalkera", "source.json"), FETCHED);
    deepStrictEqual(await clearStaleOwnState(fresh, before, "fetched"), []);
    ok((await readdir(join(fresh, ".zalkera"))).includes("source.json"));
});

test("거절 문면의 「있는 것」은 앞 넷과 나머지 수를 말한다", () => {
    strictEqual(occupiedLine(["a"]), "있는 것: a");
    strictEqual(occupiedLine(["a", "b", "c", "d", "e", "f"]), "있는 것: a · b · c · d 외 2개");
    // 긴 이름 하나가 알림 상한을 먹어 다음 할 일이 잘리지 않게 이름마다 자른다
    strictEqual(occupiedLine(["x".repeat(255)]), `있는 것: ${"x".repeat(40)}…`);
    // 짝 글자를 반으로 가르지 않는다
    const emoji = "a" + "😀".repeat(50);
    ok(!/[\ud800-\udfff](?![\udc00-\udfff])/u.test(occupiedLine([emoji]).replace(/[\u{10000}-\u{10FFFF}]/gu, "")), "짝 글자가 반쪽으로 남았다");
    strictEqual([...occupiedLine([emoji])].length, "있는 것: ".length + 40 + 1);
});
