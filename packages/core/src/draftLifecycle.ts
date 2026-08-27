/**
 * **발행·되돌리기·버리기**(memo184 §2.4·§2.5 · T3).
 *
 * ⚠ **형제 `publish.ts` 와 다른 파일이다.** 그쪽은 폴더를 **zip 으로 묶어 올리는** 길(확장의 D2·D3)이고,
 *   이쪽은 **이미 사이트 쪽에 걸려 있는 편집**을 판으로 올리는 길이다. 둘은 입구도 원장 출처도 다르다
 *   (`UPLOAD` vs `EDIT`). 이름이 비슷해 헷갈리기 쉬워 여기 적어 둔다.
 *
 * ■ 세 동사가 서버 문 둘을 나눠 쓴다 — **새 문은 0**
 *
 * | 동사 | 문 | 하는 일 |
 * |---|---|---|
 * | `publish` | `POST /draft/publish` | 편집을 판 N+1 로 올린다 |
 * | `rollback <판>` | `POST /revisions/{n}/activate` | **라이브 판을 옮긴다** |
 * | `discard` | 같은 문(활성 판 대상) | **편집만 버린다.** 판은 안 옮긴다 |
 *
 * ⚠ **동사를 겸용시키지 않는다.** 초안의 「rollback 뒤 다시」는 두 일을 한 동사에 묶은 문장이었고
 *   그 겸용이 🔴3 의 절반이다. 되돌리기 대상이 지금 활성 판이면 그것은 **버리기**이므로 받지 않는다.
 *
 * ■ 확인 게이트의 성질 — 정직하게
 *
 * 로컬 확인은 **보안 통제가 아니라 UX 가드**다. 강제 지점이 우리 프로세스라 사용자가 우회할 수 있다.
 * 「MCP 확인 코드와 동급」이라 적지 않는다. 그래서 파괴적 동사는 로컬 MCP 카탈로그 밖에 둔다(§2.6).
 */
import {resolve} from "node:path";
import type {DraftPublishResult, ZalkeraApi} from "./api.ts";
import {DevtoolsError} from "./errors.ts";
import {rebuildBaseline} from "./baseline.ts";
import {readLedger, writeLedger} from "./pull.ts";
import type {StrandedPlan} from "./strandedPlan.ts";

export interface PublishDraftOptions {
    api: ZalkeraApi;
    folder: string;
    /** 판에 붙일 이름. 서버가 다듬고 길이를 잰다 — 여기서 두 번 하지 않는다. */
    label?: string;
    /**
     * 게시 대기 AI 변경을 **함께 버린다.** 명시 동의가 있을 때만 참이다.
     *
     * ⚠ 서버가 그 동의를 요구하면(`DRAFT_DISCARD_CONFIRM_REQUIRED`) 부르는 쪽이 사람에게 묻고
     *   다시 부른다 — 여기서 자동으로 참으로 바꾸지 않는다.
     */
    discardPendingChanges?: boolean;
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
    const published = await options.api.publishDraft(options.label, options.discardPendingChanges === true);

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
    /** 걸려 있는 편집을 함께 버린다. 명시 동의가 있을 때만 참이다. */
    discardDraft?: boolean;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}

export interface RollbackOutcome {
    revisionNo: number;
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
    const result = await options.api.activateRevision(options.revisionNo, options.discardDraft === true);

    // 전이표: 대상 판으로 **교체** · 세대 null · `mine` 비움 · **작업본은 안 건드린다**.
    const rebuilt = await rebuildBaseline({
        api: options.api,
        folder: root,
        revisionNo: options.revisionNo,
        onProgress: report,
        fetchImpl: options.fetchImpl,
    }).catch(() => null);
    if (rebuilt === null) await forgetLedger(root);

    return {
        revisionNo: options.revisionNo,
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
}

/**
 * 사이트 쪽에서 편집 중인 것을 버린다. **판은 안 옮긴다.**
 *
 * 지금 활성 판을 대상으로 `activate` 를 부르는 것이 그 뜻이다 — 포인터는 제자리이고 편집만 걷힌다.
 */
export async function discardDraft(options: DiscardOptions): Promise<DiscardOutcome> {
    const report = options.onProgress ?? (() => {});
    const root = resolve(options.folder);

    const active = await activeRevisionNo(options.api);

    report("편집 중인 것을 버리는 중입니다…");
    const result = await options.api.activateRevision(active, true);

    // 전이표 `discard`: `base`/`files` 무변경 · 세대 **null** · `mine` **비움** · 작업본 안 건드림.
    const ledger = await readLedger(root);
    if (ledger) await writeLedger(root, {...ledger, server: null, mine: {}});

    return {
        plan: options.plan,
        discardedPendingChanges: result.discardedPendingChanges ?? 0,
        hadDraft: result.discardedDraft ?? options.plan.paths.length > 0,
    };
}

/**
 * 장부를 **잊는다** — 「모름」의 표현이다(§2.1 「부재/손상 장부 = 모름」).
 *
 * ⚠ 옛 판을 가리키는 장부를 그대로 두는 쪽이 더 나쁘다. 그것은 **거짓**이고, 그 위에서 계산한
 *   선행조건이 낡은 매니페스트를 근거로 삼는다. 없으면 다음 `push` 가 거절하고 `baseline` 이 복구한다.
 */
async function forgetLedger(root: string): Promise<void> {
    const {rm} = await import("node:fs/promises");
    const {join} = await import("node:path");
    const {SYNC_LEDGER_PATH} = await import("./syncLedger.ts");
    await rm(join(root, SYNC_LEDGER_PATH), {force: true}).catch(() => undefined);
}

/** 지금 켜진 판. **못 읽으면 던진다** — 무엇 위에서 움직이는지 모르는 채로 원장을 건드리지 않는다. */
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
    if (active === undefined) {
        throw new DevtoolsError(
            "SERVER_UNREADABLE_DRAFT",
            "이 사이트에 켜져 있는 버전이 없습니다.",
            "콘솔에서 어떤 버전을 켤지 먼저 정해 주세요.",
        );
    }
    return active;
}
