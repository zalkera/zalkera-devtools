/**
 * **취소를 실패로 고지하지 않는가.**
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decideErrorNotice, isCancelled } from "./errorNotice.ts";
import { DevtoolsError } from "./errors.ts";

test("취소는 알림을 띄우지 않는다 — 스스로 그만둔 일을 실패로 고지하지 않는다", () => {
  const shown = decideErrorNotice(new DevtoolsError("CANCELLED", "로그인을 취소했습니다."));
  assert.equal(shown.kind, "cancelled");
  assert.equal(shown.message, "", "취소인데 알림 본문이 있다");
  assert.equal(shown.logPrefix, "취소", "출력에는 남아야 한다 — 무슨 일이 있었는지는 보여야 한다");
  assert.match(shown.raw, /취소했습니다/);
});

test("취소가 아닌 것은 알림으로 낸다", () => {
  const shown = decideErrorNotice(
    new DevtoolsError("SERVER_UNREACHABLE", "잘커라 서버에 연결하지 못했습니다.", "프록시를 확인해 주세요."),
  );
  assert.equal(shown.kind, "error");
  assert.match(shown.message, /연결하지 못했습니다/);
  assert.match(shown.message, /프록시/, "다음에 할 일이 빠졌다");
  assert.equal(shown.logPrefix, "오류");
});

test("취소 갈래를 무엇으로도 흉내 낼 수 없다 — 코드만 본다", () => {
  // 문면으로 판정하면 서버가 「취소」라는 낱말 하나로 오류를 조용히 감춘다.
  for (const impostor of [
    new DevtoolsError("SERVER_REJECTED", "취소: 서버가 거절했습니다."),
    new DevtoolsError("SERVER_REJECTED", "CANCELLED"),
    new Error("취소했습니다"),
    "취소",
  ]) {
    assert.equal(decideErrorNotice(impostor).kind, "error", String(impostor));
  }
});

test("알림 본문은 소독을 지난다 — 출력에는 원문이 남는다", () => {
  // 아카이브 항목 이름이 그대로 실려 **누르면 명령이 도는 링크**가 된 적이 있다.
  const evil = "../[열기](command:workbench.action.terminal.new)";
  const shown = decideErrorNotice(new DevtoolsError("SERVER_REJECTED", `받은 파일이 폴더 밖을 가리킵니다: ${evil}`));
  assert.ok(!/\]\(command:/.test(shown.message), `알림에 링크가 살아 있다: ${shown.message}`);
  assert.ok(shown.raw.includes("command:"), "출력에서 원문이 사라졌다 — 근거가 없어진다");
});

test("DevtoolsError 가 아닌 것도 알림으로 낼 수 있게 만든다", () => {
  // `JSON.parse` 실패 메시지는 입력 조각을 담는다 — 그 갈래도 소독을 지나야 한다.
  const raw = new SyntaxError('Unexpected token in [열기](command:evil)');
  const shown = decideErrorNotice(raw);
  assert.equal(shown.kind, "error");
  assert.ok(shown.message.length > 0);
  assert.ok(!/\]\(command:/.test(shown.message), shown.message);
});

test("취소 판정은 한 곳이다 — 표시와 흐름이 같은 사실을 본다", () => {
  // 뜻이 둘인 판정이라 자리마다 사본이 생겼다(확장에 셋 있었다). 사실을 하나로 두고 각자 답한다.
  const cancelled = new DevtoolsError("CANCELLED", "취소했습니다.");
  assert.equal(isCancelled(cancelled), true);
  assert.equal(decideErrorNotice(cancelled).kind, "cancelled");

  const other = new DevtoolsError("SERVER_REJECTED", "거절");
  assert.equal(isCancelled(other), false);
  assert.equal(decideErrorNotice(other).kind, "error");
});

test("취소 판정은 코드만 본다 — 문면·타입으로 흉내 낼 수 없다", () => {
  for (const impostor of [
    new DevtoolsError("SERVER_REJECTED", "취소했습니다"),
    new Error("CANCELLED"),
    {code: "CANCELLED"},
    "CANCELLED",
    null,
    undefined,
  ]) {
    assert.equal(isCancelled(impostor), false, String(impostor));
  }
});
