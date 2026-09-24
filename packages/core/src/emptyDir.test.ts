import { ok, strictEqual } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { isReceivable, meaningfulEntries, removeAdded, snapshotEntries } from "./emptyDir.ts";
import { tempDir } from "./testing/tempDir.ts";

const scratch = () => tempDir("zalkera-empty-");

test("빈 폴더는 받을 수 있다", async () => {
    ok(await isReceivable(await scratch()));
});

test("VS Code 가 만든 .vscode 때문에 막히지 않는다", async () => {
    // 실사용 신고(2026-08-10): 폴더를 연 창에서 사이트를 고르면 VS Code 가 워크스페이스 설정을 쓰면서
    // .vscode/settings.json 을 만든다 — **도구가 만든 파일 때문에 도구가 막히던** 자물쇠다.
    const dir = await scratch();
    await mkdir(join(dir, ".vscode"));
    await writeFile(join(dir, ".vscode", "settings.json"), "{}");
    ok(await isReceivable(dir), ".vscode 만 있으면 여전히 빈 폴더로 본다");
});

test("OS 부스러기도 막지 않는다", async () => {
    const dir = await scratch();
    await writeFile(join(dir, ".DS_Store"), "x");
    await writeFile(join(dir, "Thumbs.db"), "x");
    ok(await isReceivable(dir));
});

test("사람이 만든 파일이 하나라도 있으면 막는다", async () => {
    // 가드의 목적은 그대로 선다 — 고치던 소스를 서버 버전으로 덮지 않는 것.
    const dir = await scratch();
    await mkdir(join(dir, ".vscode"));
    await writeFile(join(dir, "README.md"), "내 작업물");
    ok(!(await isReceivable(dir)));
    strictEqual((await meaningfulEntries(dir)).join(), "README.md");
});

test(".git 은 무시하지 않는다 — 이력을 가진 작업물이다", async () => {
    const dir = await scratch();
    await mkdir(join(dir, ".git"));
    ok(!(await isReceivable(dir)), ".git 이 있으면 이미 어떤 레포다");
});


/**
 * 무시는 **이름이 아니라 종류**로 정한다. 이름만 보면 `.vscode` 라는 이름의 **링크**가
 * "빈 폴더"를 통과하고, 그 링크가 해제 대상 경로가 된다 — 편집기는 링크를 만들지 않는다.
 */
test("무시 이름이라도 **심링크**면 무시하지 않는다", async () => {
    const { mkdtemp, symlink, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const victim = await tempDir("victim-");
    for (const name of [".vscode", ".DS_Store", "Thumbs.db", "desktop.ini"]) {
        const dir = await tempDir("tgt-");
        await symlink(victim, join(dir, name));
        strictEqual(await isReceivable(dir), false, `${name} 심링크가 "빈 폴더"를 통과했다`);
    }
    // 통제군 — 진짜 편집기 파일은 여전히 무시한다.
    const clean = await tempDir("tgt-");
    await mkdir(join(clean, ".vscode"));
    await writeFile(join(clean, ".vscode", "settings.json"), "{}");
    await writeFile(join(clean, ".DS_Store"), "x");
    strictEqual(await isReceivable(clean), true, "정상 편집기 파일을 막았다");
});

// ── 우리 표식뿐인 폴더 (2026-09-24 실사용 신고) ────────────────────────────────

test("우리 소속 표식(.zalkera/source.json)뿐인 폴더는 빈 폴더다 — 도구가 쓴 파일로 도구가 막히지 않는다", async () => {
    const dir = await scratch();
    await mkdir(join(dir, ".zalkera"));
    await writeFile(join(dir, ".zalkera", "source.json"), '{"format":2,"origin":"linked","tenant":"a","linkedAt":"t"}');
    await mkdir(join(dir, ".vscode"));
    await writeFile(join(dir, ".vscode", "settings.json"), '{"zalkera.tenant":"a"}');
    ok(await isReceivable(dir), "표식+링크만 있는 폴더가 막혔다");
    // CLI 장부도 우리 것이다
    await writeFile(join(dir, ".zalkera", "sync.json"), "{}");
    ok(await isReceivable(dir), "장부까지 있어도 우리 파일뿐이다");
    // 빈 .zalkera 도 우리 것이다
    const bare = await scratch();
    await mkdir(join(bare, ".zalkera"));
    ok(await isReceivable(bare));
});

test(".zalkera 안에 우리 것이 아닌 항목이 하나라도 있으면 막는다 — 배송 파일·손으로 푼 흔적", async () => {
    for (const foreign of ["pack.json", "provenance.json", "ASSETS-LICENSE.md", "notes.txt"]) {
        const dir = await scratch();
        await mkdir(join(dir, ".zalkera"));
        await writeFile(join(dir, ".zalkera", "source.json"), "{}");
        await writeFile(join(dir, ".zalkera", foreign), "x");
        strictEqual(await isReceivable(dir), false, `.zalkera/${foreign} 이 있는데 빈 폴더로 봤다`);
        // 걸린 이름을 안쪽까지 편다 — 「있는 것: .zalkera」로는 무엇을 치울지 모른다
        strictEqual((await meaningfulEntries(dir)).join(), `.zalkera/${foreign}`);
    }
    // 하위 폴더도 우리 것이 아니다(`.zalkera/saved/` 같은 자리)
    const nested = await scratch();
    await mkdir(join(nested, ".zalkera", "saved"), { recursive: true });
    strictEqual(await isReceivable(nested), false);
});

test(".zalkera 가 심링크거나 그 안이 심링크면 무시하지 않는다", async () => {
    const { symlink } = await import("node:fs/promises");
    const victim = await tempDir("victim-");
    const linkDir = await scratch();
    await symlink(victim, join(linkDir, ".zalkera"));
    strictEqual(await isReceivable(linkDir), false, ".zalkera 심링크가 통과했다");
    const inner = await scratch();
    await mkdir(join(inner, ".zalkera"));
    await symlink(join(victim, "x"), join(inner, ".zalkera", "source.json"));
    strictEqual(await isReceivable(inner), false, ".zalkera/source.json 심링크가 통과했다");
});

test("되감기는 통과시킨 폴더 «안쪽»에서 생긴 것만 지운다 — 표식은 남고 tar 가 쓴 것은 사라진다", async () => {
    const dir = await scratch();
    await mkdir(join(dir, ".zalkera"));
    await writeFile(join(dir, ".zalkera", "source.json"), "{}");
    const before = await snapshotEntries(dir);
    // 실패한 해제가 남겼을 법한 것: 서버 tar 의 .zalkera/provenance.json · 소스 일부
    await writeFile(join(dir, ".zalkera", "provenance.json"), "{}");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "x");
    await removeAdded(dir, before);
    const { readdir } = await import("node:fs/promises");
    strictEqual((await readdir(dir)).join(), ".zalkera");
    strictEqual((await readdir(join(dir, ".zalkera"))).join(), "source.json", "안쪽 되감기가 안 됐다 — 다음 시도가 다시 막힌다");
    ok(await isReceivable(dir), "되감은 뒤에도 다시 받을 수 있어야 한다");
});

