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

/**
 * 경로 깊이 상한. 정상 소스 트리에 이만큼 깊은 자리는 없다
 * (`src/app/api/orders/[orderNo]/cancel/route.ts` 가 7단).
 *
 * ⚠ **자원 상한이지 취향이 아니다.** 항목마다 세그먼트를 훑어 제외를 판정하므로, 깊이가 곧
 *   항목당 비용이다. 형식이 허용하는 최악(이름 65,534B = 32,767단)을 그대로 받으면 그 곱이
 *   확장 호스트를 멈춘다.
 */
const MAX_PATH_SEGMENTS = 64;

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
    // ⚠ **깊이를 먼저 본다.** 아래 훑기가 항목 × 세그먼트라, 재기 전에 끊어야 한다.
    const tooDeep = names.find((n) => segmentCount(n) > MAX_PATH_SEGMENTS);
    if (tooDeep !== undefined) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            "압축 파일에 경로가 지나치게 깊은 항목이 있습니다.",
            "사이트 소스 zip 이 맞는지 확인해 주세요 — 정상 소스에는 이런 자리가 없습니다.",
        );
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
        // 디렉터리 항목(`node_modules/`)도 **같은 잣대**로 본다 — 끝 슬래시만 떼고 잰다.
        const judged = name.endsWith("/") ? name.slice(0, -1) : name;
        (isExcludedEntry(judged) ? dropped : keep).push(name);
    }
    // 표식은 **파일**이어야 한다. 디렉터리 항목은 늘 `/` 로 끝나 표식 이름과 일치할 수 없으므로
    // 이 조건은 **중복 방어**다 — 변이로 깨지지 않는다. 뒤에 누가 `keep` 에서 끝 슬래시를 떼면
    // 그때 유일한 방어가 되므로 남긴다.
    if (!keep.some((name) => !name.endsWith("/") && STOREFRONT_MARKERS.includes(name))) {
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
    // ⚠ **접두는 파일로만 정한다.** 디렉터리 항목(`wrapper/`)은 자기 자신이 접두라, 최장공통
    //    접두를 재는 데 끼우면 **거기서 끊긴다** — 두 겹으로 감싼 실물 zip 이 한 겹만 벗겨지고
    //    표식(`package.json`)이 뿌리에 안 올라와 「사이트가 아니다」로 통째 거절된다(심의 실증).
    //    빈 디렉터리는 뿌리를 정하는 근거가 될 수도 없다.
    // ⚠ **제외 대상은 접두를 정하는 데 끼지 않는다.** 겹 자리의 `.DS_Store`(맥에서 폴더를 한 번
    //    열면 생긴다)나 `.env.local` 하나가 최장공통접두를 거기서 끊어, 두 겹이 한 겹만 벗겨지고
    //    표식이 뿌리에 안 올라와 「사이트가 아니다」가 된다(심의 실증). 받은 zip 을 풀고 상위
    //    폴더를 다시 압축하는 것이 두 겹 zip 의 전형적 생성 경로라, 이 형상이 흔하다.
    //    디렉터리 항목·`__MACOSX` 와 **같은 잣대**다 — 어차피 안 들여올 것은 뿌리도 못 정한다.
    const rest = names.filter(
        (n) => !n.endsWith("/") && !n.toLowerCase().startsWith("__macosx/") && !isExcludedEntry(n),
    );
    const first = rest[0];
    if (first === undefined) return "";

    // ⚠ **이름 전체를 한 번만 훑는다.** 깊이마다 남은 이름을 다시 잘라 담으면 비용이
    //    O(이름바이트 × 깊이)가 되고, 깊게 감싼 zip 하나가 확장 호스트를 **십수 초 얼린다**
    //    (실측: 깊이 1,120 · 항목 65,535 에서 14.6초, 취소도 안 되는 동기 구간).
    //    이 경로의 입력은 **남이 준 zip** 이라 악의·손상 입력이 곧 위협모형이다.
    let end = first.length;
    for (const name of rest) {
        const max = Math.min(end, name.length);
        let i = 0;
        while (i < max && first.charCodeAt(i) === name.charCodeAt(i)) i += 1;
        end = i;
        if (end === 0) return "";
    }
    const cut = first.slice(0, end).lastIndexOf("/");
    if (cut < 0) return "";

    // ⚠ **제외 대상은 벗기지 않는다.** `node_modules/pkg/` 도 단일 루트라, 그냥 벗기면
    //    남의 의존 트리가 `package.json` 을 뿌리에 둔 「사이트」로 둔갑한다(시험이 잡은 자리).
    let kept = "";
    for (const segment of first.slice(0, cut + 1).split("/")) {
        if (segment === "") continue;
        if (isExcludedEntry(segment)) break;
        kept += `${segment}/`;
    }
    return kept;
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

/** `/` 개수 + 1. `split` 으로 배열을 만들지 않는다 — 그 자체가 이 자리의 비용이다. */
function segmentCount(name: string): number {
    let n = 1;
    for (let i = 0; i < name.length; i += 1) {
        if (name.charCodeAt(i) === 47) n += 1;
        if (n > MAX_PATH_SEGMENTS) return n;
    }
    return n;
}
