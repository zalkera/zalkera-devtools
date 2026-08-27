/**
 * **받은 폴더가 자기 출처를 적어 두는 자리**, 그리고 그 폴더가 자기 사이트를 바라보게 하는 병합.
 *
 * ■ 표식이 왜 필요한가
 *   지금까지 받은 폴더는 자기가 어느 판에서 왔는지 아무 데도 안 적었다. 그래서 「같은 판을 또
 *   받으려는 것인가」를 물을 수 없었고, 물을 수 없으니 사본만 늘었다.
 *
 * ■ ⚠ 이 표식은 **올라가면 안 된다**
 *   정본에 실리면, 서버가 만든 다음 판을 받은 폴더가 「나는 13에서 왔다」는 낡은 거짓을 품는다.
 *   `zip.ts` 의 `EXCLUDED_PATHS` 가 이 경로를 **정확일치로** 빼는 것이 이 파일의 **전제**다 — 둘은
 *   같은 커밋에 있어야 하고, 순서가 갈리면 그 사이에 오염된 판이 나간다.
 *   ⚠ **`ALWAYS_EXCLUDED` 가 아니다.** 그 목록은 **세그먼트 이름** 기준이고 `.zalkera` 를 담지
 *     않는다(실물). 통째 배제도 안 된다 — 같은 폴더의 `ASSETS-LICENSE.md`·`pack.json` 은
 *     배송 문서가 가리키는 실물이라 실려야 한다.
 *
 * ■ 부재는 정상이다
 *   콘솔·AI 레인 등 다른 입구로 만들어진 판에는 표식이 없다. 없으면 「모른다」로 다루고, 없다는
 *   이유로 무엇도 막지 않는다.
 */

/** 프로젝트 루트 기준 상대 경로. 조회는 이 상수 하나로 한다. */
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {ensureOwnDir, writeOwnFile} from "./safeWrite.ts";

export const SOURCE_MARK_PATH = ".zalkera/source.json";

/** 사이트 코드의 모양. 서버가 받는 것과 같은 잣대다. */
export const TENANT_CODE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * 받기가 남기는 표식. **받기는 계속 이 형식을 쓴다** — 구판 확장의 판독기가 이것만 알므로,
 * 가장 흔한 경로에서 회귀가 없다.
 */
export interface FetchedMark {
    /** 형식 판올림 자리. 모르는 값이면 읽는 쪽이 「모른다」로 다룬다. */
    format: 1;
    tenant: string;
    revisionNo: number;
    /** 받은 정본 tar.gz 의 sha256. 같은 판이면 같아야 한다. */
    sha256: string;
    fetchedAt: string;
}

/**
 * 발행이 남기는 표식. sha256 칸이 없다 — 업로드 zip 의 지문은 정본 tar 의 지문과 **다른 물건**이라,
 * 같은 칸에 넣으면 칸의 뜻이 거짓이 된다.
 */
export interface PublishedMark {
    format: 2;
    origin: "published";
    tenant: string;
    revisionNo: number;
    publishedAt: string;
}

/** 명시 재연결이 남기는 표식. **판 주장을 하지 않는다.** */
export interface LinkedMark {
    format: 2;
    origin: "linked";
    tenant: string;
    linkedAt: string;
}

/**
 * 폴더의 사이트 소속과 그 근거. 어느 형상이든 `tenant` 는 있다 — 소속을 묻는 쪽은 그 칸만 본다.
 *
 * ⚠ **format 2 는 구판 확장에서 「모른다」로 강하한다**(구판 판독기가 `format !== 1` 을 null 로
 *   다룬다). 막는 것도 없고 거짓 확신도 없으므로 그 강하는 안전한 방향이다.
 */
export type SourceMark = FetchedMark | PublishedMark | LinkedMark;

/** 판 번호의 상한 — 서버 컬럼이 `Int` 다. 넘으면 409 가 아니라 400 이라 탈출구가 안 열린다. */
const MAX_REVISION_NO = 2_147_483_647;

