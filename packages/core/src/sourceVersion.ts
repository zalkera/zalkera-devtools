/**
 * **판 지문**(memo191) — 「이 폴더가 서버에 켜져 있는 판과 같은 소스인가」를 64자 hex 하나로 답한다.
 *
 * ■ 왜 서버가 주는 `sha256` 으로는 안 되나
 *   원장의 `sourceSha256` 은 **canonical tar.gz 바이트의 해시**다. gzip 구현·압축 레벨에 딸려 있어
 *   우리 손으로는 그 숫자를 만들 수 없다 — 받은 tar 를 검증할 수는 있어도(그 용도로 계속 쓴다),
 *   **내 폴더가 그 판인지**는 물을 수 없다. 지문은 tar 도 gzip 도 안 거치고 파일별 내용 해시만으로
 *   정의해서 그 물음에 답한다.
 *
 * ■ 규칙 (백엔드 `SourceVersionDigest` 와 **같은 문장**)
 *   ```
 *   sha256( "zalkera-source-v1\n" + Σ (path + "\n" + sha256 + "\n") )
 *   ```
 *   정렬은 **경로의 UTF-8 바이트 오름차순**이다. JS 기본 문자열 정렬(UTF-16 코드유닛)을 쓰면
 *   **보조평면에서 뒤집힌다** — 이모지 든 파일명 하나로 백엔드와 다른 답이 나온다.
 *   `version-digest-vectors.json` 이 그 쌍을 담고 있고, 시험이 「기본 정렬로는 다른 값이 나온다」를
 *   단언한다.
 *
 * ■ 「이 폴더」의 뜻 (memo191 §10 · 오너 결정)
 *   여기서 접는 값은 **「지금 이 폴더를 올리면 서버에 남을 판」**이다. 입력이 `hashWorkdir` 의
 *   결과이고, 그것은 **우리 포장 규칙**(`isExcludedEntry`)을 지난 목록이기 때문이다.
 *
 *   ⚠ 서버의 배제 규칙을 쓰지 않는다. 백엔드는 `dist`·`out`·`.next`·`.DS_Store` 를 안 뺀다 —
 *     그 규칙으로 접으면 **`npm run build` 한 번에 지문이 바뀐다.** 아무것도 안 고쳤는데 화면이
 *     「다름」이라고 말하는, 매일 일어나는 거짓 다름이다.
 *
 *   ⚠ 남는 틈: 콘솔 zip 업로드로 선 판이 `dist/` 를 실었다면 그 판을 받은 폴더는 여기서 그것을 빼고
 *     접으므로 거짓 다름이 된다. 드물고(그런 zip 은 대체로 잘못 포장된 것이다), 「서버 판으로 교체」가
 *     화해 경로다.
 *
 * ■ 규칙이 두 레포에 있다 — 그 드리프트를 무엇이 잡나
 *   컴파일도 CI 도 못 잡는다(레포가 다르다). **발행 직후 예측과 서버 답을 대조하는 것**이 유일한
 *   그물이다(`compareAfterPublish`). 골든 벡터는 같은 규칙이라는 확신을 주지만, 벡터 파일 자체가
 *   낡으면 조용하다.
 */
import {createHash} from "node:crypto";
import {Buffer} from "node:buffer";

/** 규칙 판을 해시 입력에 실어 자기를 밝힌다. 백엔드 `SourceVersionDigest.RULE_TAG` 와 같아야 한다. */
export const VERSION_RULE_TAG = "zalkera-source-v1";

/**
 * 화면 축약 길이. **비교에 쓰지 않는다.**
 *
 * ⚠ 이 폭은 **계약이다.** 콘솔과 이 확장이 다른 폭으로 보이면 사람이 같은 판을 「다르다」로 읽는다 —
 *   그게 이 기능이 없애려는 바로 그 혼선이다. 백엔드 `SourceVersionDigest.SHORT_LENGTH` 와 같아야 한다.
 */
export const VERSION_DIGEST_SHORT = 8;

/** 최상위 단일 폴더 언랩의 최대 반복. 백엔드 `ArchiveNormalization.MAX_UNWRAP_DEPTH` 와 같아야 한다. */
const MAX_UNWRAP_DEPTH = 8;

