import assert from "node:assert/strict";
import test from "node:test";
import { idleStatusPlan } from "./statusPlan.ts";

test("사이트를 고르면 상태바가 그 이름을 말한다", () => {
  const plan = idleStatusPlan({ tenant: "bix", folderTenant: null, site: null });
  assert.ok(plan.text.includes("bix"), `사이트 이름이 없다: ${plan.text}`);
  assert.equal(plan.warning, false);
});

test("안 골랐으면 이름 자리를 비운다 — 없는 것을 지어내지 않는다", () => {
  const plan = idleStatusPlan({ tenant: "", folderTenant: null, site: null });
  assert.equal(plan.warning, false);
  assert.ok(!plan.text.includes("undefined"), plan.text);
});

test("어긋나면 경고로 바뀌고 **양쪽 이름을 다 말한다**", () => {
  // 하나만 말하면 「무엇을 무엇으로」가 안 읽힌다.
  const plan = idleStatusPlan({ tenant: "bix", folderTenant: "credium", site: "/f" });
  assert.equal(plan.warning, true);
  assert.ok(plan.text.includes("credium"), plan.text);
  assert.ok(plan.text.includes("bix"), plan.text);
});

test("어긋남 술어가 게이트·사이드바와 같다 — 셋이 갈리면 화면마다 다른 말을 한다", () => {
  for (const input of [
    { tenant: "bix", folderTenant: "bix", site: "/f" },
    { tenant: "bix", folderTenant: null, site: "/f" },
    { tenant: "", folderTenant: "credium", site: "/f" },
    { tenant: "bix", folderTenant: "credium", site: null },
  ]) {
    assert.equal(idleStatusPlan(input).warning, false, `경고가 잘못 켜졌다: ${JSON.stringify(input)}`);
  }
});


/**
 * ⚠ **이 칸이 「하나씩 밀려 쓰게 된다」 신고의 화면 쪽이다.** 소속 없는 폴더의 창은 사이트를
 *   **전역 잔값**에서 물려받는데, 표기가 소속 있는 창과 똑같아 알아챌 자리가 없었다.
 */
test("소속 모르는 소스 폴더는 상태바가 예고형으로 말한다 — 경고색은 안 쓴다", () => {
    const plan = idleStatusPlan({tenant: "fin-01", folderTenant: null, site: "/x"});
    assert.notStrictEqual(plan.text, "$(zap) fin-01", "소속 있는 창과 표기가 같으면 알아챌 자리가 없다");
    assert.strictEqual(plan.warning, false, "정상 온보딩의 상태이기도 하다 — 경고 배경은 확증된 어긋남 전용이다");
    assert.ok(plan.tooltip.includes("사이트에 연결"), "다음에 할 일이 없다");
});

test("상태바 문자열에 경로를 싣지 않는다 — `$(…)` 가 아이콘으로 둔갑한다", () => {
    const plan = idleStatusPlan({tenant: "fin-01", folderTenant: null, site: "/home/$(rocket)/x"});
    assert.ok(!plan.text.includes("$(rocket)"), `경로가 상태바 문자열에 실렸다: ${plan.text}`);
});
