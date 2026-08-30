/**
 * **발행·되돌리기·버리기**(memo184 §2.4·§2.5 · T3).
 *
 * ⚠ **이름이 겹치는 자리 둘.** ⑴ 형제 `publish.ts`(폴더를 zip 으로 묶어 올리는 길)와 이 파일.
 *   ⑵ 이 파일의 `publishDraft`(함수)와 `ZalkeraApi.publishDraft`(메서드) — 전자가 후자를 부른다.
 *
 * ⚠ **형제 `publish.ts` 와 다른 파일이다.** 그쪽은 폴더를 **zip 으로 묶어 올리는** 길(확장의 D2·D3)이고,
 *   이쪽은 **이미 사이트 쪽에 걸려 있는 편집**을 판으로 올리는 길이다. 둘은 입구도 원장 출처도 다르다
 *   (`UPLOAD` vs `EDIT`). 이름이 비슷해 헷갈리기 쉬워 여기 적어 둔다.
 *
 * ■ **새 엔드포인트는 0** — 쓰기는 선재 문 둘로 한다
 *
 * ⚠ 「문 둘」은 **쓰는 문**의 수다. 세 동사가 실제로 지나는 문은 더 많다 — 장부를 다시 세우려고
 *   `GET /revisions`·`/revisions/{n}/source-url`·`GET /draft/files` 를 읽는다. 그래서 권한도
 *   `SITE_PUBLISH` 만으로는 모자라고 `SITE_SOURCE_READ`·`SITE_SOURCE_EXPORT` 가 함께 든다.
 *
 * | 동사 | 문 | 하는 일 |
 * |---|---|---|
 * | `publish` | `POST /draft/publish` | 편집을 판 N+1 로 올린다 |
 * | `rollback <판>` | `POST /revisions/{n}/activate` | **라이브 판을 옮긴다** |
 * | `discard` | 같은 문(활성 판 대상) | **편집을 버린다.** 판은 안 옮긴다 |
 *
 * ⚠ **「편집만」이라 쓰지 않는다.** 동의를 실으면 서버가 **게시 대기 AI 변경도 함께** 버린다 —
 *   그리고 그것은 쓴 크레딧이 돌아오지 않는 자산이다. 그 동의는 우리가 만들지 않고 사람에게 묻는다.
 *
 * ⚠ **동사를 겸용시키지 않는다.** 초안의 「rollback 뒤 다시」는 두 일을 한 동사에 묶은 문장이었고
 *   그 겸용이 🔴3 의 절반이다. 되돌리기 대상이 지금 활성 판이면 그것은 **버리기**이므로 받지 않는다.
 *
 * ■ 확인 게이트의 성질 — 정직하게
 *
 * 로컬 확인은 **보안 통제가 아니라 UX 가드**다. 강제 지점이 우리 프로세스라 사용자가 우회할 수 있다.
 * 「MCP 확인 코드와 동급」이라 적지 않는다.
 */
import {resolve} from "node:path";
import {
    isDraftInProgress,
    needsDiscardConsent,
    type DraftPublishResult,
    type ZalkeraApi,
} from "./api.ts";
import {DevtoolsError} from "./errors.ts";
import {rebuildBaseline} from "./baseline.ts";
import {plausibleRevisionNo} from "./localMark.ts";
import {rm} from "node:fs/promises";
import {readLedger, writeLedger} from "./pull.ts";
import {SYNC_LEDGER_PATH} from "./syncLedger.ts";
import {resolveExisting} from "./workdir.ts";
import type {StrandedPlan} from "./strandedPlan.ts";

export interface PublishDraftOptions {
    api: ZalkeraApi;
    folder: string;
    /** 판에 붙일 이름. 서버가 다듬고 길이를 잰다 — 여기서 두 번 하지 않는다. */
    label?: string;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}