/** 지문 입력 한 항목 — 상대경로(`/` 구분)와 그 파일 내용의 sha256(hex). */
export interface VersionEntry {
    path: string;
    sha256: string;
}

/**
 * 경로 목록에서 **최상위 단일 폴더를 벗긴다**(백엔드 `ArchiveNormalization.effectiveRoot` 의 짝).
 *
 * 🔴 **이것이 없으면 감싼 소스가 전부 거짓 「다름」이 된다.** 서버는 zip 의 최상위에 폴더 하나만
 *    있으면 그 안을 루트로 삼는다(사이트빌더·Mac 압축 관례). 우리가 안 벗기면 서버는 `index.html`,
 *    우리는 `mysite/index.html` 을 접어 지문이 통째로 갈린다.
 *
 * 판정은 「모든 경로가 같은 첫 조각을 갖고, 뿌리에 파일이 없다」 — 파일 목록으로 본 「자식이
 * 디렉터리 하나뿐」이다. 중첩 래퍼는 [MAX_UNWRAP_DEPTH] 까지 벗긴다.
 */
export function unwrapSingleRoot(paths: readonly string[]): string[] {
    let current = [...paths];
    for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
        if (current.length === 0) return current;
        const heads = current.map((p) => p.indexOf("/"));
        // 뿌리에 파일이 하나라도 있으면 그 자리가 루트다.
        if (heads.some((at) => at < 0)) return current;
        const first = current[0]!.slice(0, heads[0]!);
        if (!current.every((p, i) => p.slice(0, heads[i]!) === first)) return current;
        current = current.map((p, i) => p.slice(heads[i]! + 1));
    }
    return current;
}

/**
 * [entries] 의 판 지문(소문자 hex 64자). 빈 목록이면 `null`(= 모름 — 「같음」이 아니다).
 *
 * 입력 경로는 **이미 정규화된** 상대경로여야 한다. 언랩은 [digestOfManifest] 가 해 준다.
 */
export function sourceVersionDigest(entries: readonly VersionEntry[]): string | null {
    if (entries.length === 0) return null;
    const sorted = [...entries].sort((a, b) => {
        const byPath = Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
        return byPath !== 0 ? byPath : a.sha256.localeCompare(b.sha256);
    });
    const hash = createHash("sha256");
    hash.update(`${VERSION_RULE_TAG}\n`, "utf8");
    for (const entry of sorted) hash.update(`${entry.path}\n${entry.sha256.toLowerCase()}\n`, "utf8");
    return hash.digest("hex");
}

/**
 * 작업본 매니페스트(`hashWorkdir` 의 결과 형식)를 지문으로 접는다 — 언랩까지 여기서 한다.
 *
 * 형식을 `Record<path, {sha256}>` 로 받는 이유는 그것이 이미 손에 있는 값이기 때문이다.
 * 새로 훑지 않는다.
 */
export function digestOfManifest(manifest: Readonly<Record<string, {sha256: string}>>): string | null {
    const paths = Object.keys(manifest);
    const unwrapped = unwrapSingleRoot(paths);
    return sourceVersionDigest(paths.map((p, i) => ({path: unwrapped[i]!, sha256: manifest[p]!.sha256})));
}

/** 화면용 축약. 모르면 `null` — 부르는 쪽이 「모름」 문장을 낸다(빈 문자열로 접으면 「같음」처럼 보인다). */
export function shortVersion(digest: string | null | undefined): string | null {
    if (!digest || digest.length < VERSION_DIGEST_SHORT) return null;
    return digest.slice(0, VERSION_DIGEST_SHORT);
}

/**
 * 두 지문의 관계. **`null` 은 「모름」이고 「다름」이 아니다** — 어느 한쪽이라도 모르면 답은 모름이다.
 *
 * ⚠ 모름을 「다름」으로 접으면 화면이 근거 없이 사람을 놀래고, 「같음」으로 접으면 다른 소스를 배포한다.
 *   둘 다 틀리므로 값이 셋이다.
 */
export function compareVersions(mine: string | null, theirs: string | null): "same" | "differs" | "unknown" {
    if (!mine || !theirs) return "unknown";
    return mine === theirs ? "same" : "differs";
}
