import type {ActivateResult} from "./api.ts";
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

/** 발행이 낳는 결과 두 줄. **갈래 둘이 나눠 쓴다** — 사본으로 두면 한쪽만 고쳐진다. */
const PUBLISH_OUTCOME =
    "올리면 방문자가 보는 사이트가 이 소스로 바뀝니다.\n" +
    "이전에 올리신 판은 「버전 전환」에 남습니다.";

/** 「지금으로 되돌리기」로 갈린 거절. 판은 안 옮기고 작업만 버린다. */
const DISCARD_TO_CURRENT = "DRAFT_DISCARD_CONFIRM_REQUIRED";

/**
 * 「바꿨습니다」 한 문장.
 *
 * ⚠ **이 문장을 내는 표면은 [say.switchOutcome] 하나다.** 종전에는 `say.switched` 가 같은 문장을
 *   따로 냈는데, 전환이 `switchOutcome` 으로 옮겨 간 뒤 **상용 호출처가 0** 이 됐다 — 그대로 두면
 *   새 호출처가 그 표면을 집어 **「무동작을 바꿨다」가 배선 검사 밖에서 되살아난다**(설계자 심의).
 *   `this` 를 못 쓰는 자리가 있어(문면 전수 시험이 떼어서 부른다) 함수로 남긴다.
 */
