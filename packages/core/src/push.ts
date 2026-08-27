/**
 * **올리기** — 작업본의 변경을 사이트 쪽 「편집 중인 것」에 얹는다(memo184 §2.3 · T2).
 *
 * ■ 순서가 계약이다
 *
 * ⑴ 장부를 읽는다 → ⑵ **서버 편집을 조회한다** → ⑶ **켜진 판을 조회한다** → ⑷ 작업본을 해시한다 →
 * ⑸ 무엇을 보낼지 정한다 → ⑹ **한 번의 배치 요청** → ⑺ 장부를 갱신한다.
 *
 * ⚠ ⑶도 **못 하면 올리지 않는다.** 기준 판은 모든 선행조건의 바탕이라, 그것이 지금 것인지 모르는
 *   채 보내면 낡은 매니페스트 위에서 계산한 값을 보내게 된다.
 *
 * ⚠ **⑵를 못 하면 올리지 않는다.** 장부로 폴백하는 순간 🔴1 이 되살아난다 — 남이 콘솔에서 되돌린
 *   뒤에도 「이미 반영됨」이라 답하는 거짓 성공이다. 선행조건의 정본은 **서버 조회**다.
 *
 * ⚠ **나눠 보내지 않는다.** 파일마다 따로 부르면 드래프트 세대가 N 개 생기고, 그 중간 세대가 다른
 *   문(발행·되돌리기)의 대상이 될 수 있다 — 의도한 변경의 **반쪽이 원장에 영구히 서는** 형상이다.
 *   상한을 넘으면 분할이 아니라 **거절**이고, 그때 길은 zip 레인이다.
 *
 * ■ 요청은 **최대 [MAX_PUSH_ATTEMPTS] 번**이고, 재계산마다 가드를 다시 지난다
 *
 * 거절 사유가 둘이라 갈래마다 한 번씩 재시도하면 **두 사유가 겹칠 때 세 번**이 된다 — 종전 판이
 * 그랬고 주석은 「한 번」이라 적고 있었다(실측). 지금은 상한이 반복문 하나에 있고 그 값이 곧 계약이다.
 *
 * 실패한 요청은 세대를 만들지 않으므로(서버가 얹기 전에 거절한다) 여러 번 나가도 **원장에 반쪽이
 * 서지는 않는다.** 상한이 있는 이유는 그것이 아니라, 사유가 번갈아 오는 서버에 무한히 매달리지
 * 않기 위해서다.
 *
 * 재계산에는 [PushPlan.unseen] 가드가 **그대로** 걸린다 — 안 그러면 재시도가 「받아 적고 다시
 * 보내는」 세탁 경로가 된다(memo183 🟠4).
 *
 * ■ 응답을 못 받으면 「모름」이다
 *
 * **「아마 올라갔을 겁니다」라고 말하지 않는다.** 세대를 모름으로 두고 끝내고, 다음 실행이
 * `GET /draft/files` 로 화해한다([reconcile]).
 */
import {readFile, stat} from "node:fs/promises";
import {basename, join, resolve} from "node:path";
import type {DraftEdit, DraftFiles, ZalkeraApi} from "./api.ts";
import {DevtoolsError} from "./errors.ts";
import {plainNotice} from "./notice.ts";
import {readLedger, writeLedger} from "./pull.ts";
import {PATH_LIST_CAP, trimPaths} from "./pullPlan.ts";
import {planPush, type DraftView, type PushEdit, type PushPlan} from "./pushPlan.ts";
import {SYNC_LEDGER_FORMAT, type SyncLedger} from "./syncLedger.ts";
import {hashWorkdir} from "./workdir.ts";
import {templateBreach} from "./zip.ts";

/**
 * 상한 — **가장 좁은 실물**에 맞춘다.
 *
 * ■ 서버에는 상한이 여러 겹이고, 요청이 먼저 만나는 것은 16MiB 가 아니다
 *
 * | 겹 | 값 | 무엇을 재나 |
 * |---|---|---|
 * | `RequestBodyLimitFilter.DEFAULT_MAX_BYTES` | **4MiB** | `/api/partner` **전 경로의 HTTP 본문** |
 * | `SiteDraftService.MAX_DRAFT_BYTES` | 16MiB | 요청 총량 **그리고** 드래프트 총량 |
 * | `SiteDraftService.MAX_FILE_BYTES` | 1MiB | 파일 하나 |
 * | `SiteDraftService.MAX_DRAFT_ENTRIES` | 500 | 요청 개수 **그리고** 드래프트 총 항목 수 |
 *
 * ⚠ **16MiB 로 재면 그 선에 닿지 않는다**(심의 실측). 4–16MiB 구간은 필터가 `sendError(413)` 로
 *   끊는데 그 응답에는 `message` 도 `errorCode` 도 없어, 사람은 「서버가 요청을 거절했습니다
 *   (HTTP 413)」만 보고 **무엇을 하면 되는지 모른다.** 900KB 파일 다섯이면 닿는다.
 *
 * ⚠ **드래프트 쪽 상한은 여기서 못 잰다.** 이미 400항목인 드래프트에 200개를 올리면 우리는
 *   통과시키고 서버가 거절한다 — 로컬은 드래프트 총량을 모른다. 그때 문면은 서버 것이고,
 *   그것이 정직한 상태다.
 */
