/**
 * **지금 상태를 말하는 자리**(memo184 §2.1 전이표 · T1) — 순수 판정. 네트워크도 파일시스템도 안 만진다.
 *
 * ■ 이 조각이 존재하는 이유는 「이미 반영됨」을 **함부로 말하지 않기 위해서**다
 *
 * 🔴1 은 여기서 났다: 장부의 `mine` 만 보고 「작업본 == 내가 올린 것」이면 「반영됨」이라 답했는데,
 * 그 사이 남이 콘솔에서 되돌리면 서버에는 아무것도 없다. 그래서 **서버 조회 결과**를 받아 대조하고,
 * 세대가 갈렸으면 `mine` 을 **무효로 본다.**
 *
 * ⚠ `server.generation` 이 다르다는 것은 「남이 고쳤다」·「내 것이 사라졌다」·「내가 올린 뒤 남이 더
 *   얹었다」를 **구별하지 못한다.** 구별은 경로·sha 대조가 한다. 세대 하나로 구별한다고 적지 않는다.
 */
import type {DraftFiles} from "./api.ts";
import type {SyncLedger} from "./syncLedger.ts";
import type {WorkdirManifest} from "./workdir.ts";

export interface SyncStatusInput {
    /** 로컬 장부. 없거나 깨졌으면 `null`. */
    ledger: SyncLedger | null;
    /** 작업본 매니페스트. */
    local: WorkdirManifest;
    /** `GET /draft/files` 응답. **못 읽었으면 `null`** — 「없다」와 갈린다. */
    draft: DraftFiles | null;
    /** 서버 원장의 지금 활성 판. 못 읽었으면 `null`. */
    activeRevisionNo: number | null;
}

export type SyncBlocker =
    /** 장부가 없거나 깨졌다 — `push`·`publish` 를 막는다. 복구는 `baseline`. */
    | "LEDGER_UNKNOWN"
    /** 서버 상태를 못 읽었다 — 선행조건을 세울 수 없어 `push` 를 막는다. */
    | "SERVER_UNREADABLE"
    /** 편집이 지금 판 위가 아니다 — 발행·열람이 막혀 있고 되돌리기만 남는다. */
    | "STRANDED";

export interface SyncStatus {
    tenant: string | null;
    /** 이 폴더가 선 판. 모르면 `null`. */
    baseRevisionNo: number | null;
    activeRevisionNo: number | null;
    /**
     * 서버가 이 폴더보다 앞서 있는가. 참이면 **받기부터** 하라고 말한다.
     *
     * ⚠ 사실만 적고 끊지 않는다 — 다음에 할 일이 문면에 있어야 한다(§2.9).
     */
    behind: boolean;
    /** 작업본에서 고친 것(장부의 판 기준). */
    changed: string[];
    /** 작업본에서 지운 것. */
    removed: string[];
    /** 작업본에 새로 생긴, 판에도 편집에도 없는 것. */
    added: string[];
    /** 서버 편집이 담고 있는 경로 수. 편집이 없으면 0. */
    draftPaths: number;
    /**
     * 장부의 `mine` 이 지금도 유효한가. 세대가 갈렸으면 거짓이고, 그때 `mine` 은 **아무 말도 못 한다.**
     */
    mineValid: boolean;
    blockers: SyncBlocker[];
}

/** 상태를 낸다. 입력이 모자라면 **모른다고 말한다** — 추정해서 메우지 않는다. */
export function syncStatus(input: SyncStatusInput): SyncStatus {
    const {ledger, local, draft, activeRevisionNo} = input;
    const blockers: SyncBlocker[] = [];
    if (!ledger) blockers.push("LEDGER_UNKNOWN");
    if (!draft) blockers.push("SERVER_UNREADABLE");
    if (draft?.strandedOnOldRevision) blockers.push("STRANDED");

    const base = ledger?.files ?? {};
    const changed: string[] = [];
    const removed: string[] = [];
    const added: string[] = [];
    for (const [path, known] of Object.entries(base)) {
        const here = local[path];
        if (here === undefined) removed.push(path);
        else if (here.sha256 !== known.sha256) changed.push(path);
    }
    for (const path of Object.keys(local)) {
        if (base[path] === undefined) added.push(path);
    }

    // 세대 대조. 장부가 본 세대와 서버가 지금 말하는 세대가 같아야 `mine` 이 무언가를 뜻한다.
    const seen = ledger?.server?.generation ?? null;
    const now = draft?.generation ?? null;
    const mineValid = draft !== null && seen !== null && seen === now;

    const baseRevisionNo = ledger?.base.revisionNo ?? null;
    return {
        tenant: ledger?.tenant ?? null,
        baseRevisionNo,
        activeRevisionNo,
        behind:
            baseRevisionNo !== null && activeRevisionNo !== null && activeRevisionNo > baseRevisionNo,
        changed: changed.sort(),
        removed: removed.sort(),
        added: added.sort(),
        draftPaths: (draft?.changed.length ?? 0) + (draft?.deleted.length ?? 0),
        mineValid,
        blockers,
    };
}

/**
 * 상태를 본 결과 **장부를 고쳐야 하는가**(§2.1 전이표 — `status` 행). 고칠 것이 없으면 `null`.
 *
 * ■ 무엇을 고치나
 *
 * 장부가 본 서버 세대와 지금 서버가 말하는 세대가 **갈렸으면**, 그 장부의 `server`·`mine` 은 지난
 * 세계의 기록이다. 그대로 두면 뒤 트랜치의 좌초 안내(§2.5)와 응답 유실 화해(§2.3)가 **없는 소유를
 * 근거로** 판정한다. 그래서 둘을 비운다.
 *
 * ⚠ **세대를 지금 값으로 갈아 적지 않고 `null` 로 둔다.** `null` 은 「다음에 서버에 다시 물어라」는
 *   뜻이다. 지금 값을 적으면 「내가 이 세대를 확인했다」가 되는데, 확인한 것은 세대뿐이고 그 세대에
 *   무엇이 들었는지가 아니다 — 그 둘을 뭉치는 것이 🔴1 의 뿌리였다.
 *
 * ⚠ **서버를 못 읽었으면 아무것도 안 고친다.** 「못 물어봤다」는 「갈렸다」가 아니다. 못 읽었다고
 *   장부를 비우면 네트워크가 잠깐 끊긴 것만으로 소유 기록이 사라진다.
 */
export function ledgerCorrection(ledger: SyncLedger | null, draft: DraftFiles | null): SyncLedger | null {
    if (!ledger || !draft) return null;
    const seen = ledger.server?.generation ?? null;
    if (seen === (draft.generation ?? null)) return null;
    if (seen === null && Object.keys(ledger.mine).length === 0) return null;
    return {...ledger, server: null, mine: {}};
}
