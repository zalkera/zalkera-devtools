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
import { commandsWithNeeds } from "./whyBlocked.ts";

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
  plan(patch).flatMap((g) => g.items.map((i) => (i.kind === "action" ? i.command : undefined)));

test("사이트가 붙어도 받기 진입점이 보인다", () => {
  // 이 한 줄이 이번 건의 요점이다. 사라지면 사람은 「불러오는 기능이 없다」로 읽는다.
  assert.ok(commands({ site: "/tmp/x" }).includes("zalkera.site.open"), "받기가 사이드바에서 사라졌다");
  assert.ok(commands().includes("zalkera.site.open"), "처음 쓰는 사람에게도 보여야 한다");
});

test("순서는 사이트 · 미리보기 · 내보내기 · 불러오기 · 버전 · 도움", () => {
  assert.deepEqual(ids({ site: "/tmp/x" }), ["site", "preview", "export", "source", "version", "help"]);
});

test("소스가 없어도 여섯 묶음이 다 보인다 — 없으면 「갱신이 안 됐다」로 읽힌다", () => {
  // 오너 확정. 종전에는 못 하는 것을 숨겼는데, 실사용에서 그 대가가 더 컸다 — 확장을 새로
  // 깔았는데 메뉴가 셋뿐이니 갱신 실패로 읽혔다. 사람은 없는 것을 「조건이 안 됐다」로 읽지 않는다.
  // 못 하는 이유는 **누를 때** 말한다(`whyBlocked`).
  assert.deepEqual(ids(), ["site", "preview", "export", "source", "version", "help"]);
});

