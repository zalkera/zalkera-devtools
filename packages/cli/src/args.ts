/**
 * **인자 해석 — 순수 함수.** 프로세스도 파일시스템도 안 만진다.
 *
 * 의존성을 안 쓰는 이유는 이 레포의 다른 자리와 같다: 고객 노트북에서 우리 의존성 하나가 설치에
 * 실패하면 도구가 통째로 막힌다. 여기 필요한 문법은 열 줄이면 된다.
 */
export interface ParsedArgs {
    command: string | null;
    /** 위치 인자(명령 뒤에 붙은 값들). */
    positional: string[];
    flags: Record<string, string | true>;
}

/**
 * `zalkera pull --site acme --discard-local` 을 가른다.
 *
 * ⚠ **`--플래그=값` 과 `--플래그 값` 을 둘 다 받는다.** 한쪽만 받으면 다른 쪽을 쓴 사람은
 *   「값이 없습니다」가 아니라 **조용히 기본값으로 도는** 것을 본다.
 * ⚠ `--` 뒤는 전부 위치 인자다 — `-` 로 시작하는 폴더 이름을 넘길 길이 필요하다.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
    const positional: string[] = [];
    const flags: Record<string, string | true> = {};
    let literal = false;

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i]!;
        if (literal) {
            positional.push(token);
            continue;
        }
        if (token === "--") {
            literal = true;
            continue;
        }
        if (!token.startsWith("--")) {
            positional.push(token);
            continue;
        }
        const body = token.slice(2);
        const eq = body.indexOf("=");
        if (eq >= 0) {
            flags[body.slice(0, eq)] = body.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        // 다음 토큰이 또 플래그면 이것은 **값 없는 스위치**다. 안 그러면 `--verbose --site x` 에서
        // `verbose` 가 `--site` 를 자기 값으로 삼키고 `site` 가 사라진다.
        if (next !== undefined && !next.startsWith("--")) {
            flags[body] = next;
            i += 1;
            continue;
        }
        flags[body] = true;
    }

    return {command: positional.shift() ?? null, positional, flags};
}

/** 스위치 하나가 켜졌는가. 값이 붙어 있어도 `false`·`0`·`no` 는 꺼진 것으로 본다. */
export function flagOn(flags: ParsedArgs["flags"], name: string): boolean {
    const value = flags[name];
    if (value === undefined) return false;
    if (value === true) return true;
    return !["false", "0", "no", ""].includes(value.toLowerCase());
}

/** 값이 있는 플래그. 스위치로 켜기만 한 경우는 **값이 없는 것**이다. */
export function flagValue(flags: ParsedArgs["flags"], name: string): string | null {
    const value = flags[name];
    return typeof value === "string" && value !== "" ? value : null;
}
