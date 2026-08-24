import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { captureTenant, resolveHelpUrl, say } from "./tenantScope.ts";

/**
 * `extension.ts` 의 판정부를 core 로 내린 뒤 처음 붙는 시험(memo146 §18.2).
 *
 * 그 파일은 1,200줄이 넘는데 **시험이 0건**이었고, 2026-08-10 의 결함 넷이 전부 거기서 났다.
 * 여기 있는 것은 그중 **가장 비쌌던 축**을 잠근다 — 표기와 동작이 서로 다른 시점을 보던 자리.
 */

// ── 올리기는 곧 배포다 ──────────────────────────────────────────────────────
//
// 백엔드는 업로드로 만든 판을 **자동으로 켠다**: STATIC 은 확정 즉시, NEXT_SOURCE 는 빌드 콜백에서.
// 확장은 오랫동안 없는 2단 게이트를 가정했고, 그 위에 발행 후 「지금 전환」 단추가 서 있었다.
// 그 단추는 **누르면 반드시 실패했다** — 방금 올린 판은 이미 활성이라 전환 후보에서 빠지기 때문이다.
//
// 여기 있는 시험은 그 거짓이 돌아오지 못하게 잠근다.

test("올리기 확인창은 **사이트가 바뀐다**고 말한다", () => {
    const ask = say.publishConfirm(captureTenant("bix"));
    match(ask.message, /「bix」/);
    match(ask.detail, /방문자가 보는 사이트가 이 소스로 바뀝니다/);
});

test("올리기 확인창은 **안 바뀐다고 말하지 않는다**", () => {
    // 종전 문면이 정확히 그 약속이었고 시험이 그것을 잠그고 있었다. 방향을 뒤집어 다시 건다 —
    // 이 문장이 어떤 형태로든 돌아오면 배포 게이트가 다시 거짓말을 하는 것이다.
    const ask = say.publishConfirm(captureTenant("bix"));
    for (const text of [ask.message, ask.detail]) {
        ok(!/사이트는 그대로/.test(text), `안 바뀐다는 약속이 돌아왔다: ${text}`);
        ok(!/올리기만 합니다/.test(text), `안 바뀐다는 약속이 돌아왔다: ${text}`);
    }
});

test("게시 완료 문면은 **바뀌었다**고 말하고 되돌리기를 권하지 않는다", () => {
    const line = say.published(captureTenant("bix"), 5);
    match(line, /「bix」/);
    match(line, /버전 5를 배포했습니다/);
    ok(!/아직 바뀌지 않았습니다/.test(line), `거짓 문장이 돌아왔다: ${line}`);
});

test("게시 완료 문면은 **반영 시간을 숫자로 말하지 않는다**", () => {
    // 서빙 반영은 오케스트레이터의 스냅샷 주기이고 확장이 소유하지 않는 값이다. 여기에 숫자를 박으면
    // 저쪽 설정이 바뀌는 날 조용히 거짓이 된다 — 모르는 것은 모른다고 말한다.
    const line = say.published(captureTenant("bix"), 5);
    ok(!/\d+\s*(초|분|시간)/.test(line), `소유하지 않은 숫자를 약속했다: ${line}`);
});

test("전환 문면은 **되돌리기**로 읽힌다 — 발행 경로가 아니다", () => {
    // 「버전 전환」에 남은 일은 롤백뿐이다. 그 자리가 다시 발행 경로처럼 읽히면 같은 혼동이 돌아온다.
    match(say.switchConfirm(captureTenant("bix"), 5).detail, /바로 바뀝니다/);
});

// ── 문구가 사이트를 말하는가 ────────────────────────────────────────────────

test("사용자에게 보이는 문구는 **전부 사이트 이름을 담는다**", () => {
    // 확인창이 침묵하면 두 번 물어도 소용이 없다. 폴더와 사이트는 따로 정해지므로
    // 말하지 않으면 A 의 소스가 B 의 라이브가 된다.
    // ⚠ **손으로 적은 배열이 아니라 `say` 전체를 훑는다**(재심의 경고). 초판은 리터럴 배열이라
    // **배열에 안 적은 새 표면은 검사 밖**이었다 — `buildWaitCancelled`·`cannotSwitch` 가 정확히
    // 그렇게 샜고, 고친 뒤에도 같은 문이 열려 있었다(심의가 사이트 이름 없는 표면을 하나 더 추가해
    // 초록임을 실측). 이제 함수를 추가하면 **자동으로 검사 대상**이다.
    const t = captureTenant("bix");
    const surfaces = Object.entries(say);
    ok(surfaces.length >= 9, `표면이 줄었다 — 지운 것인가 이름을 바꾼 것인가: ${surfaces.length}`);

    for (const [name, fn] of surfaces) {
        const produced = (fn as (tenant: typeof t, revisionNo: number) => unknown)(t, 5);
        // 문자열이거나 {message, detail} 이거나 — 어느 쪽이든 사람이 읽는 부분을 전부 모은다.
        const texts =
            typeof produced === "string"
                ? [produced]
                : Object.values(produced as Record<string, string>).filter((v) => typeof v === "string");
        ok(
            texts.some((text) => text.includes(`「${t}」`)),
            `\`say.${name}\` 에 사이트 이름이 없다: ${JSON.stringify(produced)}`,
        );
    }
});