export interface PublishOutcome extends DraftPublishResult {
    /**
     * 발행 뒤 장부를 새 판으로 다시 세웠는가.
     *
     * ⚠ **거짓이어도 발행은 성공한 것이다.** 그때 장부는 「모름」이고 다음 `push` 가 거절한다 —
     *   복구는 `baseline` 이다. 여기서 던지면 사람은 「발행이 실패했다」로 읽고 또 누른다.
     */
    ledgerRebuilt: boolean;
    /** 새 판이 담고 있는 파일 수. 장부를 못 세웠으면 `null`. */
    files: number | null;
}

/** 편집을 판으로 올린다. */
export async function publishDraft(options: PublishDraftOptions): Promise<PublishOutcome> {
    const report = options.onProgress ?? (() => {});
    const root = resolve(options.folder);

    report("편집을 새 버전으로 올리는 중입니다…");
    // ⚠ **동의 재시도로 감싸지 않는다.** 이 문은 `DRAFT_DISCARD_CONFIRM_REQUIRED` 를 던지지 않는다 —
    //   그 코드를 던지는 자리는 「켜진 판으로 되돌리기」 하나다(`SiteRevisionActivationService`).
    //   감싸 두면 도달 못 하는 갈래가 초록으로 덮이고, 사람에게 없는 출구를 안내하게 된다.
    const published = await options.api.publishDraft(options.label).catch((error: unknown) => {
        // 🔴 **서버 문면의 「되돌린 뒤」가 CLI 어휘에서 다른 명령을 가리킨다.** 좌초한 편집은
        //    이 문에서 `DRAFT_BASE_MOVED` 로 막히고 서버는 「되돌린 뒤 지금 버전에서 다시 고쳐
        //    주세요」라 답하는데, CLI 의 `rollback` 은 **편집이 걸려 있으면 그 자체가 막힌다.**
        //    그대로 내보내면 두 거절이 서로를 가리켜 사람이 갇힌다 — 형제 `rollback` 쪽에서
        //    같은 충돌을 고쳤는데 이쪽이 무매핑으로 남아 있었다(심의 실측).
        //    참인 출구는 **버리기**다. 그리고 그것은 무엇을 잃는지 먼저 보여 준다.
        if (error instanceof DevtoolsError && error.serverCode === "DRAFT_BASE_MOVED") {
            throw new DevtoolsError(
                "PUBLISH_BASE_MOVED",
                "편집을 시작한 뒤 사이트 버전이 바뀌어 이 편집을 올릴 수 없습니다.",
                "`zalkera discard` 로 그 편집을 버린 뒤, `zalkera pull` 로 지금 버전을 받아 다시 고쳐 주세요. 버리기는 무엇이 걸려 있는지 먼저 보여 줍니다.",
                error,
            );
        }
        throw error;
    });

    // ⚠ **`files` 를 「직전 작업본」으로 추정하지 않는다**(§2.1). 서버가 경로 정규화·제외 목록을
    //   적용하므로 추정은 조용히 어긋난다. 새 판 매니페스트를 **다시 읽는다.**
    // ⚠ 못 읽어도 **던지지 않는다** — 판은 이미 섰다.
    report("새 버전의 파일 목록을 읽는 중입니다…");
    const rebuilt = await rebuildBaseline({
        api: options.api,
        folder: root,
        revisionNo: published.revisionNo,
        onProgress: report,
        fetchImpl: options.fetchImpl,
    }).catch(() => null);

    if (rebuilt === null) {
        // 「모름」이 정직한 답이다 — 옛 판을 가리키는 장부를 그대로 두면 **거짓**이 된다.
        await forgetLedger(root);
        return {...published, ledgerRebuilt: false, files: null};
    }
    return {...published, ledgerRebuilt: true, files: rebuilt.files};
}

