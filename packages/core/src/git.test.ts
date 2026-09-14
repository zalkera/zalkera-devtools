import assert from "node:assert/strict";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import test from "node:test";
import {affectsFolderVersion, gitStatusLine, tagOffer, type GitSnapshot} from "./git.ts";
import {excludeFromGit} from "./gitExclude.ts";
import {SOURCE_MARK_PATH} from "./localMark.ts";
import {tempDir} from "./testing/tempDir.ts";

const clean: GitSnapshot = {branch: "main", commit: "1a2b3c4d5e6f7890", uncommitted: 0};

test("git 한 줄 — 레포가 아니면 빈 문자열이다(「git 없음」은 판정이라 적지 않는다)", () => {
    assert.equal(gitStatusLine(null), "");
});

test("git 한 줄 — 깨끗한 트리는 브랜치·짧은 sha·「깨끗함」", () => {
    assert.equal(gitStatusLine(clean), "git: main @ 1a2b3c4 · 깨끗함");
});

test("git 한 줄 — 커밋하지 않은 변경은 수로 말한다", () => {
    assert.equal(gitStatusLine({...clean, uncommitted: 3}), "git: main @ 1a2b3c4 · 커밋하지 않은 변경 3개");
});

test("git 한 줄 — 분리 HEAD 와 커밋 없는 레포를 가른다", () => {
    assert.equal(gitStatusLine({...clean, branch: null}), "git: (분리됨) @ 1a2b3c4 · 깨끗함");
    assert.equal(
        gitStatusLine({branch: "main", commit: null, uncommitted: 12}),
        "git: 아직 커밋 없음 · 커밋하지 않은 변경 12개",
    );
});

test("🔴 브랜치 이름은 남이 짓는다 — 제어문자·개행이 모달 뒷줄을 위조하지 못한다", () => {
    const line = gitStatusLine({...clean, branch: "main\n그대로 두는 것: 전부‮"});
    assert.ok(!line.includes("\n"), "개행이 살아남았다");
    assert.ok(!line.includes("‮"), "재정렬 문자가 살아남았다");
    assert.match(line, /^git: main 그대로 두는 것: 전부 @ 1a2b3c4 · 깨끗함$/);
});

test("감시기 거름 — 지문에 안 드는 경로는 재계산을 예약하지 않는다(기아 방지)", () => {
    for (const p of [".git/index", ".git/HEAD", "node_modules/x/index.js", ".next/server/app.js", "dist/a.js",
        ".zalkera/source.json", ".env.local", ".vscode/settings.json", ".mcp.json", "", ".", "../outside.ts"]) {
        assert.equal(affectsFolderVersion(p), false, `${p} 가 재계산을 예약한다`);
    }
});

test("감시기 거름 — 지문에 드는 경로는 예약한다(양성 짝)", () => {
    for (const p of ["src/app/page.tsx", "next-env.d.ts", "package.json", ".gitignore", "public/a.png",
        "content/posts/a.md", "src\\app\\layout.tsx"]) {
        assert.equal(affectsFolderVersion(p), true, `${p} 가 재계산을 안 예약한다`);
    }
});

test("태그 권유 — 깨끗한 트리에서만, 이름은 zalkera/v{N}", () => {
    assert.deepEqual(tagOffer(clean, "acme", 5), {name: "zalkera/v5", message: "잘커라 acme 버전 5"});
});

test("🔴 태그 권유 — 더러운 트리·커밋 없음·레포 아님·판 번호 이상은 전부 권하지 않는다", () => {
    assert.equal(tagOffer({...clean, uncommitted: 1}, "acme", 5), null, "더러운 트리에 태그를 권했다");
    assert.equal(tagOffer({...clean, commit: null}, "acme", 5), null, "커밋 없는 레포에 태그를 권했다");
    assert.equal(tagOffer(null, "acme", 5), null);
    assert.equal(tagOffer(clean, "acme", 0), null);
    assert.equal(tagOffer(clean, "acme", 2.5), null);
});

async function repo(withGitDir: boolean): Promise<string> {
    // `tempDir()` 가 회수 목록에 올려 지운다 — `mkdtemp` 를 직접 부르면 예외 경로에서 남는다.
    const dir = await tempDir("zalkera-git-");
    if (withGitDir) await mkdir(join(dir, ".git"), {recursive: true});
    return dir;
}

test("exclude — `.git/info/exclude` 에 한 줄, 두 번 불러도 한 줄", async () => {
    const dir = await repo(true);
    await excludeFromGit(dir, SOURCE_MARK_PATH);
    await excludeFromGit(dir, SOURCE_MARK_PATH);
    const text = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
    assert.equal(text.match(/source\.json/g)?.length, 1, "두 번 적혔다");
    assert.match(text, /^\.zalkera\/source\.json$/m);
});

test("exclude — 있던 내용은 보존하고 끝 개행이 없어도 줄이 붙지 않는다", async () => {
    const dir = await repo(true);
    await mkdir(join(dir, ".git", "info"), {recursive: true});
    await writeFile(join(dir, ".git", "info", "exclude"), "*.log");
    await excludeFromGit(dir, ".zalkera/sync.json");
    assert.equal(await readFile(join(dir, ".git", "info", "exclude"), "utf8"), "*.log\n.zalkera/sync.json\n");
});

test("🔴 exclude — git 이 없으면 아무것도 만들지 않는다(만든 파일은 다음 판에 실려 나간다)", async () => {
    const dir = await repo(false);
    await excludeFromGit(dir, SOURCE_MARK_PATH);
    await assert.rejects(readFile(join(dir, ".git", "info", "exclude"), "utf8"), "git 없는 폴더에 .git 을 만들었다");
});

test("exclude — `.git` 이 파일이면(워크트리·서브모듈) 건드리지 않는다", async () => {
    const dir = await repo(false);
    await writeFile(join(dir, ".git"), "gitdir: ../.git/worktrees/x\n");
    await excludeFromGit(dir, SOURCE_MARK_PATH);
    assert.equal(await readFile(join(dir, ".git"), "utf8"), "gitdir: ../.git/worktrees/x\n", "gitdir 파일이 바뀌었다");
});

test("🔴 exclude — `.git` 이 링크면 그 너머(남의 레포)에 쓰지 않는다", async () => {
    const {symlink} = await import("node:fs/promises");
    const other = await repo(true);
    const dir = await repo(false);
    await symlink(join(other, ".git"), join(dir, ".git"), "dir");
    await excludeFromGit(dir, SOURCE_MARK_PATH);
    await assert.rejects(readFile(join(other, ".git", "info", "exclude"), "utf8"), "링크 너머 레포에 줄을 적었다");
});

test("🔴 exclude — `exclude` 파일 자리가 링크면 따라가 쓰지 않는다", async () => {
    const {symlink} = await import("node:fs/promises");
    const dir = await repo(true);
    const victim = await repo(false);
    await writeFile(join(victim, "victim.txt"), "그대로");
    await mkdir(join(dir, ".git", "info"), {recursive: true});
    await symlink(join(victim, "victim.txt"), join(dir, ".git", "info", "exclude"));
    await excludeFromGit(dir, SOURCE_MARK_PATH);
    assert.equal(await readFile(join(victim, "victim.txt"), "utf8"), "그대로", "링크 대상이 덮였다");
});
