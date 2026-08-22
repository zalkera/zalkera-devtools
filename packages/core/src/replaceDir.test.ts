/**
 * 갈아 끼우기 — **성공은 갈아 끼우고, 실패는 흔적을 안 남기며, 못 싣는 것은 안 건드린다.**
 *
 * ⚠ **픽스처는 `tempDir()` **안에** 판을 만든다.** `tempDir()` 자체를 대상으로 쓰면 그 부모가
 *   언제나 OS 임시 디렉터리라 「형제에 치운다」가 **구조적으로 시험 불가**가 되고, 남의 찌꺼기로
 *   빨개진다(심의 실측: 오탐 4건). 부모를 판마다 따로 두면 그 성질이 관찰된다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keepNames, replaceContents } from "./replaceDir.ts";
import { tempDir } from "./testing/tempDir.ts";

/** `{parent}/site` 를 만들고 돌려준다. 형제 판정이 이 `parent` 안에서 관찰된다. */
async function tree(files: Record<string, string>): Promise<{ dir: string; parent: string }> {
  const parent = await tempDir("zalkera-repl-");
  const dir = join(parent, "site");
  await mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return { dir, parent };
}

const read = async (dir: string, rel: string): Promise<string> => readFile(join(dir, rel), "utf8");
const stashes = async (parent: string): Promise<string[]> =>
  (await readdir(parent)).filter((n) => n.startsWith(".zalkera-stash-"));

test("① 옛 내용이 사라지고 새 내용이 들어온다", async () => {
  const { dir } = await tree({ "old.txt": "옛", "src/a.ts": "옛" });
  await replaceContents(dir, [], [], async () => {
    await writeFile(join(dir, "new.txt"), "새");
  });
  assert.deepEqual((await readdir(dir)).sort(), ["new.txt"]);
});

test("② 보존 경로는 새 내용 위에 되살아난다", async () => {
  const { dir } = await tree({ ".zalkera/source.json": '{"tenant":"nasiajai"}', "old.txt": "옛" });
  const { preserved } = await replaceContents(dir, [".zalkera/source.json"], [], async () => {
    await mkdir(join(dir, ".zalkera"), { recursive: true });
    await writeFile(join(dir, ".zalkera/seed.json"), "{}");
  });
  assert.deepEqual(preserved, [".zalkera/source.json"]);
  assert.equal(await read(dir, ".zalkera/source.json"), '{"tenant":"nasiajai"}');
  assert.equal(await read(dir, ".zalkera/seed.json"), "{}");
});

test("③ 채우다 실패하면 옛 내용이 그대로 돌아온다", async () => {
  const { dir } = await tree({ "old.txt": "옛", "src/a.ts": "옛A", ".gitignore": "node_modules" });
  await assert.rejects(
    replaceContents(dir, [], [], async () => {
      await writeFile(join(dir, "half.txt"), "반쪽");
      throw new Error("압축 해제 실패");
    }),
    /압축 해제 실패/,
  );
  assert.deepEqual((await readdir(dir)).sort(), [".gitignore", "old.txt", "src"]);
  assert.equal(await read(dir, "src/a.ts"), "옛A");
});

test("④ dot 파일도 지운다 — 손으로 비울 때 남던 자리다", async () => {
  const { dir } = await tree({ ".gitignore": "x", ".github/w.yml": "y", ".zalkera/seed.json": "{}" });
  await replaceContents(dir, [], [], async () => {
    await writeFile(join(dir, "only.txt"), "새");
  });
  assert.deepEqual((await readdir(dir)).sort(), ["only.txt"]);
});

test("⑤ 성공하든 실패하든 «형제 자리»에 치운 것을 안 남긴다", async () => {
  const { dir, parent } = await tree({ "a.txt": "1" });
  await replaceContents(dir, [], [], async () => writeFile(join(dir, "b.txt"), "2"));
  assert.deepEqual(await stashes(parent), []);
  await assert.rejects(replaceContents(dir, [], [], async () => Promise.reject(new Error("실패"))));
  assert.deepEqual(await stashes(parent), []);
});