// ── 서버가 준 주소 ──────────────────────────────────────────────────────────

const FALLBACK = "https://zalkera.github.io/zalkera-devtools/";

test("https 주소는 그대로 쓴다", () => {
    strictEqual(resolveHelpUrl("https://docs.zalkera.com/", FALLBACK).url, "https://docs.zalkera.com/");
});

test("서버가 안 주면 기본값 — 말없이", () => {
    for (const empty of [undefined, null, "", "   ", 42, {}]) {
        const resolved = resolveHelpUrl(empty, FALLBACK);
        strictEqual(resolved.url, FALLBACK, `입력=${JSON.stringify(empty)}`);
        strictEqual(resolved.note, undefined, "안 정한 것은 오류가 아니다 — 조용히 기본값으로");
    }
});

test("위험한 스킴은 **거절하고 말한다**", () => {
    // 설정 오타 하나가 `file:`·`vscode:` 를 여는 통로가 되면 안 된다.
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "vscode://x", "data:text/html,x"]) {
        const resolved = resolveHelpUrl(bad, FALLBACK);
        strictEqual(resolved.url, FALLBACK, `막아야 한다: ${bad}`);
        ok(resolved.note, `조용히 넘어가면 안 된다: ${bad}`);
    }
});

test("읽을 수 없는 값도 기본값으로 — 다만 말한다", () => {
    const resolved = resolveHelpUrl("그냥 문자열", FALLBACK);
    strictEqual(resolved.url, FALLBACK);
    ok(resolved.note);
});

/**
 * **알림 링크 소독 — 판정 함수도 문구 정본과 같은 규율을 받는다.**
 *
 * VS Code 비-모달 알림은 `[글](command:…)` 를 클릭 링크로 렌더하고 `allowCommands: true` 로 연다.
 * `say.*` 는 소독을 붙였는데 **같은 파일의 `decide*` 는 안 붙어**, 적대적·탈취된 서버가 준
 * 테넌트 코드가 그대로 알림에 실렸다(재심의 실증). 두 함수는 `extension.ts` 가 메시지를 **원문
 * 그대로** 비-모달 알림에 띄우는 자리다.
 *
 * 이 시험은 링크 **형태가 살아남지 않는지**만 본다 — VS Code 실렌더러를 띄우지 않고 판정하려면
 * 그 앵커(`](`)가 깨졌는지가 관측 가능한 조건이다.
 */
const RENDERS_AS_LINK = /\]\((?:https?:\/\/|command:|file:)[^)\s]+\)/i;
const EVIL = "gc](command:workbench.action.terminal.new)";

test("say.* 는 서버 테넌트 코드를 소독한다", () => {
    for (const message of [
        say.publishConfirm(captureTenant(EVIL)).message,
        say.published(captureTenant(EVIL), 3),
        say.switchConfirm(captureTenant(EVIL), 3).message,
        say.switched(captureTenant(EVIL), 3),
        say.buildFailed(captureTenant(EVIL), 3),
    ]) {
        ok(!RENDERS_AS_LINK.test(message), `링크가 살아남았다: ${message}`);
    }
});

test("양성 통제군 — 정상 사이트 이름은 원문 그대로 보인다", () => {
    // 소독이 과해 평범한 이름을 깨뜨리면 그것도 결함이다.
    for (const name of ["credium", "우리가게 본점", "Acme, Inc. (KR)"]) {
        ok(say.switched(captureTenant(name), 7).includes(name), `이름이 깨졌다: ${name}`);
    }
});

// ── 서버가 준 «숫자» ────────────────────────────────────────────────────────
// 타입이 `number` 라는 것은 런타임 보장이 아니다. `api.ts` 는 응답 필드의 타입을 검증하지 않으므로
// 적대적 서버가 그 자리에 문자열을 넣을 수 있고, `ours(...)` 는 값을 바꾸지 않아 아무것도 막지 못한다.

