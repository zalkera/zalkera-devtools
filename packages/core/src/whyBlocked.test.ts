/**
 * **못 하는 이유를 말하는가.**
 *
 * 사이드바가 여섯 묶음을 항상 보여 주는 대신, 요건이 안 맞으면 **누를 때** 말한다.
 * 그 말이 틀리거나 다음에 할 일을 안 주면, 사람은 「눌러도 아무 일이 없다」에 갇힌다.
 *
 * 재현: `npm test -w @zalkera/devtools-core`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { commandsWithNeeds, decideBlocked } from "./whyBlocked.ts";

const NOTHING = { signedIn: false, tenant: "", site: null, folderTenant: null };
const SIGNED = { signedIn: true, tenant: "", site: null, folderTenant: null };
const PICKED = { signedIn: true, tenant: "bix", site: null, folderTenant: null };
const READY = { signedIn: true, tenant: "bix", site: "/tmp/x", folderTenant: null };
/** 표식은 x, 고른 것은 y — 이번 설계가 막는 상태. */
const MISMATCH = { signedIn: true, tenant: "bix", site: "/tmp/x", folderTenant: "credium" };
/** 소속과 고른 것이 같다 — 막을 이유가 없다. */
const MATCHED = { signedIn: true, tenant: "bix", site: "/tmp/x", folderTenant: "bix" };

test("로그인 전에는 로그인을 먼저 말한다 — 둘을 한 번에 말하면 무엇부터 할지 모른다", () => {
  const blocked = decideBlocked("zalkera.preview.start", NOTHING);
  assert.ok(blocked);
  assert.match(blocked.message, /로그인/);
  assert.equal(blocked.action?.command, "zalkera.signIn");
});

test("로그인했으면 다음 요건을 말한다", () => {
  const blocked = decideBlocked("zalkera.preview.start", SIGNED);
  assert.ok(blocked);
  assert.match(blocked.message, /사이트를 먼저 골라/);
  assert.equal(blocked.action?.command, "zalkera.site.choose");
});

test("소스가 없으면 어디서 받는지 가리킨다 — 「없습니다」로 끝내지 않는다", () => {
  const blocked = decideBlocked("zalkera.preview.start", PICKED);
  assert.ok(blocked);
  assert.match(blocked.message, /불러오기/);
  assert.equal(blocked.action?.command, "zalkera.site.open");
});

test("요건이 갖춰지면 막지 않는다", () => {
  for (const command of commandsWithNeeds()) {
    assert.equal(decideBlocked(command, READY), null, `${command} 가 갖춰졌는데 막혔다`);
  }
});

test("요건이 없는 명령은 언제나 눌린다", () => {
  // 로그인·도움말·진단·초기화는 막힌 사람이 쓰는 것이다. 그것까지 막으면 빠져나갈 길이 없다.
  for (const command of ["zalkera.signIn", "zalkera.help", "zalkera.doctor", "zalkera.reset", "zalkera.site.choose"]) {
    assert.equal(decideBlocked(command, NOTHING), null, `${command} 를 막았다 — 막힌 사람의 탈출구다`);
  }
});

test("막힌 문면에는 **반드시** 다음에 할 일이 붙는다", () => {
  for (const command of commandsWithNeeds()) {
    for (const state of [NOTHING, SIGNED, PICKED]) {
      const blocked = decideBlocked(command, state);
      if (!blocked) continue;
      assert.ok(blocked.action, `${command}: 다음에 할 일이 없다 — ${blocked.message}`);
      assert.ok(blocked.action.label.length > 0);
      assert.match(blocked.action.command, /^zalkera\./);
    }
  }
});

test("데려다 주는 자리가 그 자체로 막히지 않는다 — 고리가 생기면 빠져나갈 수 없다", () => {
  // 「사이트를 고르세요 → 사이트 선택」을 눌렀는데 그것도 막히면 무한 고리다.
  for (const command of commandsWithNeeds()) {
    // ⚠ **어긋난 상태(MISMATCH)까지 본다.** 그 상태의 탈출구 둘에 요건이 붙으면 폴더가 갇힌다.
    for (const state of [NOTHING, SIGNED, PICKED, MISMATCH]) {
      const blocked = decideBlocked(command, state);
      if (!blocked) continue;
      // 두 버튼을 **같이** 본다 — 한쪽만 검사하면 다른 쪽에 요건이 붙어도 초록이다.
      for (const way of [blocked.action, blocked.alternative]) {
        if (!way) continue;
        assert.equal(
          decideBlocked(way.command, state),
          null,
          `${command} → ${way.command} 가 같은 상태에서 또 막힌다`,
        );
      }
    }
  }
});

