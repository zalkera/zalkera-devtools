/**
 * **올리기** — 작업본의 변경을 사이트 쪽 「편집 중인 것」에 얹는다(memo184 §2.3 · T2).
 *
 * ■ 순서가 계약이다
 *
 * ⑴ 장부를 읽는다 → ⑵ **서버 편집을 조회한다** → ⑶ 작업본을 해시한다 → ⑷ 무엇을 보낼지 정한다 →
 * ⑸ **한 번의 배치 요청** → ⑹ 장부를 갱신한다.
 *
 * ⚠ **⑵를 못 하면 올리지 않는다.** 장부로 폴백하는 순간 🔴1 이 되살아난다 — 남이 콘솔에서 되돌린
 *   뒤에도 「이미 반영됨」이라 답하는 거짓 성공이다. 선행조건의 정본은 **서버 조회**다.
 *
 * ⚠ **나눠 보내지 않는다.** 파일마다 따로 부르면 드래프트 세대가 N 개 생기고, 그 중간 세대가 다른
 *   문(발행·되돌리기)의 대상이 될 수 있다 — 의도한 변경의 **반쪽이 원장에 영구히 서는** 형상이다.
 *   상한을 넘으면 분할이 아니라 **거절**이고, 그때 길은 zip 레인이다.
 *
 * ■ 재시도는 **한 번**이고, 그때도 가드를 다시 지난다
 *
 * 선행조건이 어긋나면 서버를 다시 읽고 한 번만 다시 보낸다. 그 재계산에도 [PushPlan.unseen] 가드가
 * **그대로** 걸린다 — 안 그러면 재시도가 「받아 적고 다시 보내는」 세탁 경로가 된다(memo183 🟠4).
 *
 * ■ 응답을 못 받으면 「모름」이다
 *
 * **「아마 올라갔을 겁니다」라고 말하지 않는다.** 세대를 모름으로 두고 끝내고, 다음 실행이
 * `GET /draft/files` 로 화해한다([reconcile]).
 */
import {readFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import type {DraftEdit, DraftFiles, ZalkeraApi} from "./api.ts";
import {DevtoolsError} from "./errors.ts";
import {readLedger, writeLedger} from "./pull.ts";
import {PATH_LIST_CAP, trimPaths} from "./pullPlan.ts";
import {planPush, type DraftView, type PushEdit, type PushPlan} from "./pushPlan.ts";
import {SYNC_LEDGER_FORMAT, type SyncLedger} from "./syncLedger.ts";
import {hashWorkdir} from "./workdir.ts";

/**
 * 상한 셋. **서버 값과 같은 수**다(`SiteDraftService` 의 `MAX_DRAFT_ENTRIES`·`MAX_FILE_BYTES`·
 * `MAX_DRAFT_BYTES`).
 *
 * ⚠ 여기서 먼저 재는 이유는 **왕복을 아끼려는 것이 아니다.** 16MiB 를 실어 보내고 거절당하면 그
 *   바이트가 이미 회선을 지났고, 상용 파트너 평면의 본문 상한 필터가 그것을 세고 있다. 그리고
 *   거절 문면이 「무엇을 하라」를 말하려면 **어느 파일이 큰지** 알아야 하는데, 그것은 여기만 안다.
 * ⚠ 서버가 값을 바꾸면 여기가 낡는다. 낡으면 **우리 쪽이 더 좁아** 정상 요청을 막거나, 더 넓어
 *   서버가 거절한다 — 둘 다 서버 문면이 최종 판정이므로 조용한 오작동은 아니다.
 */
export const MAX_PUSH_ENTRIES = 500;
export const MAX_PUSH_FILE_BYTES = 1024 * 1024;
export const MAX_PUSH_BYTES = 16 * 1024 * 1024;

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
    /** 실제로 보낸 편집 수. 0 이면 이미 반영돼 있었다. */
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
    const reconciled = reconcile(ledger, draft);

    const local = await hashWorkdir(root);
    let plan = planPush({base: ledger.files, draft: viewOf(draft), local});
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
            warning: written ? null : LEDGER_WRITE_FAILED,
        };
    }

    requireWithinLimits(root, plan.edits);
    report(`${plan.edits.length}개를 올리는 중입니다…`);

    let dropped: string[] = [];
    let retried = false;
    let sent = await attempt(options.api, root, plan.edits, ledger, report);

    // ── 배제 목록 드리프트 — 그 경로만 빼고 **1회** 재시도하고 **말한다**(§2.8) ──
    if (sent.rejectedPaths.length > 0 && sent.kind === "excluded") {
        dropped = sent.rejectedPaths;
        const kept = plan.edits.filter((edit) => !dropped.includes(edit.path));
        if (kept.length === 0) throw sent.error;
        report(`사이트가 받지 않는 경로 ${dropped.length}개를 빼고 다시 보냅니다…`);
        sent = await attempt(options.api, root, kept, ledger, report);
        plan = {...plan, edits: kept};
    }

    // ── 선행조건 어긋남 — 서버를 **다시 읽고** 재계산해 1회 재시도 ──
    if (sent.kind === "conflict") {
        report("사이트 쪽이 그 사이 달라져 다시 읽습니다…");
        draft = await readDraft(options.api);
        const fresh = await hashWorkdir(root);
        plan = planPush({base: ledger.files, draft: viewOf(draft), local: fresh});
        // ⚠ **가드를 다시 지난다.** 안 지나면 재시도가 곧 「받아 적고 다시 보내는」 세탁 경로다.
        requireSeen(plan, options);
        const kept = plan.edits.filter((edit) => !dropped.includes(edit.path));
        if (kept.length === 0) {
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
                retriedAfterConflict: true,
                reconciled,
                previewUrl: null,
                warning: written ? null : LEDGER_WRITE_FAILED,
            };
        }
        retried = true;
        requireWithinLimits(root, kept);
        sent = await attempt(options.api, root, kept, ledger, report);
        plan = {...plan, edits: kept};
    }

    if (sent.kind !== "ok") throw sent.error;

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
        warning: written ? sent.warning : LEDGER_WRITE_FAILED,
    };
}