export interface RollbackOptions {
    api: ZalkeraApi;
    folder: string;
    /** 되돌릴 판. **지금 활성 판이면 받지 않는다** — 그것은 버리기다. */
    revisionNo: number;
    /**
     * 🔴 **게시 대기 AI 변경을 함께 버린다** — 「편집 중인 것」이 아니다.
     *
     * 종전 이름은 `discardDraft` 였고 도움말도 「편집 중인 것을 함께 버린다」였는데, **두 쪽 다
     * 거짓**이었다(심의 실측). 되돌리기 대상이 활성 판이 아니면 서버의 베이스라인 이동 가드가
     * 드래프트를 **플래그와 무관하게** 거절하므로(`DRAFT_IN_PROGRESS`), 이 값이 실제로 앉는 자리는
     * `discardPendingChanges` 다 — 그리고 그쪽은 **쓴 크레딧이 돌아오지 않는** 자산이다.
     */
    discardPending?: boolean;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}

export interface RollbackOutcome {
    /**
     * 🔴 **서버가 실제로 켠 판.** 사람이 친 번호와 **다를 수 있다** — 되돌리기 대상이 꼬리가 아니면
     * 서버가 새 판(`ROLLBACK`)을 세우고 그것을 켠다. 장부·문면은 **이 값**을 써야 한다.
     *
     * ⚠ **`null` 은 「안 옮겨졌다」가 아니라 「번호를 모른다」다.** 판은 옮겨졌다 — 그 사실은
     *   [pointerMoved] 가 말한다. 문면은 번호 없이 「옮겼습니다」라고 해야 한다.
     */
    revisionNo: number | null;
    /** 사람이 친 번호. 위와 다르면 부르는 쪽이 그 사실을 말한다. */
    requested: number;
    /** 판을 실제로 옮겼는가. 서버가 안 주면 참으로 본다(구서버의 뜻). */
    pointerMoved: boolean;
    /** 되돌리기가 편집을 버렸는가. */
    discardedDraft: boolean;
    discardedPendingChanges: number;
    ledgerRebuilt: boolean;
    /**
     * 이 폴더가 그 판과 다른 경로들. **작업본은 안 건드렸다**(§2.1) — 맞추는 일은 `pull` 의 몫이다.
     *
     * ⚠ 비지 않으면 그 상태로 `push` 할 때 **여기 실린 것이 전부** 올라간다. 부르는 쪽이 말한다.
     */
    differing: string[];
}

