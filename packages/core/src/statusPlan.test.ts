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