function switchedLine(tenant: CapturedTenant, revisionNo: number): string {
    return `「${shown(tenant)}」 사이트를 버전 ${countJosa(revisionNo, "으로/로")} 바꿨습니다.`;
}

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
    /**
     * **고른 사이트로 시작하는** zip 을 풀 자리. 옆에 만들 폴더를 본문에 적는다.
     *
     * ⚠ **맨몸 「zip 으로 시작」에는 이 문장을 쓰지 마라.** 그 문은 로그인만 요구하고 그 zip 이
     *   어느 사이트 것인지 알 방법이 없어, 사이트 이름을 적으면 **그 zip 이 그 사이트 것이라고
     *   우리가 말해 주는 셈**이 된다. 이 문장이 서는 자리는 사람이 **방금 사이트를 고른** 흐름
     *   하나뿐이고, 거기서는 이름이 사람의 선택을 되읽는 것이다.
     */
    importTargetSibling(tenant: CapturedTenant, path: string): string {
        // 안심 문구가 경로 앞이다 — `fetchTargetHere` 와 같은 이유(비-모달은 한 줄로 잘린다).
        return `지금 폴더는 그대로 둡니다. 「${shown(tenant)}」 로 쓰실 소스를 ${ours(path)} 에 풉니다.`;
    },
    /** zip 을 푼 폴더를 **그 사이트에 붙였다**는 사실. 다음에 할 일은 여는 것뿐이다. */
    importedFor(tenant: CapturedTenant): string {
        return `「${shown(tenant)}」 사이트 소스를 풀고 그 사이트에 연결해 두었습니다 — 폴더를 열면 바로 이어집니다.`;
    },
    /**
     * zip 의 **출처 표시**가 고른 사이트와 다르다. **막지 않는다** — 표시는 서명 없는 선언이고,
     * 대행사가 다른 이름으로 내보낸 팩을 쓰는 것이 정상 흐름이다(`judgeUpdate` 와 같은 규율).
     */
    importProvenanceMismatch(tenant: CapturedTenant, zipTenant: string): string {
        return `이 zip 은 「${shown(zipTenant)}」 에서 내보낸 것으로 표시되어 있습니다 — 「${shown(tenant)}」 로 쓰시려는 것이 맞는지 확인해 주세요.`;
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
    /**
     * ⚠ **모양이 갈린다 — 문장만 더하지 않는다.** 소속 있는 폴더의 일상 발행과 소속 없는 폴더의
     *   위험 발행이 같은 모양이면, 매일 누르던 반사가 위험한 날에도 그대로 눌린다. 그래서
     *   `binding === null` 갈래는 **버튼까지** 다르다 — 클릭 자체가 고지된 진술이 되게 한다
     *   (`provenanceNotice` 가 세운 형태). 이 갈래는 **폴더당 한 번뿐**이다: 발행이 성공하면
     *   표식이 소속을 결정화하므로 다음부터는 일상 갈래로 돌아온다.
     *
     * ⚠ **`detail` 첫 줄에 경로를 싣는다.** 이 모달은 며칠 전에 연 폴더에서 눌릴 수 있고, 뜨는
     *   순간 사이드바는 안 보인다 — 마지막 확인 지점은 **자족**해야 한다. `message` 의 「이 폴더」가
     *   가리키는 것이 바로 아래 선다. 형제 「zip 으로 교체」 확인이 이미 같은 형태다.
     *   **축약하지 않는다** — 모달 본문은 잘리지 않고 줄바꿈되며, 여기서는 전체가 요점이다.
     *
     * ⚠ **경로도 소독을 지난다.** 폴더 이름은 **남이 정할 수 있다**(대행사가 보낸 zip 을 푼 폴더·
     *   git clone 한 레포). 개행이 든 이름 하나면 뒤의 경고 줄을 **복제해 액자에 가두고**
     *   「이전 화면의 잔여 표시입니다」로 무력화할 수 있다(보안 심의가 실측 재현). `ours` 는
     *   항등 함수라 그것을 못 막는다 — 형제 모달 둘(`discardPendingConfirm`·`draftBlocked`)이
     *   이미 **모달 `detail` 이라는 이유로** `plainNotice` 를 지나는데 이 자리만 빠져 있었다.
     *   상한은 `MAX_CAP` 이라 정상 경로는 글자 그대로 남는다(축약과 충돌하지 않는다).
     */
    /**
     * @param baseDeclared 이 올리기가 **기반 판을 선언하는가**. 거짓이면 detail 에 한 줄을 더한다 —
     *   이 기능이 나가는 순간 사람은 보호를 전제하는데 **무표식 폴더는 조용히 무보호**이기 때문이다.
     *   그 침묵이 곧 이 트랜치가 사냥한 병(모르는 것을 안다고 믿게 두기)이다.
     *
     *   ⚠ **새 모달로 만들지 않는다.** 올리기 전에 확인창이 둘이면 사람은 둘 다 안 읽는다. 그리고
     *     이 고지는 미래 예측이 아니라 **지금 확실한 사실**이라 선확인의 TOCTOU 가 없다.
     *     발행 성공이 표식을 쓰므로 폴더당 사실상 최초 1회다.
     */
    publishConfirm(
        tenant: CapturedTenant,
        dir: string,
        binding: string | null,
        baseDeclared = true,
    ): { message: string; detail: string; action: string } {
        const noBase = baseDeclared
            ? ""
            : "\n\n이 폴더는 어느 버전에서 갈라졌는지 기록이 없어, " +
              "그 사이 다른 사람이 올렸는지 확인하지 못한 채 올라갑니다.";
        // ⚠ **중간 변수를 템플릿에 보간하지 않는다.** 소독 검사는 문면이 아니라 **구문**으로 보므로
        //    `${where}` 같은 이름은 통과시킬 근거가 없다 — 이어붙이기로 두면 **소독 대상이
        //    소독을 지난 조각(`plainNotice(dir, …)`)만 템플릿에 남는다. 공용 두 줄은 상수 하나로 둔다(사본이 갈리지 않게).
        if (binding === null) {
            return {
                message: `이 폴더는 아직 어느 사이트에도 연결되어 있지 않습니다 — 「${shown(tenant)}」 사이트로 올립니다.`,
                detail: `${plainNotice(dir, 512)}\n\n` + PUBLISH_OUTCOME + "\n올리면 이 폴더가 그 사이트에 연결됩니다." + noBase,
                action: "이 사이트로 올리고 연결",
            };
        }
        return {
            message: `「${shown(tenant)}」 사이트를 지금 이 폴더의 소스로 바꿉니다.`,
            detail: `${plainNotice(dir, 512)}\n\n` + PUBLISH_OUTCOME + noBase,
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
    /**
     * **그 사이 누가 올렸다** — 선언한 기반 판이 원장 꼬리가 아니어서 서버가 막았다.
     *
     * ⚠ **서버 문장을 그대로 싣는다.** 최신 판 번호가 그 문장에 있고, 서버는 「꼬리가 앞섰다」와
     *   「선언 번호를 원장에서 못 찾겠다」를 이미 갈라 보낸다. 확장이 다시 쓰려면 번호를 다시
     *   조회해야 하는데 그때는 꼬리가 또 움직였을 수 있어 **서버가 말한 사유와 화면이 그린 사유가
     *   갈린다.** 기계 분기는 코드(`UPLOAD_BASE_MOVED`) 하나로만 한다.
     *
     * ⚠ **「받아서 합치세요」라고 지시하지 않는다.** 백엔드가 같은 이유로 그 지시를 뺐다 — 오너가
     *   방금 되돌린 판이 꼬리일 수 있고, 그때 그 지시는 **오너 결정의 반대로** 사람을 이끈다.
     *
     * 단추는 「그대로 올리기」다. **무엇이 걸려 있는지**를 detail 이 명명한다 — 그 문장이 없으면
     * 이것은 그냥 「예/아니오」가 되고, 방어는 한 번 클릭으로 끄는 경고가 된다.
     *
     * ⚠ **「그 변경이 안 담긴다」고 단정하지 않는다.** 우리가 아는 것은 **계보**뿐이고 내용은 모른다 —
     *   사람이 이미 손으로 합쳐 넣었으면 담겨 있고(설계가 스스로 권하는 길이다), 그때 단정은 거짓이다.
     *   「위 버전」이라는 지시도 서버가 번호 둘을 말하는 갈래에서 흔들린다. 이 트랜치가 내내 사냥한
     *   병이 「모르는 것을 안다고 말하기」인데, 그 자국을 방어 문면에 남길 수는 없다.
     */
    baseMovedConfirm(
        tenant: CapturedTenant,
        serverMessage: string,
    ): { message: string; detail: string; action: string } {
        return {
            message: plainNotice(serverMessage),
            detail:
                `그대로 올리면 「${shown(tenant)}」 사이트에 지금 이 폴더의 소스가 새 버전으로 올라갑니다. ` +
                `이 폴더는 그 버전을 딛고 있지 않아, 그쪽 수정이 담겼는지는 **확인되지 않습니다** — ` +
                `이미 손으로 합쳐 두셨다면 담겨 있고, 아니면 빠집니다.\n\n` +
                `원장에서 사라지는 것은 없습니다. 확인하고 싶으면 여기서 그만두고, 그 버전을 다른 폴더에 ` +
                `받아 지금 폴더와 맞춰 본 뒤 다시 올려 주세요.`,
            action: "그대로 올리기",
        };
    },
    /**
     * **그만뒀다** — 사람이 「올리는 중」에 취소를 눌렀고, 판이 만들어지기 **전**이었다.
     *
     * ⚠ **「아무것도 남지 않았습니다」라고 말하지 마라.** 전송이 마지막 바이트까지 나간 뒤 응답만
     *   못 읽고 끊기는 경합이 있어, 그때는 S3 에 객체가 생긴다. 우리가 그 창에서 **확실히 아는
     *   사실은 하나**뿐이다 — `confirm` 을 안 보냈으니 **판은 안 만들어졌다.** 바이트·흔적이 아니라
     *   **판**에 대해서만 말한다.
     *
     * 남은 객체는 사람에게 말하지 않는다 — 보거나 지울 표면이 없어 **할 수 있는 일이 없고**,
     * 사라지는 것이 아니라 우리 비용으로 남는 것이다(같은 고아를 만드는 기존 경로도 침묵이다).
     */
    publishCancelled(tenant: CapturedTenant): string {
        return `「${shown(tenant)}」 올리기를 그만뒀습니다 — 새 버전은 만들어지지 않았습니다.`;
    },
    /**
     * **취소가 늦었다** — 눌렀을 때 서버 확인이 이미 나갔고, 그것이 성공했다.
     *
     * ⚠ **「취소했습니다」로 접지 마라.** 판은 만들어졌다. 그 문장은 거짓이고, 사람은 안 올라간 줄
     *   알고 다시 올린다. 취소가 실제로 하는 일은 **기다리기를 그만두는 것**뿐이라, 빌드 대기 취소와
     *   같은 의미론으로 강하시켜 말한다.
     */
    publishCancelledLate(tenant: CapturedTenant, revisionNo: number, alreadyLive: boolean): string {
        // ⚠ **`STATIC` 은 확정 즉시 게시다**(`status: "READY"`) — 기다릴 것이 아예 없다. 그 판에
        //    「준비되면 게시됩니다」라고 하면 **이미 손님에게 나간 것을 아직 안 나갔다고** 말하는
        //    거짓이고, 사람은 안 바뀐 줄 알고 한 번 더 올린다. 미래형은 빌드가 남은 판에만 쓴다.
        //
        //    앞머리를 변수로 뽑지 않는다 — 소독 검사기는 **보간되는 이름**을 보므로, 한 번 감싸면
        //    `shown`·`countJosa` 가 검사 밖으로 사라진다(실측: 그 판이 2건으로 반려됐다).
        return alreadyLive
            ? `취소보다 먼저 「${shown(tenant)}」 버전 ${countJosa(revisionNo, "이/가")} 만들어졌습니다. ` +
                  `이미 게시됐습니다 — 기다리기만 그만뒀습니다.`
            : `취소보다 먼저 「${shown(tenant)}」 버전 ${countJosa(revisionNo, "이/가")} 만들어졌습니다. ` +
                  `기다리기만 그만뒀습니다 — 준비되면 게시됩니다.`;
    },
    /**
     * **방문자에게 닿았다** — [published] 가 「잠시 걸립니다」로 열어 둔 문장을 닫는다.
     *
     * ⚠ 이 문장은 **서빙박스가 그 판을 띄웠다고 보고했을 때만** 나온다(`reflectionOf` 가 `reflected`).
     *   활성 포인터가 옮겨진 것으로 내면 종전의 그 거짓말 — 「배포됐습니다」인데 사이트는 안 바뀐 상태 —
     *   이 그대로 돌아온다. 관측이 없는 사이트에서는 **아무 말도 안 한다**(없는 소식을 지어내지 않는다).
     */
    reflected(tenant: CapturedTenant, revisionNo: number): string {
        return `「${shown(tenant)}」 사이트에 버전 ${countJosa(revisionNo, "이/가")} 방문자에게 반영됐습니다.`;
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
    /**
     * ⚠ **동의는 하나인데 결과가 둘이다 — 그래서 문면이 갈린다.** 인자(`discardPendingChanges=true`)
     *   하나로 뚫리는 코드가 둘이고, 하나는 **판이 옮겨지고** 하나는 **판이 그대로**다.
     *   사람은 방금 「버전 N 으로 바꿉니다」 모달에 동의했다 — 그 프레임을 여기서 안 바로잡으면
     *   **다른 행위에 대한 동의**를 받는 셈이다.
     *
     * ⚠ **건수를 되풀이하지 않는다.** 서버 문장이 이미 「편집 중인 파일 N개 · 게시 대기 AI 변경
     *   M건(쓴 크레딧은 돌아오지 않습니다)」로 **세어서** 온다. 확장이 그 위에 사본을 얹으면
     *   서버가 문구를 바꾸는 날 사본이 거짓이 된다.
     */
    discardPendingConfirm(
        tenant: CapturedTenant,
        serverMessage: string,
        serverCode: string | null,
    ): { message: string; detail: string; action: string } {
        if (serverCode === DISCARD_TO_CURRENT) {
            return {
                message: `「${shown(tenant)}」 — 고르신 버전이 이미 켜져 있습니다.`,
                detail:
                    `${plainNotice(serverMessage, 200)}\n` +
                    "판은 그대로 두고 위 작업만 사라집니다. 되돌릴 수 없습니다.",
                // 「버리고 계속」이 아니다 — **계속할 전환이 없다.**
                action: "버리기",
            };
        }
        return {
            message: `「${shown(tenant)}」 에 아직 게시하지 않은 AI 변경이 있습니다.`,
            detail:
                `${plainNotice(serverMessage, 200)}\n` +
                "계속하면 그 변경은 사라집니다. 되돌릴 수 없습니다.",
            action: "버리고 계속",
        };
    },
    /**
     * 전환이 **무엇을 했는지**. 종전에는 한 문장이라, 판이 안 움직인 경우에도 「바꿨습니다」라고
     * 말했다 — 무동작을 한 것처럼 말하는 자리다(`unchanged`/`switched` 를 가른 그 규율).
     *
     * ⚠ **`pointerMoved` 가 명시로 `false` 일 때만** 갈린다. 결여는 `true` 방향이다 — 서버
     *   기본값이 그렇고 구서버는 이 필드를 안 보낸다.
     */
    switchOutcome(
        tenant: CapturedTenant,
        revisionNo: number,
        // 사본으로 두면 한쪽만 고쳐진다 — `switchedLine` 을 뺀 것과 같은 이유다.
        result?: ActivateResult,
    ): string {
        // ⚠ **응답을 총체적으로 받는다.** 서버 값이라 형을 믿지 않고, 이 함수는 문면 전수 시험이
        //    인자 없이도 부른다 — 한 칸에 터지면 그 시험이 통째로 죽는다(같은 형상으로 이미 한 번
        //    검사기가 죽었다). 결여는 **`true` 방향**이라 구서버에서는 종전과 같이 말한다.
        // ⚠ **`this` 를 쓰지 않는다.** 문면 전수 시험은 `Object.entries(say)` 로 **떼어서** 부르므로
        //    그 자리에서 `this` 가 없다 — 실제로 그렇게 터졌다. 문장은 모듈 함수가 갖는다.
        if (result?.pointerMoved !== false) return switchedLine(tenant, revisionNo);
        const discarded =
            result.discardedDraft === true ||
            (typeof result.discardedPendingChanges === "number" && result.discardedPendingChanges > 0);
        return discarded
            ? `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "은/는")} 이미 켜져 있었습니다 — 저장하지 않았던 작업을 버렸습니다.`
            : `「${shown(tenant)}」 버전 ${countJosa(revisionNo, "은/는")} 이미 켜져 있습니다 — 바꾼 것이 없습니다.`;
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
                // ⚠ **「켜진 버전」이 없는 칸이 있다.** 첫 업로드가 빌드 실패한 테넌트는 활성 포인터가 없고,
            //    되돌리기가 지목하는 것은 그때 **드래프트의 기준 판**이다 — 그 자리에서 「켜진 버전으로」는
            //    거짓이 된다. 콘솔 배너가 쓰는 두 동사를 그대로 부른다.
            "그 편집을 먼저 처분해 주세요 — 새 버전으로 발행하거나, 편집을 되돌리면 됩니다.\n" +
                "잘커라 콘솔의 「사이트 소스」 화면 또는 사이트에 연결한 AI 대화에서 할 수 있습니다.",
        };
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