test("소스가 있으나 없으나 묶음과 순서가 같다 — 화면이 흔들리지 않는다", () => {
  assert.deepEqual(ids(), ids({ site: "/tmp/x" }));
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

test("모든 실행 항목은 실제로 누를 수 있어야 한다", () => {
  // 「목록에 있다」와 「누를 수 있다」는 다르다. 렌더러는 `kind` 를 보고 `info` 면 명령을 통째로
  // 버리므로, 명령만 세는 판정은 사이드바 전체를 안 눌리게 만들어도 통과한다.
  // ⚠ **상태를 하나라도 빼면 그 상태의 사이드바는 아무도 안 본다.** 「사이트를 안 골랐다」가
  //   빠져 있었는데, 그 화면은 처음 쓰는 사람이 반드시 지나는 자리다.
  for (const state of [
    {},
    { tenant: "" },
    { site: "/tmp/x" },
    { site: "/tmp/x", previewUrl: "http://x" },
    { signedIn: false },
  ]) {
    for (const g of plan(state)) {
      for (const i of g.items) {
        if (i.kind === "info") continue;
        assert.ok(i.command.length > 0, `${g.id}/${i.label}: 명령이 비었다`);
        assert.ok(i.label.length > 0, `${g.id}: 라벨이 비었다`);
      }
    }
  }
});

test("누를 수 있어야 하는 항목이 info 로 바뀌면 잡는다", () => {
  // 이 단언이 없으면 「사이트 소스 받기」를 info 로 바꿔도 전건 초록이다.
  const actions = plan({ site: "/tmp/x" })
    .flatMap((g) => g.items)
    .flatMap((i) => (i.kind === "action" ? [i.command] : []));
  for (const must of [
    "zalkera.site.open",
    "zalkera.preview.start",
    "zalkera.publish",
    "zalkera.version.switch",
    "zalkera.help",
  ]) {
    assert.ok(actions.includes(must), `${must} 가 누를 수 있는 항목이 아니다`);
  }
});

test("사이트가 붙으면 「불러오기」에는 받기 하나만 남는다 — 매뉴얼이 그렇게 적혀 있다", () => {
  // help.md 가 「사이트가 연결된 뒤에는 사이드바의 **불러오기** 에 「사이트 소스 받기」만 보입니다」
  // 라고 단정한다. 그 문장을 지키는 것이 여기밖에 없다 — 항목이 하나 더 늘어도 문서만 거짓이 된다.
  const attached = plan({ site: "/tmp/x" }).find((g) => g.id === "source");
  assert.ok(attached, "「불러오기」 묶음이 사라졌다");
  assert.deepEqual(
    attached.items.map((i) => (i.kind === "action" ? i.command : `info:${i.label}`)),
    ["zalkera.site.open"],
  );

  // 붙기 **전**도 함께 못 박는다 — 한쪽만 재면 다른 갈래에 항목이 늘어도 아무도 안 본다.
  const fresh = plan().find((g) => g.id === "source");
  assert.ok(fresh, "처음 쓰는 사람에게 「불러오기」가 없다");
  assert.deepEqual(
    fresh.items.map((i) => (i.kind === "action" ? i.command : `info:${i.label}`)),
    ["zalkera.site.create", "zalkera.site.open", "zalkera.site.link"],
  );
});

test("툴팁이 세는 수와 실제 항목 수가 같다", () => {
  // 「셋 중 하나로 시작합니다」는 **약속**이다. 항목이 넷이 되면 툴팁만 조용히 거짓이 되는데,
  // 그것을 보는 눈이 아무 데도 없었다.
  const WORDS: Record<string, number> = { 둘: 2, 셋: 3, 넷: 4, 다섯: 5 };
  let checked = 0;
  for (const state of [{}, { tenant: "" }, { site: "/tmp/x" }, { site: "/tmp/x", previewUrl: "http://x" }]) {
    for (const g of plan(state)) {
      const said = g.tooltip?.match(/([둘셋넷다섯])\s*중/);
      if (!said) continue;
      checked += 1;
      assert.equal(g.items.length, WORDS[said[1]!], `${g.id} 툴팁은 「${said[1]} 중」인데 항목은 ${g.items.length}개다`);
    }
  }
  assert.ok(checked > 0, "세는 툴팁을 하나도 못 찾았다 — 이 시험이 아무것도 안 재고 있다");
});

test("사이드바가 보여 주는 명령은 요건 판정이 **알고 있다**", () => {
  // 여섯 묶음이 항상 보이므로, 요건 목록에 없는 명령은 조건이 안 맞아도 **그냥 돈다.**
  // 그것이 의도인지 빠뜨린 것인지 목록만 보면 모른다 — 여기서 그 차이를 못 박는다.
  //
  // 요건이 **없어야 하는** 것: 막힌 사람의 탈출구(로그인·사이트 선택·도움말·진단·초기화·로그아웃)
  // 와, 미리보기가 도는 동안에만 보이는 중지.
  const EXITS = new Set([
    "zalkera.signIn",
    "zalkera.signOut",
    "zalkera.site.choose",
    "zalkera.help",
    "zalkera.doctor",
    "zalkera.reset",
  ]);
  const known = new Set(commandsWithNeeds());
  const shown = new Set(
    [{}, { tenant: "" }, { site: "/tmp/x" }, { site: "/tmp/x", previewUrl: "http://x" }, { signedIn: false }]
      .flatMap((s) => plan(s))
      .flatMap((g) => g.items)
      .flatMap((i) => (i.kind === "action" ? [i.command] : [])),
  );
  const unknown = [...shown].filter((c) => !known.has(c) && !EXITS.has(c)).sort();
  assert.deepEqual(
    unknown,
    [],
    `요건 판정이 모르는 명령이 사이드바에 있다 — whyBlocked.ts 에 적거나 탈출구로 선언하십시오: ${unknown.join(" ")}`,
  );
});

test("요건 목록에 사이드바 밖 명령이 섞이지 않았다", () => {
  // 목록이 낡으면 「막는다」고 적힌 것이 아무것도 안 막는다. 사이드바·팔레트 어디에도 없는
  // 명령이 목록에 있으면 그것은 이름이 바뀐 흔적이다.
  const all = new Set(
    [{}, { tenant: "" }, { site: "/tmp/x" }, { site: "/tmp/x", previewUrl: "http://x" }, { signedIn: false }]
      .flatMap((s) => plan(s))
      .flatMap((g) => g.items)
      .flatMap((i) => (i.kind === "action" ? [i.command] : [])),
  );
  // 팔레트에만 있는 것도 정당하다(예제로 시작·폴더 연결은 소스가 있으면 사이드바에서 빠진다).
  const PALETTE_ONLY = new Set(["zalkera.site.create", "zalkera.site.link", "zalkera.preview.restart"]);
  const stale = commandsWithNeeds().filter((c) => !all.has(c) && !PALETTE_ONLY.has(c));
  assert.deepEqual(stale, [], `요건 목록에 죽은 명령이 있다: ${stale.join(" ")}`);
});
