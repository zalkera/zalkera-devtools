import { ok, strictEqual } from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isReceivable, meaningfulEntries } from "./emptyDir.ts";

const scratch = () => mkdtemp(join(tmpdir(), "zalkera-empty-"));

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
