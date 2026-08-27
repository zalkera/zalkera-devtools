/**
 * **pull 이 무엇을 할지 정하는 순수 판정**(memo184 §2.2) — 파일시스템을 안 만진다.
 *
 * ■ 왜 「겹치지 않는 경로는 무간섭」이 틀렸나 (🔴2)
 *
 * 초안은 그렇게 적었고, 그러면 **서버가 지운 파일이 로컬에 남는다.** 그 뒤가 조용해서 무섭다:
 * 다음 push 에서 그 경로는 판에도 드래프트에도 없으니 `effective = null` → **신설로 판정** →
 * 서버도 `shaOf = null` → **정당하게 통과** → 지운 파일이 부활한다.
 * 선행조건(CAS)은 「지금 값이 내가 읽은 값인가」만 묻지 **「이 파일이 지워진 적이 있는가」를 안 묻는다.**
 * 그래서 **pull 의 삭제 전파가 유일한 방어**다.
 *
 * ⇒ 「무간섭」은 **어느 매니페스트에도 없던 순수 로컬 파일**로 좁아진다.
 *
 * ■ 병합이 아니다
 *
 * 삭제 전파는 3방향 비교가 아니라 **「서버가 지운 것을 로컬에서도 지운다」는 단방향 전파**다.
 * 병합 기계는 여전히 안 짓는다(memo183·184 DON'T-BUILD).
 *
 * ■ 관용 1 — 멱등 재실행
 *
 * 더러움 판정에서 **로컬 sha == 받을 sha 면 충돌이 아니다.** 이것이 없으면 중단된 pull 이 남긴
 * 「이미 옮겨 놓은 파일」이 다음 실행에서 **자기 잔해로 스스로를 막는다.**
 */

import type {LedgerFile} from "./syncLedger.ts";

/** 로컬 작업본의 한 파일. 없으면 목록에서 빠진다(빈 문자열을 쓰지 않는다 — 「없다」와 안 갈리게). */
export interface LocalFile {
    sha256: string;
}

export interface PullInput {
    /** 받을 판의 매니페스트 `N`. */
    incoming: Record<string, LedgerFile>;
    /** 장부가 아는 판의 매니페스트 `O` — **판의 진실**이지 로컬 상태가 아니다. */
    ledger: Record<string, LedgerFile>;
    /** 지금 작업본. 장부·매니페스트에 없는 순수 로컬 파일도 여기 들어온다. */
    local: Record<string, LocalFile>;
}

export interface PullPlan {
    /** 서버가 지웠다 — 로컬에서도 지운다. */
    deletes: string[];
    /** 덮어쓰거나 새로 쓴다. */
    writes: string[];
    /** 이미 같다 — 안 건드린다. */
    unchanged: string[];
    /** 어느 매니페스트에도 없던 **순수 로컬** — 무간섭. */
    untracked: string[];
    /** 로컬이 장부와 달라 덮으면 잃는다. 비지 않으면 **거절이 기본**이다. */
    conflicts: Conflict[];
}

/** 충돌 하나. [reason] 은 사람에게 무엇을 잃는지 말하는 자리다. */
export interface Conflict {
    path: string;
    reason: "modified" | "deleted-locally" | "added-locally";
}

/**
 * 세 집합으로 가른다.
 *
 * ⚠ **로컬이 장부와 같은가**가 「깨끗함」의 정의다. 받을 내용과 같은가가 아니다 — 그것으로 재면
 *   내가 고친 것과 서버가 고친 것이 우연히 같을 때만 통과하는, 뜻을 알 수 없는 규칙이 된다.
 *   다만 **관용 1**(로컬 == 받을 내용)은 예외다: 그때 덮어써도 잃을 것이 없다.
 */
