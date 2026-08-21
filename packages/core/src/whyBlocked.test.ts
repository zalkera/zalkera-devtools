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
import { commandsWithNeeds, whyBlocked } from "./whyBlocked.ts";

const NOTHING = { signedIn: false, tenant: "", site: null };
const SIGNED = { signedIn: true, tenant: "", site: null };
const PICKED = { signedIn: true, tenant: "bix", site: null };
const READY = { signedIn: true, tenant: "bix", site: "/tmp/x" };

test("로그인 전에는 로그인을 먼저 말한다 — 둘을 한 번에 말하면 무엇부터 할지 모른다", () => {
  const blocked = whyBlocked("zalkera.preview.start", NOTHING);
  assert.ok(blocked);
  assert.match(blocked.message, /로그인/);
  assert.equal(blocked.action?.command, "zalkera.signIn");
});

test("로그인했으면 다음 요건을 말한다", () => {
  const blocked = whyBlocked("zalkera.preview.start", SIGNED);
  assert.ok(blocked);
  assert.match(blocked.message, /사이트를 먼저 골라/);
  assert.equal(blocked.action?.command, "zalkera.site.choose");
});

test("소스가 없으면 어디서 받는지 가리킨다 — 「없습니다」로 끝내지 않는다", () => {
  const blocked = whyBlocked("zalkera.preview.start", PICKED);
  assert.ok(blocked);
  assert.match(blocked.message, /불러오기/);
  assert.equal(blocked.action?.command, "zalkera.site.open");
});

test("요건이 갖춰지면 막지 않는다", () => {
  for (const command of commandsWithNeeds()) {
    assert.equal(whyBlocked(command, READY), null, `${command} 가 갖춰졌는데 막혔다`);
  }
});

test("요건이 없는 명령은 언제나 눌린다", () => {
  // 로그인·도움말·진단·초기화는 막힌 사람이 쓰는 것이다. 그것까지 막으면 빠져나갈 길이 없다.
  for (const command of ["zalkera.signIn", "zalkera.help", "zalkera.doctor", "zalkera.reset", "zalkera.site.choose"]) {
    assert.equal(whyBlocked(command, NOTHING), null, `${command} 를 막았다 — 막힌 사람의 탈출구다`);
  }
});

test("막힌 문면에는 **반드시** 다음에 할 일이 붙는다", () => {
  for (const command of commandsWithNeeds()) {
    for (const state of [NOTHING, SIGNED, PICKED]) {
      const blocked = whyBlocked(command, state);
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
    for (const state of [NOTHING, SIGNED, PICKED]) {
      const blocked = whyBlocked(command, state);
      if (!blocked?.action) continue;
      assert.equal(
        whyBlocked(blocked.action.command, state),
        null,
        `${command} → ${blocked.action.command} 가 같은 상태에서 또 막힌다`,
      );
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
    assert.equal(whyBlocked("zalkera.preview.stop", state), null, "중지가 막혔다");
  }
});