export const MAX_PUSH_ENTRIES = 500;
/**
 * 한 번의 `push` 가 서버에 보내는 요청의 **총 상한**. 처음 한 번 + 재시도 둘이다.
 *
 * ⚠ 갈래마다 세지 않는다 — 그러면 사유가 겹칠 때 총량이 조용히 늘고, 「한 번」이라 적은 주석이
 *   거짓이 된다(실측: 배제 + 선행조건이 겹쳐 세 번 나갔다).
 */
export const MAX_PUSH_ATTEMPTS = 3;

/**
 * 서버가 「이 경로는 담기지 않는다」고 답할 때의 코드. 그 경로만 빼고 다시 보내면 된다.
 *
 * ⚠ 값을 옮겨 적은 것이다 — 정본은 백엔드 `SourcePathQuery.RejectedException.PATH_NOT_ACCEPTED` 다.
 *   갈리면 CLI 가 배제를 경합으로 읽어 **재시도가 수렴을 못 한다.**
 */
const PATH_NOT_ACCEPTED = "SOURCE_PATH_NOT_ACCEPTED";
/** 편집의 모양이 지금 상태와 안 맞는다(경합) — **다시 읽고 재계산**해야 한다. 빼면 안 된다. */
const SHAPE_STALE = "SOURCE_EDIT_SHAPE_STALE";

/** 서버가 준 미리보기 주소의 표시 상한. 주소가 이보다 길면 그것은 주소가 아니라 다른 것이다. */
const MAX_PREVIEW_URL = 2048;
/** 서버가 준 안내 문구의 표시 상한. 형제 `api.ts` 의 오류 문면 상한과 같은 뜻이다. */
const MAX_WARNING = 300;
export const MAX_PUSH_FILE_BYTES = 1024 * 1024;
/**
 * 한 요청의 **실제 본문** 상한. `RequestBodyLimitFilter` 가 재는 것과 **같은 것을 잰다.**
 *
 * ⚠ **원본 바이트로 재면 안 된다**(심의 실측). 4MiB 필터가 재는 것은 JSON 본문이고, 이스케이프가
 *   잦은 파일은 원본 3MiB 가 본문 4.65MiB 가 된다(따옴표 많은 CSV·JSON 픽스처). 그러면 우리 문면
 *   대신 **본문 없는 413** 이 나가고 사람은 「HTTP 413」만 본다.
 *   그래서 [bodyOf] 는 조립이 끝난 뒤 **직렬화해서** 잰다 — 그 시점에 본문을 이미 손에 들고 있다.
 * ⚠ 4MiB 그대로가 아니라 조금 좁게 잡는다. 헤더·경계값에서 우리 문면이 먼저 나오게 하려는 것이다.
 */
export const MAX_PUSH_BYTES = 3.5 * 1024 * 1024;

export interface PushOptions {
    api: ZalkeraApi;
    folder: string;
    /**
     * 안 본 남의 편집을 되돌리는 것을 **허용**한다. 명시 동의가 있을 때만 참이다.
     *
     * ⚠ 이 손잡이가 없으면 선행조건이 그것을 못 막는다 — 내 `baseSha256` 은 서버 조회에서 나오므로
     *   CAS 가 **정당하게 통과**한다([PushPlan.unseen]).
     */
    overwriteUnseen?: boolean;
    /** 거절 문면에 경로를 전부 싣는다(`--verbose`). */
    listAll?: boolean;
    onProgress?: (message: string) => void;
}

export interface PushResult {
    /**
     * 실제로 보낸 편집 수.
     *
     * ⚠ **0 이 곧 「폴더와 사이트가 같다」는 아니다.** [droppedByServer] 가 비어 있지 않으면 그
     *   경로들은 **올라가지 않았고** 폴더와 사이트는 다르다. 부르는 쪽은 둘을 함께 보고 말해야 한다 —
     *   따로 읽으면 「같습니다」와 「N개를 빼고 보냈습니다」가 나란히 찍힌다(심의 실측).
     */
    sent: number;
    /** 그중 삭제. */
    removed: number;
    /** 서버가 준 새 세대. */
    generation: string | null;
    /**
     * 서버가 거절해서 **빼고 다시 보낸** 경로들. 비어 있는 것이 정상이다.
     *
     * ⚠ **조용히 빼지 않는다.** 배제 목록이 서버와 우리 사이에서 갈렸다는 신호다(§2.8).
     */
    droppedByServer: string[];
    /** 선행조건이 어긋나 **다시 읽고 한 번 더** 보냈는가. */
    retriedAfterConflict: boolean;
    /** 지난 실행의 응답 유실을 이번에 화해했는가. `null` 이면 화해할 것이 없었다. */
    reconciled: "applied" | "not-applied" | null;
    previewUrl: string | null;
    warning: string | null;
}

