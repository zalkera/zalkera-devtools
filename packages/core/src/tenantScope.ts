import {ours, plainNotice, countJosa} from "./notice.ts";
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
    /**
     * 미리보기가 도는 사이 폴더가 다른 사이트로 재연결됐다. **다시 세우지 않고 멈춘다** —
     * 다시 세우면 이 폴더에 앞 사이트의 자격증명을 쓰게 된다.
     */
    renewalStoppedAfterRelink(binding: string): string {
        return `이 폴더가 「${shown(binding)}」 사이트로 바뀌어 미리보기를 멈췄습니다 — 다시 시작해 주세요.`;
    },
    /** 재연결 동의 — 무엇이 달라지는지 **결과로** 말한다. */
    relinkConfirm(binding: string, picked: string): string {
        return (
            `이 폴더는 「${shown(binding)}」 의 소스입니다. ` +
            `「${shown(picked)}」 로 다시 연결하면, 이 폴더의 소스가 그 사이트로 올라가게 됩니다.`
        );
    },
    /**
     * 이미 그 사이트로 작업 중이었다. **「바꿨습니다」로 말하지 않는다** — 아무것도 안 바뀌었다.
     */
    alreadyOnSite(tenant: string): string {
        return `이미 「${shown(tenant)}」 로 작업 중입니다.`;
    },
    /** 소속이 다른 폴더에서 사이트를 골랐을 때, 선택지 화면의 제목. */
    elsewhereTitle(picked: string, binding: string): string {
        // 「소스입니다」로 단정하지 않는다 — 소속은 있는데 소스가 아닌 폴더(package.json 을 지웠거나
        // 아직 안 받은 자리)도 이 화면에 온다. 표식이 말하는 것은 **연결**이지 소스 여부가 아니다.
        return `「${shown(picked)}」 작업은 다른 폴더에서 합니다 — 이 폴더는 「${shown(binding)}」 에 연결돼 있습니다`;
    },
    /**
     * 그 사이트에 받을 판이 없다. **왜 받기가 목록에 없는지**를 말하는 자리다 — 항목을 조용히
     * 빼면 사람은 그것이 고장인지 정상인지 모른다.
     */
    noSourceYet(picked: string): string {
        return `「${shown(picked)}」 에는 아직 올린 소스가 없습니다 — zip 으로 시작하실 수 있습니다.`;
    },
    /**
     * 올린 판은 있는데 **아직 받을 수 있는 것이 없다**(빌드 중이거나 실패). 「소스가 없다」로
     * 접으면 잠시 기다리면 될 사람을 zip 입고로 보낸다 — `noRevisionError` 가 가르는 그 두 갈래다.
     */
    noReadySourceYet(picked: string): string {
        return `「${shown(picked)}」 의 판이 아직 만들어지는 중이거나 실패했습니다 — 「버전 이력」에서 확인하실 수 있습니다.`;
    },
    /** 사람이 직접 고른 폴더가 남의 사이트 소스였다. **열지 않았다**는 사실이 요점이다. */
    pickedFolderBoundElsewhere(bound: string, picked: string): string {
        return `고르신 폴더는 「${shown(bound)}」 의 소스입니다 — 「${shown(picked)}」 폴더가 아니라서 열지 않았습니다.`;
    },
    /** 소속 없는 폴더에 소속을 **처음** 줄 때의 동의. 재연결과 달리 덮어쓰는 것이 없다. */
    pickedFolderLinkConfirm(picked: string): {
        message: string;
        detail: string;
        /** 소스로 안 보이는 폴더에 덧붙인다 — **막지는 않고 사실만 말한다.** */
        notSourceNote: string;
        action: string;
    } {
        return {
            message: `고르신 폴더를 「${shown(picked)}」 에 연결할까요?`,
            detail: "연결하면 이 폴더의 소스가 그 사이트로 올라가게 됩니다.",
            notSourceNote: "이 폴더에서 package.json 을 찾지 못했습니다 — 사이트 소스 폴더가 맞는지 확인해 주세요.",
            action: "연결하고 열기",
        };
    },
    /** 동의는 받았는데 소속을 못 적었다. **열지 않았다**는 사실이 요점이다. */
    pickedFolderNotLinked(picked: string): string {
        return `고르신 폴더를 「${shown(picked)}」 에 연결하지 못해 열지 않았습니다 — 출력 패널에서 이유를 확인해 주세요.`;
    },
    /** 이 폴더의 사이트로 돌아왔을 때. */
    backToFolderSite(tenant: string): string {
        return `사이트 「${shown(tenant)}」 — 이 폴더의 사이트로 돌아왔습니다.`;
    },
    /** 소속 없던 소스 폴더가 그 사이트를 입양했을 때. */
    folderAdopted(tenant: string): string {
        return `사이트 「${shown(tenant)}」 — 이 폴더를 이 사이트에 연결했습니다.`;
    },
    /** 받기 — 어느 사이트의 어느 판을, 어디로. 「지금 폴더는 그대로」가 이 문장의 요점이다. */
    fetchTargetTitle(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} 받을 새 빈 폴더를 고르세요 — 지금 폴더는 그대로 둡니다`;
    },
    /**
     * 옆에 만들 폴더를 **본문에** 적는다.
     *
     * ⚠ `detail` 은 **모달에서만 렌더된다**(`@types/vscode`). 비-모달 알림에 넣으면 화면에 안 뜨고,
     *   그러면 사람이 어디에 폴더가 생기는지 못 본 채 「옆에 새 폴더로 받기」를 누른다.
     */
    /**
     * 받을 자리가 **지금 열어 둔 그 폴더**일 때. [fetchTargetHere] 와 갈라 두는 이유는 그쪽 문장이
     * 「지금 폴더는 그대로 둡니다」라고 약속하기 때문이다 — 대상이 그 폴더 자신이면 자기모순이다.
     */
    fetchTargetIntoOpen(tenant: CapturedTenant, revisionNo: number, path: string): string {
        return `지금 열어 두신 ${ours(path)} 에 「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} 풉니다.`;
    },
    fetchTargetHere(tenant: CapturedTenant, revisionNo: number, path: string): string {
        // ⚠ **안심 문구가 경로 앞이다.** 비-모달 알림은 한 줄로 잘리는데, 경로는 길이가
        //    사람 폴더 깊이에 따라 정해진다(윈도우에서 65자가 흔하다). 경로 뒤에 두면
        //    「지금 폴더는 그대로」가 잘려 사라지고, 그것이 이 화면의 **요점**이다.
        return `지금 폴더는 그대로 둡니다. 「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} ${ours(path)} 로 받습니다.`;
    },
    /** 같은 판을 담은 폴더가 **어디인지**까지 말한다. */
    alreadyFetchedAt(tenant: CapturedTenant, revisionNo: number, path: string): string {
        return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "은/는")} 이미 ${ours(path)} 에 받아 두셨습니다.`;
    },
    fetchProgress(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} 받는 중`;
    },
    /**
     * 받기 완료. **어디에 받았는지가 문장을 가른다.**
     *
     * ⚠ 갈래가 셋인 이유: `sibling` 은 「지금 폴더는 안 바뀌었다」가 참이지만, `into-open` 에서는
     *   **받은 곳이 지금 폴더 자신**이라 그 문장이 거짓이 된다. 둘을 한 문장으로 접으면 사람이
     *   가장 확인하고 싶은 사실(내 폴더가 바뀌었나)을 정확히 반대로 말하게 된다.
     */
    fetched(
        tenant: CapturedTenant,
        revisionNo: number,
        into: "into-open" | "into-open-nested" | "sibling" | "only",
    ): string {
        // 소독 검사기는 **표시 문장 안의 보간**을 하나씩 본다. 중간 변수로 묶으면 그 변수가
        // 「허용 목록 밖」이 된다 — 묶지 않고 자리마다 소독기를 그대로 둔다.
        if (into === "into-open") {
            return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} 지금 폴더에 풀었습니다. 이 폴더가 그 사이트의 소스가 됐습니다.`;
        }
        // ⚠ **받은 꾸러미가 한 겹 감싸고 있으면 소스는 하위 폴더다.** 「이 폴더가 그 사이트의
        //    소스가 됐습니다」는 그때 거짓이고, 사람은 그 하위 폴더를 열어야 미리보기·올리기가
        //    된다 — 여기서 단추를 없애면 갈 길이 사라진다(`openSite` 가 그 갈래에 단추를 남긴다).
        if (into === "into-open-nested") {
            return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} 지금 폴더에 풀었습니다. 소스는 그 안의 하위 폴더에 있습니다.`;
        }
        if (into === "sibling") {
            return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} 새 폴더로 받았습니다. 지금 폴더는 바뀌지 않았습니다.`;
        }
        return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} 받았습니다.`;
    },
    /** 켜진 판이 없어 최근 것을 고른 경우. 말없이 고르면 화면과 실제가 갈린다. */
    pickedLatestReady(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 에 켜진 판이 없어, 가장 최근에 만들어진 버전 ${countJosa(revisionNo, "을/를")} 받습니다.`;
    },
    /**
     * 올리기 확인 — **이 문이 곧 배포다.**
     *
     * 백엔드는 업로드로 만든 판을 자동으로 켠다 — STATIC 은 확정 즉시, NEXT_SOURCE 는 빌드가
     * 끝나는 순간이다. 그러니 이 모달이 **마지막 확인 지점**이고, 여기서 "안 바뀐다"고 말하면
     * 사람은 읽지 않고 넘긴 뒤 미검수 소스를 손님에게 보낸다.
     */
    publishConfirm(tenant: CapturedTenant): { message: string; detail: string; action: string } {
        return {
            message: `「${shown(tenant)}」 사이트를 지금 이 폴더의 소스로 바꿉니다.`,
            detail:
                "올리면 방문자가 보는 사이트가 이 소스로 바뀝니다.\n" +
                "이전에 올리신 판은 「버전 전환」에 남습니다.",
            action: "올리고 게시",
        };
    },

    /**
     * 게시 완료 — **사실을 말한다.**
     *
     * ⚠ **반영 시간을 숫자로 적지 않는다.** 서빙 반영은 오케스트레이터의 스냅샷 주기에 달려 있고
     *   그 값은 확장이 소유하지 않는다. 여기 숫자를 박으면 저쪽 설정이 바뀌는 날 조용히 거짓이 된다
     *   — 모르는 것은 모른다고 말하는 편이 낫다.
     */
    published(tenant: CapturedTenant, revisionNo: number): string {
        return (
            `「${shown(tenant)}」 사이트에 버전 ${countJosa(revisionNo, "을/를")} 배포했습니다. ` +
            `방문자에게 반영되기까지 잠시 걸립니다.`
        );
    },
    switchConfirm(tenant: CapturedTenant, revisionNo: number): { message: string; detail: string; action: string } {
        return {
            message: `「${shown(tenant)}」 사이트를 버전 ${countJosa(revisionNo, "으로/로")} 바꿉니다.`,
            detail: "방문자가 보는 화면이 바로 바뀝니다.",
            action: "바꾸기",
        };
    },
    /**
     * 게시 대기 중인 AI 변경을 **버리고** 전환할지 묻는다.
     *
     * 서버는 이 거절에 「계속하려면 확인해 주세요」라고 적어 보낸다. 확인할 자리가 없으면 그 문장이
     * 곧 막다른 길이다 — 사용자는 시키는 대로 할 방법이 없는 채로 같은 거절을 반복해서 본다.
     *
     * 몇 건이 사라지는지는 **서버만 안다.** 그래서 서버 문장을 그대로 싣되, 나가는 자리가 모달
     * `detail` 이라 여기서 소독한다.
     */
    discardPendingConfirm(
        tenant: CapturedTenant,
        serverMessage: string,
    ): { message: string; detail: string; action: string } {
        return {
            message: `「${shown(tenant)}」 에 아직 게시하지 않은 AI 변경이 있습니다.`,
            detail:
                `${plainNotice(serverMessage, 200)}\n` +
                "계속하면 그 변경은 사라집니다. 되돌릴 수 없습니다.",
            action: "버리고 계속",
        };
    },
    /**
     * 발행 전 편집이 남아 막혔다 — **동의를 묻지 않는다.**
     *
     * 서버 가드 5층은 거절형이라 「버리고 계속」이 성립하지 않는다(위 [discardPendingConfirm] 과
     * 여기가 다른 이유다). 확장이 할 일은 **무엇이 걸려 있고 어디서 처분하는가**를 말하는 것이다 —
     * 그 두 가지를 안 주면 사용자는 같은 거절을 반복해서 보고, 그게 막다른 길이다.
     *
     * 처분하는 길이 둘이라 둘 다 말한다: 발행하면 그 편집이 새 버전이 되고, 되돌리면 사라진다.
     */
    draftBlocked(
        tenant: CapturedTenant,
        serverMessage: string,
    ): { message: string; detail: string } {
        return {
            message: `「${shown(tenant)}」 에 아직 발행하지 않은 편집이 있어 올릴 수 없습니다.`,
            detail:
                `${plainNotice(serverMessage, 200)}\n` +
                "그 편집을 먼저 처분해 주세요 — 새 버전으로 발행하거나, 지금 켜져 있는 버전으로 되돌리면 됩니다.\n" +
                "잘커라 콘솔의 「사이트 소스」 화면 또는 사이트에 연결한 AI 대화에서 할 수 있습니다.",
        };
    },
    switched(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 사이트를 버전 ${countJosa(revisionNo, "으로/로")} 바꿨습니다.`;
    },
    building(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} 서버가 빌드하는 중`;
    },
    buildFailed(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "을/를")} 서버가 만들지 못했습니다. 사이트는 그대로입니다.`;
    },
    buildTimedOut(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "이/가")} 아직 빌드 중입니다. 끝나면 게시됩니다 — ` +
            `그 사이 다른 판을 올리시면 그쪽이 켜집니다.`;
    },
    /**
     * 기다리기를 그만뒀을 때. ⚠ **취소는 빌드를 멈추는 것이 아니다** — 서버는 계속 짓는다.
     * 그 사실을 말해 주지 않으면 사용자는 자기가 취소해서 안 된 줄 안다.
     *
     * 이 분기만 인라인 문자열로 남아 사이트 이름이 없었다(심의 경고) — 대기 중 사이트를 바꾼
     * 사용자가 "어느 사이트가 빌드 중이라는 거지"로 오독하는 자리였다.
     */
    buildWaitCancelled(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "은/는")} 서버에서 계속 빌드됩니다. 기다리기만 그만뒀습니다 — ` +
            `끝나면 게시됩니다 — 그 사이 다른 판을 올리시면 그쪽이 켜집니다.`;
    },
    /**
     * 빌드는 끝났는데 그 판이 안 켜졌다 — 기다리는 사이 다른 판이 활성이 됐다.
     * **「배포했습니다」로 접지 않는다**: 사람이 방금 올린 소스가 지금 손님에게 나가는 것이 아니다.
     */
    supersededByOther(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "은/는")} 다 만들어졌지만 켜지지 않았습니다 — ` +
            `기다리는 사이 다른 판이 켜졌습니다. 「버전 전환」에서 고르실 수 있습니다.`;
    },
    buildGone(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 에서 버전 ${countJosa(revisionNo, "을/를")} 찾지 못했습니다.`;
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