test("자기 상태 파일 목록은 zip 배제 목록의 부분집합이다 — 표식이 정본에 실리면 안 되는 그 파일들이다", async () => {
    const { OWN_STATE_FILES } = await import("./emptyDir.ts");
    const { isExcludedEntry } = await import("./zip.ts");
    for (const p of OWN_STATE_FILES) ok(isExcludedEntry(p), `${p} 는 zip 에 실리는데 빈 폴더 판정은 무시한다`);
});

test(".zalkera 안의 OS 부스러기는 막지 않는다 — 탐색기가 열어 본 것만으로 다시 잠기지 않게", async () => {
    const dir = await scratch();
    await mkdir(join(dir, ".zalkera"));
    await writeFile(join(dir, ".zalkera", "source.json"), "{}");
    await writeFile(join(dir, ".zalkera", ".DS_Store"), "x");
    ok(await isReceivable(dir), ".zalkera/.DS_Store 하나로 막혔다");
    // 양성 짝 — 부스러기 이름이라도 폴더면 우리 것이 아니다
    const odd = await scratch();
    await mkdir(join(odd, ".zalkera", "Thumbs.db"), { recursive: true });
    strictEqual(await isReceivable(odd), false);
});

test("되감기는 기준선 뒤 우리 폴더가 심링크로 바뀌었으면 안쪽으로 내려가지 않는다 — 폴더 밖을 지우지 않는다", async () => {
    const { rm: remove, symlink, readdir } = await import("node:fs/promises");
    const dir = await scratch();
    await mkdir(join(dir, ".zalkera"));
    await writeFile(join(dir, ".zalkera", "source.json"), "{}");
    const before = await snapshotEntries(dir);
    const victim = await tempDir("victim-");
    await writeFile(join(victim, "a.txt"), "고객 파일");
    await remove(join(dir, ".zalkera"), { recursive: true });
    await symlink(victim, join(dir, ".zalkera"));
    await removeAdded(dir, before);
    strictEqual((await readdir(victim)).join(), "a.txt", "되감기가 심링크를 따라가 폴더 밖 파일을 지웠다");
});

test("되감기는 .vscode 안쪽을 건드리지 않는다 — 받기가 그 안에 쓰지 않으므로 거기 생긴 것은 사람·편집기 것이다", async () => {
    const { readdir } = await import("node:fs/promises");
    const dir = await scratch();
    await mkdir(join(dir, ".vscode"));
    await writeFile(join(dir, ".vscode", "settings.json"), "{}");
    const before = await snapshotEntries(dir);
    await writeFile(join(dir, ".vscode", "launch.json"), "{}");
    await removeAdded(dir, before);
    strictEqual((await readdir(join(dir, ".vscode"))).sort().join(), "launch.json,settings.json");
});
