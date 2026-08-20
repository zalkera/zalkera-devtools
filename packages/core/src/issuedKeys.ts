/**
 * **발급해 둔 미리보기 열쇠의 목록.**
 *
 * ■ 왜 목록인가
 *   종전에는 한 칸이었다(`globalState` 의 `zalkera.issuedKey`). 그런데 그 칸은 **창 사이에
 *   공유**되고 미리보기는 **창마다** 켠다. 창 A(사이트 a)와 창 B(사이트 b)가 각각 켜면 뒤에 켠
 *   쪽이 그 칸을 덮는다. A 는 자기 모듈 메모리에 제 키를 들고 있어 그동안은 멀쩡하지만, A 가
 *   다시 열리면(reload·재시작) 그 칸에서 **B 의 키**를 읽는다 — 그 뒤 A 에서 로그아웃하면
 *   B 의 키가 지워지고 **A 의 키는 최대 12시간 산다.** 도움말은 로그아웃하면 지워진다고 무조건으로
 *   약속한다.
 *
 * ■ 왜 core 인가
 *   확장 안에 두면 시험도 검사기도 못 닿는다. 이 레포는 그 사각에서 결함을 반복해서 냈다
 *   (`reentrancy.ts`·`fetchTarget.ts` 가 같은 이유로 내려왔다).
 *
 * ■ 저장된 값을 믿지 않는다
 *   `globalState` 는 디스크에 있고 우리가 쓴 판이 여럿이다. 모양이 다르면 **그 항목만 버린다** —
 *   통째로 버리면 지워야 할 열쇠를 못 지우고, 통째로 믿으면 `undefined.keyId` 가 로그아웃을 끊는다.
 */

export interface IssuedKey {
    keyId: number;
    tenant: string;
}

/**
 * 목록의 상한. 정상적으로는 창 수만큼(한 자리)이다. 이 값은 **저장된 값이 망가졌을 때**의
 * 방지선이지 정책이 아니다.
 *
 * ⚠ **넘쳐서 버린 열쇠를 조용히 잃지 않는다.** 종전에는 `slice` 가 오래된 쪽을 말없이 떨궜고,
 *   그 열쇠는 아무도 못 지운 채 서버 TTL(최대 12시간)까지 살았다 — 도움말이 「로그아웃하면
 *   서버에서 폐기됩니다」를 **무조건으로** 약속하는데 그 약속이 거기서 깨진다.
 *   그래서 [addIssuedKey] 가 버린 것을 **돌려주고**, 부르는 쪽이 그것을 폐기한다.
 */
export const MAX_ISSUED_KEYS = 64;

function isKey(value: unknown): value is IssuedKey {
    if (value === null || typeof value !== "object") return false;
    const { keyId, tenant } = value as Record<string, unknown>;
    return Number.isSafeInteger(keyId) && (keyId as number) > 0 && typeof tenant === "string" && tenant !== "";
}

/**
 * 저장된 값을 목록으로 읽는다.
 *
 * 옛 판이 남긴 **단일 객체**도 받는다 — 안 받으면 이 판으로 올린 사람의 살아 있는 열쇠가
 * 그 순간 미아가 된다(아무도 못 지운다).
 */
export function readIssuedKeys(raw: unknown): IssuedKey[] {
    return readIssuedKeysWithOverflow(raw).list;
}

/**
 * [readIssuedKeys] 와 같되 **상한 때문에 버린 것**을 함께 돌려준다.
 *
 * 저장된 값이 상한을 넘었다는 것은 이미 어딘가 샌 것이다. 그 열쇠들도 서버에서 살아 있으므로
 * 조용히 버리면 안 된다 — 부르는 쪽이 폐기 목록에 넣는다.
 */
export function readIssuedKeysWithOverflow(raw: unknown): {list: IssuedKey[]; dropped: IssuedKey[]} {
    if (isKey(raw)) return {list: [raw], dropped: []};
    if (!Array.isArray(raw)) return {list: [], dropped: []};
    const valid = raw.filter(isKey);
    const over = valid.length - MAX_ISSUED_KEYS;
    if (over <= 0) return {list: valid, dropped: []};
    return {list: valid.slice(over), dropped: valid.slice(0, over)};
}

/** 목록에 더한다. 같은 `keyId` 는 한 번만 — 갱신은 같은 열쇠를 다시 적는 일이 있다. */
export function addIssuedKey(list: readonly IssuedKey[], key: IssuedKey): IssuedKey[] {
    return addIssuedKeyWithOverflow(list, key).list;
}

/**
 * [addIssuedKey] 와 같되 **상한 때문에 버린 것**을 함께 돌려준다.
 *
 * 버린 열쇠는 서버에서 살아 있다. 부르는 쪽이 그것을 폐기해야 「로그아웃하면 지워진다」가 참이 된다.
 * 정상 사용에서는 늘 빈 배열이다 — 상한에 닿는다는 것 자체가 어딘가 새고 있다는 뜻이다.
 */
export function addIssuedKeyWithOverflow(
    list: readonly IssuedKey[],
    key: IssuedKey,
): {list: IssuedKey[]; dropped: IssuedKey[]} {
    if (!isKey(key)) return {list: [...list], dropped: []};
    const merged = [...list.filter((k) => k.keyId !== key.keyId), key];
    const over = merged.length - MAX_ISSUED_KEYS;
    if (over <= 0) return {list: merged, dropped: []};
    return {list: merged.slice(over), dropped: merged.slice(0, over)};
}

/** 목록에서 뺀다. 없으면 그대로 — 두 번 지우는 것은 정상이다(경합). */
export function removeIssuedKey(list: readonly IssuedKey[], keyId: number): IssuedKey[] {
    return list.filter((k) => k.keyId !== keyId);
}
