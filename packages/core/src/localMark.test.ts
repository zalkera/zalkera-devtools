/**
 * **출처 표식과 폴더 연결 쓰기의 시험.**
 *
 * 두 가지를 문다 — 표식이 **올라가지 않는가**(그 보증은 `zip.test.ts` 가 함께 진다), 그리고
 * 폴더 연결 쓰기가 **남의 설정을 지우지 않는가**.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourceMark,
  holdsSameRevision,
  mergeTenantSetting,
  parseSourceMark,
  SOURCE_MARK_PATH,
} from "./localMark.ts";

test("표식은 읽고 쓴 것이 같다", () => {
  const text = buildSourceMark({ tenant: "credium", revisionNo: 13, sha256: "abc", fetchedAt: "2026-08-20T00:00:00.000Z" });
  const mark = parseSourceMark(text);
  assert.equal(mark?.tenant, "credium");
  assert.equal(mark?.format, 1);
  assert.equal(mark?.format === 1 ? mark.revisionNo : null, 13);
});

test("표식이 없거나 깨졌으면 「모른다」다 — 「받은 적 없다」가 아니다", () => {
  // 거짓 확신을 만들지 않는다. 콘솔·AI 레인으로 만들어진 판에는 표식이 없고, 그것은 정상이다.
  for (const bad of [null, "", "{", "[]", "null", '{"format":2}', '{"format":1}', '{"format":1,"tenant":"a"}']) {
    assert.equal(parseSourceMark(bad), null, `이 입력이 표식으로 통과했다: ${bad}`);
  }
});

test("같은 사이트의 같은 판만 「이미 받았다」로 센다", () => {
  const mark = parseSourceMark(
    buildSourceMark({ tenant: "credium", revisionNo: 13, sha256: "abc", fetchedAt: "t" }),
  );
  assert.equal(holdsSameRevision(mark, "credium", 13), true);
  assert.equal(holdsSameRevision(mark, "credium", 14), false, "다른 판을 같다고 셌다");
  assert.equal(holdsSameRevision(mark, "other", 13), false, "다른 사이트를 같다고 셌다");
  assert.equal(holdsSameRevision(null, "credium", 13), false, "모르는데 안다고 했다");
});

test("경로 상수는 한 곳에서만 온다", () => {
  assert.equal(SOURCE_MARK_PATH, ".zalkera/source.json");
});

test("폴더 연결 쓰기가 남의 키를 지우지 않는다", () => {
  const existing = JSON.stringify({ "editor.fontSize": 14, "zalkera.tenant": "old" }, null, 2);
  const r = mergeTenantSetting(existing, "credium");
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.ok ? r.text : "{}");
  assert.equal(parsed["editor.fontSize"], 14, "남의 키가 사라졌다");
  assert.equal(parsed["zalkera.tenant"], "credium", "우리 키가 안 바뀌었다");
});

test("파일이 없으면 새로 만든다", () => {
  const r = mergeTenantSetting(null, "credium");
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.ok ? r.text : "{}"), { "zalkera.tenant": "credium" });
});

test("못 읽으면 쓰지 않는다 — 사람 설정을 날리는 것보다 안 잇는 편이 낫다", () => {
  for (const bad of ['{"a":1} // 주석', "[1,2]", "그냥 글자"]) {
    const r = mergeTenantSetting(bad, "credium");
    assert.equal(r.ok, false, `이 내용을 덮어썼다: ${bad}`);
  }
});

// ── 실제로 파일을 쓰는 자리. 이 경로가 확장 안에 있을 때 **아무 시험도 안 물었다.** ──
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { linkFolderToTenant, writeSourceMarkTo } from "./localMark.ts";
import { tempDirSync } from "./testing/tempDir.ts";

const roots: string[] = [];
const fresh = () => {
  const d = tempDirSync("zalkera-lm-");
  roots.push(d);
  return d;
};
test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test("폴더 연결 — 파일이 없으면 만든다", async () => {
  const root = fresh();
  const r = await linkFolderToTenant(root, "credium");
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".vscode", "settings.json"), "utf8")), {
    "zalkera.tenant": "credium",
  });
});

test("폴더 연결 — 남의 키를 지우지 않는다", async () => {
  const root = fresh();
  mkdirSync(join(root, ".vscode"));
  writeFileSync(join(root, ".vscode", "settings.json"), JSON.stringify({ "editor.fontSize": 14 }, null, 2));
  await linkFolderToTenant(root, "credium");
  const after = JSON.parse(readFileSync(join(root, ".vscode", "settings.json"), "utf8"));
  assert.equal(after["editor.fontSize"], 14, "남의 키가 사라졌다");
  assert.equal(after["zalkera.tenant"], "credium");
});

test("폴더 연결 — settings.json 이 링크면 쓰지 않는다", async () => {
  // 링크를 따라가면 **고객 폴더 밖**의 공유 설정을 고쳐 놓고 「연결해 두었습니다」를 찍는다.
  // dotfiles·모노레포 공유 설정에서 흔한 배치다.
  const root = fresh();
  const outside = fresh();
  const shared = join(outside, "shared.json");
  writeFileSync(shared, JSON.stringify({ "editor.fontSize": 15 }));
  mkdirSync(join(root, ".vscode"));
  symlinkSync(shared, join(root, ".vscode", "settings.json"));

  const r = await linkFolderToTenant(root, "victim");
  assert.equal(r.ok, false, "링크를 따라가 썼다");
  assert.deepEqual(JSON.parse(readFileSync(shared, "utf8")), { "editor.fontSize": 15 }, "폴더 밖 파일이 바뀌었다");
});

test("폴더 연결 — 끊어진 링크에도 쓰지 않는다", async () => {
  const root = fresh();
  const outside = fresh();
  mkdirSync(join(root, ".vscode"));
  symlinkSync(join(outside, "없는파일.json"), join(root, ".vscode", "settings.json"));

  const r = await linkFolderToTenant(root, "acme");
  assert.equal(r.ok, false, "끊어진 링크를 따라가 폴더 밖에 만들었다");
  assert.equal(existsSync(join(outside, "없는파일.json")), false, "폴더 밖에 파일이 생겼다");
});

test("폴더 연결 — 주석이 섞인 settings.json 은 안 쓴다", async () => {
  const root = fresh();
  mkdirSync(join(root, ".vscode"));
  const jsonc = '{\n  // 주석\n  "editor.fontSize": 14\n}';
  writeFileSync(join(root, ".vscode", "settings.json"), jsonc);
  const r = await linkFolderToTenant(root, "credium");
  assert.equal(r.ok, false, "JSONC 를 덮어썼다");
  assert.equal(readFileSync(join(root, ".vscode", "settings.json"), "utf8"), jsonc, "내용이 바뀌었다");
});

test("표식 — 링크면 쓰지 않는다", async () => {
  const root = fresh();
  const outside = fresh();
  const shared = join(outside, "mark.json");
  writeFileSync(shared, "원본");
  mkdirSync(join(root, ".zalkera"));
  symlinkSync(shared, join(root, ".zalkera", "source.json"));

  const r = await writeSourceMarkTo(root, {
    tenant: "credium",
    revisionNo: 13,
    sha256: "abc",
    fetchedAt: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(r.ok, false, "링크를 따라가 썼다");
  assert.equal(readFileSync(shared, "utf8"), "원본", "폴더 밖 파일이 바뀌었다");
});

test("표식 — 정상 경로는 읽어 되돌아온다", async () => {
  const root = fresh();
  const r = await writeSourceMarkTo(root, {
    tenant: "credium",
    revisionNo: 13,
    sha256: "abc",
    fetchedAt: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  const mark = parseSourceMark(readFileSync(join(root, SOURCE_MARK_PATH), "utf8"));
  assert.equal(mark?.format === 1 ? mark.revisionNo : null, 13);
});

test("폴더 연결 — 못 읽으면 안 쓴다. 「없다」와 「못 읽는다」는 다르다", async () => {
  // 접어 버리면 읽기 실패가 「빈 파일」로 둔갑해 고객 설정을 통째로 날린다.
  const root = fresh();
  mkdirSync(join(root, ".vscode"));
  const path = join(root, ".vscode", "settings.json");
  const original = JSON.stringify({ "editor.fontSize": 14, "files.autoSave": "off" }, null, 2);
  writeFileSync(path, original);
  chmodSync(path, 0o222); // 쓰기만 가능 — 읽기가 EACCES 로 실패한다
  try {
    const r = await linkFolderToTenant(root, "credium");
    assert.equal(r.ok, false, "못 읽었는데 썼다");
    chmodSync(path, 0o644);
    assert.equal(readFileSync(path, "utf8"), original, "고객 설정이 날아갔다");
  } finally {
    chmodSync(path, 0o644);
  }
});

test("표식 format 2 — 발행본과 재연결본을 읽는다", () => {
  const published = parseSourceMark(
    JSON.stringify({ format: 2, origin: "published", tenant: "alpha", revisionNo: 7, publishedAt: "t" }),
  );
  assert.equal(published?.tenant, "alpha");
  assert.equal(published?.format === 2 ? published.origin : null, "published");

  const linked = parseSourceMark(
    JSON.stringify({ format: 2, origin: "linked", tenant: "beta", linkedAt: "t" }),
  );
  assert.equal(linked?.tenant, "beta");
  assert.equal(linked?.format === 2 ? linked.origin : null, "linked");
});

test("모르는 형식·결손 필드는 null — 거짓 확신을 만들지 않는다", () => {
  // 파서 교체 실수 하나로 기존 표식 전체가 null 이 되면, 이미 보호되던 폴더의 게이트가
  // 소리 없이 꺼진다. 양방향으로 고정한다.
  assert.equal(parseSourceMark(JSON.stringify({ format: 3, tenant: "a" })), null);
  assert.equal(parseSourceMark(JSON.stringify({ format: 2, origin: "wat", tenant: "a" })), null);
  // origin 은 맞는데 그 형상의 필수 칸이 없다.
  assert.equal(parseSourceMark(JSON.stringify({ format: 2, origin: "linked", tenant: "a" })), null);
  assert.equal(
    parseSourceMark(JSON.stringify({ format: 2, origin: "published", tenant: "a", publishedAt: "t" })),
    null,
  );
  // 소속이 없는 표식은 어느 형상이든 쓸모가 없다.
  assert.equal(parseSourceMark(JSON.stringify({ format: 2, origin: "linked", tenant: "", linkedAt: "t" })), null);
});

test("재연결 표식에는 「이미 받아 두셨습니다」가 뜨지 않는다 — 판 주장이 없다", () => {
  const linked = parseSourceMark(
    JSON.stringify({ format: 2, origin: "linked", tenant: "alpha", linkedAt: "t" }),
  );
  assert.equal(holdsSameRevision(linked, "alpha", 1), false);
  assert.equal(holdsSameRevision(linked, "alpha", 0), false);
  // 발행본도 마찬가지다. 판을 알기는 하지만 그것은 **올린 것**의 판이지, 그 폴더가 지금 그
  // 판의 사본이라는 뜻이 아니다 — 올린 뒤로 계속 편집했을 수 있다.
  const published = parseSourceMark(
    JSON.stringify({ format: 2, origin: "published", tenant: "alpha", revisionNo: 7, publishedAt: "t" }),
  );
  assert.equal(holdsSameRevision(published, "alpha", 7), false);
  // 받기 표식만 그 주장을 낼 수 있다.
  const fetched = parseSourceMark(
    JSON.stringify({ format: 1, tenant: "alpha", revisionNo: 7, sha256: "s", fetchedAt: "t" }),
  );
  assert.equal(holdsSameRevision(fetched, "alpha", 7), true);
  assert.equal(holdsSameRevision(fetched, "alpha", 8), false);
  assert.equal(holdsSameRevision(fetched, "beta", 7), false);
});

test("표식의 사이트 코드는 모양을 지켜야 읽힌다 — 폴더는 유통된다", () => {
  const bad = ["", "UPPER", "a b", "a/b", "-lead", "x".repeat(64), "../../etc", "a\u0000b"];
  for (const tenant of bad) {
    assert.equal(
      parseSourceMark(JSON.stringify({ format: 2, origin: "linked", tenant, linkedAt: "t" })),
      null,
      `모양이 틀린 코드가 통과했다: ${JSON.stringify(tenant)}`,
    );
  }
  // 정상 코드는 그대로 읽힌다 — 조이다가 멀쩡한 표식을 죽이면 게이트가 통째로 꺼진다.
  for (const tenant of ["credium", "a", "a-b-c", "x".repeat(63)]) {
    assert.equal(
      parseSourceMark(JSON.stringify({ format: 2, origin: "linked", tenant, linkedAt: "t" }))?.tenant,
      tenant,
      `정상 코드가 막혔다: ${tenant}`,
    );
  }
});
