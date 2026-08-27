/**
 * **로컬 장부 `.zalkera/sync.json`** — 이 폴더가 서버의 무엇을 언제 받았고 무엇을 올렸는가(memo184 §2.1).
 *
 * ■ vsix 표식과 **다른 물건이고 공존한다**(오너 결정 ㉮)
 *
 * `.zalkera/source.json`(vsix 표식)과 이 장부는 하나로 합치지 않는다. 겹치는 칸(`tenant`·`revisionNo`)이
 * 어긋나면 **이 장부가 판정하고 남의 표식은 안 고친다** — 보고만 한다. 합치면 구판 vsix 판독기가 깨진다.
 *
 * ■ 세 칸의 뜻이 갈린다 — 이것이 이 파일의 요지다
 *
 * - [SyncLedger.files] = **판의 진실**. 서버 원장이 정하고 우리는 받아 적는다.
 * - [SyncLedger.server] = 마지막으로 본 **서버 드래프트 세대**(불투명 문자열). 서버가 준 값 그대로다 —
 *   내부 토큰·seq 는 클라이언트에 안 온다(S3 키 재료).
 * - [SyncLedger.mine] = 그 세대에 **내가** 얹은 것.
 *
 * ⚠ **[SyncLedger.mine] 을 선행조건 계산에 쓰지 마라.** 초안이 그렇게 했고 그것이 🔴1(거짓 동기화)의
 *   뿌리다: 내가 올린 뒤 남이 콘솔에서 되돌리면 서버엔 없는데 장부는 「올렸다」고 적혀 있어, 다음 실행이
 *   「차이 0 · 이미 반영됨」이라 답하고 발행은 `DRAFT_EMPTY` 로 죽는다.
 *   **선행조건의 정본은 서버 조회다**(`GET /draft/files`). 이 칸이 쓰이는 자리는 둘뿐 —
 *   ⑴ 좌초 안내의 소유 판정 ⑵ 응답 유실 화해.
 *
 * ⚠ **서버 상태를 못 읽으면 push 를 거절한다.** 장부로 폴백하는 순간 🔴1 이 그대로 되살아난다.
 */

/** 장부가 사는 자리. **`zip.ts` 의 배제 목록이 이 상수를 쓴다** — 두 벌이면 장부가 정본에 실린다. */
export const SYNC_LEDGER_PATH = ".zalkera/sync.json";

/** 장부 형식 판. 모르는 판을 만나면 **읽지 않는다**(추측해 읽으면 그 추측이 선행조건이 된다). */
export const SYNC_LEDGER_FORMAT = 1;

/** 그 판의 매니페스트 한 줄 — 로컬이 tar 로 계산한 값이다. */
export interface LedgerFile {
    sha256: string;
    bytes: number;
}

export interface SyncLedger {
    format: number;
    tenant: string;
    /** 마지막으로 받은 판. */
    base: {revisionNo: number; tarSha256: string};
    /** 그 판의 매니페스트 — **판의 진실**. */
    files: Record<string, LedgerFile>;
    /** 마지막으로 본 서버 드래프트 세대. 드래프트가 없었으면 `null`. */
    server: {generation: string} | null;
    /** 그 세대에 내가 올린 것. `null` 값은 **내가 올린 삭제**다. ⚠ 선행조건 계산에 쓰지 마라. */
    mine: Record<string, string | null>;
    pulledAt: string;
    pushedAt: string | null;
}

/**
 * 장부를 읽는다. **모르는 형식·깨진 내용은 `null`** 이다 — 「없다」로 다룬다.
 *
 * ⚠ 부분 복구를 하지 않는다. 반쯤 읽어 낸 장부는 **틀린 선행조건**을 만들고, 그것이 조용히
 *   남의 변경을 덮는다. 없으면 `baseline` 이 판에서 다시 세운다 — 그 길이 있으므로 관용할 이유가 없다.
 */
export function parseSyncLedger(text: string): SyncLedger | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (o.format !== SYNC_LEDGER_FORMAT) return null;
    if (typeof o.tenant !== "string" || o.tenant === "") return null;

    const base = o.base as Record<string, unknown> | undefined;
    if (!base || typeof base.revisionNo !== "number" || typeof base.tarSha256 !== "string") return null;

    const files: Record<string, LedgerFile> = {};
    const rawFiles = o.files;
    if (typeof rawFiles !== "object" || rawFiles === null) return null;
    for (const [path, value] of Object.entries(rawFiles as Record<string, unknown>)) {
        const f = value as Record<string, unknown>;
        if (typeof f?.sha256 !== "string" || typeof f?.bytes !== "number") return null;
        files[path] = {sha256: f.sha256, bytes: f.bytes};
    }

    const server = o.server as Record<string, unknown> | null | undefined;
    if (server !== null && server !== undefined && typeof server.generation !== "string") return null;

    const mine: Record<string, string | null> = {};
    const rawMine = o.mine;
    if (rawMine !== undefined) {
        if (typeof rawMine !== "object" || rawMine === null) return null;
        for (const [path, value] of Object.entries(rawMine as Record<string, unknown>)) {
            if (value !== null && typeof value !== "string") return null;
            mine[path] = value as string | null;
        }
    }

    return {
        format: SYNC_LEDGER_FORMAT,
        tenant: o.tenant,
        base: {revisionNo: base.revisionNo, tarSha256: base.tarSha256},
        files,
        server: server == null ? null : {generation: server.generation as string},
        mine,
        pulledAt: typeof o.pulledAt === "string" ? o.pulledAt : "",
        pushedAt: typeof o.pushedAt === "string" ? o.pushedAt : null,
    };
}

/** 장부를 쓴다. 사람이 열어 볼 수 있게 들여쓴다 — 이 파일은 고객 폴더에 산다. */
export function serializeSyncLedger(ledger: SyncLedger): string {
    return `${JSON.stringify(ledger, null, 2)}\n`;
}
