import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { captureTenant, decideReadyPrompt, decideSwitch, resolveHelpUrl, say } from "./tenantScope.ts";

/**
 * `extension.ts` 의 판정부를 core 로 내린 뒤 처음 붙는 시험(memo146 §18.2).
 *
 * 그 파일은 1,200줄이 넘는데 **시험이 0건**이었고, 2026-08-10 의 결함 넷이 전부 거기서 났다.
 * 여기 있는 것은 그중 **가장 비쌌던 축**을 잠근다 — 표기와 동작이 서로 다른 시점을 보던 자리.
 */

// ── 전환 대상이 올린 곳과 같은가 ────────────────────────────────────────────

test("같은 사이트면 전환한다", () => {
    deepStrictEqual(decideSwitch(captureTenant("bix"), "bix"), { ok: true });
});

test("기다리는 사이 사이트가 바뀌었으면 **아무것도 하지 않는다**", () => {
    // 원 결함: 빌드 대기(수 분·비모달) 중에 사이드바로 사이트를 바꿀 수 있다. 그때 「지금 전환」이
    // 그대로 살아 있으면 **다른 사이트를 켠다** — 리비전 번호는 테넌트별 순번이라 겹친다.
    const decision = decideSwitch(captureTenant("bix"), "credium");
    strictEqual(decision.ok, false);
    if (decision.ok) return;
    strictEqual(decision.reason, "TENANT_CHANGED");
    // 메시지가 **양쪽을 다 말해야** 사용자가 무슨 일이 났는지 안다.
    match(decision.message, /credium/);
    match(decision.message, /bix/);
});

test("팔레트에서 직접 부른 경로는 대조할 것이 없어 통과한다", () => {
    // 그 경로는 사용자가 목록에서 눈으로 보고 고른다 — 여기서 막으면 정상 업무가 죽는다.
    deepStrictEqual(decideSwitch(undefined, "bix"), { ok: true });
});

// ── 빌드가 끝난 뒤 무엇을 보여 주나 ─────────────────────────────────────────

test("같은 사이트면 원클릭 전환을 권한다", () => {
    const prompt = decideReadyPrompt(captureTenant("bix"), "bix", 5);
    strictEqual(prompt.kind, "offer");
    if (prompt.kind !== "offer") return;
    match(prompt.message, /버전 5/);
    match(prompt.message, /아직 바뀌지 않았습니다/);
});

test("사이트가 바뀌었으면 원클릭을 내리고 **어디로 가야 하는지** 말한다", () => {
    const prompt = decideReadyPrompt(captureTenant("bix"), "credium", 5);
    strictEqual(prompt.kind, "redirect", "원클릭이 남아 있으면 다른 사이트를 켠다");
    // "안 된다"만 말하면 막다른 길이다 — 돌아갈 곳을 말해야 한다.
    match(prompt.message, /「bix」 로 돌아가/);
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

test("올리기 확인창은 **사이트가 안 바뀐다**는 것도 말한다", () => {
    // 이름을 「발행」에서 「새 버전 올리기」로 고친 것과 같은 축이다 — 하지 않은 일을 말하면
    // 사람은 사이트가 바뀐 줄 알고 확인하지 않는다.
    const { detail } = say.publishConfirm(captureTenant("bix"));
    match(detail, /방문자가 보는 사이트는 그대로/);
});

test("전환 확인창은 **바로 바뀐다**고 말한다", () => {
    match(say.switchConfirm(captureTenant("bix"), 5).detail, /바로 바뀝니다/);
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

test("decideSwitch 가 서버 테넌트 코드를 소독한다", () => {
    const d = decideSwitch(captureTenant(EVIL), "live");
    ok(!d.ok);
    ok(!RENDERS_AS_LINK.test(d.message), `링크가 살아남았다: ${d.message}`);
});

test("decideSwitch 는 current 도 소독한다 — 둘 다 서버값이다", () => {
    const d = decideSwitch(captureTenant("mine"), EVIL);
    ok(!d.ok);
    ok(!RENDERS_AS_LINK.test(d.message), `링크가 살아남았다: ${d.message}`);
});

test("decideReadyPrompt 가 양쪽 갈래에서 소독한다", () => {
    // redirect 갈래(uploaded !== current)와 offer 갈래(같음)를 각각 밟는다 —
    // 한 갈래만 고치고 넘어가는 것이 이 결함의 원래 형상이었다.
    const redirect = decideReadyPrompt(captureTenant(EVIL), "other", 5);
    ok(!RENDERS_AS_LINK.test(redirect.message), `redirect 갈래에 링크: ${redirect.message}`);
    const offer = decideReadyPrompt(captureTenant(EVIL), EVIL, 5);
    ok(!RENDERS_AS_LINK.test(offer.message), `offer 갈래에 링크: ${offer.message}`);
});

test("say.* 도 같은 규율 — 대조군", () => {
    for (const message of [
        say.publishConfirm(captureTenant(EVIL)).message,
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
        say.cannotSwitch(tenant, evil),
        say.buildGone(tenant, evil),
    ]) {
        ok(!RENDERS_AS_LINK.test(line), `링크가 살아 있다: ${line}`);
    }
});

test("정상 숫자는 그대로 보인다 — 과소독 아님", () => {
    const tenant = captureTenant("acme");
    ok(say.switched(tenant, 42).includes("버전 42 "), say.switched(tenant, 42));
    ok(say.building(tenant, 0).includes("버전 0 "), say.building(tenant, 0));
});

test("숫자로 못 읽으면 물음표 — 남의 글자를 문장에 싣지 않는다", () => {
    const tenant = captureTenant("acme");
    const line = say.switched(tenant, "abc" as unknown as number);
    ok(line.includes("버전 ? "), line);
});
