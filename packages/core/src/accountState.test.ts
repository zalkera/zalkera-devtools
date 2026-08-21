/**
 * **로그아웃이 계정에 딸린 것을 다 지우는가.**
 *
 * 한 자리가 빠지면 다음 사람이 앞사람의 것을 본다. 실제로 「고른 사이트」가 빠져 있었고,
 * A 로 로그아웃하고 B 로 로그인해도 화면에 A 의 사이트 이름이 남았다.
 *
 * ⚠ **지우는 동작은 확장에 있다**(VS Code 설정·SecretStorage 를 만진다). 여기서 잠그는 것은
 *   **목록**이고, 그 목록을 확장이 실제로 지우는지는 `check-wiring.mjs` 가 자리마다 못 박는다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_SCOPED } from "./accountState.ts";

const WHAT = ACCOUNT_SCOPED.map((e) => e.what);

test("계정에 딸린 자리가 넷이다 — 하나라도 빠지면 다음 사람이 앞사람 것을 본다", () => {
  assert.deepEqual([...WHAT].sort(), ["envCredentials", "issuedKeys", "tenant", "tokens"]);
});

test("`tenant` 가 목록에 있다 — 이것이 빠져서 A 의 사이트가 B 에게 보였다", () => {
  // 목록에서 빼는 순간 그 결함이 되돌아온다. 이름을 지목해 못 박는다.
  assert.ok(WHAT.includes("tenant"));
});

test("자리마다 **집행 조각**을 든다 — 목록만이면 아무것도 강제하지 않는다", () => {
  // 종전 판은 배열을 아무도 소비하지 않아 번들에서 통째로 사라졌다(트리셰이킹).
  // `check-wiring.mjs` 가 이 값을 읽어 확장에 그 조각이 있는지 본다.
  for (const entry of ACCOUNT_SCOPED) {
    assert.ok(entry.enforcedBy.length > 0, `${entry.what}: 집행 조각이 없다`);
    assert.ok(entry.why.length > 0, `${entry.what}: 왜 지워야 하는지가 없다`);
    // 조각이 실제 코드처럼 생겼는가 — 이름만 적어 두면 배선 검사가 아무 데나 걸린다.
    assert.match(entry.enforcedBy, /[(;]/, `${entry.what}: 조각이 코드가 아니다 — ${entry.enforcedBy}`);
  }
});

test("집행 조각이 서로 겹치지 않는다 — 겹치면 한 조각이 두 자리를 지키는 척한다", () => {
  const shapes = ACCOUNT_SCOPED.map((e) => e.enforcedBy);
  assert.equal(new Set(shapes).size, shapes.length);
});

test("목록이 비지 않았다 — 비면 배선 검사가 아무것도 안 지킨다", () => {
  assert.ok(ACCOUNT_SCOPED.length >= 4);
});
