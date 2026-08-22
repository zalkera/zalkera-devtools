import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./testing/tempDir.ts";
import { createZip, type ZipEntry } from "./zip.ts";
import { extractZip, listZipEntries } from "./unzip.ts";
import { removeAdded, snapshotEntries } from "./emptyDir.ts";
import { decideImportPlan } from "./importZip.ts";

/**
 * **디렉터리 항목까지 담은 zip.** 실물(탐색기·Finder·`zip -r`)이 이 모양이다.
 *
 * ⚠ 이 헬퍼가 없으면 시험이 실물과 갈린다 — `createZip` 은 디렉터리 항목을 안 내므로,
 *   파일만 담은 zip 으로는 「정상 zip 이 통째로 거절되는」 사고를 못 잡는다(심의 실증).
 */
function zipWithDirs(entries: Record<string, string>, dirs: string[]): Promise<Buffer> {
  const list: ZipEntry[] = [
    ...dirs.map((path) => ({path, data: Buffer.alloc(0)})),
    ...Object.entries(entries).map(([path, text]) => ({path, data: Buffer.from(text, "utf8")})),
  ];
  return createZip(list);
}

function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const list: ZipEntry[] = Object.entries(entries).map(([path, text]) => ({
    path,
    data: Buffer.from(text, "utf8"),
  }));
  return createZip(list);
}

async function importInto(zip: Buffer, dir: string) {
  const plan = decideImportPlan(listZipEntries(zip));
  return {plan, ...(await extractZip(zip, dir, plan))};
}

test("중첩·제외가 실제 해제에도 그대로 적용된다", async () => {
  const dir = await tempDir("zalkera-import-");
  {
    const { fileCount } = await importInto(
      await zipOf({
        "site/package.json": '{"name":"x"}',
        "site/src/app/page.tsx": "export default () => null;",
        "site/.vscode/settings.json": '{"zalkera.tenant":"someone-else"}',
        "site/.env.local": "ZALKERA_STOREFRONT_KEY=oqsk_live_LEAK",
        "__MACOSX/site/._package.json": "junk",
      }),
      dir,
    );
    assert.equal(fileCount, 2, "푼 개수가 계획과 다르다");
    assert.ok(existsSync(join(dir, "package.json")), "중첩이 안 벗겨졌다");
    assert.ok(existsSync(join(dir, "src/app/page.tsx")));
    // ⚠ 보낸 쪽 링크가 들어오면 이 폴더가 **남의 사이트라고 주장**한다.
    assert.ok(!existsSync(join(dir, ".vscode")), ".vscode 가 들어왔다");
    assert.ok(!existsSync(join(dir, ".env.local")), "자격증명이 들어왔다");
    assert.ok(!existsSync(join(dir, "__MACOSX")), "OS 부스러기가 들어왔다");
  }
});

test("계획을 안 주면 옛 동작 그대로다 — 받기·예제로 시작이 이 경로다", async () => {
  const dir = await tempDir("zalkera-import-");
  {
    const { fileCount } = await extractZip(await zipOf({ "a.txt": "hi", "b/c.txt": "there" }), dir);
    assert.equal(fileCount, 2);
    assert.equal(readFileSync(join(dir, "b/c.txt"), "utf8"), "there");
  }
});

test("접두를 벗긴 뒤에도 뿌리 밖으로 못 나간다", async () => {
  // ⚠ 이 시험이 고정하는 것은 **순서**다. 벗기기가 안전 검사보다 뒤로 가면, 검사는 벗기기 전
  //   이름을 보고 통과시키는데 실제로 쓰는 경로는 다른 것이 된다.
  const dir = await tempDir("zalkera-import-");
  {
    const zip = await zipOf({ "site/package.json": "{}", "site/../../escaped.txt": "nope" });
    // 오류문이 **벗긴 이름**(`../../escaped.txt`)을 말한다는 것이 순서가 맞다는 증거다 —
    // 벗기기가 검사보다 뒤였다면 `site/../../escaped.txt` 로 보고됐을 것이고, 그 이름은
    // `resolve` 상 뿌리 안이라 통과했을 것이다.
    await assert.rejects(() => importInto(zip, dir), /폴더 밖을 가리킵니다: \.\.\/\.\.\/escaped\.txt/);
    assert.ok(!existsSync(join(dir, "..", "..", "escaped.txt")), "뿌리 밖에 파일이 생겼다");
  }
});

