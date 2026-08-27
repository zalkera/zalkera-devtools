/**
 * **사람에게 말하는 자리**(memo184 §2.9 보고 규율).
 *
 * ⚠ **개발 도구 어휘 0.** 사장님과 LLM 이 읽는다. 「판」·「편집 중인 것」·「올리기」·「받기」로 쓴다.
 * ⚠ **경로를 전량 나열하지 않는다** — 건수 + 최대 10경로 + 「외 N개」. 전량은 `--verbose`.
 * ⚠ **사실만 적고 끊지 않는다** — 다음에 할 일이 문장 안에 있어야 한다.
 */
import type {SyncStatus} from "@zalkera/devtools-core";

/** 목록을 줄인다. 「외 N개」가 붙는 자리가 여기 하나다. */
export function trim(paths: readonly string[], cap = 10, verbose = false): string[] {
    if (verbose || paths.length <= cap) return [...paths];
    return [...paths.slice(0, cap), `외 ${paths.length - cap}개`];
}

function block(title: string, paths: readonly string[], verbose: boolean): string[] {
    if (paths.length === 0) return [];
    return [`${title} ${paths.length}개`, ...trim(paths, 10, verbose).map((p) => `  · ${p}`)];
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
        lines.push(`사이트 쪽에 아직 안 켠 편집이 ${status.draftPaths}개 경로에 있습니다.`);
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
    STRANDED:
        "사이트 쪽에서 편집 중이던 것이 지금 판 위가 아닙니다. 그대로는 켤 수 없습니다.\n`zalkera discard` 로 그 편집을 버리거나, 콘솔에서 되돌리기를 해 주세요.",
};
