/**
 * **사람에게 말하는 자리**(memo184 §2.9 보고 규율).
 *
 * ⚠ **개발 도구 어휘 0.** 사장님과 LLM 이 읽는다. 「판」·「편집 중인 것」·「올리기」·「받기」로 쓴다.
 * ⚠ **경로를 전량 나열하지 않는다** — 건수 + 최대 10경로 + 「외 N개」. 전량은 `--verbose`.
 * ⚠ **사실만 적고 끊지 않는다** — 다음에 할 일이 문장 안에 있어야 한다.
 */
import {
    PATH_LIST_CAP,
    trimPaths,
    type PushResult,
    type StrandedPlan,
    type SyncStatus,
} from "@zalkera/devtools-core";

/**
 * ⚠ **자르는 판정을 여기 두지 않는다.** 거절 문면은 코어가 만들고 이 파일은 상태 보고를 만드는데,
 *   둘이 각자 자르면 같은 목록이 자리마다 다르게 잘린다. 판정은 [trimPaths] 한 벌이다.
 */
function block(title: string, paths: readonly string[], verbose: boolean): string[] {
    if (paths.length === 0) return [];
    return [`${title} ${paths.length}개`, ...trimPaths(paths, PATH_LIST_CAP, verbose).map((p) => `  · ${p}`)];
}

/** 상태를 사람의 문장으로. */
export function describeStatus(status: SyncStatus, verbose = false): string {
    const lines: string[] = [];
    lines.push(`사이트: ${status.tenant ?? "(모름)"}`);
    lines.push(
        status.baseRevisionNo === null
            ? "이 폴더가 선 판: 모름"
            : `이 폴더가 선 판: ${status.baseRevisionNo}판`,
    );
    if (status.activeRevisionNo !== null) lines.push(`지금 사이트에 켜진 판: ${status.activeRevisionNo}판`);

    if (status.behind) {
        lines.push("");
        lines.push(`기준이 ${status.baseRevisionNo}판에서 ${status.activeRevisionNo}판으로 움직였습니다.`);
        // ⚠ **고친 것이 있으면 `pull` 도 그대로는 막힌다.** 여기서 「pull 하세요」로 끝내면 사람은
        //   그 거절을 만나고, 그 거절은 「push 하세요」라고 답한다 — 두 문이 서로를 가리켜 갇힌다
        //   (실측). 이 자리는 고친 것을 이미 알고 있으므로 **실제 출구**를 댈 수 있다.
        const dirty = status.changed.length + status.removed.length;
        lines.push(
            dirty === 0
                ? `이 폴더를 ${status.activeRevisionNo}판에 맞추려면 \`zalkera pull\` 을 실행하세요.`
                : `이 폴더에서 고친 것이 ${dirty}개 있어 \`zalkera pull\` 은 그대로는 막힙니다. ` +
                  "`zalkera pull --discard-local` 을 실행하면 고친 파일을 옆 폴더에 옮겨 두고 새 판을 받습니다.",
        );
        lines.push(
            `지금 올리면 ${status.baseRevisionNo}판을 보고 고친 내용이 ${status.activeRevisionNo}판 위에 얹힙니다.`,
        );
    }

    const changes = [
        ...block("고친 것", status.changed, verbose),
        ...block("지운 것", status.removed, verbose),
        ...block("새로 만든 것", status.added, verbose),
    ];
    lines.push("");
    if (changes.length === 0) lines.push("이 폴더에서 고친 것이 없습니다.");
    else lines.push(...changes);

    if (status.draftPaths > 0) {
        lines.push("");
        // ⚠ **사실만 적고 끊지 않는다.** 같은 파일의 `behind` 갈래와 `BLOCKER_TEXT` 는 다음 걸음을
        //   문장 안에 두는데 여기만 끊겨 있었다 — 한 파일 안에서 규율이 갈리면 그 규율은 없는 것이다.
        lines.push(`사이트 쪽에 아직 안 켠 편집이 ${status.draftPaths}개 경로에 있습니다.`);
        lines.push(
            status.mineValid
                ? "이 폴더에서 올린 것입니다. `zalkera publish` 로 켜거나 `zalkera discard` 로 버릴 수 있습니다."
                : "이 폴더에서 올린 것인지는 알 수 없습니다 — 그 사이 사이트 쪽이 달라졌습니다. 콘솔에서 무엇이 들어 있는지 확인해 주세요.",
        );
    }

    for (const blocker of status.blockers) {
        lines.push("");
        lines.push(BLOCKER_TEXT[blocker]);
    }
    return lines.join("\n");
}

/**
 * 막힌 이유와 **그때 할 일**.
 *
 * ⚠ 「무엇이 막혔다」만 적고 끊으면 사람은 다음 걸음을 못 찾는다 — 그 자리에서 폴더를 지우고
 *   다시 받는 길을 스스로 만들어 내고, 그러면 작업본이 사라진다.
 */
const BLOCKER_TEXT: Record<SyncStatus["blockers"][number], string> = {
    LEDGER_UNKNOWN:
        "이 폴더에 기준 기록이 없어 올리기는 막혀 있습니다.\n`zalkera baseline` 을 실행하면 지금 판을 기준으로 다시 세웁니다. 폴더의 파일은 건드리지 않습니다.",
    SERVER_UNREADABLE:
        "지금 사이트 쪽 상태를 확인하지 못했습니다. 그래서 올리기는 막아 두었습니다.\n잠시 뒤 다시 시도해 주세요.",
    // ⚠ **있는 명령만 댄다.** 좌초는 사람이 막혀서 다음 걸음을 찾는 자리다 — 없는 동사를 대면
    //   「모르는 명령입니다」로 끝난다. `discard` 는 T3 에서 실제로 생겼다.
    STRANDED:
        "사이트 쪽에서 편집 중이던 것이 지금 버전 위가 아닙니다. 그대로는 켤 수 없습니다.\n`zalkera discard` 로 그 편집을 버릴 수 있습니다 — 버리기 전에 무엇이 걸려 있는지 보여 줍니다.",
};

