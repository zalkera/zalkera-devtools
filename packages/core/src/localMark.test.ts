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
  assert.equal(mark?.revisionNo, 13);
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
