/**
 * **"어느 사이트냐"를 판정하고 말하는 자리.** 순수 함수만 있고 `vscode` 를 모른다.
 *
 * ■ 왜 core 로 내렸나 (memo146 §18.2 근본 · 2026-08-10)
 *   `extension.ts` 는 1,200줄이 넘는데 **시험이 0건**이었고, 그날 난 결함 넷이 전부 거기서 났다.
 *   그중 가장 아팠던 것이 이 축이다 — 알림이 **라이브로** 테넌트를 다시 읽어, A 에 올린 버전을
 *   「B」라고 적고 「지금 전환」이 실제로 B 를 전환했다. *사이트 이름을 적어 안심시키려던 수정이
 *   틀린 이름으로 오인을 보증하는 자리가 됐다.*
 *
 * ■ 이 파일의 설계가 그 결함을 **구조적으로** 막는다
 *   문구를 만드는 함수가 전부 `tenant` 를 **인자로 요구한다.** 라이브로 읽을 방법이 없으므로,
 *   호출부는 캡처한 값을 넘길 수밖에 없다. 규율이 아니라 타입이 지킨다.
 *
 *   ⚠ 그러니 여기 어느 함수에도 "현재 테넌트를 읽는" 기능을 넣지 마라. 그 순간 이 파일의
 *   존재 이유가 사라진다.
 */

/** 「지금 전환」을 눌렀을 때, 그 버전을 올린 사이트와 지금 작업 사이트가 같은가. */
export type SwitchDecision =
    | { ok: true }
    /** 기다리는 사이 사이트가 바뀌었다. **아무것도 하지 않는다** — 조용히 남의 사이트를 켜는 것보다 낫다. */
    | { ok: false; reason: "TENANT_CHANGED"; message: string };

/**
 * 전환 대상이 올린 곳과 같은지 본다.
 *
 * `expected` 가 없으면(팔레트에서 직접 「버전 전환」을 부른 경우) 대조할 것이 없으므로 통과다 —
 * 그 경로는 사용자가 목록에서 눈으로 보고 고른다.
 */
export function decideSwitch(expected: string | undefined, current: string): SwitchDecision {
    if (expected === undefined || expected === current) return { ok: true };
    return {
        ok: false,
        reason: "TENANT_CHANGED",
        message: `작업 사이트가 「${current}」 로 바뀌어 전환하지 않았습니다(그 버전은 「${expected}」 의 것입니다).`,
    };
}

/** 빌드가 끝난 뒤 무엇을 보여 줄지. */
export type ReadyPrompt =
    /** 같은 사이트다 — 원클릭 전환을 권한다. */
    | { kind: "offer"; message: string; action: string }
    /** 사이트가 바뀌었다 — 원클릭을 내리고 **어디로 가야 하는지** 말한다. */
    | { kind: "redirect"; message: string };

export function decideReadyPrompt(uploaded: string, current: string, revisionNo: number): ReadyPrompt {
    if (uploaded !== current) {
        return {
            kind: "redirect",
            message:
                `「${uploaded}」 버전 ${revisionNo} 가 준비됐습니다. 지금 작업 사이트는 「${current}」 라서 ` +
                `여기서 바로 전환하지 않습니다 — 「${uploaded}」 로 돌아가 「버전 전환」에서 고르십시오.`,
        };
    }
    return {
        kind: "offer",
        message: `「${uploaded}」 버전 ${revisionNo} 가 준비됐습니다. 사이트는 아직 바뀌지 않았습니다.`,
        action: "지금 전환",
    };
}

/**
 * 사용자에게 보이는 문구. **전부 `tenant` 를 요구한다** — 그것이 이 모듈의 요점이다.
 *
 * 확인창이 침묵하면 두 번 물어도 소용이 없다. 폴더와 사이트는 따로 정해지고 사이드바에서 사이트만
 * 바꿀 수 있어서, 말하지 않으면 A 의 소스가 B 의 라이브가 된다.
 */
export const say = {
    publishConfirm(tenant: string): { message: string; detail: string; action: string } {
        return {
            message: `「${tenant}」 사이트에 지금 소스를 새 버전으로 올립니다.`,
            detail:
                "올리기만 합니다 — 방문자가 보는 사이트는 그대로입니다.\n" +
                "그 버전으로 바꾸려면 올린 뒤 따로 전환하십시오.",
            action: "올리기",
        };
    },
    switchConfirm(tenant: string, revisionNo: number): { message: string; detail: string; action: string } {
        return {
            message: `「${tenant}」 사이트를 버전 ${revisionNo} 로 바꿉니다.`,
            detail: "방문자가 보는 화면이 바로 바뀝니다.",
            action: "바꾸기",
        };
    },
    switched(tenant: string, revisionNo: number): string {
        return `「${tenant}」 사이트를 버전 ${revisionNo} 로 바꿨습니다.`;
    },
    building(tenant: string, revisionNo: number): string {
        return `「${tenant}」 버전 ${revisionNo} 를 서버가 빌드하는 중`;
    },
    buildFailed(tenant: string, revisionNo: number): string {
        return `「${tenant}」 버전 ${revisionNo} 를 서버가 만들지 못했습니다. 사이트는 그대로입니다.`;
    },
    buildTimedOut(tenant: string, revisionNo: number): string {
        return `「${tenant}」 버전 ${revisionNo} 가 아직 빌드 중입니다. 끝나면 「버전 전환」에서 고르실 수 있습니다.`;
    },
    buildGone(tenant: string, revisionNo: number): string {
        return `「${tenant}」 에서 버전 ${revisionNo} 를 찾지 못했습니다.`;
    },
};

/**
 * 서버가 준 매뉴얼 주소를 쓸지 정한다.
 *
 * ⚠ **서버가 보낸 값이라도 그대로 열지 않는다.** 설정 오타 하나가 `file:`·`vscode:` 를 여는 통로가
 * 되면 안 된다. 판정이 안 서면 조용히 기본값으로 간다 — 도움말을 못 여는 것이 더 나쁜 고장이다.
 */
export function resolveHelpUrl(fromServer: unknown, fallback: string): { url: string; note?: string } {
    if (typeof fromServer !== "string" || fromServer.trim() === "") return { url: fallback };
    let parsed: URL;
    try {
        parsed = new URL(fromServer);
    } catch {
        return { url: fallback, note: "서버가 보낸 도움말 주소를 읽지 못했습니다 — 기본 주소로 엽니다." };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return {
            url: fallback,
            note: `서버가 보낸 도움말 주소를 쓰지 않습니다(${parsed.protocol}) — 기본 주소로 엽니다.`,
        };
    }
    return { url: parsed.toString() };
}