/**
 * 올리기 결과를 사람의 문장으로.
 *
 * 🔴 **이 조립에 시험이 없던 것이 결함의 원인이었다**(심의 지적). `main.ts` 안에 인라인으로 있어
 *    프로세스를 띄우지 않으면 못 쟀고, 그래서 「다시 보냈습니다」가 요청 0회에 찍히고 「같습니다」
 *    밑에 「빼고 보냈습니다」가 붙는 모순이 두 회전을 살아남았다. 순수 함수로 뽑아 잰다.
 *
 * ⚠ **판정을 행동으로 옮겨 적지 않는다.** 화해 판정과 실제 전송은 별개다 — 요청이 0번 나가는
 *   갈래가 둘 있다.
 */
export function describePush(result: PushResult, verbose = false): string[] {
    const lines: string[] = [];
    if (result.reconciled === "applied") {
        lines.push("지난번에 올린 것이 사이트 쪽에 들어가 있었습니다. 그것으로 정리했습니다.");
    } else if (result.reconciled === "not-applied") {
        lines.push("지난번에 올린 것이 사이트 쪽에 없었습니다.");
    }

    // ⚠ **「같습니다」는 뺀 것이 없을 때만 말한다.** 뺀 것이 있으면 폴더와 사이트는 다르다 —
    //    따로 찍으면 「같습니다」 바로 밑에 「N개를 빼고 보냈습니다」가 온다.
    lines.push(
        result.sent > 0
            ? `${result.sent}개를 올렸습니다(그중 지운 것 ${result.removed}개).`
            : result.droppedByServer.length > 0
              ? "올린 것이 없습니다 — 달라진 것이 모두 사이트가 받지 않는 경로였습니다."
              : "올릴 것이 없습니다 — 이 폴더의 내용이 사이트 쪽과 같습니다.",
    );

    if (result.retriedAfterConflict) {
        lines.push("올리는 사이에 사이트 쪽이 달라져 다시 읽고 한 번 더 보냈습니다.");
    }
    if (result.droppedByServer.length > 0) {
        lines.push(
            `사이트가 받지 않는 경로 ${result.droppedByServer.length}개는 빼고 보냈습니다.`,
            ...trimPaths(result.droppedByServer, PATH_LIST_CAP, verbose).map((p) => `  · ${p}`),
        );
    }
    if (result.previewUrl) lines.push(`미리보기: ${result.previewUrl}`);
    if (result.warning) lines.push(result.warning);
    // ⚠ **올린 것이 있을 때만 「안 켜졌다」를 말한다.** 안 말하면 사장님이 사이트를 보고
    //   뭐가 잘못됐냐고 물을 곳이 없다.
    if (result.sent > 0) lines.push("아직 사이트에 켜지지는 않았습니다 — 켜려면 `zalkera publish` 를 실행하세요.");
    return lines;
}

/**
 * 버리기 전에 **무엇을 잃는지** 말한다(memo184 §2.5).
 *
 * 🔴 **「로컬 원본이 있어 손실이 아니다」는 A 갈래에서만 쓴다.** 초안은 그 문장을 무조건 달았고,
 *    그것이 사장님의 유일본을 지우게 만드는 문장이다.
 * 🔴 **「남의 드래프트」라고 쓰지 않는다.** 같은 사람이 두 표면을 쓰면 그 말이 거짓이 된다.
 *    문면은 **「여기 없는 편집」** — 폴더 기준이라 언제나 참이다.
 */
export function describeStranded(plan: StrandedPlan, verbose = false): string[] {
    const list = trimPaths(plan.paths, PATH_LIST_CAP, verbose).map((p) => `  · ${p}`);
    if (plan.verdict === "mine") {
        return [
            "지금 사이트 쪽에 걸려 있는 편집은 이 폴더에서 올린 것과 같습니다.",
            ...list,
            "버리고 다시 올려도 이 폴더의 내용은 그대로입니다.",
        ];
    }
    // ⚠ **목록이 비었는데 「걸려 있습니다」를 단정하지 않는다.** 서버가 「없음」이라 답한 경우와
    //   못 읽은 경우가 그렇다 — 전자는 부르는 쪽이 이미 걸러야 하고, 후자는 모른다고 말해야 한다.
    if (plan.paths.length === 0) {
        return [
            "⚠ 지금 사이트 쪽에 무엇이 걸려 있는지 확인하지 못했습니다.",
            "버리면 되찾을 방법이 없으니, 콘솔의 「편집 중」에서 먼저 확인해 주세요.",
        ];
    }
    return [
        "⚠ 지금 사이트 쪽에 **이 폴더에 없는 편집**이 걸려 있습니다.",
        ...list,
        "콘솔이나 AI 로 고친 내용일 수 있고, 버리면 되찾을 방법이 없습니다.",
        "무엇이 걸려 있는지 콘솔의 「편집 중」에서 먼저 확인해 주세요.",
    ];
}

/** 갈래 B 에서 사람이 **직접 쳐야 하는** 문구. 한 글자 동의(y)를 받지 않는다. */
export const DISCARD_PHRASE = "버립니다";
