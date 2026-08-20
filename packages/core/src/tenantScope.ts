import {ours, plainNotice, count} from "./notice.ts";
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
 *   문구를 만드는 함수가 전부 [CapturedTenant] 를 요구한다. **생 `string` 은 컴파일이 안 된다** —
 *   그래서 호출부는 캡처한 값을 넘길 수밖에 없다. 규율이 아니라 타입이 지킨다.
 *
 *   ⚠ 초판은 인자 타입이 그냥 `string` 이었다. 심의가 `say.publishConfirm(tenant)` 를
 *   `say.publishConfirm(tenantCode())` 로 한 줄 되돌려 보니 **시험 144건이 전부 초록**이었다 —
 *   *"타입이 지킨다"* 고 적어 놓고 타입이 요구한 것은 `string` 하나였고 `tenantCode()` 도 `string`
 *   이었다. 선언이 거짓이었던 것이다. 브랜드가 그 선언을 처음으로 참으로 만든다.
 *
 *   ⚠ 여기 어느 함수에도 "현재 테넌트를 읽는" 기능을 넣지 마라. 그 순간 존재 이유가 사라진다.
 */

/**
 * **캡처된** 테넌트 코드. 라이브로 읽은 값과 타입으로 구분된다.
 *
 * 만드는 곳은 [captureTenant] 하나뿐이고, 호출부는 **API 를 그 테넌트에 묶는 자리에서만** 부른다
 * (`ensureApiFor`). 그러면 표기와 동작이 같은 값을 보는 것이 컴파일 시점에 강제된다.
 */
export type CapturedTenant = string & { readonly __capturedTenant: unique symbol };

/**
 * 캡처 지점 표시. **API 를 이 테넌트에 묶는 그 순간에만** 부른다.
 *
 * ⚠ `tenantCode()` 같은 라이브 조회의 반환을 여기 통과시키면 브랜드가 거짓이 된다. 이 함수를
 * 호출하는 자리가 늘어나면 그것이 곧 이 방어가 느슨해지는 신호다 — 지금은 한 곳뿐이다.
 */
export function captureTenant(tenant: string): CapturedTenant {
    return tenant as CapturedTenant;
}

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
export function decideSwitch(expected: CapturedTenant | undefined, current: string): SwitchDecision {
    if (expected === undefined || expected === current) return { ok: true };
    return {
        ok: false,
        reason: "TENANT_CHANGED",
        message: `작업 사이트가 「${shown(current)}」 로 바뀌어 전환하지 않았습니다(그 버전은 「${shown(expected)}」 의 것입니다).`,
    };
}

/** 빌드가 끝난 뒤 무엇을 보여 줄지. */
export type ReadyPrompt =
    /** 같은 사이트다 — 원클릭 전환을 권한다. */
    | { kind: "offer"; message: string; action: string }
    /** 사이트가 바뀌었다 — 원클릭을 내리고 **어디로 가야 하는지** 말한다. */
    | { kind: "redirect"; message: string };

export function decideReadyPrompt(uploaded: CapturedTenant, current: string, revisionNo: number): ReadyPrompt {
    if (uploaded !== current) {
        return {
            kind: "redirect",
            message:
                `「${shown(uploaded)}」 버전 ${count(revisionNo)} 가 준비됐습니다. 지금 작업 사이트는 「${shown(current)}」 라서 ` +
                `여기서 바로 전환하지 않습니다 — 「${shown(uploaded)}」 로 돌아가 「버전 전환」에서 고르십시오.`,
        };
    }
    return {
        kind: "offer",
        message: `「${shown(uploaded)}」 버전 ${count(revisionNo)} 가 준비됐습니다. 사이트는 아직 바뀌지 않았습니다.`,
        action: "지금 전환",
    };
}

/**
 * 사용자에게 보이는 문구. **전부 `tenant` 를 요구한다** — 그것이 이 모듈의 요점이다.
 *
 * 확인창이 침묵하면 두 번 물어도 소용이 없다. 폴더와 사이트는 따로 정해지고 사이드바에서 사이트만
 * 바꿀 수 있어서, 말하지 않으면 A 의 소스가 B 의 라이브가 된다.
 */
/**
 * ⚠ **표시 직전에 소독한다.** 여기 박히는 사이트 이름은 **서버가 준 값**이고(`/api/me` 의
 * `tenants[].code`), 이 문장들은 **비-모달 알림**으로 나간다. VS Code 는 비-모달 알림의
 * `[글](command:…)`·`[글](file:…)` 를 **클릭 가능한 링크로 렌더**하므로, 적대적·탈취된 서버가
 * 우리 신뢰 알림에 자기 문구의 링크를 띄울 수 있다(심의 실증 — 링크 정규식이 실제로 물었다).
 *
 * 이 레포는 같은 서버의 `handshake.message`·API 오류를 이미 신뢰 못 할 값으로 보고 `plainNotice`
 * 로 막는다. **자기 위협 모델 기준으로 누락된 소독**이었지, 새 방어가 아니다.
 *
 * 소독은 **표시 자리에서만** 한다 — `x-tenant` 헤더는 `api.ts` 의 `tenantCode()` 가 따로 만들며
 * 그쪽은 원문이어야 한다. 여기서 defang 한 값이 와이어로 가지 않는다.
 */
