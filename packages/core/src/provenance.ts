/**
 * **출처 표시 — 「이 zip 이 어디서 나왔다고 «주장»하는가」.**
 *
 * 한 사람이 여러 사이트를 오가며 대행사가 보내오는 zip 을 계속 받는다. C 폴더에 D 의 zip 을
 * 넣고 올리면 C 사이트가 D 내용으로 나가는데, **도구가 그것을 못 보고 있었다** — 납품 zip 에는
 * 사이트 정체성이 한 조각도 없다(실측: `.zalkera/` 에 `seed.json`·`ASSETS-LICENSE.md` 뿐).
 *
 * ## 이것은 «소속»이 아니다 — 그 구분이 이 파일의 전부다
 *
 * 소속 표식(`SOURCE_MARK_PATH`)이 포장에서 빠진 이유는, zip 에 실린 정체성 파일이 **그 소스를
 * 풀어 연 사람의 확장을 조용히 그 테넌트로 향하게** 하기 때문이다. 그 위험이 안 돌아오는 근거를
 * 구성으로 박는다.
 *
 *   ⑴ **소속 판독 경로가 안 바뀐다.** 소속은 여전히 `folderBinding(mark, linked)` 하나이고 `mark` 는
 *      `SOURCE_MARK_PATH` 한 곳에서만 온다. 이 표시를 읽는 자리는 갱신의 대조 하나뿐이고, 그
 *      결과는 **문구 분기에만** 쓴다.
 *   ⑵ **타입으로 격리한다.** [Provenance] 는 `SourceMark` 유니언에 넣지 않는다 — `folderBinding` 에
 *      넘길 수 없어 「출처를 소속으로 승격」하는 코드가 컴파일에서 막힌다.
 *   ⑶ **디스크에 안 남긴다.** `EXCLUDED_PATHS` 에 있어 들여오기·갱신이 떨군다. 낡은 표시가 다음
 *      판을 받는 모두에게 복제되는 부패가 몸통 자체를 못 갖는다.
 *   ⑷ **강하 방향이 안전하다.** 위조·복사된 표시가 만들 수 있는 최악은 **틀린 경고 문구**다.
 */
import { TENANT_CODE } from "./localMark.ts";

/** 이 파일의 zip 내 경로. `EXCLUDED_PATHS`(zip.ts)와 **같은 문자열**이어야 한다. */
export const PROVENANCE_PATH = ".zalkera/provenance.json";

export interface Provenance {
  /** 이 도구가 만든 표시의 판. 모르는 값은 «모른다»로 강하한다. */
  format: 1;
  /** 무엇을 주장하는가. 지금은 하나다 — 「이 사이트에서 내보냈다」. */
  claim: "site-export";
  tenant: string;
}

/**
 * 갱신이 낼 수 있는 판정 넷.
 *
 * ⚠ **`unknown` 을 `match` 로 접지 마라.** 시작 팩에서 나온 소스는 **정의상** 출처가 없다 —
 *   그것이 지금 주된 경로다. 접는 순간 이 게이트 전체가 거짓말이 된다.
 */
export type UpdateVerdict = "match" | "mismatch" | "unknown" | "unbound";

/** 표시를 만든다. 내보내기·발행이 **지금 소속**으로 찍는다(디스크 것을 싣지 않는다). */
export function buildProvenance(tenant: string): string {
  const value: Provenance = { format: 1, claim: "site-export", tenant };
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 표시를 읽는다. 모르면 `null` — **빈 값과 다르다.**
 *
 * 잣대는 `parseSourceMark` 와 같다. 모르는 `format`·`claim`, 규격 밖 테넌트 코드는 전부 `null` 로
 * 강하해 「모른다」가 된다 — 틀린 확신보다 모르는 편이 낫다.
 */
export function parseProvenance(text: string | null): Provenance | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.format !== 1 || v.claim !== "site-export") return null;
  if (typeof v.tenant !== "string" || !TENANT_CODE.test(v.tenant)) return null;
  return { format: 1, claim: "site-export", tenant: v.tenant };
}

/**
 * 이 zip 을 이 폴더에 갈아 끼워도 되는가 — **말할 뿐 막지 않는다.**
 *
 * 막지 않는 이유: 새 사이트의 첫 납품은 정당하게 출처가 없다. 막으면 주 경로가 죽는다.
 */
export function judgeUpdate(prov: Provenance | null, binding: string | null): UpdateVerdict {
  if (binding === null) return "unbound";
  if (prov === null) return "unknown";
  return prov.tenant === binding ? "match" : "mismatch";
}