/** 라이브 판을 옮긴다. */
export async function rollbackRevision(options: RollbackOptions): Promise<RollbackOutcome> {
    const report = options.onProgress ?? (() => {});
    const root = resolve(options.folder);

    const active = await activeRevisionNo(options.api);
    if (options.revisionNo === active) {
        throw new DevtoolsError(
            "ROLLBACK_IS_DISCARD",
            `${options.revisionNo}판은 지금 켜져 있는 버전입니다 — 되돌릴 것이 없습니다.`,
            "편집 중인 것을 버리려는 것이라면 `zalkera discard` 를 쓰세요. 그쪽은 판을 옮기지 않고 편집만 버립니다.",
        );
    }

    report(`${options.revisionNo}판으로 되돌리는 중입니다…`);
    const result = await requireConsent(() =>
        options.api.activateRevision(options.revisionNo, options.discardPending === true),
    ).catch((error: unknown) => {
        // 🔴 **뚫을 수 없는 거절에 출구를 댄다.** 편집이 걸려 있으면 서버가 **동의와 무관하게**
        //    거절한다(베이스라인 이동 가드 5층). 그 서버 문면은 「발행하거나 **되돌린** 뒤」인데,
        //    CLI 어휘에서 그 「되돌리기」는 **방금 실패한 그 명령**이다 — 실제 출구는 버리기다.
        //    형제 확장은 같은 자리에서 안내를 대는데 CLI 만 맨몸이었다(심의 실측).
        if (isDraftInProgress(error)) {
            throw new DevtoolsError(
                "ROLLBACK_BLOCKED_BY_DRAFT",
                "사이트 쪽에 편집 중인 것이 있어 버전을 되돌릴 수 없습니다.",
                "`zalkera publish` 로 그 편집을 새 버전으로 만들거나, `zalkera discard` 로 버린 뒤 다시 시도해 주세요. 버리기는 무엇이 걸려 있는지 먼저 보여 줍니다.",
                error,
            );
        }
        throw error;
    });

    // 🔴 **서버가 실제로 켠 판을 쓴다 — 사람이 친 번호가 아니다.**
    //    되돌리기 대상이 꼬리가 아니면 서버는 **새 판(`ROLLBACK`)을 세우고 그것을 켠다**
    //    (`activateByPointer`). 즉 `rollback 3` 의 결과는 3판이 아니라 10판일 수 있다.
    //    친 번호를 장부에 적으면 바로 다음 `push` 가 「기준이 3판에서 10판으로 움직였다」로 죽는다
    //    (심의 실측). 그리고 「3판으로 되돌렸습니다」와 `status` 의 「켜진 판: 10판」이 어긋난다.
    //
    // 🔴 **응답이 이미 그 번호를 싣는다 — 다시 조회하지 않는다.** 조회로 읽으면 그 조회가
    //    실패할 때 **이미 옮겨진 라이브**를 「확인 못 했습니다 · 잠시 뒤 다시 시도해 주세요」로
    //    보고하고, 그 안내를 따른 재시도가 같은 내용의 판을 하나 더 세운다(심의 실측).
    //    형제 `publishDraft` 는 판이 선 뒤로는 아무것도 안 던진다 — 규율을 맞춘다.
    // ⚠ **서버 값이라 런타임 검사가 없다.** `request<T>` 는 캐스트일 뿐이다 — 형 선언만 믿으면
    //   판 번호가 아닌 값이 그대로 장부에 적히고, 그 장부는 다음 `push` 를 영구히 막는다.
    //   잣대는 표식 입구와 **같은 것**을 쓴다(`plausibleRevisionNo`) — 둘이 갈리면 화면이
    //   「정수만 싣는다」고 적어 놓고 한쪽으로는 아닌 것을 싣는다.
    const landed =
        plausibleRevisionNo(result.revisionNo) ??
        (await activeRevisionNo(options.api).catch(() => null));
    if (landed === null) {
        // 구서버(번호 미탑재) + 조회 실패. **판은 이미 옮겨졌다** — 던지면 거짓말이다.
        await forgetLedger(root);
        return {
            revisionNo: null,
            requested: options.revisionNo,
            pointerMoved: result.pointerMoved ?? true,
            discardedDraft: result.discardedDraft ?? false,
            discardedPendingChanges: result.discardedPendingChanges ?? 0,
            ledgerRebuilt: false,
            differing: [],
        };
    }

    // 전이표: 대상 판으로 **교체** · 세대 null · `mine` 비움 · **작업본은 안 건드린다**.
    const rebuilt = await rebuildBaseline({
        api: options.api,
        folder: root,
        revisionNo: landed,
        onProgress: report,
        fetchImpl: options.fetchImpl,
    }).catch(() => null);
    if (rebuilt === null) await forgetLedger(root);

    return {
        revisionNo: landed,
        requested: options.revisionNo,
        pointerMoved: result.pointerMoved ?? true,
        discardedDraft: result.discardedDraft ?? false,
        discardedPendingChanges: result.discardedPendingChanges ?? 0,
        ledgerRebuilt: rebuilt !== null,
        differing: rebuilt?.differing ?? [],
    };
}

export interface DiscardOptions {
    api: ZalkeraApi;
    folder: string;
    /**
     * **게시 대기 AI 변경을 함께 버린다.** 명시 동의가 있을 때만 참이다.
     *
     * ⚠ 이것은 편집 폐기와 **다른 자산군**이다 — 쓴 크레딧이 돌아오지 않는다. 우리가 보여 주는
     *   좌초 목록에는 이 레일이 안 뜨므로, 동의를 여기서 자동으로 만들면 **보여 준 것과 지우는 것이
     *   갈린다.**
     */
    discardPending?: boolean;
    /**
     * 🔴 **사람에게 보여 준 그 판정**을 그대로 넘긴다.
     *
     * 안 넘기면 여기서 다시 조회하는데, 그 사이 서버 쪽이 바뀔 수 있다 — 그러면 **사람이 확인한
     * 것과 우리가 버리는 것이 다른 것**이 된다. 특히 「내 것」이라 보고 y 를 누른 뒤 남의 편집이
     * 끼어들면, 동의 없이 그것을 지운다. 왕복도 하나 준다.
     */
    plan: StrandedPlan;
    onProgress?: (message: string) => void;
}