/**
 * 이 표식이 **선언할 기반 판**을 아는가 — 안다면 그 번호.
 *
 * ■ 선언의 뜻은 「폴더 내용이 판 N 과 같다」가 아니다
 *   **「판 N 을 받아 그 위에서 작업했다」**이다. 폴더는 새 작업을 담아 판 N 과 **달라야 정상**이고,
 *   서버가 대조하는 것도 내용이 아니라 「그 뒤에 남이 올렸는가」다. 그래서 폴더 내용을 재서 표식을
 *   검증하려 들면 안 된다 — 의미론이 틀렸고, 파일 단위 변경 검출은 이 트랜치의 금지 목록이다.
 *
 * ■ 표식별 처분
 *   · `FetchedMark`  — 받은 판을 안다. 선언한다.
 *   · `PublishedMark`— 자기가 올린 판을 안다. 선언한다(서버가 묻는 것은 「그 뒤 남이 올렸는가」뿐이다).
 *   · `LinkedMark`   — **판 주장을 하지 않는 표식**이다. 선언하지 않는다.
 *   · 표식 없음      — 선언하지 않는다.
 *
 * ⚠ **없는 값을 지어내지 마라.** 모르는데 아무 번호나 실으면 **근거 없이 남을 막는다** — 이 트랜치가
 *   내내 사냥한 병(모르는 것을 안다고 말하기)이 방어 쪽에서 재생산되는 자리다.
 *
 * ⚠ **소속이 다르면 선언하지 않는다.** 발행 게이트가 「폴더 소속 = 고른 사이트」를 이미 보장하지만,
 *   이 읽기는 그 게이트와 **다른 시점**이라 남의 사이트 표식 번호를 이 원장에 선언하는 길이 열린다.
 *
 * @param tenant 지금 올리는 사이트. 표식 소속과 다르면 `null`.
 */
export function declaredBaseRevisionNo(mark: SourceMark | null, tenant: string): number | null {
    if (!mark || mark.tenant !== tenant) return null;
    if ("origin" in mark && mark.origin === "linked") return null;
    // ⚠ **범위를 본다.** 표식은 폴더 안 파일이라 손으로 고칠 수 있다. Int32 밖 값(`1e21` 등)은 서버
    //    역직렬화에서 **409 가 아니라 400** 이 되고, 그러면 `isUploadBaseMoved` 가 거짓이라 「그대로
    //    올리기」가 **안 열린다** — 표식은 발행 성공에서만 갱신되므로 그 폴더는 다시 못 올린다.
    //    이 방어가 없애려던 영구 막다른길이 표식 쪽 입구로 되돌아오는 자리다. 0·음수도 판이 아니다.
    const no = mark.revisionNo;
    return typeof no === "number" && Number.isSafeInteger(no) && no > 0 && no <= MAX_REVISION_NO
        ? no
        : null;
}

export function buildSourceMark(input: Omit<FetchedMark, "format">): string {
    const mark: FetchedMark = {format: 1, ...input};
    return `${JSON.stringify(mark, null, 2)}\n`;
}

/** 발행·재연결이 쓰는 표식의 본문. 받기는 [buildSourceMark] 를 쓴다. */
export function buildBindingMark(input: Omit<PublishedMark, "format"> | Omit<LinkedMark, "format">): string {
    const mark: SourceMark = {format: 2, ...input} as SourceMark;
    return `${JSON.stringify(mark, null, 2)}\n`;
}

/**
 * 표식을 읽는다. 없거나·깨졌거나·모르는 형식이면 `null` — **거짓 확신을 만들지 않는다.**
 * 이 함수가 `null` 을 준다고 「받은 적 없다」는 뜻은 아니다. 「모른다」는 뜻이다.
 */