/** 올리기를 실행한다. */
export async function pushSiteSource(options: PushOptions): Promise<PushResult> {
    const report = options.onProgress ?? (() => {});
    const root = resolve(options.folder);

    const ledger = await readLedger(root);
    if (!ledger) throw ledgerUnknown();
    if (ledger.tenant !== options.api.tenantCode()) throw foreignLedger(ledger.tenant);

    report("사이트 쪽 상태를 확인하는 중입니다…");
    let draft = await readDraft(options.api);
    // 🔴 **판이 움직였는지 본다.** 이 폴더의 기준 판은 장부가 정하는데, 그 사이 남이 발행하면
    //    장부는 옛 판을 가리킨 채로 남는다 — 그러면 `effectiveSha` 의 셋째 줄(판 매니페스트)이
    //    **낡은 값**이 되고, 보낼 것이 없다는 판정이 「폴더와 사이트가 같다」로 잘못 읽힌다.
    //    그것이 🔴1(거짓 동기화)의 판 쪽 갈래다(심의 실측).
    //
    // ⚠ **드래프트의 `baseRevisionNo` 로는 못 잰다.** 편집이 없으면 그 칸이 `null` 이고(백엔드
    //   `draftFiles` 실물), 판만 움직인 경우가 정확히 그 형상이다. 활성 판을 따로 묻는다.
    // ⚠ **못 읽으면 올리지 않는다.** 기준 판은 모든 선행조건의 바탕이라, 그것이 지금 것인지
    //   모르는 채 보내면 낡은 매니페스트 위에서 계산한 값을 보내게 된다. 「모른다」가 「같다」로
    //   변하는 자리를 하나도 남기지 않는다.
    const active = await activeRevisionNo(options.api);
    const reconciled = reconcile(ledger, draft);

    const local = await hashWorkdir(root);
    // ⚠ **세대가 갈렸으면 `mine` 을 안 넘긴다.** 지난 세계의 기록이라 소유를 증언할 수 없다
    //    (형제 `syncStatus` 의 `mineValid` 와 같은 규칙 — 규칙이 둘이면 한쪽만 조여진다).
    const owned = ownedBy(ledger, draft);
    // ⚠ **`>` 가 아니라 `!==` 다.** 되돌리기도 움직임이다 — 콘솔에서 5판으로 되돌리면 이 폴더는
    //    7판인데 가드가 안 서고 「사이트 쪽과 같습니다」가 나갔다(심의 실측).
    if (active !== ledger.base.revisionNo) {
        // ⚠ **작업본을 본 뒤에 던진다.** 「`pull` 을 먼저」라고만 말하면 그 `pull` 이 로컬 변경 때문에
        //   또 거절하고, 그 거절은 「`push` 를 먼저」라고 답한다 — **두 문이 서로를 가리켜 사람이
        //   갇힌다**(실측). 출구를 대려면 이 폴더에 고친 것이 있는지 알아야 한다.
        const dirty = Object.keys(ledger.files).filter(
            (path) => local[path]?.sha256 !== ledger.files[path]?.sha256,
        ).length;
        throw baseMoved(ledger.base.revisionNo, active, dirty);
    }
    let plan = planPush({base: ledger.files, draft: viewOf(draft), local, mine: owned});
    requireSeen(plan, options);

    if (plan.edits.length === 0) {
        const written = await writeLedger(root, {
            ...ledger,
            server: draft.generation === null ? null : {generation: draft.generation},
            mine: {},
        });
        return {
            sent: 0,
            removed: 0,
            generation: draft.generation,
            droppedByServer: [],
            retriedAfterConflict: false,
            reconciled,
            previewUrl: null,
            warning: written ? null : ledgerWriteFailed(0),
        };
    }

    requireWithinLimits(plan.edits);
    report(`${plan.edits.length}개를 올리는 중입니다…`);

    const dropped: string[] = [];
    let retried = false;
    let sent: Attempt | null = null;

    // ⚠ **경계를 구조에 둔다.** 종전에는 갈래마다 `if` 로 한 번씩 재시도했고, 두 사유가 **겹치면
    //   요청이 세 번** 나갔다(실측). 「재시도는 한 번」이라 적어 두고 그것이 거짓이었다.
    //   여기서는 상한이 하나이고, 그 값이 곧 계약이다.
    for (let round = 0; round < MAX_PUSH_ATTEMPTS; round += 1) {
        requireWithinLimits(plan.edits);
        sent = await attempt(options.api, root, plan.edits, report);
        if (sent.kind === "ok") break;

        if (sent.kind === "lost") {
            // 🔴 **「모름」을 장부에 적고 끝낸다.** 재시도하지 않는다 — 요청이 닿았는지 모르므로
            //    다시 보내면 같은 편집을 두 번 얹을 수 있다. 다음 실행이 화해한다([reconcile]).
            //    `mine` 은 **보내려던 것**으로 적는다: 화해가 대조할 대상이 그것이다.
            //    이 줄이 없으면 `server.generation` 이 지난 세대로 남고, 다음 실행의 화해가
            //    `ledger.server !== null` 에서 곧바로 되돌아간다 — 문은 있는데 못 부른다(심의 실측).
            const attempted: Record<string, string | null> = {};
            for (const edit of plan.edits) attempted[edit.path] = edit.sha256;
            // ⚠ **쓰기 실패를 본다.** 못 쓰면 지난 세대가 남아 다음 실행의 화해가 진입도 못 하는데,
            //    안내는 「다시 실행하면 정리합니다」라고 약속한다 — 그 약속이 거짓이 된다(심의 실측).
            const noted = await writeLedger(root, {...ledger, server: null, mine: attempted});
            throw responseLost(sent.error!, noted);
        }

        // ⚠ **상한이 두 군데다 — 일부러 그렇다.** 반복 조건이 경계이고, 이 줄은 **마지막 회전에서
        //   쓸데없는 재조회를 안 하려는** 것이다(선행조건 갈래는 여기서 서버를 다시 읽는다).
        //   한쪽만 빼도 관측 결과는 같다(변이 실측 — 둘 다 빼야 시험이 깨진다). 그래도 남기는 이유는
        //   빼면 **거절당할 것이 뻔한 회전에서 서버를 한 번 더 두드리기** 때문이다.
        if (round === MAX_PUSH_ATTEMPTS - 1) throw sent.error;

        if (sent.kind === "excluded") {
            // ⚠ **우리 계획에 있는 경로만 받는다.** 서버가 아무 문자열이나 주면 그것이 그대로
            //   사람에게 보고되고, 우리 출력이 남의 글이 된다(실측: `../../etc/passwd` 가 목록에 떴다).
            const named = sent.rejectedPaths.filter((path) => plan.edits.some((edit) => edit.path === path));
            if (named.length === 0) throw sent.error;
            dropped.push(...named);
            const kept = plan.edits.filter((edit) => !named.includes(edit.path));
            if (kept.length === 0) throw sent.error;
            report(`사이트가 받지 않는 경로 ${named.length}개를 빼고 다시 보냅니다…`);
            plan = {...plan, edits: kept};
            continue;
        }

        if (sent.kind === "conflict") {
            report("사이트 쪽이 그 사이 달라져 다시 읽습니다…");
            draft = await readDraft(options.api);
            const fresh = await hashWorkdir(root);
            plan = planPush({base: ledger.files, draft: viewOf(draft), local: fresh, mine: ownedBy(ledger, draft)});
            // ⚠ **가드를 다시 지난다.** 안 지나면 재시도가 곧 「받아 적고 다시 보내는」 세탁 경로다.
            requireSeen(plan, options);
            plan = {...plan, edits: plan.edits.filter((edit) => !dropped.includes(edit.path))};
            // ⚠ **보낸 뒤에 참이 된다.** 여기서 세우면 아래 조기 반환 갈래(보낼 것이 없어짐)에서도
            //   「다시 보냈습니다」가 찍히는데, 그 갈래에서는 **두 번째 요청이 안 나간다**(심의 실측).
            if (plan.edits.length === 0) {
                const written = await writeLedger(root, {
                    ...ledger,
                    server: draft.generation === null ? null : {generation: draft.generation},
                    mine: {},
                });
                return {
                    sent: 0,
                    removed: 0,
                    generation: draft.generation,
                    droppedByServer: dropped,
                    // 두 번째 요청이 안 나갔다 — 재계산은 했지만 **다시 보내지는 않았다.**
                    retriedAfterConflict: false,
                    reconciled,
                    previewUrl: null,
                    warning: written ? null : ledgerWriteFailed(0),
                };
            }
            retried = true;
            continue;
        }

        throw sent.error;
    }

    if (sent === null || sent.kind !== "ok") throw sent?.error ?? unreachable();

    // ⑹ 장부 갱신 — **이번에 보낸 경로 전체**를 그 세대 기준으로 다시 적는다.
    const mine: Record<string, string | null> = {};
    for (const edit of plan.edits) mine[edit.path] = edit.sha256;
    const written = await writeLedger(root, {
        ...ledger,
        server: sent.generation === null ? null : {generation: sent.generation},
        mine,
        pushedAt: new Date().toISOString(),
    });

    return {
        sent: plan.edits.length,
        removed: plan.edits.filter((edit) => edit.sha256 === null).length,
        generation: sent.generation,
        droppedByServer: dropped,
        retriedAfterConflict: retried,
        reconciled,
        previewUrl: sent.previewUrl,
        warning: written ? sent.warning : ledgerWriteFailed(plan.edits.length),
    };
}

