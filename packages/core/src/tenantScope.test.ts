import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { decideReadyPrompt, decideSwitch, resolveHelpUrl, say } from "./tenantScope.ts";

/**
 * `extension.ts` 의 판정부를 core 로 내린 뒤 처음 붙는 시험(memo146 §18.2).
 *
 * 그 파일은 1,200줄이 넘는데 **시험이 0건**이었고, 2026-08-10 의 결함 넷이 전부 거기서 났다.
 * 여기 있는 것은 그중 **가장 비쌌던 축**을 잠근다 — 표기와 동작이 서로 다른 시점을 보던 자리.
 */

// ── 전환 대상이 올린 곳과 같은가 ────────────────────────────────────────────

test("같은 사이트면 전환한다", () => {
    deepStrictEqual(decideSwitch("bix", "bix"), { ok: true });
});

test("기다리는 사이 사이트가 바뀌었으면 **아무것도 하지 않는다**", () => {
    // 원 결함: 빌드 대기(수 분·비모달) 중에 사이드바로 사이트를 바꿀 수 있다. 그때 「지금 전환」이
    // 그대로 살아 있으면 **다른 사이트를 켠다** — 리비전 번호는 테넌트별 순번이라 겹친다.
    const decision = decideSwitch("bix", "credium");
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
    const prompt = decideReadyPrompt("bix", "bix", 5);
    strictEqual(prompt.kind, "offer");
    if (prompt.kind !== "offer") return;
    match(prompt.message, /버전 5/);
    match(prompt.message, /아직 바뀌지 않았습니다/);
});

test("사이트가 바뀌었으면 원클릭을 내리고 **어디로 가야 하는지** 말한다", () => {
    const prompt = decideReadyPrompt("bix", "credium", 5);
    strictEqual(prompt.kind, "redirect", "원클릭이 남아 있으면 다른 사이트를 켠다");
    // "안 된다"만 말하면 막다른 길이다 — 돌아갈 곳을 말해야 한다.
    match(prompt.message, /「bix」 로 돌아가/);
});

// ── 문구가 사이트를 말하는가 ────────────────────────────────────────────────

test("사용자에게 보이는 문구는 **전부 사이트 이름을 담는다**", () => {
    // 확인창이 침묵하면 두 번 물어도 소용이 없다. 폴더와 사이트는 따로 정해지므로
    // 말하지 않으면 A 의 소스가 B 의 라이브가 된다.
    const t = "bix";
    const surfaces = [
        say.publishConfirm(t).message,
        say.switchConfirm(t, 5).message,
        say.switched(t, 5),
        say.building(t, 5),
        say.buildFailed(t, 5),
        say.buildTimedOut(t, 5),
        say.buildGone(t, 5),
    ];
    for (const text of surfaces) {
        ok(text.includes(`「${t}」`), `사이트 이름이 없다: ${text}`);
    }
});

test("올리기 확인창은 **사이트가 안 바뀐다**는 것도 말한다", () => {
    // 이름을 「발행」에서 「새 버전 올리기」로 고친 것과 같은 축이다 — 하지 않은 일을 말하면
    // 사람은 사이트가 바뀐 줄 알고 확인하지 않는다.
    const { detail } = say.publishConfirm("bix");
    match(detail, /방문자가 보는 사이트는 그대로/);
});

test("전환 확인창은 **바로 바뀐다**고 말한다", () => {
    match(say.switchConfirm("bix", 5).detail, /바로 바뀝니다/);
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