test("목록이 비지 않았다 — 비면 위 시험이 전부 공허하게 초록이다", () => {
  assert.ok(commandsWithNeeds().length >= 8, `요건 있는 명령이 ${commandsWithNeeds().length}개`);
});

test("도는 것을 멈추는 명령에는 요건이 없다 — 폴더가 닫혀도 dev 서버를 끌 수 있어야 한다", () => {
  // 요건을 걸면 미리보기가 도는 중에 폴더/사이트 선택이 풀렸을 때 **중지 단추가 무동작**이
  // 되어, 발급된 자격증명을 들고 있는 dev 서버를 화면에서 끌 수 없다(심의 권고).
  for (const state of [NOTHING, SIGNED, PICKED, READY]) {
    assert.equal(decideBlocked("zalkera.preview.stop", state), null, "중지가 막혔다");
  }
});

test("어긋난 폴더 — 폴더를 만지는 명령은 막고, 탈출구는 안 막는다", () => {
  // 게이트가 서는 여섯. 이 목록을 지우면 교차 오염이 그대로 돌아온다.
  // 갱신은 **남의 사이트 폴더를 지우는** 형태라 여기 빠지면 그 사고가 무경고로 난다.
  for (const command of [
    "zalkera.preview.start",
    "zalkera.preview.restart",
    "zalkera.agent.connect",
    "zalkera.precheck",
    "zalkera.publish",
    "zalkera.site.updateZip",
  ]) {
    const blocked = decideBlocked(command, MISMATCH);
    assert.ok(blocked, `${command} 가 어긋난 폴더에서 안 막혔다`);
    assert.equal(blocked.action?.command, "zalkera.site.useFolder");
    assert.equal(blocked.alternative?.command, "zalkera.site.open");
  }
  // 재연결과 복귀는 이 상태의 정규 탈출구다 — 막으면 빠져나갈 수 없다.
  for (const command of ["zalkera.site.link", "zalkera.site.useFolder"]) {
    assert.equal(decideBlocked(command, MISMATCH), null, `${command} 가 막혔다 — 탈출구다`);
  }
});

test("어긋남이 아닌 상태는 막지 않는다 — 조임 실수로 기존 사용자를 세우지 않는다", () => {
  // 표식이 없으면 「모른다」다. 막으면 표식 없이 받아 둔 폴더를 쓰는 사람이 전부 멈춘다.
  assert.equal(decideBlocked("zalkera.publish", READY), null, "표식 없는 폴더를 막았다");
  // 소속과 고른 것이 같으면 막을 이유가 없다.
  assert.equal(decideBlocked("zalkera.publish", MATCHED), null, "일치하는데 막았다");
  // 이 창에 소스가 없으면 그것은 `site` 요건이 할 말이지 이 자리가 아니다.
  const noSite = { signedIn: true, tenant: "bix", site: null, folderTenant: "credium" };
  assert.equal(
    decideBlocked("zalkera.publish", noSite)?.action?.command,
    "zalkera.site.open",
    "소스 없음이 어긋남으로 보고됐다",
  );
});

test("어긋남 문면은 두 사이트 이름을 **둘 다** 담는다", () => {
  // 하나만 말하면 사람이 「무엇을 무엇으로 바꿔야 하는지」를 못 읽는다.
  const blocked = decideBlocked("zalkera.publish", MISMATCH);
  assert.ok(blocked?.message.includes("credium"), `폴더 사이트가 없다: ${blocked?.message}`);
  assert.ok(blocked?.message.includes("bix"), `고른 사이트가 없다: ${blocked?.message}`);
});

test("소속을 정하는 자리는 **어떤 상태에서도** 사이트 미선택으로 막히지 않는다", () => {
  // ⚠ 이것은 고리 시험이 못 잡는 종류다. 고리 시험은 「같은 상태에서 버튼이 또 막히는가」만
  //   보는데, 이 사고는 **선택이 아무것도 안 적어 상태가 안 바뀌는** 교차-함수 고리였다:
  //   로그아웃이 링크를 지우고 표식만 남긴 폴더 → 다른 계정이 사이트를 골라도 소속이 달라
  //   무기록 → tenant 가 영원히 비어 재연결이 막힘 → 사이트 선택으로 되돌려 보냄 → 무한.
  for (const folderTenant of [null, "x"]) {
    for (const tenant of ["", "y"]) {
      const state = { signedIn: true, tenant, site: "/f", folderTenant };
      for (const escape of ["zalkera.site.link", "zalkera.site.useFolder"]) {
        assert.equal(
          decideBlocked(escape, state),
          null,
          `${escape} 가 막혔다 — 폴더의 소속을 정할 길이 사라진다: ${JSON.stringify(state)}`,
        );
      }
    }
  }
});
