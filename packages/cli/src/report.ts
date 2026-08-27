/**
 * **사람에게 말하는 자리**(memo184 §2.9 보고 규율).
 *
 * ⚠ **개발 도구 어휘 0.** 사장님과 LLM 이 읽는다. 「판」·「편집 중인 것」·「올리기」·「받기」로 쓴다.
 * ⚠ **경로를 전량 나열하지 않는다** — 건수 + 최대 10경로 + 「외 N개」. 전량은 `--verbose`.
 * ⚠ **사실만 적고 끊지 않는다** — 다음에 할 일이 문장 안에 있어야 한다.
 */
import {PATH_LIST_CAP, trimPaths, type SyncStatus} from "@zalkera/devtools-core";

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
        lines.push(`기준이 ${status.baseRevisionNo}에서 ${status.activeRevisionNo}로 움직였습니다.`);
        lines.push(
            `이 폴더를 ${status.activeRevisionNo}에 맞추려면 \`zalkera pull\` 을 실행하세요. ` +
                `지금 올리면 ${status.baseRevisionNo}를 보고 고친 내용이 ${status.activeRevisionNo} 위에 얹힙니다.`,
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
                ? "이 폴더에서 올린 것입니다. 콘솔에서 켜거나 되돌릴 수 있습니다."
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
    // ⚠ **없는 명령을 지시하지 않는다.** 좌초는 사람이 막혀서 다음 걸음을 찾는 자리다 — 거기서
    //   `zalkera discard`(T3 예정)를 대면 「모르는 명령입니다」로 끝난다(심의 지적).
    STRANDED:
        "사이트 쪽에서 편집 중이던 것이 지금 판 위가 아닙니다. 그대로는 켤 수 없습니다.\n지금은 콘솔에서 그 편집을 되돌려 주세요. 되돌리면 이 폴더로 다시 받을 수 있습니다.",
};
