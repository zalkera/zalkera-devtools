/**
 * **받은 폴더가 자기 출처를 적어 두는 자리**, 그리고 그 폴더가 자기 사이트를 바라보게 하는 병합.
 *
 * ■ 표식이 왜 필요한가
 *   지금까지 받은 폴더는 자기가 어느 판에서 왔는지 아무 데도 안 적었다. 그래서 「같은 판을 또
 *   받으려는 것인가」를 물을 수 없었고, 물을 수 없으니 사본만 늘었다.
 *
 * ■ ⚠ 이 표식은 **올라가면 안 된다**
 *   정본에 실리면, 서버가 만든 다음 판을 받은 폴더가 「나는 13에서 왔다」는 낡은 거짓을 품는다.
 *   `zip.ts` 의 `ALWAYS_EXCLUDED` 가 `.zalkera` 를 빼는 것이 이 파일의 **전제**다 — 둘은 같은
 *   커밋에 있어야 하고, 순서가 갈리면 그 사이에 오염된 판이 나간다.
 *
 * ■ 부재는 정상이다
 *   콘솔·AI 레인 등 다른 입구로 만들어진 판에는 표식이 없다. 없으면 「모른다」로 다루고, 없다는
 *   이유로 무엇도 막지 않는다.
 */

/** 프로젝트 루트 기준 상대 경로. 조회는 이 상수 하나로 한다. */
import {mkdir, readFile} from "node:fs/promises";
import {join} from "node:path";
import {writeOwnFile} from "./safeWrite.ts";

export const SOURCE_MARK_PATH = ".zalkera/source.json";

export interface SourceMark {
    /** 형식 판올림 자리. 모르는 값이면 읽는 쪽이 「모른다」로 다룬다. */
    format: 1;
    tenant: string;
    revisionNo: number;
    /** 받은 정본 tar.gz 의 sha256. 같은 판이면 같아야 한다. */
    sha256: string;
    fetchedAt: string;
}

export function buildSourceMark(input: Omit<SourceMark, "format">): string {
    const mark: SourceMark = {format: 1, ...input};
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
    if (o.format !== 1) return null;
    if (typeof o.tenant !== "string" || o.tenant.length === 0) return null;
    if (typeof o.revisionNo !== "number" || !Number.isInteger(o.revisionNo)) return null;
    if (typeof o.sha256 !== "string" || o.sha256.length === 0) return null;
    if (typeof o.fetchedAt !== "string") return null;
    return {format: 1, tenant: o.tenant, revisionNo: o.revisionNo, sha256: o.sha256, fetchedAt: o.fetchedAt};
}

/** 이 폴더가 **같은 사이트의 같은 판**을 이미 담고 있는가. 모르면 `false`(사본을 막지 않는다). */
export function holdsSameRevision(mark: SourceMark | null, tenant: string, revisionNo: number): boolean {
    return mark !== null && mark.tenant === tenant && mark.revisionNo === revisionNo;
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
 *   쓰지 않고 사유를 돌려준다 — 부르는 쪽이 「폴더 연결을 한 번 눌러 주세요」로 옮긴다.
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
export async function writeSourceMarkTo(root: string, mark: Omit<SourceMark, "format">): Promise<MergeResult> {
    try {
        await mkdir(join(root, ".zalkera"), {recursive: true});
        await writeOwnFile(join(root, SOURCE_MARK_PATH), buildSourceMark(mark));
        return {ok: true, text: ""};
    } catch (error) {
        return {ok: false, reason: error instanceof Error ? error.message : String(error)};
    }
}

/**
 * 새 폴더가 그 사이트를 바라보게 한다 — 「폴더 연결」이 하는 쓰기의 선행 수행.
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
        await mkdir(join(root, ".vscode"), {recursive: true});
        await writeOwnFile(path, merged.text);
        return {ok: true, text: merged.text};
    } catch (error) {
        return {ok: false, reason: error instanceof Error ? error.message : String(error)};
    }
}
