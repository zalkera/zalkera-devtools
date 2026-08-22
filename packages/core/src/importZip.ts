/**
 * **남이 준 zip 을 들여올 때의 판정.**
 *
 * 서버가 준 팩과 다르다. 팩은 원장이 sha256 을 주장하고 우리가 대조하지만, 로컬 파일에는
 * **주장할 원장이 없다.** 그래서 무결성 검증을 흉내 내지 않고, 대신 **구조를 쓰기 전에** 판정한다 —
 * 통과하지 못하면 파일을 하나도 만들지 않는다.
 *
 * ⚠ **판정이 여기 사는 이유.** 흡수·제외를 확장 안에 두면 시험도 검사기도 못 닿는다. 특히 흡수는
 *   경로를 **다시 쓰는** 연산이라, 안전 검사(zip-slip·심링크)가 **벗긴 이름**을 보게 순서를 고정해야
 *   한다. 그 순서가 코드 한 곳에 있어야 시험이 문다.
 */
import {readFile, stat} from "node:fs/promises";
import {DevtoolsError} from "./errors.ts";
import {MAX_DOWNLOAD_BYTES} from "./limits.ts";
import {isExcludedEntry} from "./zip.ts";

export interface ImportPlan {
    /** 흡수할 공통 접두(`site/` 처럼). 없으면 빈 문자열. */
    strip: string;
    /** 실제로 풀 항목 — 접두를 벗긴 이름. */
    keep: string[];
    /** 제외한 항목 — 사람에게 무엇이 빠졌는지 말하기 위해 남긴다. */
    dropped: string[];
}

/** 이 zip 이 잘커라 스토어프론트인가를 판정하는 표. 하나라도 있으면 참으로 본다. */
const STOREFRONT_MARKERS = ["package.json", "llms.txt", ".zalkera/pack.json"];

/**
 * 항목 이름 목록에서 해제 계획을 만든다. **파일을 만들기 전에** 부른다.
 *
 * 하는 일 셋:
 * ⑴ OS 압축 도구가 만든 **단일 중첩 루트**(`site/site/...`)를 흡수한다 — Windows·macOS 기본
 *    해제가 이걸 만들고, 그러면 확장이 「소스 없음」으로 본다.
 * ⑵ 발행이 **정본에 못 싣는 것**을 들여오지도 않는다(같은 목록을 쓴다). 보낸 쪽 `.vscode` 가
 *    들어오면 그 폴더가 **보낸 사람의 사이트라고 주장**하게 된다.
 * ⑶ 스토어프론트가 아니면 **거절한다.** 아무 zip 이나 풀어 주면 그 폴더는 이도저도 아니게 된다.
 */
export function decideImportPlan(names: readonly string[]): ImportPlan {
    if (names.length === 0) {
        throw new DevtoolsError("NOT_A_SITE", "압축 파일이 비어 있습니다.", "받으신 파일을 다시 확인해 주세요.");
    }
    const strip = commonRoot(names);
    const keep: string[] = [];
    const dropped: string[] = [];
    for (const raw of names) {
        // ⚠ **접두로 시작하지 않는 항목을 그 길이만큼 자르면 쓰레기 이름이 된다.**
        //    `__MACOSX/site/._x` 를 `site/` 로 자르면 `OSX/site/._x` 가 되고, 그 이름은 제외 목록
        //    어디에도 안 걸려 **통과한다**(시험이 잡은 자리). 접두 밖은 버린다.
        if (!raw.startsWith(strip)) {
            dropped.push(raw);
            continue;
        }
        const name = raw.slice(strip.length);
        // 접두를 벗기고 남은 것이 없는 항목(= 그 접두 디렉터리 자신)은 셀 것이 아니다.
        if (name === "") continue;
        (isExcludedEntry(name) ? dropped : keep).push(name);
    }
    if (!keep.some((name) => STOREFRONT_MARKERS.includes(name))) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            "잘커라 사이트 소스가 아닙니다.",
            "사이트 소스 zip 인지 확인해 주세요 — package.json 이 있어야 합니다.",
        );
    }
    return {strip, keep, dropped};
}

/**
 * 모든 항목이 공유하는 **단일** 디렉터리 접두. 없으면 빈 문자열.
 *
 * ⚠ **반복해서 벗긴다.** 압축을 두 번 거치면 `site/site/...` 가 된다(실사용에서 나온다).
 * ⚠ **`__MACOSX/` 는 접두 계산에서 빼고 본다.** 그것까지 세면 공통 접두가 없다고 판정되어
 *   중첩이 안 벗겨진다 — macOS 에서 압축한 zip 이 정확히 그 모양이다.
 */
function commonRoot(names: readonly string[]): string {
    let prefix = "";
    let rest = names.filter((n) => !n.toLowerCase().startsWith("__macosx/"));
    for (;;) {
        const heads = new Set(rest.map((n) => n.slice(0, n.indexOf("/") + 1)));
        // 뿌리에 파일이 있으면(`indexOf("/") === -1` → 빈 문자열) 벗길 것이 없다.
        if (heads.size !== 1 || heads.has("")) return prefix;
        const head = [...heads][0];
        if (head === undefined) return prefix;
        // ⚠ **제외 대상은 벗기지 않는다.** `node_modules/pkg/` 도 단일 루트라, 그냥 벗기면
        //    남의 의존 트리가 `package.json` 을 뿌리에 둔 「사이트」로 둔갑한다(시험이 잡은 자리).
        if (isExcludedEntry(head.slice(0, -1))) return prefix;
        prefix += head;
        rest = rest.map((n) => n.slice(head.length)).filter((n) => n !== "");
        if (rest.length === 0) return prefix;
    }
}

/**
 * 들여올 zip 을 읽는다. **상한을 먼저 재고 읽는다.**
 *
 * ⚠ 파일을 통째로 메모리에 올리므로, 재지 않고 읽으면 사람이 실수로 고른 큰 파일 하나로
 *   확장이 죽는다. 전선에서 받는 것과 같은 상한을 쓴다 — 같은 물건이 다른 문으로 들어올 뿐이다.
 */
export async function readZipFile(path: string): Promise<Buffer> {
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) {
        throw new DevtoolsError("NOT_A_SITE", "고르신 파일을 읽을 수 없습니다.", "파일이 그대로 있는지 확인해 주세요.");
    }
    if (info.size > MAX_DOWNLOAD_BYTES) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            `파일이 너무 큽니다(상한 ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB).`,
            "사이트 소스 zip 이 맞는지 확인해 주세요 — node_modules 가 섞이면 이만큼 커집니다.",
        );
    }
    return readFile(path);
}