/**
 * 장부를 못 썼을 때의 문면.
 *
 * ⚠ **올린 것이 있을 때만 「반영됐지만」이라 말한다.** 조기 반환 갈래는 `sent: 0` 이라 그 말이
 *   거짓이 된다 — 종전에는 「올릴 것이 없습니다」 바로 밑에 「올린 것은 반영됐지만」이 붙었다(심의 실측).
 */
const ledgerWriteFailed = (sent: number) =>
    sent > 0
        ? "올린 것은 사이트 쪽에 반영됐지만 이 폴더의 기준 기록을 쓰지 못했습니다. `zalkera baseline` 을 한 번 실행해 주세요."
        : "이 폴더의 기준 기록을 쓰지 못했습니다. `zalkera baseline` 을 한 번 실행해 주세요.";

/** 서버 편집 조회. **못 읽으면 올리지 않는다.** */
async function readDraft(api: ZalkeraApi): Promise<DraftFiles> {
    const draft = await api.draftFiles().catch(() => null);
    if (!draft) {
        throw new DevtoolsError(
            "SERVER_UNREADABLE_DRAFT",
            "지금 사이트 쪽 상태를 확인하지 못해 아무것도 올리지 않았습니다.",
            "잠시 뒤 다시 시도해 주세요.",
        );
    }
    if (draft.strandedOnOldRevision) {
        throw new DevtoolsError(
            "STRANDED_DRAFT",
            "사이트 쪽에서 편집 중이던 것이 지금 버전 위가 아니라 여기에 얹을 수 없습니다.",
            "콘솔에서 그 편집을 되돌린 뒤 다시 시도해 주세요. 되돌리기 전에 무엇이 들어 있었는지는 콘솔에서 볼 수 있습니다.",
        );
    }
    return draft;
}

