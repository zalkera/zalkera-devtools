/**
 * 갈아 끼우기 — **성공은 갈아 끼우고, 실패는 흔적을 안 남긴다.**
 *
 * 아래 다섯이 함께 서야 한다. 특히 ③이 없으면 「실패해도 되돌린다」가 주장으로만 남고,
 * ④가 없으면 dot 파일이 남아 다음 시도가 「비어 있지 않습니다」로 막히는 그 함정이 그대로다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { replaceContents } from "./replaceDir.ts";
import { tempDir } from "./testing/tempDir.ts";

async function tree(files: Record<string, string>): Promise<string> {
  const root = await tempDir("zalkera-repl-");
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), body);
  }
  return root;
}

const read = async (root: string, rel: string): Promise<string> =>
  readFile(join(root, rel), "utf8");

test("① 옛 내용이 사라지고 새 내용이 들어온다", async () => {
  const dir = await tree({ "old.txt": "옛", "src/a.ts": "옛" });
  await replaceContents(dir, [], async () => {
    await writeFile(join(dir, "new.txt"), "새");
  });
  assert.deepEqual((await readdir(dir)).sort(), ["new.txt"]);
});

test("② 보존 경로는 새 내용 위에 되살아난다", async () => {
  const dir = await tree({
    ".zalkera/source.json": '{"tenant":"nasiajai"}',
    "old.txt": "옛",
  });
  const { preserved } = await replaceContents(
    dir,
    [".zalkera/source.json"],
    async () => {
      await mkdir(join(dir, ".zalkera"), { recursive: true });
      await writeFile(join(dir, ".zalkera/seed.json"), "{}");
    },
  );
  assert.deepEqual(preserved, [".zalkera/source.json"]);
  assert.equal(
    await read(dir, ".zalkera/source.json"),
    '{"tenant":"nasiajai"}',
  );
  assert.equal(await read(dir, ".zalkera/seed.json"), "{}");
});

test("③ 채우다 실패하면 옛 내용이 그대로 돌아온다", async () => {
  const dir = await tree({
    "old.txt": "옛",
    "src/a.ts": "옛A",
    ".gitignore": "node_modules",
  });
  await assert.rejects(
    replaceContents(dir, [], async () => {
      await writeFile(join(dir, "half.txt"), "반쪽");
      throw new Error("압축 해제 실패");
    }),
    /압축 해제 실패/,
  );
  assert.deepEqual((await readdir(dir)).sort(), [
    ".gitignore",
    "old.txt",
    "src",
  ]);
  assert.equal(await read(dir, "src/a.ts"), "옛A");
});

test("④ dot 파일도 지운다 — 손으로 비울 때 남던 자리다", async () => {
  const dir = await tree({
    ".gitignore": "x",
    ".github/w.yml": "y",
    ".zalkera/seed.json": "{}",
  });
  await replaceContents(dir, [], async () => {
    await writeFile(join(dir, "only.txt"), "새");
  });
  assert.deepEqual((await readdir(dir)).sort(), ["only.txt"]);
});

test("⑤ 성공하든 실패하든 치운 자리를 안 남긴다", async () => {
  const dir = await tree({ "a.txt": "1" });
  const parent = join(dir, "..");
  const stashes = async (): Promise<string[]> =>
    (await readdir(parent)).filter((n) => n.startsWith(".zalkera-stash-"));
  await replaceContents(dir, [], async () =>
    writeFile(join(dir, "b.txt"), "2"),
  );
  assert.deepEqual(await stashes(), []);
  await assert.rejects(
    replaceContents(dir, [], async () => Promise.reject(new Error("실패"))),
  );
  assert.deepEqual(await stashes(), []);
});