const LEDGER_WRITE_FAILED =
    "올린 것은 사이트 쪽에 반영됐지만 이 폴더의 기준 기록을 쓰지 못했습니다. `zalkera baseline` 을 한 번 실행해 주세요.";

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

/** 상한 셋을 **보내기 전에** 잰다. 어느 파일이 걸렸는지 말한다. */
function requireWithinLimits(root: string, edits: readonly PushEdit[]): void {
    if (edits.length > MAX_PUSH_ENTRIES) {
        throw new DevtoolsError(
            "PUSH_TOO_LARGE",
            `한 번에 올릴 수 있는 파일은 ${MAX_PUSH_ENTRIES}개인데 ${edits.length}개입니다.`,
            "고친 것이 이만큼 많으면 편집이 아니라 새 소스입니다 — 콘솔에서 소스를 통째로 올리는 쪽이 맞습니다.",
        );
    }
}

/**
 * 한 번 보낸다. **던지지 않고** 결과를 갈라 돌려준다 — 부르는 쪽이 재시도를 정한다.
 *
 * ⚠ 재시도 판정을 여기 두면 「1회」가 자리마다 달라진다.
 */
async function attempt(
    api: ZalkeraApi,
    root: string,
    edits: readonly PushEdit[],
    ledger: SyncLedger,
    report: (message: string) => void,
): Promise<Attempt> {
    const body = await bodyOf(root, edits);
    try {
        const result = await api.editDraft(body);
        return {
            kind: "ok",
            generation: result.generation,
            previewUrl: result.previewUrl,
            warning: result.warning,
            rejectedPaths: [],
        };
    } catch (error) {
        if (!(error instanceof DevtoolsError)) throw error;
        // 응답을 못 받은 것은 **거절이 아니다.** 「모름」으로 끝내고 다음 실행이 화해한다.
        if (error.code === "SERVER_UNREACHABLE") throw responseLost(error);
        const kind =
            error.serverCode === "DRAFT_PRECONDITION_FAILED"
                ? "conflict"
                : error.serverCode === "INVALID_INPUT_VALUE" && error.paths.length > 0
                  ? "excluded"
                  : "other";
        if (kind === "conflict" && error.paths.length > 0) {
            report(`사이트 쪽이 달라진 파일 ${error.paths.length}개: ${trimPaths([...error.paths], 5).join(" · ")}`);
        }
        return {kind, error, rejectedPaths: [...error.paths], generation: null, previewUrl: null, warning: null};
    }
}

interface Attempt {
    kind: "ok" | "conflict" | "excluded" | "other";
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
        const raw = await readFile(join(root, edit.path));
        if (raw.byteLength > MAX_PUSH_FILE_BYTES) {
            throw new DevtoolsError(
                "PUSH_TOO_LARGE",
                `파일 하나가 너무 큽니다: ${edit.path} (${Math.round(raw.byteLength / 1024)}KB · 상한 ${MAX_PUSH_FILE_BYTES / 1024}KB).`,
                "동영상·원본 이미지·빌드 산출물이 소스 폴더에 들어 있지 않은지 확인해 주세요.",
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
        total += raw.byteLength;
        if (total > MAX_PUSH_BYTES) {
            throw new DevtoolsError(
                "PUSH_TOO_LARGE",
                `한 번에 올릴 수 있는 총량(${MAX_PUSH_BYTES / 1024 / 1024}MB)을 넘었습니다.`,
                "나눠 보내면 사이트 쪽에 반쪽만 서는 상태가 생깁니다 — 콘솔에서 소스를 통째로 올려 주세요.",
            );
        }
        body.push({
            path: edit.path,
            content: raw.toString("utf8"),
            ...(edit.baseSha256 === null ? {} : {baseSha256: edit.baseSha256}),
        });
    }
    return body;
}

function responseLost(cause: DevtoolsError): DevtoolsError {
    return new DevtoolsError(
        "PUSH_RESPONSE_LOST",
        "올렸는지 확인하지 못했습니다.",
        "콘솔의 「편집 중」에서 지금 걸려 있는 내용을 먼저 봐 주세요. 다음에 다시 실행하면 이 도구가 사이트 쪽과 대조해 정리합니다.",
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