export function parseSourceMark(text: string | null): SourceMark | null {
    if (text === null) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    // 모양을 본다. 표식은 폴더에 있고 폴더는 zip·git 으로 유통된다 — 남이 만든 표식이
    // 제어문자·초장문을 워크스페이스 설정과 레지스트리 키로 나르게 두지 않는다.
    // 사이트 코드를 손으로 받는 자리와 **같은 잣대**다.
    if (typeof o.tenant !== "string" || !TENANT_CODE.test(o.tenant)) return null;
    if (o.format === 1) {
        if (typeof o.revisionNo !== "number" || !Number.isInteger(o.revisionNo)) return null;
        if (typeof o.sha256 !== "string" || o.sha256.length === 0) return null;
        if (typeof o.fetchedAt !== "string") return null;
        return {format: 1, tenant: o.tenant, revisionNo: o.revisionNo, sha256: o.sha256, fetchedAt: o.fetchedAt};
    }
    if (o.format === 2 && o.origin === "published") {
        if (typeof o.revisionNo !== "number" || !Number.isInteger(o.revisionNo)) return null;
        if (typeof o.publishedAt !== "string") return null;
        return {
            format: 2,
            origin: "published",
            tenant: o.tenant,
            revisionNo: o.revisionNo,
            publishedAt: o.publishedAt,
        };
    }
    if (o.format === 2 && o.origin === "linked") {
        if (typeof o.linkedAt !== "string") return null;
        return {format: 2, origin: "linked", tenant: o.tenant, linkedAt: o.linkedAt};
    }
    return null;
}

/**
 * 이 폴더가 **같은 사이트의 같은 판**을 이미 담고 있는가. 모르면 `false`(사본을 막지 않는다).
 *
 * ⚠ **`linked` 는 언제나 `false` 다** — 그 표식에는 판 칸이 없다. 소속만 아는 폴더에
 *   「이미 받아 두셨습니다」가 뜨면 그것은 거짓이다.
 */
export function holdsSameRevision(mark: SourceMark | null, tenant: string, revisionNo: number): boolean {
    // 받기 표식(format 1)만 이 주장을 낼 수 있다. `linked` 는 판 칸이 없고, `published` 는
    // **올린 것**의 판이라 그 폴더가 지금 그 판의 사본이라는 뜻이 아니다 — 올린 뒤로 계속
    // 편집했을 수 있다. 「이미 받아 두셨습니다」는 사본이라는 주장이므로 둘 다 거짓이 된다.
    return mark !== null && mark.format === 1 && mark.tenant === tenant && mark.revisionNo === revisionNo;
}

export type MergeResult = {ok: true; text: string} | {ok: false; reason: string};

/**
 * 새 폴더의 `.vscode/settings.json` 에 `zalkera.tenant` 만 적는다.
 *
 * ■ 남의 키를 지우지 않는다
 *   기존 내용이 있으면 **그대로 두고 이 키만** 설정한다. 통째로 덮으면 사람이 넣어 둔 편집기
 *   설정이 조용히 사라진다.
 *
 * ■ 못 읽으면 **안 쓴다**
 *   주석이 섞인 JSONC 나 손상된 파일을 우리가 다시 쓰면 그 사람의 설정이 날아간다. 그럴 때는
 *   쓰지 않고 사유를 돌려준다 — 부르는 쪽이 「사이트에 연결을 한 번 눌러 주세요」로 옮긴다.
 */
export function mergeTenantSetting(existing: string | null, tenant: string): MergeResult {
    if (tenant.length === 0) return {ok: false, reason: "사이트 코드가 비어 있습니다"};
    if (existing === null || existing.trim().length === 0) {
        return {ok: true, text: `${JSON.stringify({"zalkera.tenant": tenant}, null, 2)}\n`};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(existing);
    } catch {
        return {ok: false, reason: "settings.json 을 읽지 못했습니다(주석이 섞였거나 손상)"};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {ok: false, reason: "settings.json 이 객체가 아닙니다"};
    }
    const merged = {...(parsed as Record<string, unknown>), "zalkera.tenant": tenant};
    return {ok: true, text: `${JSON.stringify(merged, null, 2)}\n`};
}

