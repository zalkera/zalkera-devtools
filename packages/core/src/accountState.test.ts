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

test("계정에 딸린 자리가 넷이다 — 하나라도 빠지면 다음 사람이 앞사람 것을 본다", () => {
  assert.deepEqual(
    [...ACCOUNT_SCOPED].sort(),
    ["envCredentials", "issuedKeys", "tenant", "tokens"],
  );
});

test("`tenant` 가 목록에 있다 — 이것이 빠져서 A 의 사이트가 B 에게 보였다", () => {
  // 목록에서 빼는 순간 그 결함이 되돌아온다. 이름을 지목해 못 박는다.
  assert.ok(ACCOUNT_SCOPED.includes("tenant"));
});

test("목록이 비지 않았다 — 비면 배선 검사가 아무것도 안 지킨다", () => {
  assert.ok(ACCOUNT_SCOPED.length >= 4);
});
