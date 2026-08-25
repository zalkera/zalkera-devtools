import assert from "node:assert/strict";
import test from "node:test";
import { displayPath } from "./displayPath.ts";

test("짧은 경로는 손대지 않는다", () => {
  assert.strictEqual(displayPath("/srv/a", null), "/srv/a");
});

test("홈 아래는 `~` 로 접는다 — 다만 폴더 경계에서만", () => {
  assert.strictEqual(displayPath("/home/jo/site", "/home/jo"), "~/site");
  assert.strictEqual(displayPath("/home/jo", "/home/jo"), "~");
  // ⚠ 접두 문자열만 보면 `/home/jonghwa` 가 `/home/jo` 아래로 잘못 접힌다.
  assert.strictEqual(displayPath("/home/jonghwa", "/home/jo"), "/home/jonghwa");
});

test("**꼬리를 지킨다** — 식별력이 마지막 폴더 이름에 있다", () => {
  const long = "/home/jonghwa/projects/zalkera/customers/fin-01-v7";
  const shown = displayPath(long, null);
  assert.ok(shown.length <= 44, `상한을 넘었다: ${shown}`);
  assert.ok(shown.endsWith("fin-01-v7"), `꼬리가 잘렸다: ${shown}`);
  assert.ok(shown.startsWith("…/"), `머리를 접었다는 표시가 없다: ${shown}`);
});

test("아주 긴 이름 하나여도 꼬리를 지킨다 — 판 번호가 끝에 있다", () => {
  const shown = displayPath(`/x/${"a".repeat(80)}-v12`, null);
  assert.ok(shown.length <= 44, `상한을 넘었다: ${shown.length}`);
  assert.ok(shown.endsWith("-v12"), `판 번호가 사라졌다: ${shown}`);
});

test("윈도 경로는 그 표기를 지킨다", () => {
  const shown = displayPath("C:\\Users\\jonghwa\\projects\\zalkera\\customers\\fin-02", null);
  assert.ok(shown.includes("\\"), `구분자가 바뀌었다: ${shown}`);
  assert.ok(shown.endsWith("fin-02"), `꼬리가 잘렸다: ${shown}`);
});

test("홈을 모르면 접지 않는다 — 없는 것을 지어내지 않는다", () => {
  assert.strictEqual(displayPath("/home/jo/site", undefined), "/home/jo/site");
});
