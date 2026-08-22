/**
 * 상태바에 **지금 어느 사이트로 일하는지**를 띄운다.
 *
 * 여러 거래처를 번갈아 다루면 「이 창이 어느 사이트였더라」가 매번 든다. 사이드바를 열어야
 * 알 수 있으면 그건 화면에 없는 것과 같다.
 *
 * ⚠ **판정이 여기 사는 이유.** 확장 안 조건문은 시험이 못 문다. 특히 어긋남 표시는 게이트·
 *   사이드바와 **같은 술어**여야 한다 — 셋이 갈리면 화면마다 다른 말을 한다.
 */
export interface StatusInput {
    /** 고른 사이트. 안 골랐으면 빈 문자열. */
    tenant: string;
    /** 열린 폴더가 속한 사이트. 모르면 `null`. */
    folderTenant: string | null;
    /** 이 창에 사이트 소스가 있는가. */
    site: string | null;
}

export interface StatusPlan {
    /** 상태바 문자열. 아이콘 포함. */
    text: string;
    /** 경고 배경을 쓸 것인가. 어긋났을 때만 참이다 — 늘 켜면 배경이 된다. */
    warning: boolean;
    tooltip: string;
}

/** 미리보기가 안 도는 창의 상태바. 미리보기 중에는 그쪽이 자리를 쓴다. */
export function idleStatusPlan(input: StatusInput): StatusPlan {
    const mismatched =
        input.folderTenant !== null &&
        input.tenant !== "" &&
        input.site !== null &&
        input.folderTenant !== input.tenant;

    if (mismatched) {
        return {
            text: `$(warning) ${input.folderTenant} 폴더 · ${input.tenant} 선택`,
            warning: true,
            tooltip: "이 폴더의 사이트와 고르신 사이트가 다릅니다 — 눌러서 되돌릴 수 있습니다.",
        };
    }
    if (input.tenant === "") {
        return {text: "$(zap) 잘커라", warning: false, tooltip: "작업할 사이트를 고르세요"};
    }
    return {text: `$(zap) ${input.tenant}`, warning: false, tooltip: `작업 사이트: ${input.tenant}`};
}
