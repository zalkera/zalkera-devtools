/**
 * **받을 판·받을 자리 판정의 시험.** 이 판정이 틀리면 화면에 말한 것과 실제로 받는 것이 갈린다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decideFetchedInto, nextAvailableName, noRevisionError, pickRevision, suggestFolderName } from "./fetchTarget.ts";

const rev = (revisionNo: number, status: string, isActive = false) => ({ revisionNo, status, isActive });

test("켜진 판이 있으면 그것을 받는다", () => {
  const choice = pickRevision([rev(11, "READY"), rev(12, "READY", true), rev(13, "READY")]);
  assert.deepEqual(choice, { revisionNo: 12, why: "active" });
});

test("켜진 판이 없으면 READY 중 가장 큰 번호 — 목록 첫 줄로 때우지 않는다", () => {
  // `revisions[0]` 로 때우면 그것이 BUILDING·FAILED 일 수 있고, 그러면 화면에 말한 판과
  // 실제로 받는 것이 갈린다.
  const choice = pickRevision([rev(14, "BUILDING"), rev(13, "FAILED"), rev(12, "READY"), rev(11, "READY")]);
  assert.deepEqual(choice, { revisionNo: 12, why: "latest-ready" });
});

test("READY 가 하나도 없으면 고르지 않는다", () => {
  assert.equal(pickRevision([rev(3, "BUILDING"), rev(2, "FAILED")]), null);
  assert.equal(pickRevision([]), null);
});

test("켜진 판이 READY 가 아니면 켜진 것으로 세지 않는다", () => {
  // 서버가 그런 상태를 낼 수 있는지와 무관하게, 받을 수 없는 것을 「이걸 받습니다」라고 말하면 안 된다.
  const choice = pickRevision([rev(9, "BUILDING", true), rev(8, "READY")]);
  assert.deepEqual(choice, { revisionNo: 8, why: "latest-ready" });
});

test("폴더 이름은 판 번호로 특정한다 — 지문을 이름에 넣지 않는다", () => {
  // 판 번호가 이미 불변 식별자다. 지문을 더하면 같은 말을 두 번 하면서 사람이 못 읽는 글자만 는다.
  assert.equal(suggestFolderName("credium", 13), "credium-v13");
  assert.equal(suggestFolderName("credium/", 13), "credium-v13");
  assert.equal(suggestFolderName("  내사이트  ", 7), "내사이트-v7");
  assert.equal(suggestFolderName("", 1), "site-v1", "이름이 없어도 쓸 수 있는 이름을 낸다");
});

test("이름이 남의 것이면 비킨다 — 덮어쓰지 않는다", () => {
  const used = new Set(["a-v1", "a-v1-2", "a-v1-3"]);
  assert.equal(nextAvailableName("a-v1", (n) => used.has(n)), "a-v1-4");
  assert.equal(nextAvailableName("b-v1", (n) => used.has(n)), "b-v1");
});

test("끝없이 매달리지 않는다 — 못 찾으면 사람에게 고르게 한다", () => {
  assert.equal(nextAvailableName("x", () => true, 5), null);
});

test("한 번도 안 올린 사람에게 「빌드 중이거나 실패했다」고 말하지 않는다", () => {
    // 뭉치면 처음 쓰는 사람이 「버전 이력」을 열어 빈 목록을 본다 — 도구가 자기 상태를 잘못 진단해
    // 놓고 사람을 엉뚱한 곳으로 보내는 것이다.
    const empty = noRevisionError([]);
    assert.match(empty.message, /올린 사이트 소스가 없/);
    assert.match(empty.hint ?? "", /예제 zip 다운로드/);
    assert.doesNotMatch(empty.hint ?? "", /만들어지는 중|실패/);
});

test("올렸는데 아직 못 켜는 경우는 그렇게 말한다", () => {
    const notReady = noRevisionError([rev(3, "BUILDING"), rev(2, "FAILED")]);
    assert.match(notReady.hint ?? "", /만들어지는 중이거나 실패/);
    assert.doesNotMatch(notReady.hint ?? "", /예제 zip 다운로드/);
});

test("두 문장은 서로 달라야 한다 — 같으면 가른 뜻이 없다", () => {
    assert.notEqual(noRevisionError([]).hint, noRevisionError([rev(1, "BUILDING")]).hint);
});

// ── 받은 뒤 무엇을 말하고 무엇을 내나 ──────────────────────────────────────
//
// 이 자리는 확장 안 조건문으로 뒀다가 **두 번** 틀렸다. 문면 갈래는 `tenantScope.test.ts` 가
// 물지만 「어느 갈래를 고르는가」는 아무도 안 물었다 — 그래서 판정을 여기로 내렸다.

test("지금 폴더에 풀었으면 그렇게 말하고, 열 것이 없다", () => {
  assert.deepEqual(decideFetchedInto({ openDir: "/w/a", target: "/w/a", root: "/w/a" }), {
    into: "into-open",
    needsOpen: false,
  });
});

test("감싼 꾸러미면 **문면은 지금 폴더, 단추는 남는다**", () => {
  // `findProjectRoot` 가 한 단계 내려간 칸. 여기서 단추를 없애면 하위 폴더로 갈 길이 사라지고,
  // 「새 폴더로 받았습니다」로 접으면 지금 폴더가 안 바뀌었다는 거짓이 된다.
  assert.deepEqual(
    decideFetchedInto({ openDir: "/w/a", target: "/w/a", root: "/w/a/inner" }),
    { into: "into-open-nested", needsOpen: true },
  );
});

test("옆 폴더로 받았으면 sibling 이고 열 것이 있다", () => {
  assert.deepEqual(decideFetchedInto({ openDir: "/w/a", target: "/w/b", root: "/w/b" }), {
    into: "sibling",
    needsOpen: true,
  });
});

test("열린 폴더가 없으면 only", () => {
  assert.deepEqual(decideFetchedInto({ openDir: null, target: "/w/b", root: "/w/b" }), {
    into: "only",
    needsOpen: true,
  });
});

test("네 갈래가 **서로 다른 입력에서만** 나온다 — 뭉치면 한 칸이 거짓이 된다", () => {
  const seen = new Set(
    [
      { openDir: "/w/a", target: "/w/a", root: "/w/a" },
      { openDir: "/w/a", target: "/w/a", root: "/w/a/inner" },
      { openDir: "/w/a", target: "/w/b", root: "/w/b" },
      { openDir: null, target: "/w/b", root: "/w/b" },
    ].map((i) => decideFetchedInto(i).into),
  );
  assert.equal(seen.size, 4, [...seen].join(","));
});