const viewOf = (draft: DraftFiles): DraftView => ({changed: draft.changed, deleted: draft.deleted});

/**
 * 장부의 「내가 올린 것」이 **지금도 증언할 수 있는가.**
 *
 * 세대가 갈렸으면 그 기록은 지난 세계의 것이라 아무것도 못 말한다 — 빈 것을 넘긴다.
 * 형제 `syncStatus` 의 `mineValid` 와 **같은 규칙**이다(규칙이 둘이면 한쪽만 조여진다).
 */
function ownedBy(ledger: SyncLedger, draft: DraftFiles): Record<string, string | null> {
    const seen = ledger.server?.generation ?? null;
    return seen !== null && seen === (draft.generation ?? null) ? ledger.mine : {};
}

/** 지금 켜진 판. **못 읽으면 던진다** — 「모른다」를 「같다」로 바꾸지 않는다. */
async function activeRevisionNo(api: ZalkeraApi): Promise<number> {
    // ⚠ **상한을 걸지 않는다.** 형제 `fetchSource` 도 안 건다. 걸면 되돌리기 뒤에 새 판이 여럿
    //   쌓였을 때 **활성이 창 밖으로 밀려** 영구히 못 올리게 된다(심의 실측).
    const rows = await api.listRevisions().catch(() => null);
    if (rows === null) {
        throw new DevtoolsError(
            "SERVER_UNREADABLE_DRAFT",
            "지금 사이트에 켜져 있는 버전을 확인하지 못해 아무것도 올리지 않았습니다.",
            "잠시 뒤 다시 시도해 주세요. 계속 그러면 이 계정에 버전 목록을 볼 권한이 있는지 확인해 주세요.",
        );
    }
    const active = rows.find((row) => row.isActive)?.revisionNo;
    if (active === undefined) {
        // 서버는 답했는데 켜진 판이 없다 — 「잠시 뒤 다시」가 거짓인 상태다.
        throw new DevtoolsError(
            "SERVER_UNREADABLE_DRAFT",
            "이 사이트에 켜져 있는 버전이 없습니다.",
            "콘솔에서 어떤 버전을 켤지 먼저 정해 주세요. 그 전에는 무엇 위에 얹는 것인지 알 수 없어 올리지 않습니다.",
        );
    }
    return active;
}


/**
 * 지난 실행의 **응답 유실을 화해한다**(§2.3).
 *
 * 장부에 「내가 올린 것」은 있는데 세대가 「모름」이면, 지난 실행이 요청은 보냈고 응답을 못 받은 것이다.
 * 그 경로들이 서버 편집에 **그대로 있으면** 적용된 것이고, **없으면** 안 된 것이다.
 *
 * ⚠ **일부만 보이는 경우는 「적용됨」이 아니다.** 서버의 `applyEdits` 는 업로드 뒤 한 문장 CAS 라
 *   부분 적용이 없다 — 일부만 보이면 **그 사이 남이 고친 것**이므로 재계산 갈래로 간다(=「안 됨」).
 */
export function reconcile(ledger: SyncLedger, draft: DraftFiles): "applied" | "not-applied" | null {
    const paths = Object.keys(ledger.mine);
    if (ledger.server !== null || paths.length === 0) return null;
    const applied = paths.every((path) => {
        const expected = ledger.mine[path] ?? null;
        if (expected === null) return draft.deleted.includes(path);
        return draft.changed.some((row) => row.path === path && row.sha256 === expected);
    });
    return applied ? "applied" : "not-applied";
}