export interface DiscardOutcome {
    /** 무엇을 버렸는지 — 부르는 쪽이 이미 사람에게 보여 준 그 목록이다. */
    plan: StrandedPlan;
    discardedPendingChanges: number;
    /** 버린 것이 실제로 있었는가. 거짓이면 애초에 편집이 없었다. */
    hadDraft: boolean;
    /**
     * 🔴 **라이브 판이 움직였는가.** 버리기는 판을 안 옮기는 동사인데, 우리가 읽은 활성 판이 그
     * 사이 낡았으면 서버가 이 호출을 되돌리기로 처리한다. 참이면 **배포 사건**이다.
     */
    pointerMoved: boolean;
}

/**
 * 사이트 쪽에서 편집 중인 것을 버린다. **판은 안 옮긴다.**
 *
 * 지금 활성 판을 대상으로 `activate` 를 부르는 것이 그 뜻이다 — 포인터는 제자리다.
 *
 * ⚠ **동의를 실으면 게시 대기 AI 변경도 함께 걷힌다**(서버가 「둘 다 버린다」로 못박은 자리 —
 *   사람 편집만 버리면 다음 AI 게시가 남은 것을 실어 나른다). 그 동의는 부르는 쪽이 사람에게 묻는다.
 */
export async function discardDraft(options: DiscardOptions): Promise<DiscardOutcome> {
    const report = options.onProgress ?? (() => {});
    const root = resolve(options.folder);

    const active = await activeRevisionNo(options.api);

    // 🔴 **버리기 전에 「확인한 것과 버리는 것이 같은가」를 한 번 잰다.**
    //
    //    사람이 목록을 보고 답하는 창은 상한이 없다(분 단위일 수 있다). 그 사이 콘솔·AI 레인이
    //    편집을 얹으면 그 한 글자 동의가 **보여 준 적 없는 것**을 태운다 — §2.5 🔴3 이 막으려던
    //    그 얼굴이다.
    //
    // ⚠ **문 앞에 둔다 — 거절 갈래 안이 아니다.** 안에만 두면 `--discard-pending` 을 처음부터
    //   준 회차는 서버가 동의를 안 물어 그 갈래가 아예 안 돌고, 재검이 통째로 빠진다(심의 실측).
    //   그리고 우리 거절 문면이 **바로 그 플래그를 안내한다**([asConsentRequired]) — 도구가
    //   스스로 가리키는 재시도 경로가 가드 밖에 있는 꼴이었다.
    //
    // ⚠ 창이 없어지는 것은 아니다 — 사람-시간이 망-시간으로 줄 뿐이고, 서버가 원자 조건부
    //   폐기를 안 받는 한 그 잔량은 남는다(§2.5 에 적혀 있다).
    const now = await options.api.draftFiles().catch(() => null);
    if (now === null || (now.generation ?? null) !== options.plan.generation) {
        throw new DevtoolsError(
            "DRAFT_MOVED_WHILE_CONFIRMING",
            "확인하시는 사이 사이트 쪽 편집이 달라져 아무것도 버리지 않았습니다.",
            "`zalkera discard` 를 다시 실행하면 지금 걸려 있는 것을 보여 드립니다.",
        );
    }

    report("편집 중인 것을 버리는 중입니다…");
    // 🔴 **동의를 무조건 참으로 보내지 않는다.** 그 인자는 `discardPendingChanges` 이고, 참이면
    //    서버가 **게시 대기 AI 변경 전량**을 크레딧과 함께 지운다 — 그런데 우리가 사람에게 보여
    //    준 목록(`GET /draft/files`)에는 그 레일이 **아예 안 뜬다.** 갈래 A 의 마지막 문장이
    //    「버려도 이 폴더의 내용은 그대로입니다」인데 그 `y` 한 글자가 다른 자산군을 지웠다.
    //    → 거짓으로 먼저 보내고, 서버가 무엇이 걸렸는지 답하게 한다.
    const result = await options.api
        .activateRevision(active, options.discardPending === true)
        .catch(async (error: unknown) => {
            // 🔴 **여기서 끝내면 이 동사는 한 번에 성공하지 못한다.** 서버는 게시 대기 AI 변경이
            //    **0건이어도** 드래프트만 있으면 이 동의를 요구한다(`discardToCurrent` 의
            //    `(draft != null || pending > 0) && !consented`). 즉 버릴 편집이 실제로 있는
            //    **모든** 버리기가 방금 받은 `y`/`버립니다` 직후 거절로 끝났고, 사람은 크레딧
            //    자산의 동의 플래그(`--discard-pending`)를 **습관으로** 붙이게 됐다(심의 실측).
            //
            //    갈래는 서버가 짚어 준 항목으로 가른다 — 문면을 파싱하지 않는다:
            //    ⑴ 크레딧이 걸렸으면 **여기서 멈춘다.** 그 자산은 사람에게 보여 준 적이 없다.
            //    ⑵ 편집만 걸렸으면 그것은 **방금 확인받은 바로 그 목록**이므로 동의를 실어 잇는다.
            if (!needsDiscardConsent(error) || !(error instanceof DevtoolsError)) throw error;
            if (stopsHere(error)) throw asConsentRequired(error);
            // 세대는 이 문 **앞에서** 이미 쟀다 — 두 갈래가 같은 문을 지나야 한쪽만 뚫리지 않는다.
            report("서버가 확인을 한 번 더 요구해 방금 주신 동의를 그대로 잇습니다…");
            return options.api.activateRevision(active, true);
        });

    // 전이표 `discard`: `base`/`files` 무변경 · 세대 **null** · `mine` **비움** · 작업본 안 건드림.
    const ledger = await readLedger(root);
    if (ledger) await writeLedger(root, {...ledger, server: null, mine: {}});

    return {
        plan: options.plan,
        discardedPendingChanges: result.discardedPendingChanges ?? 0,
        hadDraft: result.discardedDraft ?? options.plan.paths.length > 0,
        // 🔴 **라이브가 움직였는지 싣는다.** 갈래는 서버가 정한다 — 우리가 읽은 활성 판이 그 사이
        //    낡았으면 서버는 이 호출을 **되돌리기로 처리해 포인터를 옮긴다.** 그 사실을 안 실으면
        //    배포 사건이 일어났는데 「아무 일도 없었다」로 읽힌다.
        pointerMoved: result.pointerMoved ?? false,
    };
}