export function planPull(input: PullInput): PullPlan {
    const {incoming, ledger, local} = input;
    const plan: PullPlan = {deletes: [], writes: [], unchanged: [], untracked: [], conflicts: []};

    for (const [path, known] of Object.entries(ledger)) {
        const here = local[path];
        const next = incoming[path];
        const clean = here !== undefined && here.sha256 === known.sha256;

        if (next === undefined) {
            // 추적 삭제 — 서버가 지웠다.
            if (here === undefined) continue; // 이미 없다. 멱등.
            if (clean) plan.deletes.push(path);
            else plan.conflicts.push({path, reason: "modified"});
            continue;
        }
        if (here === undefined) {
            // 장부엔 있는데 로컬에 없다 — 사람이 지웠다. 덮어쓰면 그 삭제가 사라진다.
            // 서버가 바꿨든 안 바꿨든 **사람이 지운 것을 되살리는 것**이라 충돌이다.
            plan.conflicts.push({path, reason: "deleted-locally"});
            continue;
        }
        if (next.sha256 === known.sha256) {
            // 추적 동일 — 서버가 안 바꿨다.
            if (clean) plan.unchanged.push(path);
            else plan.conflicts.push({path, reason: "modified"});
            continue;
        }
        // 추적 변경 — 서버가 바꿨다.
        if (clean || here.sha256 === next.sha256) plan.writes.push(path);
        else plan.conflicts.push({path, reason: "modified"});
    }

    for (const [path, next] of Object.entries(incoming)) {
        if (ledger[path] !== undefined) continue;
        const here = local[path];
        if (here === undefined) {
            plan.writes.push(path); // 추적 신설.
            continue;
        }
        // 추적 신설 충돌 — 로컬에 같은 이름이 이미 있다. 관용 1 이면 통과.
        if (here.sha256 === next.sha256) plan.unchanged.push(path);
        else plan.conflicts.push({path, reason: "added-locally"});
    }

    for (const path of Object.keys(local)) {
        if (ledger[path] === undefined && incoming[path] === undefined) plan.untracked.push(path);
    }

    plan.deletes.sort();
    plan.writes.sort();
    plan.unchanged.sort();
    plan.untracked.sort();
    plan.conflicts.sort((a, b) => a.path.localeCompare(b.path));
    return plan;
}

/**
 * `--discard-local` 로 충돌을 치운 **뒤에** 무엇을 적용해야 하는가.
 *
 * 🔴 치워 두기만 하면 그 경로는 **아무것도 안 남는다.** 로컬 파일은 옆 폴더로 갔고 계획의 `writes`
 *    에는 그 경로가 없다(충돌로 갈렸으니까) — 「서버 것으로 받았다」고 말해 놓고 파일이 사라진다.
 *    실측으로 잡힌 결함이다.
 *
 * 처분은 **받을 매니페스트가 정한다**:
 * - 받을 것이 있으면 → 쓴다(치운 자리에 서버 내용이 들어온다).
 * - 받을 것이 없으면 → 지운다(서버가 지운 경로다. 치우면서 이미 없어졌지만, 지우기는 없는 것을
 *   관용하므로 목록에 남겨 두는 편이 「무엇을 했나」를 정직하게 센다).
 */
export function applyAfterDiscard(
    plan: PullPlan,
    incoming: Readonly<Record<string, {sha256: string}>>,
): {writes: string[]; deletes: string[]} {
    const writes = [...plan.writes];
    const deletes = [...plan.deletes];
    for (const conflict of plan.conflicts) {
        if (incoming[conflict.path] !== undefined) writes.push(conflict.path);
        else deletes.push(conflict.path);
    }
    return {writes: writes.sort(), deletes: deletes.sort()};
}

/**
 * 경로 목록을 사람에게 보일 만큼 줄인다(memo184 §2.9).
 *
 * ⚠ **「외 N개」가 붙는 자리는 여기 하나여야 한다.** 종전에는 CLI 의 보고 쪽과 코어의 거절 문면이
 *   각자 잘랐고, 사용자는 그 둘을 **같은 터미널에서** 봤다 — 상한이 갈리면 같은 목록이 자리마다
 *   다르게 잘린다.
 */
export const PATH_LIST_CAP = 10;

export function trimPaths(paths: readonly string[], cap = PATH_LIST_CAP, all = false): string[] {
    if (all || paths.length <= cap) return [...paths];
    return [...paths.slice(0, cap), `외 ${paths.length - cap}개`];
}