test("⑥ keep 은 치우지도 지우지도 않는다 — zip 이 못 실어 오는 것들이다", async () => {
  // 이것이 없으면 갱신이 고객의 .git·시크릿·에디터 설정을 영구히 지운다. 손으로 비우던
  // 방식은 그것들을 «안 지웠다»(dot 파일이라서) — 대체하는 쪽이 더 많이 지우면 안 된다.
  const { dir } = await tree({
    ".git/HEAD": "ref: refs/heads/main",
    ".env.local": "KEY=1",
    ".vscode/settings.json": '{"zalkera.tenant":"nasiajai"}',
    "node_modules/pkg/index.js": "x",
    "old.txt": "옛",
  });
  const keep = [".git", ".env.local", ".vscode", "node_modules"];
  const { kept } = await replaceContents(dir, [], keep, async () => {
    await writeFile(join(dir, "new.txt"), "새");
  });
  assert.deepEqual(kept.sort(), keep.slice().sort());
  assert.equal(await read(dir, ".git/HEAD"), "ref: refs/heads/main");
  assert.equal(await read(dir, ".env.local"), "KEY=1");
  assert.equal(await read(dir, ".vscode/settings.json"), '{"zalkera.tenant":"nasiajai"}');
  assert.equal(await read(dir, "node_modules/pkg/index.js"), "x");
  assert.deepEqual((await readdir(dir)).sort(), [".env.local", ".git", ".vscode", "new.txt", "node_modules"]);
});

test("⑦ 치우다 중간에 실패해도 되돌린다 — 되돌리기가 그 자리를 못 지나면 폴더가 갈린다", async () => {
  const { dir } = await tree({ "a.txt": "1", "b.txt": "2", "locked/x.txt": "3" });
  // 쓰기 권한이 없는 디렉터리는 옮길 수 없다(POSIX). 20개 중 4번째에서 죽는 그 형태다.
  await chmod(join(dir, "locked"), 0o500);
  try {
    await assert.rejects(replaceContents(dir, [], [], async () => writeFile(join(dir, "new.txt"), "새")));
  } finally {
    // 이 줄이 안 돌면 권한 0500 트리가 임시 디렉터리에 영구히 남는다 — 회수기가 EACCES 로 죽는다.
    await chmod(join(dir, "locked"), 0o700);
  }
  assert.deepEqual((await readdir(dir)).sort(), ["a.txt", "b.txt", "locked"]);
  assert.equal(await read(dir, "a.txt"), "1");
});

test("⑧ 심링크로 열린 폴더 — 치우는 자리를 «실경로» 옆에 잡는다", async () => {
  // ⚠ 링크와 대상이 **같은 부모**면 이 성질이 안 보인다 — `dirname(link) === dirname(real)` 이라
  //   `realpath` 를 지워도 시험이 초록이다(확인 심의 실측). 부모를 갈라야 관찰된다.
  const { dir, parent } = await tree({ "a.txt": "1" });
  const elsewhere = await tempDir("zalkera-link-");
  const link = join(elsewhere, "link");
  await symlink(dir, link);
  let sawStashNextToReal = false;
  await replaceContents(link, [], [], async () => {
    sawStashNextToReal = (await stashes(parent)).length === 1;
    assert.deepEqual(await stashes(elsewhere), [], "링크 쪽에 치우면 파일시스템이 갈릴 수 있다");
    await writeFile(join(link, "new.txt"), "새");
  });
  assert.ok(sawStashNextToReal, "치운 자리가 실경로 옆이 아니다");
  assert.deepEqual((await readdir(dir)).sort(), ["new.txt"]);
  assert.deepEqual(await stashes(parent), []);
  await rm(link, { force: true });
});

