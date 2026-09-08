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
 *   타입도 컴파일도 못 잡는다(레포가 다르다). 지금 서 있는 그물은 둘이다:
 *   · 백엔드 게이트 `detect-version-digest-parity.py` — 규칙 태그·표시 폭·언랩 깊이와
 *     **골든 벡터 파일 바이트**를 대사한다. 벡터가 낡는 자리를 그것이 막는다.
 *   · 두 레포 각자의 골든 벡터 시험 — 알고리즘 본문이 규칙대로인가.
 *
 *   ⚠ **안 서 있는 것**: 배포된 vsix 가 낡은 판일 때는 위 둘 다 못 본다(대사기는 소스를 본다).
 *     발행 직후 예측과 서버 답을 런타임에 대조하는 축은 **아직 안 지었다**(memo191 §12).
 */
import {createHash} from "node:crypto";
import {Buffer} from "node:buffer";

/** 규칙 판을 해시 입력에 실어 자기를 밝힌다. 백엔드 `SourceVersionDigest.RULE_TAG` 와 같아야 한다. */
export const VERSION_RULE_TAG = "zalkera-source-v2";

/**
 * **해시 입력에서 빼는 경로.** 목록에서 빼는 것이 아니다 — 포장기는 계속 넣고 서버도 계속 싣는다.
 * 빠지는 것은 **지문의 입력**뿐이다. 백엔드 `SourceVersionDigest.EXCLUDED_INPUT_PATHS` 와 같아야 한다.
 *
 * 🔴 `.zalkera/provenance.json` 은 **우리가 넣는 기록물**이지 고객 소스가 아니다. 그런데 포장기만 그것을
 *    주입하고 서버 배제는 그 경로를 안 뺐다 — 그래서 **같은 소스가 어느 문(콘솔 zip / devtools)으로
 *    들어왔느냐로 다른 판**이 됐다(실측: 같은 폴더가 `686b36a3…` vs `6fe064a3…`). 그 위에 방향 판정이
 *    올라가면 화면이 **반대 방향을 확신 있게** 말하고 옆에서 「새 버전 배포」를 권한다.
 *
 * ⚠ **정확일치다.** `sub/.zalkera/provenance.json` 은 고객 파일이고, `.zalkera/pack.json` 은 배송 문서가
 *   가리키는 실물이라 그대로 입력이다.
 *
 * ⛔ 여기에 `dist`·`.vscode` 를 더하지 마라(오너 확정) — `dist/` 만 다른 두 판이 같은 지문이 되어
 *   STATIC 에서 **거짓 「일치」**가 된다.
 */
export const DIGEST_EXCLUDED_INPUT_PATHS: readonly string[] = [".zalkera/provenance.json"];

/**
 * 화면 축약 길이. **비교에 쓰지 않는다.**
 *
 * ⚠ 이 폭은 **계약이다.** 콘솔과 이 확장이 다른 폭으로 보이면 사람이 같은 판을 「다르다」로 읽는다 —
 *   그게 이 기능이 없애려는 바로 그 혼선이다. 백엔드 `SourceVersionDigest.SHORT_LENGTH` 와 같아야 한다.
 */
export const VERSION_DIGEST_SHORT = 8;

/** 최상위 단일 폴더 언랩의 최대 반복. 백엔드 `ArchiveNormalization.MAX_UNWRAP_DEPTH` 와 같아야 한다. */
const MAX_UNWRAP_DEPTH = 8;

