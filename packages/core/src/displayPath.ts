/**
 * **화면에 짧게 적는 경로.**
 *
 * ■ 왜 우리가 줄이나
 *   VS Code 의 트리 행은 넘치면 **꼬리에서** 자른다. 경로에서 식별력이 가장 큰 조각은 마지막
 *   폴더 이름인데, 그대로 두면 정확히 그것부터 사라진다 —
 *   `/home/jonghwa/projects/zalkera/fin-01-v7` 이 `/home/jonghwa/projects/zal…` 이 된다.
 *   그래서 **머리를 접고 꼬리를 지킨다.**
 *
 * ■ 여기서만 쓴다
 *   사이드바 전용이다. **모달에는 쓰지 않는다** — 되돌릴 수 없는 결정을 확인하는 자리는
 *   전체 경로가 요점이고, 모달 본문은 잘리지 않고 줄바꿈된다.
 *   상태바에도 쓰지 않는다: 그 자리는 `$(아이콘)` 표기를 해석하므로 그런 글자가 든 폴더 이름이
 *   아이콘으로 둔갑한다.
 */

/** 사이드바 한 행에 들어가는 대략의 상한. 넘으면 머리를 접는다. */
const SIDEBAR_LIMIT = 44;

/** 이 경로가 쓰는 구분자. 윈도 경로가 섞여 들어와도 그 표기를 지킨다. */
function separatorOf(path: string): string {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** 홈 아래면 `~` 로 접는다. **접두가 폴더 경계에서 끝날 때만** — `/home/jo` 가 `/home/jonghwa` 를 먹지 않는다. */
function foldHome(path: string, home: string | null | undefined): string {
    if (home === null || home === undefined || home === "") return path;
    if (path === home) return "~";
    const sep = separatorOf(home);
    const prefix = home.endsWith(sep) ? home : home + sep;
    return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

/**
 * 화면에 적을 경로. 짧으면 그대로, 길면 `…/뒤쪽/폴더` 꼴로 **꼬리를 지켜** 접는다.
 *
 * @param home 홈 폴더. 주면 그 아래 경로를 `~` 로 접는다. 모르면 생략한다.
 */
export function displayPath(path: string, home?: string | null, limit = SIDEBAR_LIMIT): string {
    const folded = foldHome(path, home);
    if (folded.length <= limit) return folded;

    const sep = separatorOf(folded);
    // 앞머리가 빈 조각(절대경로의 `/`)은 버린다 — 어차피 `…` 가 그 자리를 말한다.
    const parts = folded.split(sep).filter((piece) => piece.length > 0);
    // 조각이 없으면(구분자만 있는 경로) 접을 것이 없다.
    if (parts.length === 0) return folded;

    // `…` 와 구분자 두 글자를 미리 빼 두고 꼬리부터 붙인다.
    const room = limit - 2;
    let tail = parts[parts.length - 1] as string;
    for (let i = parts.length - 2; i >= 0; i--) {
        const wider = `${parts[i] as string}${sep}${tail}`;
        if (wider.length > room) break;
        tail = wider;
    }
    // **마지막 조각 하나가 이미 상한을 넘는 경우**가 있다(아주 긴 폴더 이름). 그때도 꼬리를
    // 지킨다 — 이름의 끝이 판을 가르는 자리다(`이름-v12` 의 `12`).
    if (tail.length > room) tail = tail.slice(tail.length - room);
    return `…${sep}${tail}`;
}