/**
 * 장부를 **잊는다** — 「모름」의 표현이다(§2.1 「부재/손상 장부 = 모름」).
 *
 * ⚠ 옛 판을 가리키는 장부를 그대로 두는 쪽이 더 나쁘다. 그것은 **거짓**이고, 그 위에서 계산한
 *   선행조건이 낡은 매니페스트를 근거로 삼는다. 없으면 다음 `push` 가 거절하고 `baseline` 이 복구한다.
 */
async function forgetLedger(root: string): Promise<void> {
    // 🔴 **조각마다 링크를 본다.** 형제 쓰기 경로는 맨 `fs` 를 금지하고 [ensureOwnDir]·[writeOwnFile]
    //    한 문을 지나는데, 지우는 쪽이 그 규율을 빠져나가고 있었다 — `.zalkera` 가 링크면 그 링크가
    //    가리키는 **폴더 밖 파일**을 지운다(심의 실측). 그리고 그 조합은 우연이 아니다: 링크면
    //    장부 쓰기가 거부되고 → 발행의 재수립이 던지고 → 이 함수가 **반드시** 돈다.
    const target = await resolveExisting(root, SYNC_LEDGER_PATH);
    if (target === null) return;
    await rm(target, {force: true}).catch(() => undefined);
}

/**
 * 지금 켜진 판. **못 읽으면 던진다** — 무엇 위에서 움직이는지 모르는 채로 원장을 건드리지 않는다.
 *
 * 🔴 **`isActive` 로 직접 찾는 것만으로는 모자란다.** 첫 업로드가 빌드 실패한 테넌트는 활성
 *    포인터가 **영영 `null`** 이고, 그러면 이 함수가 던져 `discard`·`rollback` 이 둘 다 막힌다 —
 *    그런데 그 거절의 안내(「콘솔에서 버전을 켜세요」)를 따르면 드래프트 때문에 `DRAFT_IN_PROGRESS`
 *    로 막히고, 그 거절의 출구가 다시 `discard` 다. **두 문이 서로를 가리킨다.**
 *
 *    백엔드가 그 자리를 알고 `GET /draft` 에 `revertTargetRevisionNo` 를 실어 답을 준다 —
 *    그쪽 KDoc 이 「화면이 `isActive` 로 직접 찾으면 안 된다 … 영원히 안 고쳐지는 거짓말이다」라고
 *    못박아 두었다. 그 문을 쓴다.
 */