/** 지문 규칙이 내는 값의 모양 — 소문자 hex 64자. 백엔드 `SourceVersionDigest.HEX_LENGTH` 와 같은 계약이다. */
export const VERSION_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * **이 값이 판 지문인가.** 「안다/모른다」를 묻는 술어는 **하나뿐이어야 한다.**
 *
 * 🔴 종전에는 둘이었고 구간이 갈렸다 — [shortVersion] 은 「8자 이상인가」, [compareVersions] 는 「빈 문자열이
 *    아닌가」를 물었다. 그래서 `"abc"` 같은 값이 실리면 한 화면이 동시에 **「지문 없음(=모른다)」과
 *    「N번 내용 그대로(=안다)」**을 말할 수 있었다. 콘솔은 이 병을 먼저 겪고 술어를 하나로 좁혔다
 *    (`site-revision-history/lib/format.ts`) — 두 레포가 같은 술어를 써야 같은 답이 나온다.
 *
 * ⚠ **「충분히 긴가」가 아니라 「지문인가」를 묻는다.** 길이만 보면 10자짜리 값이 `abcdefgh` 로
 *   **자신 있게** 그려진다 — 유효한 지문이 아닌 것에 그럴듯한 신원을 붙이는 자리다.
 *
 * ⚠ 형을 먼저 본다. 서버가 준 값이라 문자열이 아닐 수 있고, `slice`·`test` 를 바로 부르면
 *   사이드바가 통째로 죽는다(실측된 자리다).
 */
export function isVersionDigest(value: unknown): value is string {
    return typeof value === "string" && VERSION_DIGEST_PATTERN.test(value);
}

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
 * 입력 경로는 **이미 정규화된** 상대경로여야 한다. 언랩은 부르는 쪽이 한다([unwrapSingleRoot]) — 서버는 배제 **전** 목록으로 래퍼를 판정하므로 순서가 규칙의 일부다.
 */
export function sourceVersionDigest(entries: readonly VersionEntry[]): string | null {
    // ⚠ **배제는 여기 산다 — 부르는 쪽에 두지 않는다.** 부르는 자리가 셋(폴더 예측·시험의 서버측 계산·
    //    벡터 시험)이라 호출부에 두면 한쪽이 빠뜨리고, 그 사실은 조용하다.
    const input = entries.filter((e) => !DIGEST_EXCLUDED_INPUT_PATHS.includes(e.path));
    if (input.length === 0) return null;
    const sorted = [...input].sort((a, b) => {
        const byPath = Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
        return byPath !== 0 ? byPath : a.sha256.localeCompare(b.sha256);
    });
    const hash = createHash("sha256");
    hash.update(`${VERSION_RULE_TAG}\n`, "utf8");
    for (const entry of sorted) hash.update(`${entry.path}\n${entry.sha256.toLowerCase()}\n`, "utf8");
    return hash.digest("hex");
}


/**
 * 화면용 축약. 모르면 `null` — 부르는 쪽이 「모름」 문장을 낸다(빈 문자열로 접으면 「같음」처럼 보인다).
 *
 * ⚠ **타입을 먼저 본다.** 종전 판은 `!digest` 만 보고 `slice` 를 불러, 서버가 `versionDigest` 에
 *   숫자·불린·객체를 주면 `TypeError` 를 던졌다. 그 예외는 `sidebarPlan` 을 거쳐 트리 `getChildren`
 *   까지 올라가 **사이드바 전체가 안 그려지고** 다음 발행·전환까지 복구되지 않는다(심의 실측).
 *   형제 `count` 가 비숫자를 거부하는 것과 같은 이유다 — 이 값을 정하는 것은 서버다.
 */
export function shortVersion(digest: unknown): string | null {
    if (!isVersionDigest(digest)) return null;
    return digest.slice(0, VERSION_DIGEST_SHORT);
}

/**
 * 두 지문의 관계. **`null` 은 「모름」이고 「다름」이 아니다** — 어느 한쪽이라도 모르면 답은 모름이다.
 *
 * ⚠ 모름을 「다름」으로 접으면 화면이 근거 없이 사람을 놀래고, 「같음」으로 접으면 다른 소스를 배포한다.
 *   둘 다 틀리므로 값이 셋이다.
 */
export function compareVersions(mine: unknown, theirs: unknown): "same" | "differs" | "unknown" {
    // 지문이 아니면 **모름**이다 — 서버가 준 값이라 형도 모양도 보장되지 않는다([isVersionDigest]).
    if (!isVersionDigest(mine) || !isVersionDigest(theirs)) return "unknown";
    return mine === theirs ? "same" : "differs";
}