test("⑨ 새 소스가 옛 이름을 쓰는데 실패하면 — 옛것이 그대로 돌아온다", async () => {
  // 종전 되돌리기는 «원래 있던 이름»을 전부 건너뛰어, 새 소스가 같은 이름을 쓰면
  // (src·package.json — 사실상 모든 zip) 그 새 것이 안 지워진 채 ENOTEMPTY 로 죽었다.
  // 폴더가 옛것과 새것이 섞인 채 남고 나머지는 점(.) 형제에 갇히던 자리다.
  const { dir, parent } = await tree({ "src/a.ts": "옛A", "package.json": "{}" });
  await assert.rejects(
    replaceContents(dir, [], [], async () => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/page.tsx"), "새");
      throw new Error("압축이 끊겼습니다");
    }),
    /압축이 끊겼습니다/,
  );
  assert.equal(await read(dir, "src/a.ts"), "옛A");
  assert.deepEqual((await readdir(join(dir, "src"))).sort(), ["a.ts"]);
  assert.deepEqual(await stashes(parent), []);
});

test("⑩ 보존 파일을 못 되살리면 원래 소스가 어디 있는지 말한다", async () => {
  // 새 소스가 보존 경로와 같은 이름의 «파일»을 실어 오면 mkdir 이 EEXIST 로 죽는다.
  // 감싸지 않으면 예외가 맨몸으로 나가고 치운 자리가 영구히 남는다.
  const { dir, parent } = await tree({ ".zalkera/source.json": '{"tenant":"t"}' });
  await assert.rejects(
    replaceContents(dir, [".zalkera/source.json"], [], async () => {
      await writeFile(join(dir, ".zalkera"), "파일이다");
    }),
    /원래 소스는 .*\.zalkera-stash-/,
  );
  assert.equal((await stashes(parent)).length, 1, "실패했으면 치운 자리를 남겨 사람이 찾게 한다");
});

test("⑪ 보존 파일을 못 «읽으면» 갈아 끼우지 않는다 — 부재로 읽으면 소속이 조용히 풀린다", async () => {
  const { dir } = await tree({ ".zalkera/source.json": '{"tenant":"t"}', "a.txt": "1" });
  await chmod(join(dir, ".zalkera/source.json"), 0o000);
  try {
    await assert.rejects(replaceContents(dir, [".zalkera/source.json"], [], async () => Promise.resolve()));
    assert.deepEqual((await readdir(dir)).sort(), [".zalkera", "a.txt"], "손도 안 댔어야 한다");
  } finally {
    await chmod(join(dir, ".zalkera/source.json"), 0o600);
  }
});

test("⑫ 손 목록은 포장기가 빼는 것에서 나온다 — 손으로 열거하면 갈린다", async () => {
  const { dir } = await tree({
    ".git/HEAD": "x",
    ".ssh/id_rsa": "x",
    ".aws/credentials": "x",
    ".idea/w.xml": "x",
    ".npmrc": "x",
    ".env.production": "x",
    "server.pem": "x",
    ".vscode/settings.json": "{}",
    "node_modules/p/i.js": "x",
    ".next/build": "x",
    "src/a.ts": "옛",
  });
  const keep = await keepNames(dir);
  // 자격증명·이력·편집기 상태는 남고, 다시 만들어지는 것은 안 남는다.
  assert.deepEqual(
    keep.slice().sort(),
    [".aws", ".env.production", ".git", ".idea", ".npmrc", ".ssh", ".vscode", "server.pem"],
  );
  await replaceContents(dir, [], keep, async () => writeFile(join(dir, "new.txt"), "새"));
  assert.equal(await read(dir, ".ssh/id_rsa"), "x");
  assert.equal(await read(dir, ".env.production"), "x");
  assert.equal(await read(dir, ".npmrc"), "x");
  // 다시 만들어지는 것은 사라진다 — 옛 의존이 새 소스에 조용히 쓰이면 안 된다.
  assert.equal((await readdir(dir)).includes("node_modules"), false);
  assert.equal((await readdir(dir)).includes(".next"), false);
});