async function activeRevisionNo(api: ZalkeraApi): Promise<number> {
    const rows = await api.listRevisions().catch(() => null);
    if (rows === null) {
        throw new DevtoolsError(
            "SERVER_UNREADABLE_DRAFT",
            "지금 사이트에 켜져 있는 버전을 확인하지 못했습니다.",
            "잠시 뒤 다시 시도해 주세요. 계속 그러면 이 계정에 버전 목록을 볼 권한이 있는지 확인해 주세요.",
        );
    }
    const active = rows.find((row) => row.isActive)?.revisionNo;
    if (active !== undefined) return active;

    // 활성 행이 없다 — 서버가 정한 되돌리기 대상으로 접는다.
    const fallback = await api.draftState().then((state) => state.revertTargetRevisionNo ?? null).catch(() => null);
    if (fallback !== null) return fallback;
    throw new DevtoolsError(
        "SERVER_UNREADABLE_DRAFT",
        "이 사이트에 켜져 있는 버전이 없습니다.",
        "콘솔에서 어떤 버전을 켤지 먼저 정해 주세요. 그 전에는 무엇 위에 얹는 것인지 알 수 없어 원장을 건드리지 않습니다.",
    );
}

/**
 * **서버가 동의를 요구하면 그 문면 그대로 올린다.**
 *
 * 🔴 종전에는 동의를 **무조건 참으로** 보냈다. 그 인자(`discardPendingChanges`)가 참이면 서버가
 *    게시 대기 AI 변경 전량을 **쓴 크레딧과 함께** 지우는데, 우리가 사람에게 보여 준 목록에는
 *    그 레일이 **아예 안 뜬다** — 동의받은 것과 지운 것이 다른 자산군이었다(심의 실측).
 *
 * ⚠ **여기서 자동으로 참으로 바꾸지 않는다.** 서버 문면은 편집 N개와 AI M건을 **나눠 세므로**,
 *   그것을 사람에게 보여 주고 다시 묻는 것이 정석이다. 우리가 만든 문장으로 대신하지 않는다.
 *
 * 🔴 **코드 하나로 재지 않는다 — [needsDiscardConsent] 집합으로 잰다.** 지금 집합에 든 코드가
 *    하나라고 상수 비교로 바꾸면, 백엔드가 코드를 더하는 날 이 레일이 조용히 죽는다. 백엔드
 *    `ConsentRetryableErrorCodes` KDoc 도 「술어를 늘리지 말고 집합을 넓혀라」라고 못박아 두었다.
 *
 * ⚠ **크레딧 문장을 우리가 만들지 않는다.** 버리기 갈래는 게시 대기 AI 변경이 **0건이어도**
 *   드래프트만 있으면 이 거절을 낸다 — 그때 「쓴 크레딧은 돌아오지 않습니다」는 우리가 지어낸
 *   거짓 겁주기다. 크레딧이 실제로 걸렸는지는 서버가 [PENDING_MARK] 로 답한다.
 */