test("디렉터리 항목이 든 실물 zip 이 통째로 거절되지 않는다", async () => {
  // ⚠ 이것이 이 기능의 **1순위 입력**이다 — 고객·개발사가 폴더를 통째로 압축해 보낸다.
  //   계획이 파일만 판정하면 `node_modules/` 디렉터리 항목이 해제기 안쪽 가드까지 가서
  //   「받은 파일에 node_modules 가 들어 있습니다」로 폭사한다.
  const dir = await tempDir("zalkera-import-");
  {
    const zip = await zipWithDirs(
      {
        "site/package.json": '{"name":"x"}',
        "site/src/page.tsx": "export default null;",
        "site/node_modules/pkg/index.js": "module.exports={}",
      },
      ["site/", "site/src/", "site/node_modules/", "site/node_modules/pkg/"],
    );
    const plan = decideImportPlan(listZipEntries(zip));
    const { fileCount } = await extractZip(zip, dir, plan);
    assert.equal(fileCount, 2, "정상 zip 이 온전히 풀리지 않았다");
    assert.ok(existsSync(join(dir, "package.json")));
    assert.ok(existsSync(join(dir, "src/page.tsx")));
    // 제외 대상은 **빈 껍데기조차** 남기지 않는다 — 「들여오지도 않는다」가 참이어야 한다.
    assert.ok(!existsSync(join(dir, "node_modules")), "제외 폴더가 빈 껍데기로 생겼다");
  }
});

test("제외 디렉터리 항목은 빈 폴더로도 안 생긴다", async () => {
  const dir = await tempDir("zalkera-import-");
  {
    const zip = await zipWithDirs({ "package.json": "{}" }, [".git/", ".vscode/", "dist/", ".ssh/"]);
    const plan = decideImportPlan(listZipEntries(zip));
    await extractZip(zip, dir, plan);
    for (const junk of [".git", ".vscode", "dist", ".ssh"]) {
      assert.ok(!existsSync(join(dir, junk)), `${junk} 가 빈 껍데기로 생겼다`);
    }
  }
});

test("해제가 도중에 멈추면 **아무것도 남기지 않는다** — 문서가 그렇게 약속한다", async () => {
  // ⚠ help.md 가 「…아무것도 풀지 않고 멈춘 것이니 폴더는 그대로입니다」라고 단정한다.
  //   `extractZip` 은 항목을 훑으며 그때그때 쓰므로, 롤백이 없으면 그 문장이 거짓이 된다.
  //   재시도도 「비어 있지 않습니다」로 막혀 손으로 지우기 전에는 못 빠져나온다.
  //   적대적 zip 이 보안 정지를 유발하고도 디스크에 흔적을 남기는 자리이기도 하다.
  const dir = await tempDir("zalkera-import-");
  {
    const zip = await zipOf({
      "site/package.json": "{}",
      "site/src/a.ts": "export default 1;",
      "site/../../escaped.txt": "nope",
    });
    const plan = decideImportPlan(listZipEntries(zip));
    const before = await snapshotEntries(dir);
    await assert.rejects(async () => {
      try {
        await extractZip(zip, dir, plan);
      } catch (cause) {
        await removeAdded(dir, before);
        throw cause;
      }
    });
    assert.deepEqual(readdirSync(dir), [], `반쪽 해제가 남았다: ${readdirSync(dir).join(",")}`);
  }
});

test("목록이 디렉터리 항목도 돌려준다 — 계획이 그것까지 판정해야 규칙이 한 곳에 있다", async () => {
  // ⚠ 목록이 파일만 주면 계획은 디렉터리를 못 보고, `node_modules/` 항목이 해제기 안쪽
  //   가드까지 가서 **정상 zip 이 통째로 거절된다.** 그 사고를 이 한 줄이 막는다.
  const zip = await zipWithDirs({ "package.json": "{}" }, ["src/", "node_modules/"]);
  const names = listZipEntries(zip);
  assert.ok(names.includes("src/"), `디렉터리 항목이 목록에 없다: ${names.join(",")}`);
  assert.ok(names.includes("node_modules/"), `제외 대상 디렉터리가 목록에 없다: ${names.join(",")}`);
});