/**
 * 출처 표식을 남긴다. **`writeOwnFile` 을 지난다** — 심링크를 따라가 폴더 밖에 쓰지 않고,
 * 임시 파일 + `rename` 으로 원자적이다.
 *
 * 실패는 던지지 않고 사유로 돌려준다 — 표식은 편의지 받기의 조건이 아니다.
 */
export async function writeSourceMarkTo(root: string, mark: Omit<FetchedMark, "format">): Promise<MergeResult> {
    return writeMarkText(root, buildSourceMark(mark));
}

/**
 * 소속을 정하는 표식을 쓴다 — 발행(`published`)·명시 재연결(`linked`).
 * 받기는 [writeSourceMarkTo] 를 쓴다(형식이 다르다).
 */
export async function writeBindingMarkTo(
    root: string,
    mark: Omit<PublishedMark, "format"> | Omit<LinkedMark, "format">,
): Promise<MergeResult> {
    return writeMarkText(root, buildBindingMark(mark));
}

async function writeMarkText(root: string, text: string): Promise<MergeResult> {
    try {
        // ⚠ `mkdir(recursive)` 를 쓰지 않는다 — `.zalkera` **자체**가 심링크면 무동작이 되고
        //    뒤의 쓰기가 폴더 밖으로 나간다(잎만 보는 검사는 그것을 못 본다).
        await ensureOwnDir(root, ".zalkera");
        await writeOwnFile(join(root, SOURCE_MARK_PATH), text);
        return {ok: true, text: ""};
    } catch (error) {
        return {ok: false, reason: error instanceof Error ? error.message : String(error)};
    }
}

/**
 * 새 폴더가 그 사이트를 바라보게 한다 — 「사이트에 연결」이 하는 쓰기의 선행 수행.
 *
 * ■ 세 가지를 지킨다
 *   ⑴ **남의 키를 안 지운다**(병합) ⑵ **못 읽으면 안 쓴다**(「없다」와 구분한다)
 *   ⑶ **심링크를 안 따라간다**(`writeOwnFile`) — `.vscode/settings.json` 을 링크로 두는 것이
 *      흔해서, 생 쓰기는 고객 폴더 **밖**의 공유 설정을 고쳐 놓고 성공했다고 말한다.
 *      (막는 것은 **잎 심링크**다 — `safeWrite.ts` 의 `writeOwnFile` 한계 주석을 함께 보라.)
 */
export async function linkFolderToTenant(root: string, tenant: string): Promise<MergeResult> {
    const path = join(root, ".vscode", "settings.json");
    let existing: string | null = null;
    try {
        existing = await readFile(path, "utf8");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
            return {ok: false, reason: `설정 파일을 읽지 못했습니다(${code ?? "알 수 없음"})`};
        }
    }
    let merged: MergeResult;
    try {
        merged = mergeTenantSetting(existing, tenant);
    } catch (error) {
        // 아주 깊게 중첩된 설정에서 `JSON.parse` 가 스택을 넘길 수 있다. 던지면 받기가 실패한
        // 것처럼 보인다 — 여기서 잡아 받기는 살린다.
        return {ok: false, reason: error instanceof Error ? error.message : String(error)};
    }
    if (!merged.ok) return merged;
    try {
        // ⚠ `.vscode` 자체가 심링크면 남의 공유 설정에 쓰게 된다 — 조각마다 확인하고 만든다.
        await ensureOwnDir(root, ".vscode");
        await writeOwnFile(path, merged.text);
        return {ok: true, text: merged.text};
    } catch (error) {
        return {ok: false, reason: error instanceof Error ? error.message : String(error)};
    }
}