/** 안 본 편집을 되돌리게 되면 **거절이 기본**이다. */
function requireSeen(plan: PushPlan, options: PushOptions): void {
    if (plan.unseen.length === 0 || options.overwriteUnseen === true) return;
    const list = trimPaths(plan.unseen, PATH_LIST_CAP, options.listAll === true)
        .map((path) => `  · ${path}`)
        .join("\n");
    throw new DevtoolsError(
        "PUSH_WOULD_REVERT",
        `사이트 쪽에 이 폴더가 아직 못 받은 편집이 ${plan.unseen.length}개 있어 아무것도 올리지 않았습니다.\n${list}`,
        "`zalkera pull` 로 지금 버전을 받은 뒤 다시 올리거나, 그 편집을 콘솔에서 확인해 주세요. 그대로 올리면 그 편집이 사라집니다.",
    );
}

/**
 * **개수** 상한을 보내기 전에 잰다.
 *
 * ⚠ 크기 상한 둘(`MAX_PUSH_FILE_BYTES`·`MAX_PUSH_BYTES`)은 여기가 아니라 [bodyOf] 에 있다 —
 *   계획 단계는 sha 만 알고 **바이트 수를 모른다.** 세 상한을 한자리에 모으려면 계획 단계가
 *   파일을 다 읽어야 하는데, 그러면 개수 상한이 그 뒤에 걸려 읽기가 헛일이 된다.
 */
function requireWithinLimits(edits: readonly PushEdit[]): void {
    if (edits.length > MAX_PUSH_ENTRIES) {
        throw new DevtoolsError(
            "PUSH_TOO_LARGE",
            `한 번에 올릴 수 있는 파일은 ${MAX_PUSH_ENTRIES}개인데 ${edits.length}개입니다.`,
            "고친 것이 이만큼 많으면 편집이 아니라 새 소스입니다 — 콘솔에서 소스를 통째로 올리는 쪽이 맞습니다.",
        );
    }
}

/**
 * 한 번 보낸다. **재시도할 수 있는 거절은 던지지 않고 갈라 돌려준다** — 부르는 쪽이 정한다.
 *
 * ⚠ 재시도 판정을 여기 두면 상한이 자리마다 달라진다([MAX_PUSH_ATTEMPTS]).
 *
 * ⚠ **던지는 자리는 있다.** 다시 보내도 결과가 같을 것들이다:
 *   ⑴ [bodyOf] 의 크기 상한·이진 파일 거절·서식 비밀 거절 ⑵ `DevtoolsError` 가 아닌 예외
 *
 * ⚠ **응답 유실은 던지지 않는다** — `kind: "lost"` 로 돌려준다. 여기서 던지면 부르는 쪽이 장부에
 *   「모름」을 못 적고, 그러면 다음 실행의 화해가 아예 진입하지 못한다(그 결함을 실제로 겪었다).
 */
async function attempt(
    api: ZalkeraApi,
    root: string,
    edits: readonly PushEdit[],
    report: (message: string) => void,
): Promise<Attempt> {
    const body = await bodyOf(root, edits);
    try {
        const result = await api.editDraft(body);
        return {
            kind: "ok",
            generation: result.generation,
            // 🔴 **서버가 정한 문자열은 소독을 지난다.** 같은 응답의 오류 갈래는 이미 지나는데
            //    성공 갈래의 이 둘만 안 지났다 — 그리고 이 둘은 `stdout` 으로 나간다. 제어문자가
            //    살아 있으면 서버가 **커서를 올려 방금 찍은 줄을 지우고** 다른 문장을 앉힐 수 있다
            //    (심의 실측). `plainNotice` 가 제어문자를 걷는다.
            previewUrl: plainNotice(result.previewUrl ?? "", MAX_PREVIEW_URL) || null,
            warning: plainNotice(result.warning ?? "", MAX_WARNING) || null,
            rejectedPaths: [],
        };
    } catch (error) {
        if (!(error instanceof DevtoolsError)) throw error;
        // 응답을 못 받은 것은 **거절이 아니다.** 「모름」으로 끝내고 다음 실행이 화해한다.
        // 🔴 **여기서 던지면 부르는 쪽이 장부에 「모름」을 못 적는다.** 갈래로 돌려준다.
        if (error.code === "SERVER_UNREACHABLE") {
            return {kind: "lost", error, rejectedPaths: [], generation: null, previewUrl: null, warning: null};
        }
        // ⚠ **사유를 서버 코드로 가른다.** 종전에는 「경로가 실려 왔는가」로 갈랐는데, 경합
        //    (「기준 해시를 안 줬다」)도 경로를 싣는다 — 그것을 「배제」로 읽으면 그 파일이
        //    **조용히 빠진 채** 「올렸습니다」가 나간다(심의 실측).
        const kind =
            error.serverCode === "DRAFT_PRECONDITION_FAILED" || error.serverCode === SHAPE_STALE
                ? "conflict"
                : error.serverCode === PATH_NOT_ACCEPTED && error.paths.length > 0
                  ? "excluded"
                  : "other";
        if (kind === "conflict" && error.paths.length > 0) {
            report(`사이트 쪽이 달라진 파일 ${error.paths.length}개: ${trimPaths([...error.paths], 5).join(" · ")}`);
        }
        return {kind, error, rejectedPaths: [...error.paths], generation: null, previewUrl: null, warning: null};
    }
}