const shown = (tenant: CapturedTenant | string): string => plainNotice(tenant, 64);

export const say = {
    /** 받기 — 어느 사이트의 어느 판을, 어디로. 「지금 폴더는 그대로」가 이 문장의 요점이다. */
    fetchTargetTitle(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${count(revisionNo)} 를 받을 새 빈 폴더를 고르세요 — 지금 폴더는 그대로 둡니다`;
    },
    fetchProgress(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${count(revisionNo)} 를 받는 중`;
    },
    /** 받기 완료. `hadOpenSite` 면 **지금 폴더가 안 바뀌었다**는 사실을 같이 말한다. */
    fetched(tenant: CapturedTenant, revisionNo: number, hadOpenSite: boolean): string {
        // 소독 검사기는 **표시 문장 안의 보간**을 하나씩 본다. 중간 변수로 묶으면 그 변수가
        // 「허용 목록 밖」이 된다 — 묶지 않고 자리마다 소독기를 그대로 둔다.
        return hadOpenSite
            ? `「${shown(tenant)}」 버전 ${count(revisionNo)} 를 새 폴더로 받았습니다. 지금 폴더는 바뀌지 않았습니다.`
            : `「${shown(tenant)}」 버전 ${count(revisionNo)} 를 받았습니다.`;
    },
    /** 같은 판을 이미 받아 둔 폴더가 있다. **사본을 막지는 않는다** — 망가진 사본을 다시 받을 길은 남긴다. */
    alreadyFetched(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${count(revisionNo)} 는 이미 받아 두셨습니다.`;
    },
    /** 켜진 판이 없어 최근 것을 고른 경우. 말없이 고르면 화면과 실제가 갈린다. */
    pickedLatestReady(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 에 켜진 판이 없어, 가장 최근에 만들어진 버전 ${count(revisionNo)} 를 받습니다.`;
    },
    publishConfirm(tenant: CapturedTenant): { message: string; detail: string; action: string } {
        return {
            message: `「${shown(tenant)}」 사이트에 지금 소스를 새 버전으로 올립니다.`,
            detail:
                "올리기만 합니다 — 방문자가 보는 사이트는 그대로입니다.\n" +
                "그 버전으로 바꾸려면 올린 뒤 따로 전환하십시오.",
            action: "올리기",
        };
    },
    switchConfirm(tenant: CapturedTenant, revisionNo: number): { message: string; detail: string; action: string } {
        return {
            message: `「${shown(tenant)}」 사이트를 버전 ${count(revisionNo)} 로 바꿉니다.`,
            detail: "방문자가 보는 화면이 바로 바뀝니다.",
            action: "바꾸기",
        };
    },
    switched(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 사이트를 버전 ${count(revisionNo)} 로 바꿨습니다.`;
    },
    building(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${count(revisionNo)} 를 서버가 빌드하는 중`;
    },
    buildFailed(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${count(revisionNo)} 를 서버가 만들지 못했습니다. 사이트는 그대로입니다.`;
    },
    buildTimedOut(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${count(revisionNo)} 가 아직 빌드 중입니다. 끝나면 「버전 전환」에서 고르실 수 있습니다.`;
    },
    /**
     * 기다리기를 그만뒀을 때. ⚠ **취소는 빌드를 멈추는 것이 아니다** — 서버는 계속 짓는다.
     * 그 사실을 말해 주지 않으면 사용자는 자기가 취소해서 안 된 줄 안다.
     *
     * 이 분기만 인라인 문자열로 남아 사이트 이름이 없었다(심의 경고) — 대기 중 사이트를 바꾼
     * 사용자가 "어느 사이트가 빌드 중이라는 거지"로 오독하는 자리였다.
     */
    buildWaitCancelled(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${count(revisionNo)} 는 서버에서 계속 빌드됩니다. 기다리기만 그만뒀습니다 — ` +
            `끝나면 「버전 전환」에 나옵니다.`;
    },
    /** 전환 대상이 목록에 없을 때(빌드 중·실패·이미 활성). */
    cannotSwitch(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${count(revisionNo)} 로 바꿀 수 없습니다.`;
    },
    buildGone(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 에서 버전 ${count(revisionNo)} 를 찾지 못했습니다.`;
    },
};

import { httpUrl } from "./serverUrl.ts";

/**
 * 서버가 준 매뉴얼 주소를 쓸지 정한다.
 *
 * ⚠ **서버가 보낸 값이라도 그대로 열지 않는다.** 설정 오타 하나가 `file:`·`vscode:` 를 여는 통로가
 * 되면 안 된다. 판정이 안 서면 조용히 기본값으로 간다 — 도움말을 못 여는 것이 더 나쁜 고장이다.
 */
export function resolveHelpUrl(fromServer: unknown, fallback: string): { url: string; note?: string } {
    if (typeof fromServer !== "string" || fromServer.trim() === "") return { url: fallback };
    const parsed = httpUrl(fromServer);
    if (!parsed) {
        return { url: fallback, note: "서버가 보낸 도움말 주소를 쓰지 않습니다 — 기본 주소로 엽니다." };
    }
    return { url: parsed.toString() };
}