async function requireConsent<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (error) {
        if (needsDiscardConsent(error) && error instanceof DevtoolsError) throw asConsentRequired(error);
        throw error;
    }
}

/** 서버의 동의 요구를 **그 문면 그대로** 올리고, 확인하는 자리를 덧댄다. */
function asConsentRequired(error: DevtoolsError): DevtoolsError {
    return new DevtoolsError(
        "DISCARD_CONSENT_REQUIRED",
        error.message,
        creditsAtStake(error)
            ? "그래도 계속하려면 `--discard-pending` 을 붙여 주세요. 쓴 크레딧은 돌아오지 않습니다."
            : "그래도 계속하려면 `--discard-pending` 을 붙여 주세요.",
        error,
    );
}

/**
 * 서버가 **어느 항목이 걸렸는지** 짚어 줄 때 「게시 대기 AI 변경」을 가리키는 표식
 * (백엔드 `BusinessException.Detail.key` → 응답 `errors[].field` → [DevtoolsError.paths]).
 *
 * ⚠ **문면을 파싱하지 않는다.** 서버의 한국어 문구를 뜯어 쓰면 그 문구가 계약이 되고, 백엔드가
 *   문장을 다듬는 날 이 분기가 조용히 뒤집힌다.
 */
const PENDING_MARK = "pendingAiChanges";

/** 이 자산군만이 **사람에게 이미 보여 준 것**이다 — `GET /draft/files` 가 나열한 그 목록. */
const SHOWN_MARK = "draft";

/**
 * 여기서 **멈추는가** — 동의를 이어 붙여도 되는가의 판정.
 *
 * 🔴 **허용목록이다. 차단목록으로 쓰지 마라.** 종전에는 [creditsAtStake] 하나가 이 자리와 문면
 *    고르기를 겸했는데, 그것은 「모르는 표식」을 **안전이 아니라 위험 쪽**으로 접었다(설계자 심의
 *    실측): 서버가 `["draft","futureAsset"]` 을 주면 `includes(PENDING_MARK)` 가 거짓이라 동의를
 *    자동으로 이어, **보여 준 적 없는 제3 자산군**이 그대로 소각됐다.
 *
 * ⚠ 바로 옆 [creditsAtStake] 는 **부재**를 「걸렸다」로 접는다. 부재는 안전 쪽인데 「모르는 존재」만
 *   반대로 접히는 비대칭이 이 게이트가 죽이려던 병(동의받은 것 ≠ 지운 것)을 되살린다.
 *
 * ⚠ 서버가 앞서고 설치된 CLI 가 낡는 것은 이 제품의 **상시 형상**이다. 백엔드가 같은 불리언으로
 *   걷는 자산군을 하나 더 붙이는 날, 낡은 CLI 가 그것을 무경고로 태우면 안 된다.
 */
function stopsHere(error: DevtoolsError): boolean {
    return error.paths.length === 0 || error.paths.some((p) => p !== SHOWN_MARK);
}

/**
 * 이 거절에 **쓴 크레딧이 걸려 있는가.**
 *
 * ⚠ **결여는 「걸렸다」로 접는다.** 표식을 안 보내는 서버(이 표식보다 먼저 배포된 판)에서는
 *   걸렸는지 알 수 없고, 그때 「안 걸렸다」로 접으면 크레딧이 걸린 회차를 **경고 없이** 태운다.
 *
 * ⚠ **이것은 「멈추나」가 아니라 「무엇이라 말하나」다**([stopsHere] 와 분리한 이유). 여기서
 *   허용목록을 쓰면 크레딧이 아닌 모르는 표식에도 「쓴 크레딧은 돌아오지 않습니다」가 붙어
 *   **거짓 겁주기**가 된다. 멈추는 것과 겁주는 것은 다른 질문이다.
 */
function creditsAtStake(error: DevtoolsError): boolean {
    return error.paths.length === 0 || error.paths.includes(PENDING_MARK);
}