interface Attempt {
    kind: "ok" | "conflict" | "excluded" | "lost" | "other";
    generation: string | null;
    previewUrl: string | null;
    warning: string | null;
    rejectedPaths: string[];
    error?: DevtoolsError;
}

/**
 * 보낼 본문을 만든다 — 파일을 **여기서 읽는다**.
 *
 * ⚠ 크기 상한을 **읽는 자리에서** 잰다. 계획 단계는 sha 만 알고 크기를 모르며, 다 읽고 나서 재면
 *   16MiB 를 이미 램에 올린 뒤다.
 */
async function bodyOf(root: string, edits: readonly PushEdit[]): Promise<DraftEdit[]> {
    const body: DraftEdit[] = [];
    let total = 0;
    for (const edit of edits) {
        if (edit.sha256 === null) {
            body.push({path: edit.path, remove: true, ...(edit.baseSha256 === null ? {} : {baseSha256: edit.baseSha256})});
            continue;
        }
        // ⚠ **읽기 전에 잰다.** 다 읽고 나서 재면 상한이 「메모리 예산」으로는 전혀 안 선다 —
        //    300MB 파일 하나가 1MiB 상한에 걸려 거절되기까지 실측 VmHWM 423MB 였다(심의).
        //    그리고 2GiB 를 넘으면 `readFile` 이 먼저 `ERR_FS_FILE_TOO_LARGE` 로 죽어, 준비해 둔
        //    한국어 문면 대신 **영문 내부 오류**가 그대로 터미널에 나갔다.
        //    형제 `packProject` 는 이미 `stat` 으로 먼저 재고 있었다.
        const size = (await stat(join(root, edit.path))).size;
        if (size > MAX_PUSH_FILE_BYTES) {
            throw new DevtoolsError(
                "PUSH_TOO_LARGE",
                `파일 하나가 너무 큽니다: ${edit.path} (${Math.round(size / 1024)}KB · 상한 ${MAX_PUSH_FILE_BYTES / 1024}KB).`,
                "동영상·원본 이미지·빌드 산출물이 소스 폴더에 들어 있지 않은지 확인해 주세요.",
            );
        }
        // 원본 바이트로는 **거르기만** 한다 — 확실히 넘는 것을 읽기 전에 끊는다. 최종 판정은 아래
        // 직렬화 뒤에 한다(이스케이프 몫은 여기서 모른다).
        if (total + size > MAX_PUSH_BYTES) throw tooLarge();
        const raw = await readFile(join(root, edit.path));
        // 🔴 **이름만 서식인 비밀 파일을 안 보낸다.** `.env.example` 은 「값이 없다」는 전제로
        //    이름 예외를 받는데, 값이 들어 있으면 그 전제가 깨진 것이다. zip 레인은 이 문턱을
        //    이미 달고 있었고 이 레인만 없었다 — 같은 폴더가 한쪽으로는 막히고 한쪽으로는
        //    나갔다(심의 실측: `oqsk_` 라이브 키가 그대로 올라갔다).
        //
        //    ⚠ **여기서는 빼지 않고 거절한다.** zip 레인은 「묶는 김에 뺀다」라 빼고 이름을 대지만,
        //    올리기는 사람이 **그 파일을 고쳐서 부른 것**일 수 있다. 조용히 빼면 「올렸는데 안 바뀐다」가
        //    되고, 그 원인이 비밀이라는 사실은 아무 데도 안 보인다.
        const breach = templateBreach(basename(edit.path), raw);
        if (breach !== null) {
            throw new DevtoolsError(
                "PUSH_SECRET_TEMPLATE",
                `${edit.path} 에 실제 값이 들어 있어 올리지 않았습니다(${breach}).`,
                "`.env.example` 같은 서식 파일은 값을 비워 두어야 올라갑니다. 실제 값은 콘솔의 환경변수 화면에서 관리해 주세요.",
            );
        }
        // 🔴 **글자로 되돌아오지 않는 바이트는 보내지 않는다.** 이 문의 본문은 JSON 문자열이라
        //    `content` 가 UTF-8 로만 실린다 — 그림·글꼴 같은 이진 파일은 왕복하면서 **조용히
        //    망가진다**(실측: 10바이트 PNG 머리가 16바이트로 나갔다). 망가진 채 올라가면 사이트가
        //    깨진 이미지를 서빙하고, 원인은 아무 데도 안 보인다.
        //
        //    판정은 어림이 아니라 **실제 왕복 대조**다 — 「널 바이트가 있는가」 같은 어림은
        //    UTF-8 이 아닌 텍스트 인코딩(EUC-KR 주석이 든 옛 소스)을 놓친다.
        if (!Buffer.from(raw.toString("utf8"), "utf8").equals(raw)) {
            throw new DevtoolsError(
                "PUSH_NOT_TEXT",
                `글자 파일이 아니라 올릴 수 없습니다: ${edit.path}`,
                "이 방법은 글자로 된 파일만 다룹니다. 그림·글꼴·압축 파일이 바뀌었으면 콘솔에서 소스를 통째로 올려 주세요 — 그러면 그 파일들도 그대로 갑니다.",
            );
        }
        total += size;
        body.push({
            path: edit.path,
            content: raw.toString("utf8"),
            ...(edit.baseSha256 === null ? {} : {baseSha256: edit.baseSha256}),
        });
    }
    // 🔴 **실제 본문으로 잰다.** 여기서만 그 값을 알 수 있다 — 위의 누적은 원본 바이트라
    //    이스케이프 몫을 못 본다(심의 실측: 원본 3MiB → 본문 4.65MiB → 413).
    if (Buffer.byteLength(JSON.stringify({edits: body}), "utf8") > MAX_PUSH_BYTES) throw tooLarge();
    return body;
}

