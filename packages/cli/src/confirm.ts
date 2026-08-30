/**
 * **파괴적 동사 앞의 확인**(memo184 §2.5).
 *
 * ■ 이것은 **보안 통제가 아니라 UX 가드**다 — 정직하게 적는다
 *
 * 강제 지점이 우리 로컬 프로세스라 사용자가 우회할 수 있다. 「MCP 확인 코드와 동급」이라 적지 않는다.
 * 반경이 유계라 그 성질로 충분하다고 본 것이다: 되돌리기의 대상(판)은 가역이고, 편집 폐기는
 * 원장·라이브를 안 건드린다.
 *
 * ■ 터미널이 아니면 **묻지 않고 멈춘다**
 *
 * 스크립트·CI 에서 물으면 대답이 없어 **영원히 매달린다.** 그때는 거절하고, 명시 손잡이를 알려 준다 —
 * 그 손잡이가 곧 「사람이 문구를 쳤다」와 같은 뜻이다.
 */
import {createInterface} from "node:readline/promises";

export interface ConfirmOptions {
    /** 물음. 마지막에 `(y/n)` 따위를 붙이는 것은 부르는 쪽 몫이다. */
    question: string;
    /**
     * 정확히 이 문구를 쳐야 통과한다. 없으면 `y`·`yes`·`예` 를 받는다.
     *
     * ⚠ 갈래 B 는 **한 글자 동의를 받지 않는다** — 사람이 문구를 직접 친다.
     */
    phrase?: string;
    /** 이미 명시로 동의했는가(플래그). 참이면 묻지 않는다. */
    given?: boolean;
    /** 터미널이 아닐 때 알려 줄 손잡이 이름(`--yes` 따위). */
    flag: string;
    input?: NodeJS.ReadableStream & {isTTY?: boolean};
    output?: NodeJS.WritableStream;
}

/** 사람에게 묻는다. 통과하면 `true`. */
export async function confirm(options: ConfirmOptions): Promise<boolean> {
    if (options.given === true) return true;
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stderr;
    if (input.isTTY !== true) {
        output.write(
            `${options.question}\n` +
                `터미널이 아니라 물어볼 수 없습니다. 계속하려면 \`${options.flag}\` 를 붙여 주세요.\n`,
        );
        return false;
    }
    const rl = createInterface({input, output});
    try {
        const answer = (await rl.question(`${options.question}\n> `)).trim();
        if (options.phrase !== undefined) return answer === options.phrase;
        return ["y", "yes", "예"].includes(answer.toLowerCase());
    } finally {
        rl.close();
    }
}