test("서버가 revisionNo 에 링크를 넣어도 문장에 살아남지 않는다", () => {
    const evil = "1 [열기](command:workbench.action.terminal.new)" as unknown as number;
    const tenant = captureTenant("acme");
    for (const line of [
        say.switched(tenant, evil),
        say.switchConfirm(tenant, evil).message,
        say.building(tenant, evil),
        say.buildFailed(tenant, evil),
        say.buildTimedOut(tenant, evil),
        say.buildWaitCancelled(tenant, evil),
        say.published(tenant, evil),
        say.buildGone(tenant, evil),
    ]) {
        ok(!RENDERS_AS_LINK.test(line), `링크가 살아 있다: ${line}`);
    }
});

test("정상 숫자는 그대로 보인다 — 과소독 아님", () => {
    const tenant = captureTenant("acme");
    ok(say.switched(tenant, 42).includes("버전 42로"), say.switched(tenant, 42));
    ok(say.building(tenant, 0).includes("버전 0을"), say.building(tenant, 0));
});

test("숫자 뒤 조사가 **읽는 소리**를 따른다", () => {
    // 「버전 1 가 준비됐습니다」가 실사용에서 나온 자리다. 조사는 숫자의 받침이 아니라
    // 그것을 읽는 소리로 정해진다 — 1=일·10=십 은 받침이 있고 2=이·5=오 는 없다.
    const tenant = captureTenant("acme");
    for (const [n, expected] of [[1, "버전 1로"], [2, "버전 2로"], [3, "버전 3으로"], [7, "버전 7로"], [10, "버전 10으로"]] as const) {
        ok(say.switched(tenant, n).includes(expected), `${n}: ${say.switched(tenant, n)}`);
    }
});

test("숫자로 못 읽으면 물음표 — 남의 글자를 문장에 싣지 않는다", () => {
    const tenant = captureTenant("acme");
    const line = say.switched(tenant, "abc" as unknown as number);
    // 조사는 붙는다 — 숫자가 아니면 받침 없는 쪽으로 접는다(문장이 끊기는 것보다 낫다).
    ok(line.includes("버전 ?로"), line);
    ok(!line.includes("abc"), line);
});

test("동의 문면은 서버 문장을 싣되 소독한다", () => {
  // 몇 건이 사라지는지는 서버만 안다 — 그래서 서버 문장을 그대로 싣는다. 나가는 자리가 모달
  // `detail` 이라 링크 형태는 여기서 무력화해야 한다.
  const ask = say.discardPendingConfirm(
    captureTenant("bix"),
    "게시 대기 중인 AI 변경 3건이 취소됩니다. [열기](command:workbench.action.terminal.new)",
  );
  match(ask.detail, /3건이 취소됩니다/);
  match(ask.detail, /되돌릴 수 없습니다/);
  ok(!/\]\(command:/.test(ask.detail), `링크가 살아 있다: ${ask.detail}`);
  ok(ask.action.length > 0);
});

test("동의 문면도 사이트 이름을 소독한다", () => {
  const ask = say.discardPendingConfirm(captureTenant(EVIL), "");
  ok(!/\]\(command:/.test(ask.message), ask.message);
});

test("서버 문장이 길어도 모달을 밀어내지 않는다", () => {
  const ask = say.discardPendingConfirm(captureTenant("bix"), "가".repeat(5000));
  ok(ask.detail.length < 400, `detail 이 ${ask.detail.length}자다`);
});

// ── 받은 곳이 「지금 폴더」일 때 ────────────────────────────────────────────

test("지금 폴더에 풀었으면 **바뀌었다**고 말한다", () => {
  // 종전에는 갈래가 둘뿐이라 「새 폴더로 받았습니다. 지금 폴더는 바뀌지 않았습니다」가 나갔다 —
  // 사람이 이 알림에서 가장 확인하고 싶은 사실을 정확히 반대로 말하던 자리다.
  const line = say.fetched(captureTenant("bix"), 5, "into-open");
  match(line, /지금 폴더에 풀었습니다/);
  ok(!/바뀌지 않았습니다/.test(line), line);
  ok(!/새 폴더/.test(line), line);
});

test("옆 폴더로 받았으면 **안 바뀌었다**고 말한다 — 그 문장은 여전히 참이다", () => {
  match(say.fetched(captureTenant("bix"), 5, "sibling"), /지금 폴더는 바뀌지 않았습니다/);
});

test("받을 자리를 묻는 문면이 자기모순이 아니다", () => {
  // `fetchTargetHere` 는 「지금 폴더는 그대로 둡니다」로 시작한다 — 대상이 그 폴더 자신인
  // 갈래에서 재사용하면 동의를 구하는 문장이 스스로를 부정한다.
  const intoOpen = say.fetchTargetIntoOpen(captureTenant("bix"), 5, "/w/empty");
  ok(!/그대로 둡니다/.test(intoOpen), intoOpen);
  match(intoOpen, /지금 열어 두신/);
});