function tooLarge(): DevtoolsError {
    return new DevtoolsError(
        "PUSH_TOO_LARGE",
        `한 번에 올릴 수 있는 총량(${Math.round(MAX_PUSH_BYTES / 1024 / 1024 * 10) / 10}MB)을 넘었습니다.`,
        "나눠 보내면 사이트 쪽에 반쪽만 서는 상태가 생깁니다 — 콘솔에서 소스를 통째로 올려 주세요.",
    );
}

function responseLost(cause: DevtoolsError, noted: boolean): DevtoolsError {
    return new DevtoolsError(
        "PUSH_RESPONSE_LOST",
        "올렸는지 확인하지 못했습니다.",
        noted
            ? "콘솔의 「편집 중」에서 지금 걸려 있는 내용을 먼저 봐 주세요. 다음에 다시 실행하면 이 도구가 사이트 쪽과 대조해 정리합니다."
            : "콘솔의 「편집 중」에서 지금 걸려 있는 내용을 봐 주세요. 이 폴더의 기준 기록을 쓰지 못해 다음 실행이 자동으로 정리하지는 못합니다.",
        cause,
    );
}

const ledgerUnknown = () =>
    new DevtoolsError(
        "LEDGER_UNKNOWN",
        "이 폴더에 기준 기록이 없어 무엇이 달라졌는지 셀 수 없습니다.",
        "`zalkera baseline` 을 실행하면 지금 버전을 기준으로 다시 세웁니다. 폴더의 파일은 건드리지 않습니다.",
    );

const foreignLedger = (tenant: string) =>
    new DevtoolsError(
        "LEDGER_UNKNOWN",
        `이 폴더의 기준 기록은 다른 사이트(${tenant})의 것입니다.`,
        "`zalkera pull` 로 이 사이트의 소스를 받거나, `zalkera baseline` 으로 기준을 다시 세워 주세요.",
    );

/** 반복문이 상한 안에서 반드시 `ok` 로 끝나거나 던지므로 여기 오지 않는다. */
function unreachable(): DevtoolsError {
    return new DevtoolsError("SERVER_REJECTED", "올리기가 끝나지 않았습니다.", "다시 시도해 주세요.");
}

/**
 * 기준 판이 움직였다 — **올리기 전에 받아야 한다.**
 *
 * ⚠ 사실만 적고 끊지 않는다(§2.9). 「기준이 12에서 14로 움직였습니다」로 끝내면 사람은 다음 걸음을
 *   못 찾고, 그 자리에서 폴더를 지우고 다시 받는 길을 스스로 만들어 낸다.
 *
 * ⚠ **막는 이유는 값이 낡아서다.** 판이 움직이면 이 폴더의 기준 매니페스트가 낡고, 그 위에서
 *   「보낼 것이 없다」가 나오면 그것은 「같다」가 아니라 **모른다**이다.
 */
function baseMoved(mine: number, now: number, dirty: number): DevtoolsError {
    // ⚠ **`zalkera baseline` 을 여기서 대지 않는다.** 그것은 장부만 새 판으로 바꿔 놓는데, 폴더
    //   내용은 옛 판 그대로다 — 그 뒤의 `push` 는 **새 판과 다른 것을 전부** 보낸다(내가 만진 적
    //   없는 것까지). 실측: 만진 것 1개 · 나간 것 4개.
    const way =
        dirty === 0
            ? `이 폴더를 ${now}판에 맞추려면 \`zalkera pull\` 을 실행하세요.`
            : `이 폴더에서 고친 것이 ${dirty}개 있어 \`zalkera pull\` 도 그대로는 막힙니다. ` +
              "`zalkera pull --discard-local` 을 실행하면 고친 파일을 옆 폴더에 옮겨 두고 새 판을 받습니다 — " +
              "그 뒤 옮겨 둔 파일을 보고 다시 고쳐 올리시면 됩니다.";
    return new DevtoolsError(
        "PUSH_BASE_MOVED",
        `기준이 ${mine}판에서 ${now}판으로 움직여 아무것도 올리지 않았습니다.`,
        `${way} 지금 올리면 ${mine}판을 보고 고친 내용이 ${now}판 위에 얹힙니다.`,
    );
}
