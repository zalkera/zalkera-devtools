/**
 * **올리기가 무엇을 보낼지 정하는 순수 판정**(memo184 §2.3) — 파일시스템도 네트워크도 안 만진다.
 *
 * ■ 선행조건의 정본은 **서버 조회**다 — 장부가 아니다 (🔴1)
 *
 * 각 경로의 「내가 읽은 값」은 이렇게 정해진다:
 *
 * ```
 * effective(path) =
 *   서버 편집이 그 경로를 지웠으면   → null
 *   서버 편집이 그 경로를 썼으면     → 그 sha
 *   아니면 판(base) 매니페스트의 sha → 있으면 그 sha
 *   아무 데도 없으면                → null (신설)
 * ```
 *
 * 이 세 줄은 서버 `DraftOverlay.shaOf` **와 같은 규칙**이다. 로컬이 추정하지 않고 서버에서 읽어 온다.
 *
 * ⚠ **장부의 `mine` 은 여기 안 쓰인다.** 초안은 그 칸으로 「이미 올렸다」를 판정했고, 그것이 🔴1 의
 *   뿌리다 — 남이 콘솔에서 되돌리면 서버에는 아무것도 없는데 장부만 보고 「이미 반영됨」이라 답했다.
 *
 * ■ 「이미 반영됨」은 **서버 조회 결과와 작업본이 같을 때만** 말한다
 *
 * 보낼 것이 하나도 없다는 판정은 여기서 나오고, 그 입력은 전부 서버가 준 것이다.
 */
import type {LedgerFile} from "./syncLedger.ts";
import type {WorkdirManifest} from "./workdir.ts";

/** 서버가 말하는 「지금 편집 중인 것」. `GET /draft/files` 응답에서 온다. */
export interface DraftView {
    /** 편집이 바꿔 놓은 경로와 그 sha. */
    changed: ReadonlyArray<{path: string; sha256: string}>;
    /** 편집이 지운 경로. */
    deleted: readonly string[];
}

export interface PushInput {
    /** 판(base) 매니페스트 — 장부의 `files`. **판의 진실**이다. */
    base: Readonly<Record<string, LedgerFile>>;
    /** 서버 편집. **못 읽었으면 부르면 안 된다** — 부르는 쪽이 먼저 거절한다. */
    draft: DraftView;
    /** 지금 작업본. */
    local: WorkdirManifest;
    /**
     * **내가 이 세대에 올린 것**(장부의 `mine`). 값이 `null` 이면 내가 올린 삭제다.
     *
     * ⚠ **선행조건 계산에 안 쓴다** — 그것이 🔴1 의 뿌리다. 여기 쓰이는 자리는 하나뿐이고,
     *   그것은 [PushPlan.unseen] 의 **소유 판정**이다(§2.5 좌초 소유 판정과 같은 성질).
     * ⚠ **세대가 갈렸으면 넘기지 마라.** 지난 세계의 기록이라 아무것도 못 말한다 — 부르는 쪽이
     *   그때 빈 객체를 넘긴다(`syncStatus` 의 `mineValid` 와 같은 규칙).
     * ⚠ 생략하면 **소유를 아무것도 주장하지 않는다.** 빠뜨렸을 때 더 막는 쪽으로 기울게 한 것이다 —
     *   반대로 두면 잊는 순간 남의 편집이 조용히 덮인다.
     */
    mine?: Readonly<Record<string, string | null>>;
}

/** 보낼 편집 하나. [sha256] 이 `null` 이면 **지우는 것**이다. */
export interface PushEdit {
    path: string;
    /** 올릴 내용의 sha. 삭제면 `null`. */
    sha256: string | null;
    /**
     * 선행조건 — 「내가 읽은 그 내용 위에 얹는다」. 신설이면 `null`.
     *
     * ⚠ **서버 조회에서 나온 값이다.** 장부에서 꺼내면 🔴1 이 되살아난다.
     */
    baseSha256: string | null;
}

export interface PushPlan {
    /** 서버에 보낼 편집들. 비어 있으면 **이미 반영된 것**이다. */
    edits: PushEdit[];
    /**
     * 🔴 **내가 안 본 남의 편집을 덮게 되는 경로들.**
     *
     * 판정은 「서버 편집이 이 경로를 건드렸는데, 내 작업본이 **그 내용이 아니다**」다. 내가 그
     * 내용을 들고 있다는 증거는 sha 일치 하나뿐이고, 받기는 **판**을 받지 편집을 받지 않는다.
     *
     * ⚠ **선행조건이 이것을 못 막는다.** 내 `baseSha256` 은 서버 조회에서 나오므로 CAS 는
     *   **정당하게 통과**하고, 남이 콘솔에서 고쳐 둔 것이 조용히 판 값으로 되돌아간다.
     *   「지금 값이 내가 읽은 값인가」만 묻지 「내가 그 값을 본 적이 있는가」를 안 묻는다 —
     *   받기의 삭제 전파와 같은 구조의 구멍이다.
     *
     * 그래서 부르는 쪽은 **거절이 기본**이고, 명시 동의가 있을 때만 넘어간다.
     */
    unseen: string[];
}

