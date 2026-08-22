import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./testing/tempDir.ts";
import { createZip, type ZipEntry } from "./zip.ts";
import { extractZip, listZipEntries } from "./unzip.ts";
import { decideImportPlan } from "./importZip.ts";

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
