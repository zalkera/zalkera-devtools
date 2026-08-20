/**
 * **발급해 둔 열쇠를 하나도 잃지 않는가.**
 *
 * 잃으면 그 열쇠가 최대 12시간 상용 데이터를 읽는다 — 화면은 로그아웃인데.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ISSUED_KEYS,
  addIssuedKey,
  addIssuedKeyWithOverflow,
  readIssuedKeys,
  readIssuedKeysWithOverflow,
  removeIssuedKey,
} from "./issuedKeys.ts";

test("두 창이 각각 켜면 둘 다 남는다 — 뒤에 켠 것이 앞것을 덮지 않는다", () => {
  // 이 한 줄이 이번 건의 요점이다. 한 칸이면 창 A 가 다시 열릴 때 B 의 열쇠를 읽고, 로그아웃이
  // B 것을 지우면서 A 것을 영영 남긴다.
  let list = addIssuedKey([], { keyId: 1, tenant: "alpha" });
  list = addIssuedKey(list, { keyId: 2, tenant: "beta" });
  assert.deepEqual(list, [
    { keyId: 1, tenant: "alpha" },
    { keyId: 2, tenant: "beta" },
  ]);
});

test("열쇠마다 자기 사이트를 들고 다닌다 — 폐기는 그 헤더로 나간다", () => {
  const list = addIssuedKey(addIssuedKey([], { keyId: 1, tenant: "alpha" }), { keyId: 2, tenant: "beta" });
  assert.equal(list.find((k) => k.keyId === 1)?.tenant, "alpha");
  assert.equal(list.find((k) => k.keyId === 2)?.tenant, "beta");
});

test("같은 열쇠를 다시 적어도 두 번 안 남는다", () => {
  const list = addIssuedKey(addIssuedKey([], { keyId: 7, tenant: "a" }), { keyId: 7, tenant: "a" });
  assert.equal(list.length, 1);
});

test("뺀 것은 없어지고, 없는 것을 빼도 조용하다", () => {
  const list = addIssuedKey(addIssuedKey([], { keyId: 1, tenant: "a" }), { keyId: 2, tenant: "b" });
  assert.deepEqual(removeIssuedKey(list, 1), [{ keyId: 2, tenant: "b" }]);
  assert.deepEqual(removeIssuedKey(removeIssuedKey(list, 1), 1), [{ keyId: 2, tenant: "b" }]);
});

test("옛 판이 남긴 단일 객체도 읽는다 — 안 읽으면 살아 있는 열쇠가 미아가 된다", () => {
  assert.deepEqual(readIssuedKeys({ keyId: 9, tenant: "old" }), [{ keyId: 9, tenant: "old" }]);
});

test("망가진 항목은 **그것만** 버린다", () => {
  // 통째로 버리면 지워야 할 열쇠를 못 지우고, 통째로 믿으면 `undefined.keyId` 가 로그아웃을 끊는다.
  const read = readIssuedKeys([
    { keyId: 1, tenant: "a" },
    null,
    { keyId: "2", tenant: "b" },
    { keyId: 3 },
    { keyId: 0, tenant: "c" },
    { keyId: 4, tenant: "" },
    "문자열",
    { keyId: 5, tenant: "e" },
  ]);
  assert.deepEqual(read, [
    { keyId: 1, tenant: "a" },
    { keyId: 5, tenant: "e" },
  ]);
});

test("아무것도 없거나 모양이 아니면 빈 목록", () => {
  for (const raw of [undefined, null, 0, "", "x", { keyId: 1 }, {}]) {
    assert.deepEqual(readIssuedKeys(raw), [], `${JSON.stringify(raw)} 를 열쇠로 읽었다`);
  }
});

test("망가진 값이 무한정 쌓이지 않는다", () => {
  const many = Array.from({ length: MAX_ISSUED_KEYS + 20 }, (_, i) => ({ keyId: i + 1, tenant: "t" }));
  assert.equal(readIssuedKeys(many).length, MAX_ISSUED_KEYS);
  // 최근 것이 남는다 — 오래된 것은 TTL 로 만료된다.
  assert.equal(readIssuedKeys(many).at(-1)?.keyId, MAX_ISSUED_KEYS + 20);
  let list: { keyId: number; tenant: string }[] = [];
  for (const k of many) list = addIssuedKey(list, k);
  assert.equal(list.length, MAX_ISSUED_KEYS);
});

test("상한을 넘어 밀려난 열쇠를 **돌려준다** — 조용히 버리면 그것이 12시간 산다", () => {
  // 도움말은 「로그아웃하면 서버에서 폐기됩니다」를 무조건으로 약속한다. 목록에서 말없이
  // 떨어진 열쇠는 아무도 못 지운다(심의 권고).
  const full = Array.from({ length: MAX_ISSUED_KEYS }, (_, i) => ({ keyId: i + 1, tenant: "t" }));
  const { list, dropped } = addIssuedKeyWithOverflow(full, { keyId: 9999, tenant: "새것" });
  assert.equal(list.length, MAX_ISSUED_KEYS);
  assert.deepEqual(dropped, [{ keyId: 1, tenant: "t" }], "밀려난 것을 안 돌려줬다");
  assert.equal(list.at(-1)?.keyId, 9999);
  assert.equal(list.some((k) => k.keyId === 1), false, "밀려난 것이 목록에 남았다");
});

test("저장된 값이 상한을 넘었을 때도 밀려난 것을 돌려준다", () => {
  const many = Array.from({ length: MAX_ISSUED_KEYS + 3 }, (_, i) => ({ keyId: i + 1, tenant: "t" }));
  const { list, dropped } = readIssuedKeysWithOverflow(many);
  assert.equal(list.length, MAX_ISSUED_KEYS);
  assert.deepEqual(dropped.map((k) => k.keyId), [1, 2, 3]);
});

test("정상 사용에서는 밀려나는 것이 없다 — 상한은 방지선이지 정책이 아니다", () => {
  assert.deepEqual(addIssuedKeyWithOverflow([], { keyId: 1, tenant: "a" }).dropped, []);
  assert.deepEqual(readIssuedKeysWithOverflow([{ keyId: 1, tenant: "a" }]).dropped, []);
  // 같은 열쇠를 다시 적는 것(갱신)도 밀어내지 않는다.
  const full = Array.from({ length: MAX_ISSUED_KEYS }, (_, i) => ({ keyId: i + 1, tenant: "t" }));
  assert.deepEqual(addIssuedKeyWithOverflow(full, { keyId: 1, tenant: "t" }).dropped, []);
});

test("짧은 이름은 긴 이름과 같은 목록을 준다 — 두 벌이 갈리면 한쪽만 고쳐진다", () => {
  const full = Array.from({ length: MAX_ISSUED_KEYS + 5 }, (_, i) => ({ keyId: i + 1, tenant: "t" }));
  assert.deepEqual(readIssuedKeys(full), readIssuedKeysWithOverflow(full).list);
  assert.deepEqual(addIssuedKey(full, { keyId: 1, tenant: "t" }), addIssuedKeyWithOverflow(full, { keyId: 1, tenant: "t" }).list);
});
