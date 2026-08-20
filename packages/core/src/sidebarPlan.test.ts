/**
 * **사이드바가 무엇을 보여 주는가.**
 *
 * 이 시험이 없을 때, 「사이트가 붙으면 받기 진입점이 사라진다」가 아무 곳에도 안 걸렸다 — 명령은
 * 팔레트에 그대로 있어 명령 검사기도 통과했다. 사람 눈에만, 그것도 「불러오는 기능이 없다」는
 * 오해로 한참 뒤에 걸렸다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sidebarPlan, type SidebarState } from "./sidebarPlan.ts";

const base: SidebarState = {
  signedIn: true,
  tenant: "credium",
  site: null,
  previewUrl: null,
  keyExpiresAt: null,
};
const plan = (patch: Partial<SidebarState> = {}) => sidebarPlan({ ...base, ...patch });
const ids = (patch?: Partial<SidebarState>) => plan(patch).map((g) => g.id);
const commands = (patch?: Partial<SidebarState>) =>
  plan(patch).flatMap((g) => g.items.map((i) => i.command));

test("사이트가 붙어도 받기 진입점이 보인다", () => {
  // 이 한 줄이 이번 건의 요점이다. 사라지면 사람은 「불러오는 기능이 없다」로 읽는다.
  assert.ok(commands({ site: "/tmp/x" }).includes("zalkera.site.open"), "받기가 사이드바에서 사라졌다");
  assert.ok(commands().includes("zalkera.site.open"), "처음 쓰는 사람에게도 보여야 한다");
});

test("순서는 사이트 · 미리보기 · 내보내기 · 불러오기 · 버전 · 도움", () => {
  assert.deepEqual(ids({ site: "/tmp/x" }), ["site", "preview", "export", "source", "version", "help"]);
});

test("소스가 없으면 할 수 없는 일을 권하지 않는다 — 순서는 그대로다", () => {
  // 상태별로 순서를 따로 두지 않는다. 빠지는 묶음이 있을 뿐이다.
  assert.deepEqual(ids(), ["site", "source", "help"]);
});

test("소스가 있으면 「예제로 시작」·「폴더 연결」은 사이드바에서 뺀다", () => {
  // 셋이 다 보이면 「누르면 내 것이 날아가나」를 매번 다시 계산하게 된다. 팔레트에는 남는다.
  const withSite = commands({ site: "/tmp/x" });
  assert.ok(!withSite.includes("zalkera.site.create"), "예제로 시작이 남았다");
  assert.ok(!withSite.includes("zalkera.site.link"), "폴더 연결이 남았다");
  const fresh = commands();
  assert.ok(fresh.includes("zalkera.site.create") && fresh.includes("zalkera.site.link"));
});

test("묶음 id 는 라벨과 무관하다 — 문면을 다듬어도 접힘이 안 풀린다", () => {
  for (const g of plan({ site: "/tmp/x" })) {
    assert.ok(/^[a-z]+$/.test(g.id), `id 가 라벨에서 나온 것 같다: ${g.id}`);
    assert.ok(!g.id.includes(g.label), `id 에 라벨이 섞였다: ${g.id}`);
  }
});

test("id 는 겹치지 않는다 — 겹치면 접힘 상태가 서로를 덮는다", () => {
  const seen = plan({ site: "/tmp/x" }).map((g) => g.id);
  assert.equal(new Set(seen).size, seen.length);
});

test("미리보기가 돌면 중지가 함께 보인다", () => {
  const running = commands({ site: "/tmp/x", previewUrl: "http://localhost:3000" });
  assert.ok(running.includes("zalkera.preview.stop"), "돌고 있는데 멈출 길이 없다");
  assert.ok(!commands({ site: "/tmp/x" }).includes("zalkera.preview.stop"), "안 도는데 중지가 보인다");
});

test("로그인 전에는 로그인과 진단만", () => {
  assert.deepEqual(commands({ signedIn: false }), ["zalkera.signIn", "zalkera.doctor"]);
});

test("사이트를 안 골랐으면 고를 길을 준다 — 알리기만 하고 막다른 길로 두지 않는다", () => {
  assert.ok(commands({ tenant: "" }).includes("zalkera.site.choose"));
});