/**
 * 각 경로의 「지금 값」. 서버 `DraftOverlay.shaOf` 와 **같은 세 줄**이다.
 *
 * ⚠ 이 함수가 이 파일에서 유일하게 선행조건을 정한다. 자리를 늘리면 한쪽만 고쳐진다.
 */
export function effectiveSha(
    base: Readonly<Record<string, LedgerFile>>,
    draft: DraftView,
    path: string,
): string | null {
    if (draft.deleted.includes(path)) return null;
    const written = draft.changed.find((row) => row.path === path);
    if (written) return written.sha256;
    return base[path]?.sha256 ?? null;
}

/** 무엇을 보낼지 정한다. */
export function planPush(input: PushInput): PushPlan {
    const {base, draft, local} = input;
    const mine = input.mine ?? {};
    const edits: PushEdit[] = [];
    const unseen: string[] = [];

    // 서버가 아는 모든 경로 ∪ 작업본의 모든 경로. 어느 한쪽에만 있어도 처분이 있다.
    const paths = new Set<string>([
        ...Object.keys(base),
        ...draft.changed.map((row) => row.path),
        ...draft.deleted,
        ...Object.keys(local),
    ]);

    for (const path of [...paths].sort()) {
        const now = effectiveSha(base, draft, path);
        const here = local[path]?.sha256 ?? null;
        if (here === now) continue;
        if (here === null) {
            // 서버에는 있는데 작업본에 없다 — 내가 지운 것이다.
            edits.push({path, sha256: null, baseSha256: now});
            continue;
        }
        edits.push({path, sha256: here, baseSha256: now});
    }

    // 🔴 **안 본 편집을 덮는 경로**를 따로 센다.
    //
    // 판정은 「편집이 건드렸는데 **그 내용을 내가 안 들고 있다**」다. 들고 있다는 증거는 하나뿐이다:
    // 내 작업본의 sha 가 편집의 sha 와 **같다**. 그것이 아니면 나는 그 내용을 본 적이 없다.
    //
    // ⚠ **「내 작업본이 판 그대로일 때만」으로 좁히면 안 된다**(심의 실측). 그러면 「남도 고치고
    //   나도 고친」 경우가 빠지는데, 그 경우야말로 남의 편집이 확실히 사라지는 자리다. 그리고 내
    //   `baseSha256` 은 서버 조회에서 나오므로 CAS 가 정당하게 통과한다 — **sha 만 받아 적고 다시
    //   보내는** 바로 그 형상이다(memo183 🟠4 가 서버 쪽에서 막은 것을 우리가 되살리는 꼴).
    //
    // ⚠ 대가를 정직하게 적는다: 받기는 **판**을 받지 편집을 안 받으므로, 남이 편집한 경로는 명시
    //   동의 없이는 못 올린다. **내가** 올린 것은 장부의 `mine` 이 소유를 증언해 안 걸린다 —
    //   다만 그 증언은 **세대가 같을 때만** 유효하다.
    for (const path of paths) {
        const touched =
            draft.changed.some((row) => row.path === path) || draft.deleted.includes(path);
        if (!touched) continue;
        const now = effectiveSha(base, draft, path);
        const here = local[path]?.sha256 ?? null;
        if (here === now) continue;
        // 🔴 **내가 올린 것은 내가 본 것이다.** 이 줄이 없으면 「고치고 → 올리고 → 또 고치고 →
        //    올리는」 통상 루프가 **두 번째부터 막힌다**(실측). 그때 문면은 남을 탓하고, 안내를
        //    따르면 자기 작업이 판 내용으로 덮인다 — 술어를 넓히다 만든 회귀였다.
        //
        //    ⚠ 이것이 `mine` 의 **유일한** 쓰임이다. 선행조건은 여전히 서버 조회가 정한다(🔴1).
        //    그리고 부르는 쪽이 **세대가 같을 때만** 이 값을 넘긴다 — 갈렸으면 지난 세계의 기록이다.
        if (Object.hasOwn(mine, path) && mine[path] === now) continue;
        unseen.push(path);
    }

    return {edits, unseen: unseen.sort()};
}
